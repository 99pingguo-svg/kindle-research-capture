"""Owner-provided drafts (本人が用意したドラフト).

Accepted formats (one product per file, or a JSON list):

Markdown::

    ---
    asin: B0XXXXXXXX
    ---
    # タイトル
    概要（最初の見出しまでの段落）
    ## 何に使うか
    ...

JSON::

    {"asin": "B0XXXXXXXX", "title": "...", "summary": "...",
     "sections": [{"heading": "何に使うか", "body": "..."}]}

Headings that match the standard section names go to those sections; other
headings become extra sections.  A draft becomes the next version directly
when the article has no edits by the owner yet; otherwise it is stored as a
proposal so nothing the owner wrote is overwritten.
"""

from __future__ import annotations

import json
import re
import secrets
from pathlib import Path
from typing import Dict, List, Optional

from . import articles, content as content_mod, products
from .core import Actor, Ctx, EditorialError, record_event

_HEADING_ALIASES = {
    "use": ("何に使うか", "用途", "使い道", "どんな商品か"),
    "fit": ("向く人・向かない人", "向く人", "向いている人", "おすすめの人", "向かない人"),
    "choose": ("選ぶときのポイント", "選び方", "選ぶときの違い", "比較のポイント"),
    "caution": ("購入前の注意", "注意点", "購入前に確認", "気をつけたい点"),
    "specs": ("確認できた仕様", "仕様", "スペック", "基本情報"),
}


def _section_key(heading: str, used: set) -> str:
    h = re.sub(r"\s+", "", heading)
    for key, names in _HEADING_ALIASES.items():
        if key not in used and any(h.startswith(n) for n in names):
            return key
    return "x" + secrets.token_hex(3)


def parse_markdown(text: str) -> dict:
    text = (text or "").replace("\r\n", "\n").strip()
    meta: Dict[str, str] = {}
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end > 0:
            for line in text[4:end].splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip().lower()] = v.strip()
            text = text[end + 4:].lstrip("\n")
    title, summary_lines, sections = "", [], []
    current: Optional[dict] = None
    for line in text.split("\n"):
        if line.startswith("# ") and not title and current is None:
            title = line[2:].strip()
        elif line.startswith("## "):
            current = {"heading": line[3:].strip(), "lines": []}
            sections.append(current)
        elif current is None:
            summary_lines.append(line)
        else:
            current["lines"].append(line)
    return {
        "asin": meta.get("asin", "").upper(),
        "slug": meta.get("slug", ""),
        "title": meta.get("title") or title,
        "summary": "\n".join(summary_lines).strip(),
        "sections": [{"heading": s["heading"], "body": "\n".join(s["lines"]).strip()} for s in sections],
    }


def to_content(draft: dict, base: dict, kind: str) -> dict:
    """Merge a parsed draft into the article's current content."""
    out = dict(base)
    if draft.get("title"):
        out["title"] = draft["title"]
    if draft.get("summary"):
        out["summary"] = draft["summary"]
    if draft.get("sections"):
        standard = content_mod.PAGE_SECTIONS if kind == "page" else content_mod.PRODUCT_SECTIONS
        by_key = {k: {"key": k, "heading": h, "body": ""} for k, h in standard}
        extra: List[dict] = []
        used: set = set()
        for sec in draft["sections"]:
            key = _section_key(sec.get("heading", ""), used) if kind != "page" else "body"
            if key in by_key and key not in used:
                used.add(key)
                by_key[key]["body"] = sec.get("body", "")
                if sec.get("heading"):
                    by_key[key]["heading"] = sec["heading"]
            elif kind == "page" and key == "body" and "body" in used:
                by_key["body"]["body"] += "\n\n### %s\n%s" % (sec.get("heading", ""), sec.get("body", ""))
            else:
                extra.append({"key": key if key.startswith("x") else "x" + secrets.token_hex(3),
                              "heading": sec.get("heading", ""), "body": sec.get("body", "")})
        out["sections"] = list(by_key.values()) + extra
    return out


def _owner_has_edited(ctx: Ctx, article_id: int) -> bool:
    return any(v["author_kind"] in ("human", "polish", "claude") for v in articles.versions(ctx, article_id))


def apply_draft(ctx: Ctx, actor: Actor, draft: dict, article_id: Optional[int] = None) -> dict:
    if article_id is None:
        asin = (draft.get("asin") or "").upper()
        if not products.is_valid_asin(asin):
            raise EditorialError("ドラフトに正しいASINがありません")
        product = products.find_by_asin(ctx, asin)
        if product is None:
            raise EditorialError("ASIN %s の商品が登録されていません（先に取り込みまたは登録をしてください）" % asin)
        arts = [a for a in products.articles_for_product(ctx, product["id"]) if a["kind"] == "product"]
        if not arts:
            initial = content_mod.empty("product")
            initial["title"] = product["name"]
            initial["amazon_cards"] = [{"asin": asin, "show_image": True}]
            article_id = articles.create(ctx, actor, "product", draft.get("slug") or "item-%s" % asin.lower(),
                                         [product["id"]], initial)
        else:
            article_id = arts[0]["id"]
    art = articles.get(ctx, article_id)
    head = articles.version(ctx, art["head_version_id"])
    merged = to_content(draft, articles.version_content(head), art["kind"])
    if _owner_has_edited(ctx, article_id) or art["state"] not in ("draft", "changes"):
        vid = articles.add_proposal(ctx, actor, article_id, head["id"], merged, "import",
                                    "本人のドラフト（既存の編集を残すため提案として保存）")
        outcome = "proposal"
    else:
        vid = articles.save(ctx, actor, article_id, head["id"], merged, author_kind="human", note="本人のドラフトを取り込み")
        outcome = "main"
    record_event(ctx, actor, "article", article_id, "draft_imported", {"version_id": vid, "outcome": outcome})
    return {"article_id": article_id, "version_id": vid, "outcome": outcome}


def load_file(path: str) -> List[dict]:
    p = Path(path)
    text = p.read_text(encoding="utf-8-sig")
    if p.suffix.lower() == ".json":
        data = json.loads(text)
        items = data if isinstance(data, list) else data.get("drafts", [data]) if isinstance(data, dict) else []
        out = []
        for d in items:
            if not isinstance(d, dict):
                continue
            out.append({"asin": str(d.get("asin") or "").upper(), "slug": d.get("slug") or "",
                        "title": d.get("title") or "", "summary": d.get("summary") or "",
                        "sections": [{"heading": s.get("heading", ""), "body": s.get("body", "")}
                                     for s in d.get("sections") or [] if isinstance(s, dict)]})
        return out
    return [parse_markdown(text)]


def import_paths(ctx: Ctx, actor: Actor, paths: List[str]) -> dict:
    summary = {"applied": [], "errors": []}
    files: List[Path] = []
    for raw in paths:
        p = Path(raw).expanduser()
        if p.is_dir():
            files += sorted(x for x in p.iterdir() if x.suffix.lower() in (".md", ".markdown", ".txt", ".json"))
        else:
            files.append(p)
    for f in files:
        try:
            for draft in load_file(str(f)):
                result = apply_draft(ctx, actor, draft)
                summary["applied"].append(dict(result, file=f.name))
        except (EditorialError, OSError, ValueError) as exc:
            summary["errors"].append({"file": f.name, "error": str(exc)})
    return summary
