"""Admin screens and actions."""

from __future__ import annotations

import secrets
import traceback
from datetime import timedelta
from typing import Callable, Optional

from jinja2 import Environment, FileSystemLoader, select_autoescape

from .. import (amazon_api, approvals, articles, assets as assets_mod, auth, bridge, checks, content as content_mod,
                db, drafts, importer, imagemeta, jobs, markup, policy, polish, products, publisher, render,
                review_refs, settings, timeutil)
from ..config import PACKAGE_ROOT
from ..core import Actor, ConflictError, Ctx, EditorialError, GateError
from .app import PRELOGIN_COOKIE, SESSION_COOKIE, App, Request, Response, redirect

_env: Optional[Environment] = None


def admin_env() -> Environment:
    global _env
    if _env is None:
        e = Environment(loader=FileSystemLoader(str(PACKAGE_ROOT / "templates")),
                        autoescape=select_autoescape(["html"]), trim_blocks=True, lstrip_blocks=True)
        e.filters["jst"] = timeutil.jst_label
        e.filters["jst_date"] = timeutil.jst_date_label
        e.filters["jst_input"] = timeutil.jst_input_value
        e.filters["md"] = markup.to_html
        e.globals.update({
            "STATE_LABELS": articles.STATE_LABELS, "PUBLICATION_LABELS": articles.PUBLICATION_LABELS,
            "AUTHOR_LABELS": articles.AUTHOR_LABELS, "KIND_LABELS": articles.KIND_LABELS,
            "ASSET_KIND_LABELS": assets_mod.KIND_LABELS, "RIGHTS_LABELS": assets_mod.RIGHTS_LABELS,
            "QUALITY_LABELS": assets_mod.QUALITY_LABELS, "NOTE_KINDS": products.NOTE_KINDS,
            "NOTE_ORIGINS": products.NOTE_ORIGINS, "CONTENT_BASIS": content_mod.CONTENT_BASIS,
            "RELATIONSHIP": content_mod.RELATIONSHIP, "EVIDENCE_KINDS": content_mod.EVIDENCE_KINDS,
            "JOB_ACTIONS": jobs.ACTION_LABELS, "JOB_STATUS": jobs.STATUS_LABELS,
            "POLICY_SOURCES": policy.SOURCES,
        })
        _env = e
    return _env


def actor(req: Request) -> Actor:
    return Actor("user", req.user)


def page(ctx: Ctx, req: Request, template: str, status: int = 200, **kw) -> Response:
    token = req.cookie(SESSION_COOKIE)
    flash = auth.pop_flash(ctx, token) if (token and req.session) else None
    counts = {
        "review": db.scalar(ctx.conn, "SELECT COUNT(*) FROM articles WHERE state IN ('review','changes')"),
        "holds": db.scalar(ctx.conn, "SELECT COUNT(*) FROM holds WHERE resolved_at IS NULL"),
        "failed": db.scalar(ctx.conn, "SELECT COUNT(*) FROM publish_jobs WHERE status = 'failed'"),
    }
    body = admin_env().get_template("admin/" + template).render(
        user=req.user, csrf=req.session["csrf_token"] if req.session else "", nonce=FreshNonce(),
        flash=flash, counts=counts, path=req.path, now=timeutil.now_iso(), **kw)
    return Response(body, status)


def flash(ctx: Ctx, req: Request, message: str) -> None:
    token = req.cookie(SESSION_COOKIE)
    if token:
        auth.set_flash(ctx, token, message)


def act(ctx: Ctx, req: Request, name: str, fn: Callable[[], Optional[str]], back: str,
        success: str = "保存しました") -> Response:
    """Run a state-changing action once per form token.

    A resent or double-clicked form finds its token already used and is sent
    to the same result page instead of running the action again.
    """
    nonce = req.get("_nonce")
    try:
        previous = auth.claim_nonce(ctx, req.session["user_id"], nonce, name)
    except EditorialError as exc:
        flash(ctx, req, "⚠ " + str(exc))
        return redirect(back)
    if previous is not None:
        flash(ctx, req, "この操作は既に受け付けています（二重送信を無視しました）")
        return redirect(previous.get("redirect") or back)
    try:
        target = fn() or back
    except _Pending as exc:
        auth.store_nonce_result(ctx, nonce, {"redirect": back})
        flash(ctx, req, str(exc))
        return redirect(back)
    except GateError as exc:
        auth.release_nonce(ctx, nonce)
        flash(ctx, req, "⚠ %s\n%s" % (exc, "\n".join("・" + p.message for p in exc.problems)))
        return redirect(back)
    except EditorialError as exc:
        auth.release_nonce(ctx, nonce)
        flash(ctx, req, "⚠ " + str(exc))
        return redirect(back)
    except Exception:
        # Unexpected failure: the action may not have run, so let the owner retry.
        traceback.print_exc()
        auth.release_nonce(ctx, nonce)
        flash(ctx, req, "⚠ 予期しないエラーで操作が完了しませんでした。状態を確認してからやり直してください。")
        return redirect(back)
    auth.store_nonce_result(ctx, nonce, {"redirect": target})
    if success:
        flash(ctx, req, success)
    return redirect(target)


class _Pending(Exception):
    """The action was accepted but its job has not run yet."""


class FreshNonce:
    """Renders a new one-time form token wherever it is printed (one per form)."""

    def __str__(self) -> str:
        return auth.new_nonce()

    def __html__(self) -> str:
        return str(self)


def _int(value, default=None):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_next(value: str) -> str:
    if value and value.startswith("/") and not value.startswith("//") and "\\" not in value:
        return value
    return "/"


# ---------------------------------------------------------------- editor form

def parse_editor_form(req: Request, kind: str) -> dict:
    keys = req.getlist("sec_key")
    heads = req.getlist("sec_heading")
    bodies = req.getlist("sec_body")
    standard = {k for k, _ in (content_mod.PAGE_SECTIONS if kind == "page" else content_mod.PRODUCT_SECTIONS)}
    sections = []
    for i in range(max(len(keys), len(heads), len(bodies))):
        key = (keys[i] if i < len(keys) else "").strip()
        heading = heads[i] if i < len(heads) else ""
        body = bodies[i] if i < len(bodies) else ""
        if key not in standard and not heading.strip() and not body.strip():
            continue
        if not key:
            key = "x" + secrets.token_hex(3)
        sections.append({"key": key, "heading": heading, "body": body})

    images = []
    removed = set(req.getlist("img_remove"))
    ids = req.getlist("img_asset")
    orders = req.getlist("img_order")
    alts = req.getlist("img_alt")
    caps = req.getlist("img_caption")
    crops = {k: req.getlist("img_crop_" + k) for k in ("x", "y", "w", "h")}
    rows = []
    for i, aid in enumerate(ids):
        if aid in removed:
            continue
        crop = None
        vals = [crops[k][i] if i < len(crops[k]) else "" for k in ("x", "y", "w", "h")]
        if any(v.strip() for v in vals):
            try:
                crop = dict(zip(("x", "y", "w", "h"), [float(v) for v in vals]))
            except ValueError:
                raise EditorialError("トリミングの数値が正しくありません")
        rows.append((_int(orders[i] if i < len(orders) else None, i + 1), i, {
            "asset_id": _int(aid), "alt": alts[i] if i < len(alts) else "",
            "caption": caps[i] if i < len(caps) else "", "crop": crop}))
    for j, aid in enumerate(req.getlist("img_add")):
        if aid and aid not in ids:
            rows.append((10_000 + j, 10_000 + j, {"asset_id": _int(aid), "alt": "", "caption": "", "crop": None}))
    rows.sort(key=lambda r: (r[0], r[1]))
    images = [r[2] for r in rows]

    on = set(req.getlist("card_on"))
    with_img = set(req.getlist("card_img"))
    cards = []
    for asin, name in zip(req.getlist("card_asin"), req.getlist("card_name")):
        if asin in on:
            cards.append({"asin": asin, "show_image": asin in with_img, "name": name})

    evidence = []
    for k, claim, source, checked in zip(req.getlist("ev_kind"), req.getlist("ev_claim"),
                                         req.getlist("ev_source"), req.getlist("ev_checked")):
        if claim.strip() or source.strip():
            evidence.append({"kind": k, "claim": claim, "source": source, "checked_on": checked})

    return {
        "title": req.get("title"), "summary": req.get("summary"), "sections": sections, "images": images,
        "amazon_cards": cards, "evidence": evidence, "content_basis": req.get("content_basis") or "research",
        "relationship": req.get("relationship") or "none", "relationship_note": req.get("relationship_note"),
        "info_checked_on": req.get("info_checked_on"),
    }


# ---------------------------------------------------------------- registration

def register(app: App) -> None:
    ctx = app.ctx
    from . import mcp
    mcp.register(app, ctx)

    # ---------------- auth
    @app.route("GET", "/login", public=True)
    def login_form(req: Request):
        token = secrets.token_urlsafe(24)
        resp = Response(admin_env().get_template("admin/login.html").render(
            prelogin=token, next=_safe_next(req.get("next")), error=None))
        resp.set_cookie(PRELOGIN_COOKIE, token, max_age=1800, secure=req.secure)
        return resp

    @app.route("POST", "/login", public=True)
    def login_post(req: Request):
        cookie = req.cookie(PRELOGIN_COOKIE) or ""
        nxt = _safe_next(req.get("next"))
        if not cookie or not secrets.compare_digest(cookie, req.get("_prelogin")):
            return Response("画面を開き直してからログインしてください", 403, "text/plain; charset=utf-8")
        try:
            token, _csrf = auth.login(ctx, req.get("username"), req.get("password"), req.remote_addr)
        except auth.AuthError as exc:
            fresh = secrets.token_urlsafe(24)
            resp = Response(admin_env().get_template("admin/login.html").render(
                prelogin=fresh, next=nxt, error=str(exc)), 401)
            resp.set_cookie(PRELOGIN_COOKIE, fresh, max_age=1800, secure=req.secure)
            return resp
        resp = redirect(nxt)
        resp.set_cookie(SESSION_COOKIE, token, max_age=ctx.config.admin.session_max_days * 86400,
                        secure=req.secure or ctx.config.admin.secure_cookies)
        resp.set_cookie(PRELOGIN_COOKIE, "", max_age=0)
        return resp

    @app.route("POST", "/logout")
    def logout(req: Request):
        auth.logout(ctx, req.cookie(SESSION_COOKIE))
        resp = redirect("/login")
        resp.set_cookie(SESSION_COOKIE, "", max_age=0)
        return resp

    # ---------------- dashboard
    @app.route("GET", "/")
    def dashboard(req: Request):
        s = settings.get_all(ctx)
        by_state = {r["state"]: r["n"] for r in db.all_rows(
            ctx.conn, "SELECT state, COUNT(*) AS n FROM articles GROUP BY state")}
        live = db.scalar(ctx.conn, "SELECT COUNT(*) FROM articles WHERE publication_status='live'")
        soon = timeutil.iso(timeutil.now() + timedelta(days=30))
        expiring = db.all_rows(ctx.conn, "SELECT * FROM assets WHERE rights_status='verified' AND license_expires_at "
                               "IS NOT NULL AND license_expires_at <= ? ORDER BY license_expires_at", (soon,))
        scheduled = db.all_rows(ctx.conn, "SELECT j.*, a.slug FROM publish_jobs j JOIN articles a ON a.id = j.article_id "
                                "WHERE j.status = 'scheduled' ORDER BY j.run_at")
        failed = db.all_rows(ctx.conn, "SELECT * FROM publish_jobs WHERE status='failed' ORDER BY id DESC LIMIT 10")
        policy_due = [p for p in policy.overview(ctx, int(s["policy_review_max_age_days"])) if p["status"] != "確認済み"]
        live_asins = amazon_api.asins_in_use(ctx)
        stale = [a for a in live_asins if not amazon_api.is_fresh(amazon_api.get_item(ctx, a))]
        setup = []
        if s["operator_name"] == settings.PLACEHOLDER_OPERATOR:
            setup.append("運営者名が未設定です")
        if not s["base_url"]:
            setup.append("公開URLが未設定です（ドメイン未決定なら仮のURLで試作できます）")
        if not s["contact"]:
            setup.append("問い合わせ方法が未設定です")
        if not ctx.config.source_roots:
            setup.append("取り込み元（O/R/S）が設定されていません")
        if not ctx.amazon.configured:
            setup.append("Creators API は未設定です（商品画像・星評価は表示されず、テキストリンクのみになります）")
        if not getattr(ctx.polisher, "available", lambda: True)():
            setup.append("%s（%s）が見つかりません" % (ctx.config.polish.tool_name, ctx.config.polish.command[0]))
        return page(ctx, req, "dashboard.html", by_state=by_state, live=live, expiring=expiring,
                    scheduled=scheduled, failed=failed, policy_due=policy_due, stale=stale,
                    live_asins=live_asins, setup=setup,
                    queue=articles.list_articles(ctx, states=["review", "changes", "error"]))

    # ---------------- products
    @app.route("GET", "/products")
    def product_list(req: Request):
        rows = products.list_products(ctx, q=req.get("q"), article_state=req.get("state"),
                                      rights=req.get("rights"), status=req.get("status"))
        return page(ctx, req, "products.html", rows=rows, f={k: req.get(k) for k in ("q", "state", "rights", "status")})

    @app.route("POST", "/products/new")
    def product_new(req: Request):
        holder = {}

        def run():
            holder["id"] = products.create(ctx, actor(req), req.get("name"), asin=req.get("asin") or None,
                                           legacy_id=req.get("legacy_id") or None)
            return "/products/%d" % holder["id"]
        return act(ctx, req, "product_new", run, "/products", "商品を登録しました")

    @app.route("GET", "/products/<pid>")
    def product_detail(req: Request, pid: int):
        p = products.get(ctx, pid)
        asset_rows = []
        for a in assets_mod.for_product(ctx, pid):
            asset_rows.append({"a": a, "problems": assets_mod.rights_problems(ctx, a)})
        records = db.all_rows(ctx.conn, "SELECT * FROM source_records WHERE product_id = ? AND current = 1 ORDER BY kind",
                              (pid,))
        show_reviews = req.get("reviews") == "1"
        return page(ctx, req, "product.html", p=p, notes=products.notes(ctx, pid), assets=asset_rows,
                    arts=products.articles_for_product(ctx, pid),
                    records=[dict(r, data=db.loads(r["data_json"], {})) for r in records],
                    review_count=review_refs.count_for_product(ctx, pid),
                    reviews=review_refs.for_product(ctx, pid) if show_reviews else [],
                    item=amazon_api.get_item(ctx, p["asin"]) if p["asin"] else None,
                    holds=db.all_rows(ctx.conn, "SELECT * FROM holds WHERE entity_key LIKE ? AND resolved_at IS NULL",
                                      ((p["asin"] or "-") + "%",)))

    @app.route("POST", "/products/<pid>/update")
    def product_update(req: Request, pid: int):
        def run():
            products.update(ctx, actor(req), pid, name=req.get("name"), legacy_id=req.get("legacy_id"),
                            asin=req.get("asin"), selection_note=req.get("selection_note"),
                            manuscript_cleared_for_ai=req.get("manuscript_cleared_for_ai") == "1")
        return act(ctx, req, "product_update", run, "/products/%d" % pid)

    @app.route("POST", "/products/<pid>/verify-asin")
    def product_verify(req: Request, pid: int):
        return act(ctx, req, "verify_asin", lambda: products.verify_asin(ctx, actor(req), pid, req.get("evidence")),
                   "/products/%d" % pid, "ASINの対応を確認済みにしました")

    @app.route("POST", "/products/<pid>/status")
    def product_status(req: Request, pid: int):
        return act(ctx, req, "product_status",
                   lambda: products.set_status(ctx, actor(req), pid, req.get("status"), req.get("reason")),
                   "/products/%d" % pid)

    @app.route("POST", "/products/<pid>/notes")
    def note_add(req: Request, pid: int):
        def run():
            products.add_note(ctx, actor(req), pid, req.get("kind"), req.get("origin"), req.get("body"),
                              source_url=req.get("source_url"), checked_on=req.get("checked_on") or None,
                              ai_input_ok=req.get("ai_input_ok") == "1")
        return act(ctx, req, "note_add", run, "/products/%d#notes" % pid, "調査メモを追加しました")

    @app.route("POST", "/notes/<nid>/ai")
    def note_ai(req: Request, nid: int):
        note = db.one(ctx.conn, "SELECT * FROM product_notes WHERE id = ?", (nid,))
        back = "/products/%d#notes" % (note["product_id"] if note else 0)
        return act(ctx, req, "note_ai", lambda: products.set_note_ai(ctx, actor(req), nid, req.get("value") == "1"), back)

    @app.route("POST", "/notes/<nid>/archive")
    def note_archive(req: Request, nid: int):
        note = db.one(ctx.conn, "SELECT * FROM product_notes WHERE id = ?", (nid,))
        back = "/products/%d#notes" % (note["product_id"] if note else 0)
        return act(ctx, req, "note_archive", lambda: products.archive_note(ctx, actor(req), nid), back)

    @app.route("POST", "/products/<pid>/assets")
    def asset_upload(req: Request, pid: int):
        def run():
            files = req.files.get("file") or []
            if not files or not files[0][1]:
                raise EditorialError("画像ファイルを選んでください")
            kind = req.get("kind") or "unknown"
            if kind in ("reference_photo",):
                raise EditorialError("参照用写真はアップロードではなく取り込みで登録します")
            aid = assets_mod.create(ctx, actor(req), pid, kind, files[0][1], title=req.get("title") or files[0][0])
            return "/assets/%d" % aid
        return act(ctx, req, "asset_upload", run, "/products/%d" % pid,
                   "素材を登録しました（権利は未確認です。確認して記録してください）")

    @app.route("POST", "/products/<pid>/articles")
    def product_article(req: Request, pid: int):
        def run():
            p = products.get(ctx, pid)
            initial = content_mod.empty("product")
            initial["title"] = p["name"]
            if p["asin"]:
                initial["amazon_cards"] = [{"asin": p["asin"], "show_image": True}]
            aid = articles.create(ctx, actor(req), "product", req.get("slug") or "item-%d" % pid, [pid], initial)
            return "/articles/%d" % aid
        return act(ctx, req, "article_new", run, "/products/%d" % pid, "記事の下書きを作りました")

    # ---------------- assets
    @app.route("GET", "/assets/<aid>")
    def asset_detail(req: Request, aid: int):
        a = assets_mod.get(ctx, aid)
        parent = assets_mod.get(ctx, a["parent_asset_id"]) if a["parent_asset_id"] else None
        refs = db.all_rows(ctx.conn, "SELECT * FROM assets WHERE product_id IS ? AND kind = 'reference_photo' AND id != ?",
                           (a["product_id"], aid))
        children = db.all_rows(ctx.conn, "SELECT * FROM assets WHERE parent_asset_id = ?", (aid,))
        siblings = db.all_rows(ctx.conn, "SELECT id, title, kind FROM assets WHERE product_id IS ? AND id != ? ORDER BY id",
                               (a["product_id"], aid))
        history = db.all_rows(ctx.conn, "SELECT * FROM events WHERE entity_type='asset' AND entity_id = ? ORDER BY id DESC",
                              (str(aid),))
        return page(ctx, req, "asset.html", a=a, parent=parent, refs=refs, children=children, siblings=siblings,
                    rights_problems=assets_mod.rights_problems(ctx, a), file_problems=assets_mod.file_problems(ctx, a),
                    ai_problems=assets_mod.ai_input_problems(ctx, a),
                    steps=db.loads(a["processing_history"], []), history=history,
                    used_in=articles.articles_using_asset(ctx, aid))

    @app.route("GET", "/assets/<aid>/file")
    def asset_file(req: Request, aid: int):
        a = assets_mod.get(ctx, aid)
        try:
            data = assets_mod.read_bytes(ctx, a)
        except (OSError, EditorialError):
            return Response("ファイルを読めません（取り込み元に接続されていない可能性があります）", 404,
                            "text/plain; charset=utf-8")
        mime = imagemeta.sniff(data) or "application/octet-stream"
        resp = Response(data, 200, mime)
        resp.headers.append(("Content-Disposition", "inline"))
        return resp

    @app.route("POST", "/assets/<aid>/rights")
    def asset_rights(req: Request, aid: int):
        fields = {k: req.get(k) for k in assets_mod.RIGHTS_FIELDS if k in req.form}
        for flag in ("has_people", "has_third_party_work", "derived_from_amazon", "is_fictional_scene"):
            fields[flag] = "1" if req.get(flag) == "1" else "0"
        return act(ctx, req, "asset_rights", lambda: assets_mod.update_rights(ctx, actor(req), aid, fields),
                   "/assets/%d" % aid, "権利情報を保存しました")

    @app.route("POST", "/assets/<aid>/quality")
    def asset_quality(req: Request, aid: int):
        return act(ctx, req, "asset_quality",
                   lambda: assets_mod.update_quality(ctx, actor(req), aid, req.get("verdict"), req.get("note")),
                   "/assets/%d" % aid, "品質判定を保存しました")

    @app.route("POST", "/assets/<aid>/history")
    def asset_history(req: Request, aid: int):
        return act(ctx, req, "asset_history",
                   lambda: assets_mod.add_processing_step(ctx, actor(req), aid, req.get("step")),
                   "/assets/%d" % aid, "加工履歴を追加しました")

    # ---------------- queue / articles
    @app.route("GET", "/queue")
    def queue(req: Request):
        groups = []
        for label, states in (("確認待ち・修正待ち", ["review", "changes"]), ("下書き", ["draft"]),
                              ("承認済み・予約済み", ["approved", "scheduled"]), ("公開エラー", ["error"]),
                              ("公開済み", ["published"]), ("不採用・保管", ["rejected", "archived"])):
            groups.append((label, articles.list_articles(ctx, states=states)))
        return page(ctx, req, "queue.html", groups=groups)

    @app.route("GET", "/articles/new")
    def article_new_form(req: Request):
        return page(ctx, req, "article_new.html", plist=products.list_products(ctx))

    @app.route("POST", "/articles/new")
    def article_new(req: Request):
        def run():
            kind = req.get("kind")
            pids = [int(x) for x in req.getlist("product_ids") if x.isdigit()]
            initial = content_mod.empty(kind if kind in ("product", "comparison", "page") else "product")
            initial["title"] = req.get("title")
            cards = []
            for pid in pids:
                p = products.get(ctx, pid)
                if p["asin"]:
                    cards.append({"asin": p["asin"], "show_image": True})
            initial["amazon_cards"] = cards
            aid = articles.create(ctx, actor(req), kind, req.get("slug"), pids, initial)
            return "/articles/%d" % aid
        return act(ctx, req, "article_new", run, "/articles/new", "記事の下書きを作りました")

    def editor(req: Request, aid: int, posted: Optional[dict] = None, conflict: Optional[dict] = None,
               status: int = 200) -> Response:
        art = articles.get(ctx, aid)
        hv = articles.version(ctx, art["head_version_id"])
        content = posted or articles.version_content(hv)
        plist = products.products_for_article(ctx, aid)
        candidates = []
        chosen = {img["asset_id"] for img in content["images"]}
        for p in plist:
            for a in assets_mod.for_product(ctx, p["id"]):
                if a["kind"] == "reference_photo":
                    continue
                candidates.append({"a": a, "problems": assets_mod.selection_problems(ctx, a),
                                   "chosen": a["id"] in chosen})
        asset_info = {c["a"]["id"]: c for c in candidates}
        purpose = "approve" if art["state"] == "review" else "preview"
        report = checks.evaluate(ctx, aid, hv["id"], purpose=purpose)
        if purpose == "preview":
            report.blocks = [b for b in report.blocks if b.code not in ("state", "stale")]
        items = {p["asin"]: amazon_api.get_item(ctx, p["asin"]) for p in plist if p["asin"]}
        fresh = {k: amazon_api.is_fresh(v) for k, v in items.items()}
        card_by_asin = {c["asin"]: c for c in content["amazon_cards"]}
        show_reviews = req.get("reviews") == "1"
        refs = []
        if show_reviews:
            for p in plist:
                refs += list(review_refs.for_product(ctx, p["id"], limit=100))
        pending_job = jobs.pending_publish_job(ctx, aid)
        sections = list(content["sections"])
        sections.append({"key": "", "heading": "", "body": ""})
        evidence = list(content["evidence"]) + [{"kind": "maker_official", "claim": "", "source": "", "checked_on": ""}] * 2
        return page(ctx, req, "article.html", status=status, art=art, hv=hv, content=content, sections=sections,
                    evidence=evidence, plist=plist, candidates=candidates, asset_info=asset_info, report=report,
                    items=items, fresh=fresh, card_by_asin=card_by_asin,
                    versions=articles.versions(ctx, aid), proposals=articles.open_proposals(ctx, aid),
                    comments=articles.comments(ctx, aid), approvals_hist=approvals.history(ctx, aid),
                    jobs_hist=db.all_rows(ctx.conn, "SELECT * FROM publish_jobs WHERE article_id = ? ORDER BY id DESC "
                                          "LIMIT 20", (aid,)),
                    publog=db.all_rows(ctx.conn, "SELECT * FROM publication_log WHERE article_id = ? ORDER BY id DESC",
                                       (aid,)),
                    polish_runs=polish.runs(ctx, aid), polished=polish.is_polished(ctx, aid, hv),
                    polish_available=getattr(ctx.polisher, "available", lambda: True)(),
                    polish_tool=ctx.config.polish.tool_name,
                    restorable=[{"v": v, "report": checks.evaluate(ctx, aid, v["id"], purpose="restore")}
                                for v in approvals.restorable_versions(ctx, aid)
                                if v["id"] != art["live_version_id"]],
                    pending_job=pending_job,
                    queue_list=articles.list_articles(ctx, states=["review", "changes", "draft", "error", "approved",
                                                                   "scheduled"]),
                    show_reviews=show_reviews, review_refs=refs,
                    review_count=sum(review_refs.count_for_product(ctx, p["id"]) for p in plist),
                    conflict=conflict, unsaved=posted is not None,
                    open_requests=articles.open_change_requests(ctx, aid),
                    url=render.absolute(settings.publish_context(ctx), render.article_path(art["kind"], art["slug"])))

    @app.route("GET", "/articles/<aid>")
    def article_detail(req: Request, aid: int):
        return editor(req, aid)

    @app.route("POST", "/articles/<aid>/save")
    def article_save(req: Request, aid: int):
        art = articles.get(ctx, aid)
        base_id = _int(req.get("base_version_id"))
        nonce = req.get("_nonce")
        try:
            previous = auth.claim_nonce(ctx, req.session["user_id"], nonce, "article_save")
        except EditorialError as exc:
            flash(ctx, req, "⚠ " + str(exc))
            return redirect("/articles/%d" % aid)
        if previous is not None:
            flash(ctx, req, "この保存は既に受け付けています（二重送信を無視しました）")
            return redirect(previous.get("redirect") or "/articles/%d" % aid)
        try:
            raw = parse_editor_form(req, art["kind"])
            articles.save(ctx, actor(req), aid, base_id, raw, author_kind="human",
                          note=(req.get("note") or "").strip() or None)
        except ConflictError as exc:
            auth.release_nonce(ctx, nonce)
            head = articles.head(ctx, aid)
            diff = articles.diff_versions(ctx, base_id, head["id"]) if base_id else []
            try:
                posted = content_mod.normalize(raw, art["kind"])
            except EditorialError:
                posted = raw
            return editor(req, aid, posted=posted, conflict={"message": str(exc), "diff": diff, "base_id": base_id},
                          status=409)
        except Exception as exc:
            auth.release_nonce(ctx, nonce)
            if not isinstance(exc, EditorialError):
                traceback.print_exc()
                flash(ctx, req, "⚠ 予期しないエラーで保存できませんでした。もう一度お試しください。")
                return redirect("/articles/%d" % aid)
            try:
                posted = content_mod.normalize(raw, art["kind"]) if "raw" in locals() else None
            except EditorialError:
                posted = None
            if posted is not None:
                return editor(req, aid, posted=posted, conflict={"message": "⚠ " + str(exc), "diff": [],
                                                                 "base_id": base_id, "validation": True}, status=422)
            flash(ctx, req, "⚠ " + str(exc))
            return redirect("/articles/%d" % aid)
        target = "/articles/%d" % aid
        auth.store_nonce_result(ctx, nonce, {"redirect": target})
        flash(ctx, req, "保存しました（新しい版を作りました）")
        return redirect(target)

    def article_action(name: str, fn, success: str, anchor: str = ""):
        def handler(req: Request, aid: int):
            return act(ctx, req, name, lambda: fn(req, aid), "/articles/%d%s" % (aid, anchor), success)
        return handler

    def _run_job_now(job_id: int) -> Optional[str]:
        """Run due jobs and report on this job only (others are listed on the jobs page)."""
        results = jobs.run_due(ctx)
        mine = next((r for r in results if r.get("job_id") == job_id), None)
        if mine is None or mine.get("status") == "busy":
            raise _Pending("別の公開処理が実行中のため、この処理は待機しています（ジョブ#%d）。「公開ジョブ」で結果を確認してください。"
                           % job_id)
        if mine["status"] == "failed":
            raise EditorialError("公開処理に失敗しました: %s" % mine.get("error", ""))
        return None

    def do_polish(req, aid):
        result = polish.polish_article(ctx, actor(req), aid, _int(req.get("base_version_id")))
        if result["warnings"]:
            flash(ctx, req, "文章を整形しました。確認してほしい点:\n" + "\n".join("・" + w for w in result["warnings"]))
        return None

    def do_approve(req, aid):
        approvals.approve(ctx, actor(req), aid, _int(req.get("version_id")), req.getlist("ack"))

    def do_schedule(req, aid):
        when = timeutil.parse_jst_local(req.get("run_at"))
        if when <= timeutil.now():
            raise EditorialError("過去の日時は予約できません")
        jobs.enqueue_publish(ctx, actor(req), aid, _int(req.get("version_id")), run_at=timeutil.iso(when))

    def do_publish_now(req, aid):
        return _run_job_now(jobs.enqueue_publish(ctx, actor(req), aid, _int(req.get("version_id"))))

    def do_takedown(req, aid):
        return _run_job_now(jobs.enqueue_unpublish(ctx, actor(req), aid, req.get("reason")))

    def do_restore(req, aid):
        return _run_job_now(jobs.enqueue_restore(ctx, actor(req), aid, _int(req.get("version_id")),
                                                 req.getlist("ack")))

    def do_paste_draft(req, aid):
        draft = drafts.parse_markdown(req.get("draft"))
        if not (draft["title"] or draft["summary"] or draft["sections"]):
            raise EditorialError("貼り付けた文章からタイトル・見出しを読み取れませんでした")
        result = drafts.apply_draft(ctx, actor(req), draft, article_id=aid)
        if result["outcome"] == "proposal":
            flash(ctx, req, "ドラフトを「提案」として保存しました。内容を確認して採用してください。")
        return None

    routes = [
        ("paste-draft", do_paste_draft, "ドラフトを取り込みました"),
        ("polish", do_polish, "文章整形が完了しました（差分を確認してください）"),
        ("submit", lambda r, a: articles.submit_for_review(ctx, actor(r), a), "確認待ちにしました"),
        ("approve", do_approve, "この版を承認しました"),
        ("request-changes", lambda r, a: articles.request_changes(ctx, actor(r), a, r.get("body")), "差し戻しました"),
        ("reject", lambda r, a: articles.reject(ctx, actor(r), a, r.get("reason")), "不採用にしました"),
        ("revive", lambda r, a: articles.revive(ctx, actor(r), a) and None, "下書きとして作り直しました"),
        ("revoke", lambda r, a: approvals.revoke(ctx, actor(r), a), "承認を取り消しました"),
        ("schedule", do_schedule, "公開を予約しました"),
        ("cancel-schedule", lambda r, a: jobs.cancel_schedule(ctx, actor(r), a), "予約を取り消しました"),
        ("publish-now", do_publish_now, "公開しました"),
        ("takedown", do_takedown, "公開を取り下げました"),
        ("restore", do_restore, "過去の承認版を復元しました"),
        ("archive", lambda r, a: articles.archive(ctx, actor(r), a), "保管しました"),
        ("unarchive", lambda r, a: articles.unarchive(ctx, actor(r), a), "保管を解除しました"),
        ("comment", lambda r, a: articles.add_comment(ctx, actor(r), a, r.get("body")) and None, "コメントを追加しました"),
    ]
    for name, fn, msg in routes:
        app.route("POST", "/articles/<aid>/" + name)(article_action(name, fn, msg))

    @app.route("POST", "/proposals/<vid>/adopt")
    def proposal_adopt(req: Request, vid: int):
        prop = articles.version(ctx, vid)
        return act(ctx, req, "proposal_adopt",
                   lambda: articles.adopt_proposal(ctx, actor(req), vid, _int(req.get("base_version_id"))) and None,
                   "/articles/%d" % prop["article_id"], "提案を採用しました（新しい版になりました）")

    @app.route("POST", "/proposals/<vid>/dismiss")
    def proposal_dismiss(req: Request, vid: int):
        prop = articles.version(ctx, vid)
        return act(ctx, req, "proposal_dismiss", lambda: articles.dismiss_proposal(ctx, actor(req), vid),
                   "/articles/%d" % prop["article_id"], "提案を見送りました")

    @app.route("GET", "/articles/<aid>/preview")
    def article_preview(req: Request, aid: int):
        art = articles.get(ctx, aid)
        vid = _int(req.get("version")) or art["head_version_id"]
        ver = articles.version(ctx, vid)
        if ver["article_id"] != aid:
            return Response("Not Found", 404, "text/plain")
        html = render.render_article_html(ctx, aid, vid, preview=True)
        html = html.replace('href="/assets/site.css"', 'href="/static/site.css"').replace(
            'src="/assets/amzn-expiry.js"', 'src="/static/amzn-expiry.js"')
        resp = Response(html)
        resp.frame_ancestors = "'self'"
        return resp

    @app.route("GET", "/articles/<aid>/diff")
    def article_diff(req: Request, aid: int):
        art = articles.get(ctx, aid)
        vers = articles.versions(ctx, aid) + articles.versions(ctx, aid, track="proposal")
        b = _int(req.get("b")) or art["head_version_id"]
        default_a = articles.version(ctx, b)["base_version_id"] or b
        a = _int(req.get("a")) or default_a
        diff = articles.diff_versions(ctx, a, b)
        return page(ctx, req, "diff.html", art=art, vers=vers, a=articles.version(ctx, a), b=articles.version(ctx, b),
                    diff=diff, title=articles.version_content(articles.version(ctx, b))["title"])

    # ---------------- bulk approval
    @app.route("GET", "/approve-batch")
    def batch_form(req: Request):
        return page(ctx, req, "batch.html", c=approvals.bulk_candidates(ctx))

    @app.route("POST", "/approve-batch")
    def batch_post(req: Request):
        def run():
            items = []
            try:
                for raw in req.getlist("item"):
                    aid, vid, h = raw.split(":", 2)
                    items.append((int(aid), int(vid), h))
                shown = {}
                for raw in req.getlist("ack"):
                    aid, key = raw.split(":", 1)
                    shown.setdefault(int(aid), []).append(key)
            except ValueError:
                raise EditorialError("フォームの内容が正しくありません。一覧を開き直してください。")
            if req.get("confirm_count") != str(len(items)):
                raise EditorialError("確認した件数と選択件数が一致しません。もう一度確認してください。")
            if req.get("ack_all") != "1":
                raise EditorialError("注意事項を確認したことにチェックしてください")
            approvals.bulk_approve(ctx, actor(req), items, shown)
            return "/queue"
        return act(ctx, req, "bulk_approve", run, "/approve-batch", "まとめて承認しました")

    # ---------------- jobs
    @app.route("GET", "/jobs")
    def job_list(req: Request):
        return page(ctx, req, "jobs.html", rows=jobs.recent(ctx, 100),
                    builds=db.all_rows(ctx.conn, "SELECT * FROM builds ORDER BY created_at DESC LIMIT 10"),
                    live_build=publisher.current_build_id(ctx))

    @app.route("POST", "/jobs/<jid>/retry")
    def job_retry(req: Request, jid: int):
        def run():
            jobs.retry(ctx, actor(req), jid)
            jobs.run_due(ctx)
        return act(ctx, req, "job_retry", run, "/jobs", "再試行しました（結果は一覧で確認してください）")

    @app.route("POST", "/jobs/run")
    def job_run(req: Request):
        return act(ctx, req, "job_run", lambda: jobs.tick(ctx) and None, "/jobs", "実行時刻になったジョブを処理しました")

    @app.route("POST", "/jobs/refresh")
    def job_refresh(req: Request):
        def run():
            jobs.enqueue_refresh(ctx, actor(req), "手動の定期更新")
            jobs.run_due(ctx)
        return act(ctx, req, "job_refresh", run, "/jobs", "Amazonデータと許諾期限を更新し、サイトを作り直しました")

    # ---------------- holds / imports / events
    @app.route("GET", "/holds")
    def hold_list(req: Request):
        return page(ctx, req, "holds.html", rows=importer.holds(ctx, include_resolved=req.get("all") == "1"))

    @app.route("POST", "/holds/<hid>/resolve")
    def hold_resolve(req: Request, hid: int):
        return act(ctx, req, "hold_resolve", lambda: importer.resolve_hold(ctx, actor(req), hid, req.get("note")),
                   "/holds", "保留を解決済みにしました")

    @app.route("GET", "/imports")
    def import_list(req: Request):
        runs = [dict(r, summary=db.loads(r["summary_json"], {})) for r in
                db.all_rows(ctx.conn, "SELECT * FROM import_runs ORDER BY id DESC LIMIT 20")]
        files = db.all_rows(ctx.conn, "SELECT * FROM import_files ORDER BY updated_at DESC LIMIT 300")
        roots = {k: v.is_dir() for k, v in ctx.config.source_roots.items()}
        return page(ctx, req, "imports.html", runs=runs, files=files, roots=roots)

    @app.route("GET", "/events")
    def event_list(req: Request):
        sql = "SELECT * FROM events"
        params: list = []
        if req.get("entity"):
            sql += " WHERE entity_type = ?"
            params.append(req.get("entity"))
            if req.get("id"):
                sql += " AND entity_id = ?"
                params.append(req.get("id"))
        rows = db.all_rows(ctx.conn, sql + " ORDER BY id DESC LIMIT 300", params)
        return page(ctx, req, "events.html", rows=rows)

    # ---------------- settings / policy
    @app.route("GET", "/settings")
    def settings_form(req: Request):
        return page(ctx, req, "settings.html", s=settings.get_all(ctx), roots={k: v.is_dir() for k, v in
                                                                             ctx.config.source_roots.items()},
                    api=ctx.amazon.configured, polish_cfg=ctx.config.polish,
                    ai_tokens=auth.list_ai_tokens(ctx),
                    polish_available=getattr(ctx.polisher, "available", lambda: True)())

    @app.route("POST", "/settings")
    def settings_post(req: Request):
        def run():
            values = {k: req.get(k) for k in settings.DEFAULTS if k in req.form}
            changed = settings.set_many(ctx, actor(req), values)
            if any(k in settings.CONTEXT_KEYS for k in changed):
                flash(ctx, req, "設定を保存しました。公開表示に関わる設定が変わったため、未公開の承認と予約を無効にしました。")
        return act(ctx, req, "settings", run, "/settings", "")

    @app.route("GET", "/policy")
    def policy_page(req: Request):
        s = settings.get_all(ctx)
        hist = db.all_rows(ctx.conn, "SELECT * FROM policy_reviews ORDER BY id DESC LIMIT 100")
        return page(ctx, req, "policy.html", rows=policy.overview(ctx, int(s["policy_review_max_age_days"])),
                    hist=hist, today=timeutil.today_jst().isoformat(),
                    required=policy.required_keys(settings.publish_context(ctx), {"amazon_cards": [1]}))

    @app.route("POST", "/policy")
    def policy_post(req: Request):
        def run():
            keys = req.getlist("source_key")
            if not keys:
                raise EditorialError("確認した資料を選んでください")
            for key in keys:
                policy.record_review(ctx, actor(req), key, req.get("checked_on"), req.get("summary"),
                                     req.get("changes"), req.get("next_due") or None)
        return act(ctx, req, "policy", run, "/policy", "確認記録を保存しました")

    # ---------------- Claude hand-off from the browser
    @app.route("POST", "/bridge/export")
    def bridge_export(req: Request):
        def run():
            ids = [int(x) for x in req.getlist("article_id") if x.isdigit()] or None
            path = bridge.export_tasks(ctx, actor(req), ids)
            flash(ctx, req, "Claude向けの依頼ファイルを書き出しました: var/exports/%s" % path.name)
        return act(ctx, req, "bridge_export", run, "/queue", "")
