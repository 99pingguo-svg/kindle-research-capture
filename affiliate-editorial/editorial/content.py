"""Article content model.

A version's content is a small JSON document.  Everything that reaches the
public page is in here, so the version hash covers text, image choice and
order, crops, product cards and disclosure-relevant fields.
"""

from __future__ import annotations

import copy
import re
from datetime import date
from typing import Dict, List, Optional, Tuple

from .core import EditorialError, canonical_hash

PRODUCT_SECTIONS: List[Tuple[str, str]] = [
    ("use", "何に使うか"),
    ("fit", "向く人・向かない人"),
    ("choose", "選ぶときのポイント"),
    ("caution", "購入前の注意"),
    ("specs", "確認できた仕様"),
]
REQUIRED_PRODUCT_SECTIONS = ("use", "fit", "choose", "caution")
PAGE_SECTIONS: List[Tuple[str, str]] = [("body", "本文")]

CONTENT_BASIS = {
    "product_info": "商品情報の整理",
    "research": "独自調査",
    "hands_on": "実際の試用",
}
RELATIONSHIP = {"none": "なし", "provided": "商品提供を受けた", "commissioned": "依頼を受けた"}
EVIDENCE_KINDS = {
    "maker_official": "メーカー公式情報",
    "own_test": "本人の試用・計測",
    "own_research": "本人の調査",
    "other": "その他",
}

SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$")
_SECTION_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
_ASIN_RE = re.compile(r"^(B0[A-Z0-9]{8}|[0-9]{9}[0-9X])$")

LIMITS = {"title": 120, "summary": 300, "heading": 80, "body": 12000, "alt": 200, "caption": 300,
          "relationship_note": 400}


def empty(kind: str = "product") -> dict:
    sections = PAGE_SECTIONS if kind == "page" else PRODUCT_SECTIONS
    return {
        "title": "",
        "summary": "",
        "sections": [{"key": k, "heading": h, "body": ""} for k, h in sections],
        "images": [],
        "amazon_cards": [],
        "evidence": [],
        "content_basis": "research",
        "relationship": "none",
        "relationship_note": "",
        "info_checked_on": "",
    }


def _text(value, limit: int, label: str) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise EditorialError("%s は文字列で指定してください" % label)
    text = value.replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(ch for ch in text if ch == "\n" or ch == "\t" or ord(ch) >= 32)
    text = text.strip()
    if len(text) > limit:
        raise EditorialError("%s が長すぎます（%d文字以内）" % (label, limit))
    return text


def _date(value, label: str) -> str:
    if not value:
        return ""
    try:
        return date.fromisoformat(str(value).strip()).isoformat()
    except ValueError:
        raise EditorialError("%s は YYYY-MM-DD で入力してください" % label)


def normalize(raw: dict, kind: str = "product") -> dict:
    """Validate and canonicalise content.  Raises EditorialError."""
    if not isinstance(raw, dict):
        raise EditorialError("内容の形式が不正です")
    base = empty(kind)
    out = {
        "title": _text(raw.get("title"), LIMITS["title"], "タイトル"),
        "summary": _text(raw.get("summary"), LIMITS["summary"], "概要"),
        "sections": [],
        "images": [],
        "amazon_cards": [],
        "evidence": [],
        "content_basis": raw.get("content_basis") or base["content_basis"],
        "relationship": raw.get("relationship") or "none",
        "relationship_note": _text(raw.get("relationship_note"), LIMITS["relationship_note"], "関係の説明"),
        "info_checked_on": _date(raw.get("info_checked_on"), "情報確認日"),
    }
    if out["content_basis"] not in CONTENT_BASIS:
        raise EditorialError("記事の根拠の種類が不正です")
    if out["relationship"] not in RELATIONSHIP:
        raise EditorialError("提供・依頼関係の指定が不正です")

    seen = set()
    for i, sec in enumerate(raw.get("sections") or []):
        if not isinstance(sec, dict):
            raise EditorialError("見出し%dの形式が不正です" % (i + 1))
        key = str(sec.get("key") or "").strip() or "s%d" % (i + 1)
        if not _SECTION_KEY_RE.match(key) or key in seen:
            raise EditorialError("見出しキーが不正か重複しています: %s" % key)
        seen.add(key)
        out["sections"].append({
            "key": key,
            "heading": _text(sec.get("heading"), LIMITS["heading"], "見出し"),
            "body": _text(sec.get("body"), LIMITS["body"], "本文"),
        })
    if not out["sections"]:
        out["sections"] = base["sections"]

    seen_assets = set()
    for i, img in enumerate(raw.get("images") or []):
        if not isinstance(img, dict):
            raise EditorialError("画像%dの形式が不正です" % (i + 1))
        try:
            asset_id = int(img.get("asset_id"))
        except (TypeError, ValueError):
            raise EditorialError("画像%dの素材IDが不正です" % (i + 1))
        if asset_id in seen_assets:
            raise EditorialError("同じ画像が二重に選ばれています: #%d" % asset_id)
        seen_assets.add(asset_id)
        crop = img.get("crop")
        if crop:
            crop = _crop(crop)
        out["images"].append({
            "asset_id": asset_id,
            "sha256": str(img.get("sha256") or ""),
            "alt": _text(img.get("alt"), LIMITS["alt"], "代替テキスト"),
            "caption": _text(img.get("caption"), LIMITS["caption"], "画像の説明"),
            "crop": crop or None,
        })

    seen_asins = set()
    for card in raw.get("amazon_cards") or []:
        asin = str((card or {}).get("asin") or "").strip().upper()
        if not _ASIN_RE.match(asin):
            raise EditorialError("ASINの形式が正しくありません: %s" % asin)
        if asin in seen_asins:
            raise EditorialError("同じ商品カードが二重にあります: %s" % asin)
        seen_asins.add(asin)
        out["amazon_cards"].append({
            "asin": asin,
            "show_image": bool(card.get("show_image", True)),
            # Display name of the product (a proper noun; not rewritten by polishing).
            "name": _text(card.get("name"), 120, "商品名"),
        })

    for ev in raw.get("evidence") or []:
        if not isinstance(ev, dict):
            raise EditorialError("根拠の形式が不正です")
        ev_kind = ev.get("kind") or "other"
        if ev_kind not in EVIDENCE_KINDS:
            raise EditorialError("根拠の種類が不正です")
        claim = _text(ev.get("claim"), 400, "根拠の内容")
        source = _text(ev.get("source"), 400, "根拠の出典")
        if not claim and not source:
            continue
        out["evidence"].append({
            "claim": claim, "kind": ev_kind, "source": source,
            "checked_on": _date(ev.get("checked_on"), "根拠の確認日"),
        })
    return out


def _crop(crop) -> dict:
    try:
        vals = {k: round(float(crop[k]), 2) for k in ("x", "y", "w", "h")}
    except (KeyError, TypeError, ValueError):
        raise EditorialError("トリミング範囲が不正です")
    if not (0 <= vals["x"] < 100 and 0 <= vals["y"] < 100 and 0 < vals["w"] <= 100 and 0 < vals["h"] <= 100
            and vals["x"] + vals["w"] <= 100.001 and vals["y"] + vals["h"] <= 100.001):
        raise EditorialError("トリミング範囲は0〜100%の範囲で指定してください")
    if vals == {"x": 0, "y": 0, "w": 100, "h": 100}:
        return {}
    return vals


def content_hash(content: dict) -> str:
    return canonical_hash(content)


# Text that reaches readers and therefore goes through the polishing step.
def text_fields(content: dict) -> Dict[str, str]:
    fields = {"title": content["title"], "summary": content["summary"]}
    for i, sec in enumerate(content["sections"]):
        fields["sections.%d.heading" % i] = sec["heading"]
        fields["sections.%d.body" % i] = sec["body"]
    for i, img in enumerate(content["images"]):
        fields["images.%d.alt" % i] = img["alt"]
        fields["images.%d.caption" % i] = img["caption"]
    if content.get("relationship") != "none":
        fields["relationship_note"] = content.get("relationship_note", "")
    return fields


def apply_text_fields(content: dict, values: Dict[str, str]) -> dict:
    out = copy.deepcopy(content)
    expected = set(text_fields(content))
    if set(values) != expected:
        missing = sorted(expected - set(values))
        extra = sorted(set(values) - expected)
        raise EditorialError("文章の項目が一致しません（不足: %s / 余分: %s）" % (missing, extra))
    for path, text in values.items():
        parts = path.split(".")
        if len(parts) == 1:
            out[parts[0]] = text
        else:
            out[parts[0]][int(parts[1])][parts[2]] = text
    return out


def text_fingerprint(content: dict) -> str:
    return canonical_hash(text_fields(content))


def all_text(content: dict) -> str:
    return "\n".join(v for v in text_fields(content).values() if v)


def section_map(content: dict) -> Dict[str, dict]:
    return {s["key"]: s for s in content["sections"]}


def slugify_candidate(value: str) -> Optional[str]:
    value = (value or "").strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
    return value[:80] or None
