"""Publish jobs: publish now / scheduled, takedown, restore, daily refresh.

Safety properties:
- a job is claimed with an atomic UPDATE inside BEGIN IMMEDIATE, so two
  workers can never run the same job;
- one pending publish job per approval, protected by a unique idempotency
  key, so double clicks and resent requests cannot publish twice;
- a site-wide lease lock serialises builds;
- the live directory is switched only after the staged build verifies, and
  the switch is reverted if the database update afterwards fails.
"""

from __future__ import annotations

import os
import socket
import sqlite3
import traceback
import uuid
from datetime import timedelta
from typing import List, Optional

from . import amazon_api, approvals, articles, assets as assets_mod, checks, db, publisher, render, \
    settings, timeutil
from .core import Actor, Ctx, EditorialError, GateError, record_event

LEASE_MINUTES = 15
SITE_LOCK = "site_build"
ACTION_LABELS = {"publish": "公開", "unpublish": "取り下げ", "refresh": "定期更新"}
STATUS_LABELS = {"scheduled": "予約", "queued": "待機中", "running": "実行中", "succeeded": "成功",
                 "failed": "失敗", "canceled": "取り消し"}


def worker_id() -> str:
    return "%s-%d-%s" % (socket.gethostname(), os.getpid(), uuid.uuid4().hex[:6])


def get(ctx: Ctx, job_id: int):
    row = db.one(ctx.conn, "SELECT * FROM publish_jobs WHERE id = ?", (job_id,))
    if row is None:
        raise EditorialError("ジョブが見つかりません")
    return row


def pending_publish_job(ctx: Ctx, article_id: int):
    return db.one(ctx.conn, "SELECT * FROM publish_jobs WHERE article_id = ? AND action = 'publish' "
                  "AND status IN ('scheduled','queued','running') ORDER BY id DESC LIMIT 1", (article_id,))


# ---------------------------------------------------------------- enqueue

def _insert_job(ctx: Ctx, values: dict) -> int:
    try:
        return db.insert(ctx.conn, "publish_jobs", values)
    except sqlite3.IntegrityError:
        row = db.one(ctx.conn, "SELECT id FROM publish_jobs WHERE idempotency_key = ?", (values["idempotency_key"],))
        if row is None:
            raise
        return int(row["id"])


def enqueue_publish(ctx: Ctx, actor: Actor, article_id: int, version_id: int,
                    run_at: Optional[str] = None, approval_id: Optional[int] = None) -> int:
    """Publish an approved version now (run_at=None) or at a future UTC time."""
    now = timeutil.now()
    with db.tx(ctx.conn):
        art = articles.get(ctx, article_id)
        approval = approvals.get(ctx, approval_id) if approval_id else approvals.active_for(ctx, article_id, version_id)
        if approval is None or approval["status"] != "active" or approval["version_id"] != version_id:
            raise EditorialError("この版の有効な承認がありません。承認してから公開してください。")
        ver = articles.version(ctx, version_id)
        if ver["content_hash"] != approval["content_hash"]:
            raise EditorialError("承認した内容と版の内容が一致しません")
        scheduled = False
        if run_at:
            when = timeutil.parse_iso(run_at)
            if when <= now + timedelta(minutes=1):
                raise EditorialError("予約日時は現在より後（1分以上先）を指定してください")
            run_at = timeutil.iso(when)
            scheduled = True
        else:
            run_at = timeutil.iso(now)
        existing = pending_publish_job(ctx, article_id)
        if existing:
            if existing["approval_id"] == approval["id"] and (existing["run_at"] == run_at or not scheduled):
                return int(existing["id"])  # the same order again: do not duplicate
            raise EditorialError("この記事には既に公開予定のジョブがあります（#%d）。取り消してから指定し直してください。"
                                 % existing["id"])
        if approval["purpose"] == "publish" and art["head_version_id"] != version_id:
            raise EditorialError("承認後に新しい版が作られています")
        generation = db.scalar(ctx.conn, "SELECT COUNT(*) FROM publish_jobs WHERE approval_id = ?", (approval["id"],))
        job_id = _insert_job(ctx, {
            "article_id": article_id, "version_id": version_id, "approval_id": approval["id"],
            "content_hash": ver["content_hash"], "action": "publish", "run_at": run_at,
            "idempotency_key": "publish:%d:%s:%d" % (approval["id"], run_at, generation),
            "status": "scheduled" if scheduled else "queued", "created_by": actor.name,
            "created_at": timeutil.now_iso(),
            "reason": "復元" if approval["purpose"] == "restore" else None,
        })
        if scheduled and art["state"] == "approved" and art["head_version_id"] == version_id:
            articles.set_state(ctx, actor, article_id, "scheduled", "予約 %s" % timeutil.jst_label(run_at))
        record_event(ctx, actor, "article", article_id, "publish_enqueued",
                     {"job_id": job_id, "version_id": version_id, "run_at": run_at, "scheduled": scheduled})
        return job_id


def cancel_schedule(ctx: Ctx, actor: Actor, article_id: int) -> None:
    with db.tx(ctx.conn):
        job = pending_publish_job(ctx, article_id)
        if job is None or job["status"] not in ("scheduled", "queued"):
            raise EditorialError("取り消せる予約がありません")
        db.update(ctx.conn, "publish_jobs", "id", job["id"], {
            "status": "canceled", "last_error": "本人が取り消し", "finished_at": timeutil.now_iso()})
        art = articles.get(ctx, article_id)
        if art["state"] == "scheduled":
            articles.set_state(ctx, actor, article_id, "approved", "予約を取り消し")
        record_event(ctx, actor, "article", article_id, "schedule_canceled", {"job_id": job["id"]})


def enqueue_unpublish(ctx: Ctx, actor: Actor, article_id: int, reason: str) -> int:
    reason = (reason or "").strip()
    if not reason:
        raise EditorialError("取り下げの理由を入力してください")
    with db.tx(ctx.conn):
        art = articles.get(ctx, article_id)
        if art["publication_status"] != "live":
            raise EditorialError("公開中の記事ではありません")
        existing = db.one(ctx.conn, "SELECT id FROM publish_jobs WHERE article_id = ? AND action = 'unpublish' "
                          "AND status IN ('queued','running')", (article_id,))
        if existing:
            return int(existing["id"])
        job_id = _insert_job(ctx, {
            "article_id": article_id, "version_id": art["live_version_id"], "action": "unpublish",
            "run_at": timeutil.now_iso(), "status": "queued", "reason": reason,
            "idempotency_key": "unpublish:%d:%s" % (article_id, uuid.uuid4().hex),
            "created_by": actor.name, "created_at": timeutil.now_iso()})
        record_event(ctx, actor, "article", article_id, "unpublish_enqueued", {"job_id": job_id, "reason": reason})
        return job_id


def enqueue_refresh(ctx: Ctx, actor: Actor, reason: str = "定期更新") -> int:
    with db.tx(ctx.conn):
        existing = db.one(ctx.conn, "SELECT id FROM publish_jobs WHERE action = 'refresh' AND status = 'queued'")
        if existing:
            return int(existing["id"])
        return _insert_job(ctx, {
            "action": "refresh", "run_at": timeutil.now_iso(), "status": "queued", "reason": reason,
            "idempotency_key": "refresh:%s" % uuid.uuid4().hex, "created_by": actor.name,
            "created_at": timeutil.now_iso()})


def enqueue_restore(ctx: Ctx, actor: Actor, article_id: int, version_id: int, acknowledged=(),
                    acknowledge_all: bool = False) -> int:
    """Re-approve a past approved version and publish it.

    ``acknowledge_all`` confirms the warnings the owner was shown (blocks
    still stop the restore)."""
    if acknowledge_all:
        report = checks.evaluate(ctx, article_id, version_id, purpose="restore")
        acknowledged = [w.key for w in report.warnings]
    with db.tx(ctx.conn):
        approval_id = approvals.approve_restore(ctx, actor, article_id, version_id, acknowledged)
        return enqueue_publish(ctx, actor, article_id, version_id, approval_id=approval_id)


def retry(ctx: Ctx, actor: Actor, job_id: int) -> None:
    with db.tx(ctx.conn):
        job = get(ctx, job_id)
        if job["status"] != "failed":
            raise EditorialError("失敗したジョブだけ再試行できます")
        if job["action"] == "publish":
            approval = approvals.get(ctx, job["approval_id"])
            if approval["status"] != "active":
                raise EditorialError("承認が無効になっているため再試行できません。再承認してください。")
            other = pending_publish_job(ctx, job["article_id"])
            if other:
                raise EditorialError("別の公開ジョブが待機中です")
        db.update(ctx.conn, "publish_jobs", "id", job_id, {
            "status": "queued", "run_at": timeutil.now_iso(), "locked_by": None, "lease_until": None,
            "max_attempts": max(job["max_attempts"], job["attempts"] + 1)})
        record_event(ctx, actor, "job", job_id, "retry_requested", {})


# ---------------------------------------------------------------- locks

def acquire_lock(ctx: Ctx, name: str, holder: str, minutes: int = LEASE_MINUTES) -> bool:
    now = timeutil.now_iso()
    until = timeutil.iso(timeutil.now() + timedelta(minutes=minutes))
    with db.tx(ctx.conn):
        row = db.one(ctx.conn, "SELECT * FROM locks WHERE name = ?", (name,))
        if row and row["lease_until"] > now and row["holder"] != holder:
            return False
        ctx.conn.execute("INSERT INTO locks(name, holder, lease_until) VALUES (?,?,?) ON CONFLICT(name) "
                         "DO UPDATE SET holder = excluded.holder, lease_until = excluded.lease_until",
                         (name, holder, until))
        return True


def release_lock(ctx: Ctx, name: str, holder: str) -> None:
    ctx.conn.execute("DELETE FROM locks WHERE name = ? AND holder = ?", (name, holder))


# ---------------------------------------------------------------- runner

def claim_next(ctx: Ctx, worker: str):
    now = timeutil.now_iso()
    until = timeutil.iso(timeutil.now() + timedelta(minutes=LEASE_MINUTES))
    with db.tx(ctx.conn):
        # A worker that died mid-job: its lease expired.  The build/switch is
        # atomic and idempotent, so the job can be safely queued again.
        for r in db.all_rows(ctx.conn, "SELECT * FROM publish_jobs WHERE status = 'running' AND lease_until < ?",
                             (now,)):
            status = "queued" if r["attempts"] < r["max_attempts"] else "failed"
            db.update(ctx.conn, "publish_jobs", "id", r["id"], {
                "status": status, "locked_by": None, "lease_until": None, "retryable": 1,
                "last_error": "実行中のワーカーが応答しなくなりました"})
        row = db.one(ctx.conn, "SELECT * FROM publish_jobs WHERE status IN ('queued','scheduled') AND run_at <= ? "
                     "ORDER BY run_at, id LIMIT 1", (now,))
        if row is None:
            return None
        cur = ctx.conn.execute(
            "UPDATE publish_jobs SET status = 'running', locked_by = ?, lease_until = ?, attempts = attempts + 1, "
            "started_at = ? WHERE id = ? AND status IN ('queued','scheduled')", (worker, until, now, row["id"]))
        if cur.rowcount != 1:
            return None
        return get(ctx, row["id"])


def run_due(ctx: Ctx, worker: Optional[str] = None, limit: int = 20) -> List[dict]:
    worker = worker or worker_id()
    results = []
    for _ in range(limit):
        job = claim_next(ctx, worker)
        if job is None:
            break
        results.append(execute(ctx, job, worker))
    return results


class _Retryable(Exception):
    pass


def execute(ctx: Ctx, job, worker: str) -> dict:
    if not acquire_lock(ctx, SITE_LOCK, worker):
        with db.tx(ctx.conn):
            db.update(ctx.conn, "publish_jobs", "id", job["id"], {
                "status": "queued", "attempts": job["attempts"] - 1, "locked_by": None, "lease_until": None})
        return {"job_id": job["id"], "status": "busy"}
    try:
        if job["action"] == "publish":
            outcome = _run_publish(ctx, job)
        elif job["action"] == "unpublish":
            outcome = _run_unpublish(ctx, job)
        else:
            outcome = _run_refresh(ctx, job)
        return {"job_id": job["id"], "status": "succeeded", **outcome}
    except Exception as exc:  # every failure is recorded; nothing counts as success
        retryable = isinstance(exc, (_Retryable, OSError)) and not isinstance(exc, EditorialError)
        message = _describe(exc)
        _fail(ctx, job, message, retryable)
        return {"job_id": job["id"], "status": "failed", "error": message, "retryable": retryable}
    finally:
        release_lock(ctx, SITE_LOCK, worker)


def _describe(exc: Exception) -> str:
    if isinstance(exc, (GateError, publisher.VerificationError)):
        return "%s: %s" % (exc, " / ".join(getattr(p, "message", str(p)) for p in exc.problems))
    if isinstance(exc, EditorialError):
        return str(exc)
    return "%s: %s" % (type(exc).__name__, exc)


def _fail(ctx: Ctx, job, message: str, retryable: bool) -> None:
    system = Actor.system()
    with db.tx(ctx.conn):
        current = get(ctx, job["id"])
        again = retryable and current["attempts"] < current["max_attempts"]
        values = {"status": "queued" if again else "failed", "retryable": 1 if retryable else 0,
                  "last_error": message[:2000], "locked_by": None, "lease_until": None}
        if again:
            values["run_at"] = timeutil.iso(timeutil.now() + timedelta(minutes=2 ** current["attempts"]))
        else:
            values["finished_at"] = timeutil.now_iso()
        db.update(ctx.conn, "publish_jobs", "id", job["id"], values)
        record_event(ctx, system, "job", job["id"], "failed", {"error": message[:500], "will_retry": again})
        if job["article_id"] and job["action"] == "publish" and not again:
            art = articles.get(ctx, job["article_id"])
            if art["head_version_id"] == job["version_id"] and art["state"] in ("approved", "scheduled"):
                articles.set_state(ctx, system, art["id"], "error", message[:300], last_error=message[:2000])
            else:
                db.update(ctx.conn, "articles", "id", art["id"], {"last_error": message[:2000]})


def _site_build(ctx: Ctx, job, mapping: dict, expect_absent: Optional[List[str]] = None):
    result = publisher.build(ctx, mapping)
    try:
        report = publisher.verify(ctx, result, expect_absent=expect_absent)
    except Exception:
        publisher.discard(ctx, result["build_id"])
        raise
    db.insert(ctx.conn, "builds", {
        "id": result["build_id"], "job_id": job["id"], "created_at": timeutil.now_iso(), "status": "staged",
        "live_map_json": db.dumps({str(k): v for k, v in mapping.items()}), "verification_json": db.dumps(report)})
    return result, report


def _switch_and_commit(ctx: Ctx, job, result: dict, report: dict, commit) -> None:
    """Switch live dir, re-check it, then commit DB; revert the switch on failure."""
    previous = publisher.current_build_id(ctx)
    publisher.switch_live(ctx, result["build_id"])
    try:
        live_dir = ctx.config.public_out_dir
        for page in result["pages"]:
            if not (live_dir / page["path"].strip("/") / "index.html").exists():
                raise publisher.VerificationError("公開後の確認に失敗しました", ["%s が読めません" % page["path"]])
        with db.tx(ctx.conn):
            commit()
            if previous:
                db.update(ctx.conn, "builds", "id", previous, {"status": "superseded"})
            db.update(ctx.conn, "builds", "id", result["build_id"], {"status": "live"})
            db.update(ctx.conn, "publish_jobs", "id", job["id"], {
                "status": "succeeded", "finished_at": timeutil.now_iso(), "build_id": result["build_id"],
                "verification_json": db.dumps(report), "locked_by": None, "lease_until": None,
                "last_error": None})
    except Exception:
        if previous:
            publisher.switch_live(ctx, previous)
        else:
            try:
                os.unlink(ctx.config.public_out_dir)
            except OSError:
                pass
        db.update(ctx.conn, "builds", "id", result["build_id"], {"status": "rolled_back"})
        raise
    publisher.prune_builds(ctx)


def _run_publish(ctx: Ctx, job) -> dict:
    system = Actor.system()
    approval = approvals.get(ctx, job["approval_id"])
    art = articles.get(ctx, job["article_id"])
    ver = articles.version(ctx, job["version_id"])
    if approval["status"] != "active":
        raise EditorialError("承認が無効になっています（%s）" % (approval["status_reason"] or approval["status"]))
    if not (approval["version_id"] == ver["id"] and approval["content_hash"] == ver["content_hash"]
            == job["content_hash"]):
        raise EditorialError("承認した版・ハッシュと公開しようとした版が一致しません")
    if approval["purpose"] == "publish" and art["head_version_id"] != ver["id"]:
        raise EditorialError("承認後に新しい版が作られています")
    current_ctx = settings.publish_context(ctx)
    if settings.context_hash(current_ctx) != approval["context_hash"]:
        raise EditorialError("公開設定（広告表示・トラッキングID等）が承認時から変わっています。再承認してください。")
    purpose = "restore" if approval["purpose"] == "restore" else "publish"
    report = checks.evaluate(ctx, art["id"], ver["id"], purpose=purpose, context=db.loads(approval["context_json"]))
    if report.blocks:
        raise GateError("公開直前の検査で問題が見つかりました", report.blocks)

    now = timeutil.now_iso()
    mapping = publisher.live_map(ctx)
    mapping[art["id"]] = {"version_id": ver["id"], "approval_id": approval["id"], "published_at": now}
    for other_id, entry in mapping.items():
        if other_id != art["id"]:
            o = articles.get(ctx, other_id)
            entry["published_at"] = o["last_published_at"]
    result, verification = _site_build(ctx, job, mapping)
    url = render.absolute(db.loads(approval["context_json"]), render.article_path(art["kind"], art["slug"]))

    def commit():
        fresh = articles.get(ctx, art["id"])
        values = {"live_version_id": ver["id"], "live_approval_id": approval["id"], "publication_status": "live",
                  "last_published_at": now, "last_error": None, "updated_at": now}
        if not fresh["first_published_at"]:
            values["first_published_at"] = now
        db.update(ctx.conn, "articles", "id", art["id"], values)
        if fresh["head_version_id"] == ver["id"] and fresh["state"] in ("approved", "scheduled", "error", "review"):
            articles.set_state(ctx, system, art["id"], "published", "公開 (版%d)" % ver["version_no"])
        db.update(ctx.conn, "approvals", "id", approval["id"], {"status": "used", "status_changed_at": now})
        db.update(ctx.conn, "publish_jobs", "id", job["id"], {"result_url": url})
        db.insert(ctx.conn, "publication_log", {
            "article_id": art["id"], "version_id": ver["id"],
            "action": "restored" if purpose == "restore" else "published", "url": url,
            "build_id": result["build_id"], "job_id": job["id"], "ts": now})
        record_event(ctx, system, "article", art["id"], "published",
                     {"job_id": job["id"], "version_id": ver["id"], "url": url, "build_id": result["build_id"]})

    _switch_and_commit(ctx, job, result, verification, commit)
    return {"url": url, "build_id": result["build_id"], "notes": result["notes"]}


def _run_unpublish(ctx: Ctx, job) -> dict:
    system = Actor.system()
    art = articles.get(ctx, job["article_id"])
    if art["publication_status"] != "live":
        raise EditorialError("既に公開されていません")
    mapping = publisher.live_map(ctx)
    mapping.pop(art["id"], None)
    for other_id, entry in mapping.items():
        entry["published_at"] = articles.get(ctx, other_id)["last_published_at"]
    path = render.article_path(art["kind"], art["slug"])
    result, verification = _site_build(ctx, job, mapping, expect_absent=[path])
    now = timeutil.now_iso()

    def commit():
        db.update(ctx.conn, "articles", "id", art["id"], {
            "live_version_id": None, "live_approval_id": None, "publication_status": "withdrawn",
            "updated_at": now})
        if articles.get(ctx, art["id"])["state"] == "published":
            articles.set_state(ctx, system, art["id"], "review", "公開を取り下げ（再公開には再承認が必要）")
        db.insert(ctx.conn, "publication_log", {
            "article_id": art["id"], "version_id": art["live_version_id"], "action": "withdrawn",
            "build_id": result["build_id"], "job_id": job["id"], "ts": now})
        articles.add_system_comment(ctx, art["id"], "公開を取り下げました: %s" % (job["reason"] or ""))
        record_event(ctx, system, "article", art["id"], "withdrawn", {"job_id": job["id"], "reason": job["reason"]})

    _switch_and_commit(ctx, job, result, verification, commit)
    return {"build_id": result["build_id"]}


def _run_refresh(ctx: Ctx, job) -> dict:
    """Daily: expire licences, refresh Amazon data, enforce rating rule, rebuild."""
    system = Actor.system()
    expired = assets_mod.expire_licenses(ctx, system)
    summary = amazon_api.refresh(ctx, system, amazon_api.asins_in_use(ctx))
    mapping = publisher.live_map(ctx)
    withdrawn = []
    for article_id, entry in list(mapping.items()):
        art = articles.get(ctx, article_id)
        approval = approvals.get(ctx, entry["approval_id"])
        context = db.loads(approval["context_json"])
        entry["published_at"] = art["last_published_at"]
        if art["kind"] == "page" or context.get("rating_policy") != "require_api_min":
            continue
        content = articles.version_content(articles.version(ctx, entry["version_id"]))
        for card in content["amazon_cards"]:
            item = amazon_api.get_item(ctx, card["asin"])
            if amazon_api.is_fresh(item) and item.get("star_rating") is not None \
                    and float(item["star_rating"]) < float(context["rating_min"]):
                withdrawn.append((article_id, "星評価が%.1fになり、サイト基準（%.1f以上）を下回ったため"
                                  % (item["star_rating"], float(context["rating_min"]))))
                mapping.pop(article_id, None)
                break
    absent = [render.article_path(articles.get(ctx, a)["kind"], articles.get(ctx, a)["slug"]) for a, _ in withdrawn]
    result, verification = _site_build(ctx, job, mapping, expect_absent=absent)
    now = timeutil.now_iso()

    def commit():
        for article_id, reason in withdrawn:
            art = articles.get(ctx, article_id)
            db.update(ctx.conn, "articles", "id", article_id, {
                "live_version_id": None, "live_approval_id": None, "publication_status": "withdrawn",
                "updated_at": now})
            if art["state"] == "published":
                articles.set_state(ctx, system, article_id, "review", reason)
            articles.add_system_comment(ctx, article_id, "自動で取り下げました: " + reason)
            db.insert(ctx.conn, "publication_log", {
                "article_id": article_id, "version_id": art["live_version_id"], "action": "withdrawn",
                "build_id": result["build_id"], "job_id": job["id"], "ts": now})
            record_event(ctx, system, "article", article_id, "auto_withdrawn", {"reason": reason})
        record_event(ctx, system, "site", None, "refreshed", {
            "build_id": result["build_id"], "expired_assets": expired, "amazon": {
                k: v for k, v in summary.items() if k != "errors"}, "notes": result["notes"][:20]})

    _switch_and_commit(ctx, job, result, verification, commit)
    return {"build_id": result["build_id"], "amazon": summary, "withdrawn": [a for a, _ in withdrawn],
            "expired_assets": expired, "notes": result["notes"]}


def recent(ctx: Ctx, limit: int = 50) -> List:
    return db.all_rows(ctx.conn, "SELECT * FROM publish_jobs ORDER BY id DESC LIMIT ?", (limit,))


def format_exc() -> str:
    return traceback.format_exc(limit=3)


def tick(ctx: Ctx, worker: Optional[str] = None) -> List[dict]:
    """One scheduler step: queue the refresh when due, then run due jobs.

    Run it from cron/launchd (or the admin server with run_scheduler) at
    least every few hours while Amazon data is shown; refresh is queued
    every REFRESH_AFTER_HOURS so no page carries data older than 24 hours.
    """
    has_live = db.scalar(ctx.conn, "SELECT COUNT(*) FROM articles WHERE publication_status = 'live'")
    last = db.scalar(ctx.conn, "SELECT MAX(finished_at) FROM publish_jobs WHERE action = 'refresh' "
                     "AND status = 'succeeded'")
    due = last is None or timeutil.now() - timeutil.parse_iso(last) >= timedelta(
        hours=amazon_api.REFRESH_AFTER_HOURS)
    expiring = db.scalar(ctx.conn, "SELECT COUNT(*) FROM assets WHERE rights_status = 'verified' AND "
                         "license_expires_at IS NOT NULL AND license_expires_at <= ?", (timeutil.now_iso(),))
    if (has_live and due) or expiring:
        enqueue_refresh(ctx, Actor.system(), "定期更新（Amazonデータ・許諾期限）")
    return run_due(ctx, worker)
