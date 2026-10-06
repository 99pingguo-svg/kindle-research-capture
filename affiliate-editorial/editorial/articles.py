"""Articles, immutable versions, workflow state and review comments."""

from __future__ import annotations

import difflib
from typing import Dict, List, Optional, Tuple

from . import assets as assets_mod
from . import content as content_mod
from . import db, products, timeutil
from .core import Actor, ConflictError, Ctx, EditorialError, record_event

STATE_LABELS = {
    "draft": "下書き",
    "review": "確認待ち",
    "changes": "修正待ち",
    "rejected": "不採用",
    "approved": "承認済み",
    "scheduled": "予約済み",
    "published": "公開済み",
    "error": "公開エラー",
    "archived": "保管",
}
PUBLICATION_LABELS = {"unpublished": "未公開", "live": "公開中", "withdrawn": "取り下げ済み"}
AUTHOR_LABELS = {"import": "元データ", "human": "本人", "claude": "Claudeの案", "polish": "文章整形",
                 "system": "システム"}
KIND_LABELS = {"product": "商品紹介", "comparison": "比較記事", "page": "固定ページ"}
# Paths the static build creates itself.
RESERVED_SLUGS = {"assets", "media", "items", "index", "404", "sitemap", "robots", "static", "admin", "mcp"}

# Saving a new version from these states keeps the state.
_KEEP_STATE_ON_SAVE = ("draft", "changes", "review")
# From these, a save invalidates the unpublished approval/schedule.
_REAPPROVE_ON_SAVE = ("approved", "scheduled", "error")


def get(ctx: Ctx, article_id: int):
    row = db.one(ctx.conn, "SELECT * FROM articles WHERE id = ?", (article_id,))
    if row is None:
        raise EditorialError("記事が見つかりません: %s" % article_id)
    return row


def get_by_slug(ctx: Ctx, slug: str):
    return db.one(ctx.conn, "SELECT * FROM articles WHERE slug = ?", (slug,))


def version(ctx: Ctx, version_id: int):
    row = db.one(ctx.conn, "SELECT * FROM article_versions WHERE id = ?", (version_id,))
    if row is None:
        raise EditorialError("版が見つかりません: %s" % version_id)
    return row


def version_content(row) -> dict:
    return db.loads(row["content_json"])


def head(ctx: Ctx, article_id: int):
    art = get(ctx, article_id)
    return version(ctx, art["head_version_id"]) if art["head_version_id"] else None


def versions(ctx: Ctx, article_id: int, track: str = "main") -> List:
    return db.all_rows(ctx.conn, "SELECT * FROM article_versions WHERE article_id = ? AND track = ? "
                       "ORDER BY version_no DESC", (article_id, track))


def open_proposals(ctx: Ctx, article_id: int) -> List:
    return db.all_rows(ctx.conn, "SELECT * FROM article_versions WHERE article_id = ? AND track = 'proposal' "
                       "AND proposal_status = 'open' ORDER BY id DESC", (article_id,))


def comments(ctx: Ctx, article_id: int) -> List:
    return db.all_rows(ctx.conn, "SELECT * FROM review_comments WHERE article_id = ? ORDER BY id DESC",
                       (article_id,))


def open_change_requests(ctx: Ctx, article_id: int) -> List:
    return db.all_rows(ctx.conn, "SELECT * FROM review_comments WHERE article_id = ? AND kind = 'change_request' "
                       "AND resolved_at IS NULL ORDER BY id", (article_id,))


# ---------------------------------------------------------------- creation

def create(ctx: Ctx, actor: Actor, kind: str, slug: str, product_ids: List[int],
           initial_content: Optional[dict] = None, author_kind: str = "human",
           note: Optional[str] = None) -> int:
    if kind not in KIND_LABELS:
        raise EditorialError("記事の種類が不正です")
    slug = (slug or "").strip().lower()
    if not content_mod.SLUG_RE.match(slug):
        raise EditorialError("URL名（slug）は半角英小文字・数字・ハイフンで指定してください")
    if slug in RESERVED_SLUGS:
        raise EditorialError("「%s」はサイトの仕組みで使う名前のため、URL名にできません" % slug)
    if kind == "page" and product_ids:
        raise EditorialError("固定ページには商品を紐付けません")
    if kind == "product" and len(product_ids) != 1:
        raise EditorialError("商品紹介記事は1商品に紐付けてください")
    if kind == "comparison" and len(product_ids) < 2:
        raise EditorialError("比較記事は2商品以上を選んでください")
    for pid in product_ids:
        products.get(ctx, pid)
    raw = initial_content or content_mod.empty(kind)
    now = timeutil.now_iso()
    with db.tx(ctx.conn):
        if get_by_slug(ctx, slug):
            raise EditorialError("同じURL名の記事があります: %s" % slug)
        art_id = db.insert(ctx.conn, "articles", {
            "kind": kind, "slug": slug, "state": "draft", "created_at": now, "updated_at": now})
        for pos, pid in enumerate(product_ids):
            db.insert(ctx.conn, "article_products", {"article_id": art_id, "product_id": pid, "position": pos})
        record_event(ctx, actor, "article", art_id, "created", {"kind": kind, "slug": slug,
                                                                 "product_ids": product_ids})
        _insert_main_version(ctx, actor, art_id, None, raw, author_kind, note or "作成")
    return art_id


def _insert_main_version(ctx: Ctx, actor: Actor, article_id: int, base_version_id: Optional[int],
                         raw: dict, author_kind: str, note: Optional[str],
                         polish_run_id: Optional[int] = None, adopted_from_id: Optional[int] = None,
                         prepared: bool = False) -> int:
    if prepared:
        content = raw
    else:
        art = get(ctx, article_id)
        base = version_content(version(ctx, base_version_id)) if base_version_id else None
        content = prepare_content(ctx, art, raw, base)
    next_no = (db.scalar(ctx.conn, "SELECT MAX(version_no) FROM article_versions WHERE article_id = ? "
                         "AND track = 'main'", (article_id,)) or 0) + 1
    vid = db.insert(ctx.conn, "article_versions", {
        "article_id": article_id, "track": "main", "version_no": next_no,
        "base_version_id": base_version_id, "author_kind": author_kind, "author": actor.name,
        "content_json": db.dumps(content), "content_hash": content_mod.content_hash(content),
        "text_fingerprint": content_mod.text_fingerprint(content), "polish_run_id": polish_run_id,
        "adopted_from_id": adopted_from_id, "note": note, "created_at": timeutil.now_iso(),
    })
    db.update(ctx.conn, "articles", "id", article_id, {"head_version_id": vid, "updated_at": timeutil.now_iso()})
    record_event(ctx, actor, "article", article_id, "version_created",
                 {"version_id": vid, "version_no": next_no, "author_kind": author_kind, "note": note})
    return vid


def prepare_content(ctx: Ctx, art, raw: dict, base: Optional[dict]) -> dict:
    """Normalise content and enforce selection rules for images and cards."""
    content = content_mod.normalize(raw, art["kind"])
    allowed_products = products.product_ids_for_article(ctx, art["id"])
    names_by_asin = {p["asin"]: p["name"] for p in products.products_for_article(ctx, art["id"]) if p["asin"]}
    allowed_asins = set(names_by_asin)
    base_images = {img["asset_id"]: img for img in (base or {}).get("images", [])}
    for img in content["images"]:
        asset = assets_mod.get(ctx, img["asset_id"])
        if asset["product_id"] is not None and asset["product_id"] not in allowed_products:
            raise EditorialError("素材#%d はこの記事の商品の素材ではありません" % asset["id"])
        img["sha256"] = asset["sha256"]
        prev = base_images.get(img["asset_id"])
        is_new = prev is None or prev.get("sha256") != asset["sha256"]
        crop_changed = (prev or {}).get("crop") != img["crop"]
        if is_new:
            problems = assets_mod.selection_problems(ctx, asset, img["crop"])
            if problems:
                raise EditorialError("素材#%d は選べません: %s" % (asset["id"], "／".join(problems)))
        elif crop_changed and img["crop"] and asset["modification_ok"] != 1:
            raise EditorialError("素材#%d は加工許可がないためトリミングできません" % asset["id"])
    if art["kind"] == "page" and content["amazon_cards"]:
        raise EditorialError("固定ページに商品カードは置けません")
    for card in content["amazon_cards"]:
        if card["asin"] not in allowed_asins:
            raise EditorialError("ASIN %s はこの記事の商品ではありません" % card["asin"])
        if not card["name"]:
            card["name"] = names_by_asin[card["asin"]]
    return content


# ---------------------------------------------------------------- saving

def save(ctx: Ctx, actor: Actor, article_id: int, base_version_id: int, raw: dict,
         author_kind: str = "human", note: Optional[str] = None,
         polish_run_id: Optional[int] = None, adopted_from_id: Optional[int] = None) -> int:
    """Create a new main version.  Raises ConflictError if head moved."""
    with db.tx(ctx.conn):
        art = get(ctx, article_id)
        if art["state"] == "rejected":
            raise EditorialError("不採用の記事は「下書きとして作り直す」から再開してください")
        if art["state"] == "archived":
            raise EditorialError("保管中の記事は保管を解除してから編集してください")
        if art["head_version_id"] != base_version_id:
            raise ConflictError("この記事は別の画面で更新されています（最新は版%s）。内容を確認してから保存し直してください。"
                                % _version_no(ctx, art["head_version_id"]))
        current = version(ctx, base_version_id)
        new_content = prepare_content(ctx, art, raw, version_content(current))
        if content_mod.content_hash(new_content) == current["content_hash"]:
            return base_version_id
        vid = _insert_main_version(ctx, actor, article_id, base_version_id, new_content, author_kind, note,
                                   polish_run_id=polish_run_id, adopted_from_id=adopted_from_id, prepared=True)
        state = art["state"]
        if state in _REAPPROVE_ON_SAVE:
            from . import approvals
            approvals.invalidate_for_article(ctx, actor, article_id, "承認後に内容が変更されたため",
                                             to_state="review")
        elif state == "published":
            set_state(ctx, actor, article_id, "draft", "公開後の改訂を開始")
        return vid


def _version_no(ctx: Ctx, version_id: Optional[int]):
    if not version_id:
        return "-"
    return version(ctx, version_id)["version_no"]


def set_state(ctx: Ctx, actor: Actor, article_id: int, new_state: str, reason: Optional[str] = None,
              **extra) -> None:
    if new_state not in STATE_LABELS:
        raise EditorialError("状態が不正です")
    art = get(ctx, article_id)
    values = {"state": new_state, "updated_at": timeutil.now_iso()}
    values.update(extra)
    db.update(ctx.conn, "articles", "id", article_id, values)
    record_event(ctx, actor, "article", article_id, "state_changed",
                 {"from": art["state"], "to": new_state, "reason": reason})


# ---------------------------------------------------------------- workflow

def submit_for_review(ctx: Ctx, actor: Actor, article_id: int) -> None:
    with db.tx(ctx.conn):
        art = get(ctx, article_id)
        if art["state"] not in ("draft", "changes"):
            raise EditorialError("「%s」の記事は確認依頼できません" % STATE_LABELS[art["state"]])
        hv = version(ctx, art["head_version_id"])
        pending = open_change_requests(ctx, article_id)
        if art["state"] == "changes" and pending:
            # Each change request remembers the head it was written against.
            if any(r["version_id"] == hv["id"] for r in pending):
                raise EditorialError("修正指示の後に新しい版が作られていません")
            for r in pending:
                db.update(ctx.conn, "review_comments", "id", r["id"],
                          {"resolved_at": timeutil.now_iso(), "resolved_by_version_id": hv["id"]})
        set_state(ctx, actor, article_id, "review", "確認依頼")


def request_changes(ctx: Ctx, actor: Actor, article_id: int, body: str) -> None:
    body = (body or "").strip()
    if not body:
        raise EditorialError("修正指示の内容を入力してください")
    with db.tx(ctx.conn):
        art = get(ctx, article_id)
        if art["state"] not in ("review", "approved", "scheduled", "error", "draft"):
            raise EditorialError("「%s」の記事には差し戻しできません" % STATE_LABELS[art["state"]])
        if art["state"] in ("approved", "scheduled", "error"):
            from . import approvals
            approvals.invalidate_for_article(ctx, actor, article_id, "差し戻されたため", to_state=None)
        add_comment(ctx, actor, article_id, body, kind="change_request")
        set_state(ctx, actor, article_id, "changes", "差し戻し")


def reject(ctx: Ctx, actor: Actor, article_id: int, reason: str) -> None:
    reason = (reason or "").strip()
    if not reason:
        raise EditorialError("不採用の理由を入力してください")
    with db.tx(ctx.conn):
        art = get(ctx, article_id)
        if art["state"] not in ("draft", "review", "changes", "approved", "scheduled", "error"):
            raise EditorialError("「%s」の記事は不採用にできません" % STATE_LABELS[art["state"]])
        if art["state"] in ("approved", "scheduled", "error"):
            from . import approvals
            approvals.invalidate_for_article(ctx, actor, article_id, "不採用になったため", to_state=None)
        add_comment(ctx, actor, article_id, reason, kind="reject_reason")
        set_state(ctx, actor, article_id, "rejected", reason)


def revive(ctx: Ctx, actor: Actor, article_id: int) -> int:
    """Rejected → a fresh draft version (the rejected version stays in history)."""
    with db.tx(ctx.conn):
        art = get(ctx, article_id)
        if art["state"] != "rejected":
            raise EditorialError("不採用の記事だけが作り直せます")
        hv = version(ctx, art["head_version_id"])
        vid = _insert_main_version(ctx, actor, article_id, hv["id"], version_content(hv), "human",
                                   "不採用から下書きとして作り直し")
        set_state(ctx, actor, article_id, "draft", "作り直し")
        return vid


def archive(ctx: Ctx, actor: Actor, article_id: int) -> None:
    with db.tx(ctx.conn):
        art = get(ctx, article_id)
        if art["publication_status"] == "live":
            raise EditorialError("公開中の記事は先に取り下げてください")
        if art["state"] == "scheduled":
            raise EditorialError("予約を取り消してから保管してください")
        if art["state"] == "approved":
            from . import approvals
            approvals.invalidate_for_article(ctx, actor, article_id, "保管したため", to_state=None)
        set_state(ctx, actor, article_id, "archived", "保管")


def unarchive(ctx: Ctx, actor: Actor, article_id: int) -> None:
    with db.tx(ctx.conn):
        art = get(ctx, article_id)
        if art["state"] != "archived":
            raise EditorialError("保管中の記事ではありません")
        set_state(ctx, actor, article_id, "draft", "保管を解除")


def add_comment(ctx: Ctx, actor: Actor, article_id: int, body: str, kind: str = "comment") -> int:
    body = (body or "").strip()
    if not body:
        raise EditorialError("コメントが空です")
    art = get(ctx, article_id)
    cid = db.insert(ctx.conn, "review_comments", {
        "article_id": article_id, "version_id": art["head_version_id"], "author": actor.name,
        "kind": kind, "body": body, "created_at": timeutil.now_iso()})
    record_event(ctx, actor, "article", article_id, "comment_added", {"comment_id": cid, "kind": kind})
    return cid


def add_system_comment(ctx: Ctx, article_id: int, body: str) -> int:
    return add_comment(ctx, Actor.system(), article_id, body, kind="system")


# ---------------------------------------------------------------- proposals

def add_proposal(ctx: Ctx, actor: Actor, article_id: int, base_version_id: Optional[int], raw: dict,
                 author_kind: str, note: Optional[str] = None) -> int:
    """Store a Claude draft / import update without touching the main line."""
    if author_kind not in ("claude", "import", "polish"):
        raise EditorialError("提案の作成者が不正です")
    with db.tx(ctx.conn):
        art = get(ctx, article_id)
        base = version_content(version(ctx, base_version_id)) if base_version_id else None
        content = prepare_content(ctx, art, raw, base)
        next_no = (db.scalar(ctx.conn, "SELECT MAX(version_no) FROM article_versions WHERE article_id = ? "
                             "AND track = 'proposal'", (article_id,)) or 0) + 1
        vid = db.insert(ctx.conn, "article_versions", {
            "article_id": article_id, "track": "proposal", "version_no": next_no,
            "base_version_id": base_version_id, "author_kind": author_kind, "author": actor.name,
            "content_json": db.dumps(content), "content_hash": content_mod.content_hash(content),
            "text_fingerprint": content_mod.text_fingerprint(content), "note": note,
            "proposal_status": "open", "created_at": timeutil.now_iso(),
        })
        record_event(ctx, actor, "article", article_id, "proposal_added",
                     {"proposal_id": vid, "author_kind": author_kind, "base_version_id": base_version_id,
                      "stale": base_version_id != art["head_version_id"]})
        return vid


def adopt_proposal(ctx: Ctx, actor: Actor, proposal_id: int, base_version_id: int) -> int:
    with db.tx(ctx.conn):
        prop = version(ctx, proposal_id)
        if prop["track"] != "proposal" or prop["proposal_status"] != "open":
            raise EditorialError("採用できる提案ではありません")
        vid = save(ctx, actor, prop["article_id"], base_version_id, version_content(prop),
                   author_kind="human", note="提案（%s 案%d）を採用" % (AUTHOR_LABELS[prop["author_kind"]],
                                                                 prop["version_no"]),
                   adopted_from_id=proposal_id)
        db.update(ctx.conn, "article_versions", "id", proposal_id, {"proposal_status": "adopted"})
        record_event(ctx, actor, "article", prop["article_id"], "proposal_adopted",
                     {"proposal_id": proposal_id, "version_id": vid})
        return vid


def dismiss_proposal(ctx: Ctx, actor: Actor, proposal_id: int) -> None:
    with db.tx(ctx.conn):
        prop = version(ctx, proposal_id)
        if prop["track"] != "proposal" or prop["proposal_status"] != "open":
            raise EditorialError("見送れる提案ではありません")
        db.update(ctx.conn, "article_versions", "id", proposal_id, {"proposal_status": "dismissed"})
        record_event(ctx, actor, "article", prop["article_id"], "proposal_dismissed", {"proposal_id": proposal_id})


# ---------------------------------------------------------------- queries

def articles_using_asset(ctx: Ctx, asset_id: int) -> List[Tuple[int, set]]:
    out: Dict[int, set] = {}
    rows = db.all_rows(ctx.conn, """
        SELECT a.id, a.head_version_id, a.live_version_id,
               (SELECT GROUP_CONCAT(version_id) FROM approvals ap
                 WHERE ap.article_id = a.id AND ap.status = 'active') AS approved_versions
        FROM articles a""")
    for r in rows:
        checks = [("head", r["head_version_id"]), ("live", r["live_version_id"])]
        for vid in (r["approved_versions"] or "").split(","):
            if vid:
                checks.append(("approved", int(vid)))
        for where, vid in checks:
            if not vid:
                continue
            c = version_content(version(ctx, vid))
            if any(img["asset_id"] == asset_id for img in c["images"]):
                out.setdefault(r["id"], set()).add(where)
    return list(out.items())


def list_articles(ctx: Ctx, states: Optional[List[str]] = None, kind: Optional[str] = None) -> List[dict]:
    sql = """SELECT a.*, v.version_no AS head_no, v.content_json AS head_json, v.author_kind AS head_author,
                    v.created_at AS head_created_at
             FROM articles a LEFT JOIN article_versions v ON v.id = a.head_version_id WHERE 1=1"""
    params: list = []
    if states:
        sql += " AND a.state IN (%s)" % ",".join("?" for _ in states)
        params += states
    if kind:
        sql += " AND a.kind = ?"
        params.append(kind)
    sql += " ORDER BY a.updated_at DESC, a.id DESC"
    out = []
    for r in db.all_rows(ctx.conn, sql, params):
        d = dict(r)
        c = db.loads(d.pop("head_json"), {}) or {}
        d["title"] = c.get("title") or "（無題）"
        d["products"] = [dict(p) for p in products.products_for_article(ctx, d["id"])]
        out.append(d)
    return out


# ---------------------------------------------------------------- diff

def _char_diff(a: str, b: str) -> List[Tuple[str, str]]:
    if a == b:
        return [("equal", a)]
    if len(a) + len(b) > 40000:
        return [("delete", a), ("insert", b)]
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    if sm.ratio() < 0.5:
        # Mostly rewritten: showing whole before/after reads better than fragments.
        return [(op, t) for op, t in (("delete", a), ("insert", b)) if t]
    segs: List[Tuple[str, str]] = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            segs.append(("equal", a[i1:i2]))
        else:
            if i2 > i1:
                segs.append(("delete", a[i1:i2]))
            if j2 > j1:
                segs.append(("insert", b[j1:j2]))
    return segs


def diff_contents(a: dict, b: dict) -> List[dict]:
    """Field-by-field differences, text fields with inline segments."""
    out: List[dict] = []
    fa, fb = content_mod.text_fields(a), content_mod.text_fields(b)
    labels = {"title": "タイトル", "summary": "概要", "relationship_note": "関係の説明"}
    sec_heads = {s["key"]: s["heading"] for s in b["sections"]}
    sec_heads.update({s["key"]: s["heading"] for s in a["sections"] if s["key"] not in sec_heads})
    keys_a = {s["key"]: s for s in a["sections"]}
    keys_b = {s["key"]: s for s in b["sections"]}
    for key in ("title", "summary"):
        if fa.get(key, "") != fb.get(key, ""):
            out.append({"field": labels[key], "segments": _char_diff(fa.get(key, ""), fb.get(key, ""))})
    for key in list(keys_a) + [k for k in keys_b if k not in keys_a]:
        sa, sb = keys_a.get(key), keys_b.get(key)
        for part, label in (("heading", "見出し"), ("body", "本文")):
            ta = (sa or {}).get(part, "")
            tb = (sb or {}).get(part, "")
            if ta != tb:
                out.append({"field": "%s（%s）" % (label, sec_heads.get(key, key)),
                            "segments": _char_diff(ta, tb)})
    if fa.get("relationship_note", "") != fb.get("relationship_note", ""):
        out.append({"field": labels["relationship_note"],
                    "segments": _char_diff(fa.get("relationship_note", ""), fb.get("relationship_note", ""))})

    ia = [(i["asset_id"], i.get("crop")) for i in a["images"]]
    ib = [(i["asset_id"], i.get("crop")) for i in b["images"]]
    if ia != ib:
        out.append({"field": "画像の選択・順序・トリミング",
                    "before": ["#%d%s" % (x, " (トリミング)" if c else "") for x, c in ia],
                    "after": ["#%d%s" % (x, " (トリミング)" if c else "") for x, c in ib]})
    alt_a = {i["asset_id"]: (i["alt"], i["caption"]) for i in a["images"]}
    for img in b["images"]:
        prev = alt_a.get(img["asset_id"])
        if prev and prev != (img["alt"], img["caption"]):
            out.append({"field": "画像#%d の説明" % img["asset_id"],
                        "segments": _char_diff(" / ".join(prev), "%s / %s" % (img["alt"], img["caption"]))})
    ca = [(c["asin"], c["show_image"]) for c in a["amazon_cards"]]
    cb = [(c["asin"], c["show_image"]) for c in b["amazon_cards"]]
    if ca != cb:
        out.append({"field": "商品カード・リンク",
                    "before": ["%s%s" % (x, "" if s else "（画像なし）") for x, s in ca],
                    "after": ["%s%s" % (x, "" if s else "（画像なし）") for x, s in cb]})
    for key, label in (("content_basis", "記事の根拠"), ("relationship", "提供・依頼関係"),
                       ("info_checked_on", "情報確認日")):
        if a.get(key) != b.get(key):
            out.append({"field": label, "before": [str(a.get(key) or "")], "after": [str(b.get(key) or "")]})
    if a["evidence"] != b["evidence"]:
        out.append({"field": "根拠の記録",
                    "before": ["%s：%s（%s）" % (e["kind"], e["claim"] or e["source"], e["checked_on"]) for e in a["evidence"]],
                    "after": ["%s：%s（%s）" % (e["kind"], e["claim"] or e["source"], e["checked_on"]) for e in b["evidence"]]})
    return out


def diff_versions(ctx: Ctx, version_a: int, version_b: int) -> List[dict]:
    va, vb = version(ctx, version_a), version(ctx, version_b)
    if va["article_id"] != vb["article_id"]:
        raise EditorialError("別の記事の版とは比較できません")
    return diff_contents(version_content(va), version_content(vb))
