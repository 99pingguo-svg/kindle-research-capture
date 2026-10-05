"""Customer reviews already collected in another project (private reference).

Allowed use: the owner reads them in the admin screen while checking a draft,
to notice statements that contradict what buyers report.

Not allowed (and enforced here and in the gates):
- showing, quoting or summarising them on the public site;
- sending them to Antigravity CLI, Claude or any other generative AI;
- exporting them in Claude bundles.
Amazon only permits displaying/using reviews and star ratings obtained
through its API, and the API provides no review text.
"""

from __future__ import annotations

import csv
import io
import json
import re
import unicodedata
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set

from . import db, products, timeutil
from .core import Actor, Ctx, EditorialError, record_event, sha256_text

SHINGLE = 24

_ALIASES = {
    "asin": ("asin", "ASIN"),
    "body": ("body", "text", "review", "content", "review_body", "本文", "レビュー"),
    "title": ("title", "review_title", "headline", "見出し", "タイトル"),
    "rating": ("rating", "stars", "star_rating", "星", "評価"),
    "review_date": ("date", "review_date", "日付", "投稿日"),
    "source_label": ("source", "source_label", "出典"),
}


def _pick(record: dict, field: str) -> Optional[str]:
    for key in _ALIASES[field]:
        if key in record and record[key] not in (None, ""):
            return str(record[key]).strip()
    return None


def _records_from_file(path: Path) -> Iterable[dict]:
    text = path.read_text(encoding="utf-8-sig")
    suffix = path.suffix.lower()
    if suffix == ".csv":
        yield from csv.DictReader(io.StringIO(text))
        return
    if suffix in (".jsonl", ".ndjson"):
        for line in text.splitlines():
            if line.strip():
                yield json.loads(line)
        return
    data = json.loads(text)
    if isinstance(data, dict):
        data = data.get("reviews") or data.get("items") or []
    if not isinstance(data, list):
        raise EditorialError("レビューのJSONは配列、または reviews 配列を持つオブジェクトにしてください")
    yield from data


def import_file(ctx: Ctx, actor: Actor, path: str) -> dict:
    p = Path(path).expanduser()
    if not p.is_file():
        raise EditorialError("ファイルが見つかりません: %s" % p.name)
    summary = {"read": 0, "imported": 0, "duplicates": 0, "unknown_product": 0, "invalid": 0,
               "unknown_asins": []}
    now = timeutil.now_iso()
    with db.tx(ctx.conn):
        for rec in _records_from_file(p):
            summary["read"] += 1
            if not isinstance(rec, dict):
                summary["invalid"] += 1
                continue
            asin = (_pick(rec, "asin") or "").upper()
            body = _pick(rec, "body")
            if not products.is_valid_asin(asin) or not body:
                summary["invalid"] += 1
                continue
            product = products.find_by_asin(ctx, asin)
            if product is None:
                # Never guess which product a review belongs to.
                summary["unknown_product"] += 1
                if asin not in summary["unknown_asins"]:
                    summary["unknown_asins"].append(asin)
                continue
            digest = sha256_text(asin + "\n" + body)
            if db.one(ctx.conn, "SELECT 1 FROM review_refs WHERE sha256 = ?", (digest,)):
                summary["duplicates"] += 1
                continue
            rating = _pick(rec, "rating")
            try:
                rating_val = float(rating) if rating else None
            except ValueError:
                rating_val = None
            db.insert(ctx.conn, "review_refs", {
                "product_id": product["id"], "asin": asin, "title": _pick(rec, "title"), "body": body,
                "rating": rating_val, "review_date": _pick(rec, "review_date"),
                "source_label": _pick(rec, "source_label"), "imported_from": p.name,
                "sha256": digest, "created_at": now})
            summary["imported"] += 1
        record_event(ctx, actor, "review_refs", p.name, "imported",
                     {k: v for k, v in summary.items() if k != "unknown_asins"})
    return summary


def for_product(ctx: Ctx, product_id: int, limit: int = 200) -> List:
    return db.all_rows(ctx.conn, "SELECT * FROM review_refs WHERE product_id = ? ORDER BY review_date DESC, id "
                       "LIMIT ?", (product_id, limit))


def count_for_product(ctx: Ctx, product_id: int) -> int:
    return int(db.scalar(ctx.conn, "SELECT COUNT(*) FROM review_refs WHERE product_id = ?", (product_id,)) or 0)


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "").lower()
    return re.sub(r"[\s\W_]+", "", text)


def _shingles(text: str, size: int = SHINGLE) -> Set[str]:
    t = _normalize(text)
    return {t[i:i + size] for i in range(0, max(0, len(t) - size + 1))}


def overlaps(ctx: Ctx, product_ids: List[int], text: str, ignore: Iterable[str] = ()) -> List[str]:
    """Fragments of public text that also appear in a collected review."""
    if not product_ids:
        return []
    placeholders = ",".join("?" for _ in product_ids)
    rows = db.all_rows(ctx.conn, "SELECT body, title FROM review_refs WHERE product_id IN (%s)" % placeholders,
                       product_ids)
    if not rows:
        return []
    article = _shingles(text)
    if not article:
        return []
    ignored: Set[str] = set()
    for s in ignore:
        ignored |= _shingles(s)
    review_sh: Set[str] = set()
    for r in rows:
        review_sh |= _shingles((r["title"] or "") + "\n" + r["body"])
    common = sorted((article & review_sh) - ignored)
    # Merge to a few readable excerpts.
    out: List[str] = []
    for frag in common:
        if not any(frag[:SHINGLE // 2] in o for o in out):
            out.append(frag)
        if len(out) >= 3:
            break
    return out


def stats(ctx: Ctx) -> Dict[str, int]:
    return {"total": int(db.scalar(ctx.conn, "SELECT COUNT(*) FROM review_refs") or 0)}
