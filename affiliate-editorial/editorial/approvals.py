"""Approvals bind the owner's decision to one exact version.

An approval stores the version id, its content hash, the publish-context
snapshot (disclosures, tracking ID, operator name ...) and the Amazon image
ids seen at approval time.  Publishing re-checks all of them.
"""

from __future__ import annotations

import uuid
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from . import articles, db, settings, timeutil
from .core import Actor, Ctx, EditorialError, GateError, record_event


def get(ctx: Ctx, approval_id: int):
    row = db.one(ctx.conn, "SELECT * FROM approvals WHERE id = ?", (approval_id,))
    if row is None:
        raise EditorialError("承認が見つかりません")
    return row


def active_for(ctx: Ctx, article_id: int, version_id: Optional[int] = None):
    sql = "SELECT * FROM approvals WHERE article_id = ? AND status = 'active'"
    params: list = [article_id]
    if version_id is not None:
        sql += " AND version_id = ?"
        params.append(version_id)
    return db.one(ctx.conn, sql + " ORDER BY id DESC LIMIT 1", params)


def history(ctx: Ctx, article_id: int) -> List:
    return db.all_rows(ctx.conn, "SELECT * FROM approvals WHERE article_id = ? ORDER BY id DESC", (article_id,))


def amazon_snapshot(ctx: Ctx, content: dict) -> dict:
    snap = {}
    for card in content.get("amazon_cards", []):
        row = db.one(ctx.conn, "SELECT * FROM amazon_items WHERE asin = ?", (card["asin"],))
        snap[card["asin"]] = {
            "image_id": row["image_id"] if row else None,
            "title": row["title"] if row else None,
        }
    return snap


def _create(ctx: Ctx, actor: Actor, art, ver, acknowledged: Sequence[str], purpose: str,
            batch_id: Optional[str]) -> int:
    from . import checks
    report = checks.evaluate(ctx, art["id"], ver["id"], purpose="restore" if purpose == "restore" else "approve")
    if report.blocks:
        raise GateError("承認できない理由があります", report.blocks)
    missing = [w for w in report.warnings if w.key not in set(acknowledged)]
    if missing:
        raise GateError("注意事項を確認してください", missing)
    context = settings.publish_context(ctx)
    content = articles.version_content(ver)
    approval_id = db.insert(ctx.conn, "approvals", {
        "article_id": art["id"], "version_id": ver["id"], "content_hash": ver["content_hash"],
        "context_hash": settings.context_hash(context), "context_json": db.dumps(context),
        "amazon_snapshot_json": db.dumps(amazon_snapshot(ctx, content)),
        "acknowledged_warnings_json": db.dumps(sorted(w.key for w in report.warnings)),
        "purpose": purpose, "batch_id": batch_id, "approved_by": actor.name,
        "approved_at": timeutil.now_iso(), "status": "active",
    })
    record_event(ctx, actor, "article", art["id"], "approved",
                 {"approval_id": approval_id, "version_id": ver["id"], "version_no": ver["version_no"],
                  "content_hash": ver["content_hash"], "purpose": purpose, "batch_id": batch_id})
    return approval_id


def approve(ctx: Ctx, actor: Actor, article_id: int, version_id: int,
            acknowledged: Iterable[str] = (), batch_id: Optional[str] = None) -> int:
    with db.tx(ctx.conn):
        art = articles.get(ctx, article_id)
        if art["state"] != "review":
            raise EditorialError("確認待ちの記事だけを承認できます（現在: %s）" % articles.STATE_LABELS[art["state"]])
        if art["head_version_id"] != version_id:
            raise EditorialError("表示していた版より新しい版があります。最新の版を確認してから承認してください。")
        ver = articles.version(ctx, version_id)
        approval_id = _create(ctx, actor, art, ver, list(acknowledged), "publish", batch_id)
        articles.set_state(ctx, actor, article_id, "approved", "承認 (版%d)" % ver["version_no"])
        return approval_id


def bulk_candidates(ctx: Ctx) -> dict:
    """Articles waiting for review, split into approvable and excluded."""
    from . import checks
    eligible, excluded = [], []
    for item in articles.list_articles(ctx, states=["review"]):
        ver = articles.version(ctx, item["head_version_id"])
        report = checks.evaluate(ctx, item["id"], ver["id"], purpose="approve")
        entry = {
            "article_id": item["id"], "title": item["title"], "slug": item["slug"],
            "version_id": ver["id"], "version_no": ver["version_no"], "content_hash": ver["content_hash"],
            "products": item["products"], "warnings": report.warnings, "blocks": report.blocks,
            "rights_hold": any(p.code.startswith("rights") for p in report.blocks),
        }
        (excluded if report.blocks else eligible).append(entry)
    return {"eligible": eligible, "excluded": excluded,
            "excluded_rights_count": sum(1 for e in excluded if e["rights_hold"])}


def bulk_approve(ctx: Ctx, actor: Actor, items: Sequence[Tuple[int, int, str]],
                 acknowledged: Dict[int, Sequence[str]]) -> List[int]:
    """Approve exactly the (article, version, hash) tuples the owner saw.

    ``acknowledged`` maps article id to the warning keys that were shown on
    the list.  The batch is all-or-nothing: if any article changed or shows a
    warning the owner did not see, nothing is approved.
    """
    if not items:
        raise EditorialError("承認する記事が選ばれていません")
    batch_id = "batch-" + uuid.uuid4().hex[:12]
    ids: List[int] = []
    with db.tx(ctx.conn):
        for article_id, version_id, content_hash in items:
            art = articles.get(ctx, article_id)
            ver = articles.version(ctx, version_id)
            if (art["state"] != "review" or art["head_version_id"] != version_id
                    or ver["content_hash"] != content_hash):
                raise EditorialError("一覧を表示した後に「%s」が変更されました。もう一度一覧を確認してください。"
                                     % articles.version_content(ver)["title"])
            ids.append(_create(ctx, actor, art, ver, list(acknowledged.get(article_id, [])), "publish", batch_id))
            articles.set_state(ctx, actor, article_id, "approved", "一括承認 (版%d)" % ver["version_no"])
        record_event(ctx, actor, "batch", batch_id, "bulk_approved",
                     {"count": len(ids), "articles": [i[0] for i in items]})
    return ids


def invalidate_for_article(ctx: Ctx, actor: Actor, article_id: int, reason: str,
                           to_state: Optional[str] = "review") -> int:
    """Invalidate unpublished approvals and cancel pending publish jobs."""
    now = timeutil.now_iso()
    with db.tx(ctx.conn):
        art = articles.get(ctx, article_id)
        rows = db.all_rows(ctx.conn, "SELECT id FROM approvals WHERE article_id = ? AND status = 'active'",
                           (article_id,))
        for r in rows:
            db.update(ctx.conn, "approvals", "id", r["id"], {
                "status": "invalidated", "status_reason": reason, "status_changed_at": now})
        jobs = db.all_rows(ctx.conn, "SELECT id FROM publish_jobs WHERE article_id = ? AND action = 'publish' "
                           "AND status IN ('scheduled','queued')", (article_id,))
        for j in jobs:
            db.update(ctx.conn, "publish_jobs", "id", j["id"], {
                "status": "canceled", "last_error": reason, "finished_at": now})
        changed = bool(rows or jobs)
        if to_state and art["state"] in ("review", "approved", "scheduled", "error", "published") \
                and art["state"] != to_state:
            articles.set_state(ctx, actor, article_id, to_state, reason)
            changed = True
        if changed:
            articles.add_system_comment(ctx, article_id, "%s、承認と予約を無効にしました。再確認してください。" % reason
                                        if rows or jobs else "%s。再確認してください。" % reason)
            record_event(ctx, actor, "article", article_id, "approvals_invalidated",
                         {"reason": reason, "approvals": [r["id"] for r in rows], "jobs": [j["id"] for j in jobs]})
        return len(rows)


def invalidate_all_unpublished(ctx: Ctx, actor: Actor, reason: str) -> int:
    count = 0
    with db.tx(ctx.conn):
        ids = {r["article_id"] for r in db.all_rows(ctx.conn, "SELECT article_id FROM approvals WHERE status='active'")}
        ids |= {r["id"] for r in db.all_rows(ctx.conn, "SELECT id FROM articles WHERE state IN ('approved','scheduled')")}
        for article_id in sorted(ids):
            count += invalidate_for_article(ctx, actor, article_id, reason, to_state="review")
    return count


def revoke(ctx: Ctx, actor: Actor, article_id: int) -> None:
    with db.tx(ctx.conn):
        art = articles.get(ctx, article_id)
        if art["state"] not in ("approved", "scheduled", "error"):
            raise EditorialError("取り消せる承認がありません")
        now = timeutil.now_iso()
        for r in db.all_rows(ctx.conn, "SELECT id FROM approvals WHERE article_id = ? AND status='active'",
                             (article_id,)):
            db.update(ctx.conn, "approvals", "id", r["id"], {
                "status": "revoked", "status_reason": "本人が承認を取り消し", "status_changed_at": now})
        invalidate_for_article(ctx, actor, article_id, "承認が取り消されたため", to_state="review")
        record_event(ctx, actor, "article", article_id, "approval_revoked", {})


def restorable_versions(ctx: Ctx, article_id: int) -> List:
    """Versions that the owner approved at some point (not revoked)."""
    return db.all_rows(ctx.conn, """
        SELECT v.*, MAX(ap.approved_at) AS last_approved_at FROM article_versions v
        JOIN approvals ap ON ap.version_id = v.id
        WHERE v.article_id = ? AND ap.status IN ('active','used','invalidated')
        GROUP BY v.id ORDER BY v.version_no DESC""", (article_id,))


def approve_restore(ctx: Ctx, actor: Actor, article_id: int, version_id: int,
                    acknowledged: Iterable[str] = ()) -> int:
    """Re-approve a past approved version for restoring it to the site."""
    with db.tx(ctx.conn):
        art = articles.get(ctx, article_id)
        ver = articles.version(ctx, version_id)
        if ver["article_id"] != article_id or ver["track"] != "main":
            raise EditorialError("この記事の版ではありません")
        if version_id not in {r["id"] for r in restorable_versions(ctx, article_id)}:
            raise EditorialError("過去に承認された版だけを復元できます")
        return _create(ctx, actor, art, ver, list(acknowledged), "restore", None)
