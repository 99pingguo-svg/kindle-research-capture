"""Public page rendering.

Public pages are built only from an explicit allow-list of fields
(``article_model``/``site_model``).  Local paths, notes, comments, collected
reviews, order data and tokens are never handed to the templates.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Callable, Dict, List, Optional

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup

from . import amazon_api, articles, assets as assets_mod, content as content_mod, db, links, markup, \
    settings, timeutil
from .config import PACKAGE_ROOT
from .core import Ctx

_env: Optional[Environment] = None


def env() -> Environment:
    global _env
    if _env is None:
        e = Environment(loader=FileSystemLoader(str(PACKAGE_ROOT / "templates")),
                        autoescape=select_autoescape(["html", "xml"]), trim_blocks=True, lstrip_blocks=True)
        e.filters["jst"] = timeutil.jst_label
        e.filters["jst_date"] = timeutil.jst_date_label
        e.filters["md"] = markup.to_html
        _env = e
    return _env


def article_path(kind: str, slug: str) -> str:
    return "/%s/" % slug if kind == "page" else "/items/%s/" % slug


def absolute(context: dict, path: str) -> str:
    base = str(context.get("base_url") or "").rstrip("/")
    return base + path if base else path


# ---------------------------------------------------------------- media

class PreviewMedia:
    """Admin preview: images are served by the authenticated admin app."""

    def __call__(self, asset) -> Dict:
        return {"src": "/assets/%d/file" % asset["id"], "width": asset["width"], "height": asset["height"]}


class BuildMedia:
    """Static build: copy metadata-stripped bytes under /media/."""

    def __init__(self, ctx: Ctx, out_dir: Path):
        self.ctx = ctx
        self.out_dir = out_dir
        self.written: Dict[str, int] = {}

    def __call__(self, asset) -> Dict:
        data = assets_mod.public_bytes(self.ctx, asset)
        ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[asset["mime"]]
        name = hashlib.sha256(data).hexdigest()[:24] + ext
        path = self.out_dir / "media" / name
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        self.written[name] = asset["id"]
        return {"src": "/media/" + name, "width": asset["width"], "height": asset["height"]}


# ---------------------------------------------------------------- models

def site_model(ctx: Ctx) -> dict:
    """Site chrome (header/footer) always reflects the current settings."""
    s = settings.get_all(ctx)
    current = settings.publish_context(ctx)
    mode = current["monetization_mode"]
    model = {
        "name": current["site_name"],
        "tagline": s.get("site_tagline") or "",
        "base_url": current["base_url"],
        "operator": current["operator_name"],
        "editor": current["editor_name"],
        "contact": s.get("contact") or "",
        "monetized": mode == "associates",
        "amazon_disclosure": settings.amazon_disclosure(current) if mode == "associates" else "",
        "ai_label": current["ai_label_text"],
        "rating_concept": None,
        "year": timeutil.today_jst().year,
    }
    if current["rating_policy"] == "require_api_min":
        model["rating_concept"] = ("Amazon.co.jpでの星評価が%.1f以上の商品だけを紹介しています"
                                   "（Amazonの公式APIで24時間以内に確認した値）。" % float(current["rating_min"]))
    return model


def _crop_style(crop: Optional[dict], width: Optional[int], height: Optional[int]) -> Optional[dict]:
    if not crop or not width or not height:
        return None
    w = crop["w"] / 100.0
    h = crop["h"] / 100.0
    return {
        "wrapper": "aspect-ratio: %.4f / 1;" % ((width * w) / (height * h)),
        "img": "width: %.4f%%; left: %.4f%%; top: %.4f%%;" % (100.0 / w, -crop["x"] / w, -crop["y"] / h),
    }


def article_model(ctx: Ctx, art, ver, context: dict, media: Callable, *, preview: bool,
                  snapshot: Optional[dict] = None, published_at: Optional[str] = None,
                  modified_at: Optional[str] = None) -> dict:
    """Allow-listed data for one article page.  Returns model with 'notes'."""
    content = articles.version_content(ver)
    mode = context["monetization_mode"]
    tag = str(context.get("tracking_id") or "")
    notes: List[str] = []
    path = article_path(art["kind"], art["slug"])
    now_iso = timeutil.now_iso()
    published_at = published_at or now_iso
    modified_at = modified_at or published_at

    figures = []
    for img in content["images"]:
        asset = db.one(ctx.conn, "SELECT * FROM assets WHERE id = ?", (img["asset_id"],))
        if asset is None:
            notes.append("画像#%d: 素材が見つからないため非表示" % img["asset_id"])
            continue
        problems = assets_mod.rights_problems(ctx, asset) + assets_mod.file_problems(ctx, asset)
        if asset["quality_verdict"] == "rejected":
            problems.append("品質不採用")
        if asset["sha256"] != img["sha256"]:
            problems.append("ファイルが承認後に変更")
        if problems and not preview:
            notes.append("画像#%d を非表示: %s" % (asset["id"], "／".join(problems)))
            continue
        m = media(asset)
        figures.append({
            "src": m["src"], "width": m["width"], "height": m["height"], "alt": img["alt"],
            "caption": img["caption"],
            "fictional": asset["kind"] == "manga" or bool(asset["is_fictional_scene"]),
            "crop": _crop_style(img["crop"] if asset["modification_ok"] == 1 else None, m["width"], m["height"]),
            "warning": "／".join(problems) if (problems and preview) else "",
        })

    cards = []
    for card in content["amazon_cards"]:
        item = amazon_api.get_item(ctx, card["asin"])
        fresh = amazon_api.is_fresh(item)
        image = None
        if card["show_image"] and fresh and amazon_api.is_allowed_image_url(item.get("image_url")):
            approved_id = (snapshot or {}).get(card["asin"], {}).get("image_id")
            if preview or (approved_id and approved_id == item.get("image_id")):
                image = {"src": item["image_url"], "width": item.get("image_width"),
                         "height": item.get("image_height"), "expires": item["expires_at"]}
            else:
                notes.append("%s: 公式画像が承認時と異なる（または承認時になかった）ため非表示。再承認で表示できます"
                             % card["asin"])
        rating = None
        if context.get("rating_policy") == "require_api_min" and fresh and item.get("star_rating") is not None:
            rating = {"value": "%.1f" % float(item["star_rating"]), "count": item.get("review_count"),
                      "as_of": timeutil.jst_label(item["fetched_at"]), "expires": item["expires_at"]}
        cards.append({
            "asin": card["asin"], "name": card["name"],
            "url": links.product_url(card["asin"], mode, tag), "rel": links.rel_for(mode),
            "image": image, "rating": rating,
        })

    sections = [{"key": s["key"], "heading": s["heading"], "html": markup.to_html(s["body"])}
                for s in content["sections"] if s["body"].strip()]
    evidence = []
    for e in content["evidence"]:
        if not e["source"]:
            continue
        evidence.append({
            "kind": content_mod.EVIDENCE_KINDS.get(e["kind"], ""),
            "source": e["source"],
            "is_url": e["source"].startswith("https://"),
            "checked_on": timeutil.jst_date_label(e["checked_on"]) if e["checked_on"] else "",
        })

    canonical = absolute(context, path) if context.get("base_url") else None
    og_image = absolute(context, figures[0]["src"]) if (figures and context.get("base_url") and not preview) else None
    jsonld = None
    if art["kind"] != "page" or art["slug"] not in ("privacy",):
        data = {
            "@context": "https://schema.org",
            "@type": "Article",
            "headline": content["title"],
            "description": markup.plain(content["summary"]),
            "datePublished": published_at,
            "dateModified": modified_at,
            "author": {"@type": "Person", "name": context.get("editor_name") or context.get("operator_name")},
            "publisher": {"@type": "Organization", "name": context.get("operator_name")},
        }
        if canonical:
            data["mainEntityOfPage"] = canonical
        if og_image:
            data["image"] = [og_image]
        jsonld = Markup(json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))

    model = {
        "kind": art["kind"], "slug": art["slug"], "path": path, "canonical": canonical,
        "title": content["title"], "summary": content["summary"],
        "description": markup.plain(content["summary"])[:160],
        "sections": sections, "figures": figures, "cards": cards, "evidence": evidence,
        "basis": content_mod.CONTENT_BASIS.get(content["content_basis"], ""),
        "info_checked_on": timeutil.jst_date_label(content["info_checked_on"]) if content["info_checked_on"] else "",
        "published_at": published_at, "modified_at": modified_at,
        "ad_label": context["ad_label_text"] if (mode == "associates" and cards) else "",
        "ai_label": context["ai_label_text"], "ai_disclosure": context["ai_disclosure_text"],
        "relationship_note": content["relationship_note"] if content["relationship"] != "none" else "",
        "amazon_disclosure": settings.amazon_disclosure(context) if mode == "associates" else "",
        "jsonld": jsonld, "og_image": og_image, "notes": notes, "preview": preview,
    }
    return model


def render_article_html(ctx: Ctx, article_id: int, version_id: int, context: Optional[dict] = None,
                        preview: bool = False, media: Optional[Callable] = None,
                        snapshot: Optional[dict] = None, published_at: Optional[str] = None,
                        modified_at: Optional[str] = None, model_out: Optional[dict] = None) -> str:
    art = articles.get(ctx, article_id)
    ver = articles.version(ctx, version_id)
    context = context or settings.publish_context(ctx)
    if snapshot is None and not preview:
        snapshot = _snapshot_for_check(ctx, art, ver)
    model = article_model(ctx, art, ver, context, media or PreviewMedia(), preview=preview, snapshot=snapshot,
                          published_at=published_at, modified_at=modified_at)
    if model_out is not None:
        model_out.update(model)
    template = "public/page.html" if art["kind"] == "page" else "public/article.html"
    return env().get_template(template).render(site=site_model(ctx), page=model,
                                               about=_about_info(ctx, art))


def _snapshot_for_check(ctx: Ctx, art, ver) -> dict:
    from . import approvals
    appr = approvals.active_for(ctx, art["id"], ver["id"])
    if appr:
        return db.loads(appr["amazon_snapshot_json"], {})
    return approvals.amazon_snapshot(ctx, articles.version_content(ver))


def _about_info(ctx: Ctx, art) -> Optional[dict]:
    if art["kind"] != "page" or art["slug"] != "about":
        return None
    s = settings.get_all(ctx)
    return {"operator": s["operator_name"], "editor": s["editor_name"], "contact": s["contact"],
            "monetized": s["monetization_mode"] == "associates"}


def render_index(ctx: Ctx, items: List[dict]) -> str:
    return env().get_template("public/index.html").render(site=site_model(ctx), items=items,
                                                    canonical=absolute(settings.publish_context(ctx), "/")
                                                    if settings.get(ctx, "base_url") else None)


def render_404(ctx: Ctx) -> str:
    return env().get_template("public/404.html").render(site=site_model(ctx))


def render_sitemap(ctx: Ctx, entries: List[dict]) -> str:
    return env().get_template("public/sitemap.xml").render(entries=entries)


def robots_txt(ctx: Ctx) -> str:
    base = str(settings.get(ctx, "base_url") or "").rstrip("/")
    lines = ["User-agent: *", "Allow: /"]
    if base:
        lines.append("Sitemap: %s/sitemap.xml" % base)
    return "\n".join(lines) + "\n"
