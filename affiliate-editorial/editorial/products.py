"""Products (商品) and research notes (調査メモ)."""

from __future__ import annotations

import re
from typing import List, Optional
from urllib.parse import urlparse

from . import db, timeutil
from .core import Actor, Ctx, EditorialError, record_event

# Non-book ASINs start with B0; books use ISBN-10.  Anything else is treated
# as an unknown identifier and never assumed to be an ASIN.
ASIN_RE = re.compile(r"^(B0[A-Z0-9]{8}|[0-9]{9}[0-9X])$")
_URL_ASIN_RE = re.compile(r"/(?:dp|gp/product|gp/aw/d|exec/obidos/ASIN)/([A-Z0-9]{10})(?:[/?]|$)")

NOTE_KINDS = {
    "own_test": "本人の試用・確認",
    "own_research": "本人の調査",
    "maker_info": "メーカー公開情報",
    "manuscript": "既存原稿",
    "other": "その他",
}
NOTE_ORIGINS = {"own": "本人", "maker": "メーカー", "amazon": "Amazon", "unknown": "不明"}


def is_valid_asin(value: Optional[str]) -> bool:
    return bool(value) and bool(ASIN_RE.match(value))


def asin_from_amazon_url(url: Optional[str]) -> Optional[str]:
    """Cross-check helper only; the authoritative ASIN is an explicit field."""
    if not url:
        return None
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if not (host == "amazon.co.jp" or host.endswith(".amazon.co.jp") or host == "amzn.asia"):
        return None
    m = _URL_ASIN_RE.search(parsed.path + ("?" if parsed.query else ""))
    return m.group(1) if m else None


def get(ctx: Ctx, product_id: int):
    row = db.one(ctx.conn, "SELECT * FROM products WHERE id = ?", (product_id,))
    if row is None:
        raise EditorialError("商品が見つかりません: %s" % product_id)
    return row


def find_by_asin(ctx: Ctx, asin: str):
    return db.one(ctx.conn, "SELECT * FROM products WHERE asin = ? AND marketplace = 'www.amazon.co.jp'", (asin,))


def create(ctx: Ctx, actor: Actor, name: str, asin: Optional[str] = None,
           legacy_id: Optional[str] = None, source_url: Optional[str] = None,
           status: str = "active", hold_reason: Optional[str] = None) -> int:
    name = (name or "").strip()
    if not name:
        raise EditorialError("商品名が空です")
    if asin is not None:
        asin = asin.strip().upper() or None
        if asin and not is_valid_asin(asin):
            raise EditorialError("ASINの形式が正しくありません: %s" % asin)
    now = timeutil.now_iso()
    with db.tx(ctx.conn):
        if asin and find_by_asin(ctx, asin):
            raise EditorialError("同じASINの商品が既にあります: %s" % asin)
        pid = db.insert(ctx.conn, "products", {
            "legacy_id": legacy_id, "asin": asin, "name": name, "source_url": source_url,
            "status": status, "hold_reason": hold_reason, "created_at": now, "updated_at": now,
        })
        record_event(ctx, actor, "product", pid, "created",
                     {"asin": asin, "legacy_id": legacy_id, "status": status})
    return pid


def update(ctx: Ctx, actor: Actor, product_id: int, **fields) -> None:
    allowed = {"name", "legacy_id", "asin", "source_url", "selection_note", "manuscript_cleared_for_ai"}
    unknown = set(fields) - allowed
    if unknown:
        raise EditorialError("更新できない項目です: %s" % ", ".join(sorted(unknown)))
    row = get(ctx, product_id)
    values = {}
    for key, value in fields.items():
        if isinstance(value, str):
            value = value.strip()
        if key == "asin":
            value = (value or "").upper() or None
            if value and not is_valid_asin(value):
                raise EditorialError("ASINの形式が正しくありません: %s" % value)
        if key == "manuscript_cleared_for_ai":
            value = 1 if value else 0
        if row[key] != value:
            values[key] = value
    if not values:
        return
    with db.tx(ctx.conn):
        if "asin" in values:
            if values["asin"]:
                other = find_by_asin(ctx, values["asin"])
                if other and other["id"] != product_id:
                    raise EditorialError("同じASINの商品が既にあります")
            # A new ASIN needs fresh evidence, and approvals that linked the
            # old ASIN are no longer valid.
            values["asin_verified_at"] = None
            values["asin_evidence"] = None
        values["updated_at"] = timeutil.now_iso()
        db.update(ctx.conn, "products", "id", product_id, values)
        record_event(ctx, actor, "product", product_id, "updated",
                     {k: v for k, v in values.items() if k != "updated_at"})
        if "asin" in values:
            from . import approvals
            for art in articles_for_product(ctx, product_id):
                approvals.invalidate_for_article(ctx, actor, art["id"], "商品のASINが変更されたため")


def verify_asin(ctx: Ctx, actor: Actor, product_id: int, evidence: str) -> None:
    row = get(ctx, product_id)
    if not is_valid_asin(row["asin"]):
        raise EditorialError("ASINが未設定か形式が正しくありません")
    evidence = (evidence or "").strip()
    if not evidence:
        raise EditorialError("ASINの対応を確認した根拠を入力してください")
    now = timeutil.now_iso()
    with db.tx(ctx.conn):
        db.update(ctx.conn, "products", "id", product_id,
                  {"asin_verified_at": now, "asin_evidence": evidence, "updated_at": now})
        record_event(ctx, actor, "product", product_id, "asin_verified", {"asin": row["asin"]})


def set_status(ctx: Ctx, actor: Actor, product_id: int, status: str, reason: Optional[str] = None) -> None:
    if status not in ("active", "held", "archived"):
        raise EditorialError("状態が不正です")
    if status == "held" and not (reason or "").strip():
        raise EditorialError("保留の理由を入力してください")
    get(ctx, product_id)
    with db.tx(ctx.conn):
        db.update(ctx.conn, "products", "id", product_id, {
            "status": status, "hold_reason": reason if status == "held" else None,
            "updated_at": timeutil.now_iso()})
        record_event(ctx, actor, "product", product_id, "status_changed", {"status": status, "reason": reason})


def articles_for_product(ctx: Ctx, product_id: int) -> List:
    return db.all_rows(ctx.conn, """
        SELECT a.* FROM articles a JOIN article_products ap ON ap.article_id = a.id
        WHERE ap.product_id = ? ORDER BY a.id""", (product_id,))


def list_products(ctx: Ctx, q: str = "", article_state: str = "", rights: str = "",
                  status: str = "") -> List[dict]:
    rows = db.all_rows(ctx.conn, """
        SELECT p.*,
          (SELECT a.state FROM articles a JOIN article_products ap ON ap.article_id=a.id
             WHERE ap.product_id=p.id ORDER BY a.id LIMIT 1) AS article_state,
          (SELECT a.id FROM articles a JOIN article_products ap ON ap.article_id=a.id
             WHERE ap.product_id=p.id ORDER BY a.id LIMIT 1) AS article_id,
          (SELECT a.publication_status FROM articles a JOIN article_products ap ON ap.article_id=a.id
             WHERE ap.product_id=p.id ORDER BY a.id LIMIT 1) AS publication_status,
          (SELECT COUNT(*) FROM assets s WHERE s.product_id=p.id) AS asset_count,
          (SELECT COUNT(*) FROM assets s WHERE s.product_id=p.id AND s.rights_status='verified') AS assets_verified,
          (SELECT COUNT(*) FROM assets s WHERE s.product_id=p.id AND s.rights_status='unverified') AS assets_unverified,
          (SELECT COUNT(*) FROM assets s WHERE s.product_id=p.id AND s.rights_status IN ('denied','expired')) AS assets_blocked
        FROM products p ORDER BY p.id""")
    out = []
    needle = (q or "").strip().lower()
    for r in rows:
        d = dict(r)
        if needle and not any(needle in str(d.get(k) or "").lower() for k in ("name", "asin", "legacy_id")):
            continue
        if article_state and (d.get("article_state") or "none") != article_state:
            continue
        if status and d["status"] != status:
            continue
        if rights == "unverified" and not d["assets_unverified"]:
            continue
        if rights == "blocked" and not d["assets_blocked"]:
            continue
        if rights == "verified" and not (d["asset_count"] and d["assets_verified"] == d["asset_count"]):
            continue
        out.append(d)
    return out


# ---------------------------------------------------------------- notes

def add_note(ctx: Ctx, actor: Actor, product_id: int, kind: str, origin: str, body: str,
             source_url: Optional[str] = None, checked_on: Optional[str] = None,
             ai_input_ok: Optional[bool] = None) -> int:
    get(ctx, product_id)
    if kind not in NOTE_KINDS:
        raise EditorialError("メモの種類が不正です")
    if origin not in NOTE_ORIGINS:
        raise EditorialError("情報の出所が不正です")
    body = (body or "").strip()
    if not body:
        raise EditorialError("メモが空です")
    if checked_on:
        _validate_date(checked_on)
    if ai_input_ok is None:
        ai_input_ok = origin == "own"
    if origin in ("amazon", "unknown"):
        # Amazon content (including customer reviews) must not be used as
        # generative-AI input; unknown origin is held until clarified.
        ai_input_ok = False
    with db.tx(ctx.conn):
        nid = db.insert(ctx.conn, "product_notes", {
            "product_id": product_id, "kind": kind, "origin": origin, "body": body,
            "source_url": (source_url or "").strip() or None, "checked_on": checked_on or None,
            "ai_input_ok": 1 if ai_input_ok else 0, "created_by": actor.name,
            "created_at": timeutil.now_iso(),
        })
        record_event(ctx, actor, "product", product_id, "note_added",
                     {"note_id": nid, "kind": kind, "origin": origin, "ai_input_ok": bool(ai_input_ok)})
    return nid


def set_note_ai(ctx: Ctx, actor: Actor, note_id: int, ai_input_ok: bool) -> None:
    note = db.one(ctx.conn, "SELECT * FROM product_notes WHERE id = ?", (note_id,))
    if note is None:
        raise EditorialError("メモが見つかりません")
    if ai_input_ok and note["origin"] in ("amazon", "unknown"):
        raise EditorialError("Amazon由来・出所不明の情報はAIへの入力を許可できません")
    with db.tx(ctx.conn):
        db.update(ctx.conn, "product_notes", "id", note_id, {"ai_input_ok": 1 if ai_input_ok else 0})
        record_event(ctx, actor, "product", note["product_id"], "note_ai_changed",
                     {"note_id": note_id, "ai_input_ok": ai_input_ok})


def archive_note(ctx: Ctx, actor: Actor, note_id: int) -> None:
    note = db.one(ctx.conn, "SELECT * FROM product_notes WHERE id = ?", (note_id,))
    if note is None:
        raise EditorialError("メモが見つかりません")
    with db.tx(ctx.conn):
        db.update(ctx.conn, "product_notes", "id", note_id, {"archived": 1})
        record_event(ctx, actor, "product", note["product_id"], "note_archived", {"note_id": note_id})


def notes(ctx: Ctx, product_id: int, include_archived: bool = False) -> List:
    sql = "SELECT * FROM product_notes WHERE product_id = ?"
    if not include_archived:
        sql += " AND archived = 0"
    return db.all_rows(ctx.conn, sql + " ORDER BY id", (product_id,))


def _validate_date(value: str) -> None:
    from datetime import date
    try:
        date.fromisoformat(value)
    except ValueError:
        raise EditorialError("日付は YYYY-MM-DD で入力してください")


def product_ids_for_article(ctx: Ctx, article_id: int) -> List[int]:
    return [r["product_id"] for r in db.all_rows(
        ctx.conn, "SELECT product_id FROM article_products WHERE article_id = ? ORDER BY position, product_id",
        (article_id,))]


def products_for_article(ctx: Ctx, article_id: int) -> List:
    return db.all_rows(ctx.conn, """
        SELECT p.* FROM products p JOIN article_products ap ON ap.product_id = p.id
        WHERE ap.article_id = ? ORDER BY ap.position, p.id""", (article_id,))
