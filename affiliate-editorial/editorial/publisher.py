"""Static site build, verification and atomic switch (dummy target: local dir).

Every publish rebuilds the whole (small) site from the database into a new
staging directory, verifies it, and only then switches the live directory.
If anything fails, the previous live site stays untouched.
"""

from __future__ import annotations

import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Dict, List, Optional

from markupsafe import escape

from . import amazon_api, articles, db, imagemeta, leaks, links, render, settings, timeutil
from .config import PACKAGE_ROOT
from .core import Ctx, EditorialError

LIVE_LINK_NAME = "current"


class BuildError(EditorialError):
    pass


class VerificationError(EditorialError):
    def __init__(self, message: str, problems: List[str]):
        super().__init__(message)
        self.problems = problems


def live_map(ctx: Ctx) -> Dict[int, dict]:
    """{article_id: {"version_id", "approval_id"}} for currently live articles."""
    out = {}
    for r in db.all_rows(ctx.conn, "SELECT id, live_version_id, live_approval_id FROM articles "
                         "WHERE publication_status = 'live' AND live_version_id IS NOT NULL"):
        out[r["id"]] = {"version_id": r["live_version_id"], "approval_id": r["live_approval_id"]}
    return out


def build(ctx: Ctx, mapping: Dict[int, dict], build_id: Optional[str] = None) -> dict:
    """Render the site for ``mapping`` into a fresh staging directory."""
    build_id = build_id or "b%s-%s" % (timeutil.now().strftime("%Y%m%d%H%M%S"), uuid.uuid4().hex[:6])
    out_dir = ctx.config.builds_dir / build_id
    if out_dir.exists():
        raise BuildError("同じビルドIDが既にあります")
    out_dir.mkdir(parents=True)
    media = render.BuildMedia(ctx, out_dir)
    notes: List[str] = []
    pages: List[dict] = []
    try:
        for article_id, entry in sorted(mapping.items()):
            art = articles.get(ctx, article_id)
            ver = articles.version(ctx, entry["version_id"])
            approval = db.one(ctx.conn, "SELECT * FROM approvals WHERE id = ?", (entry["approval_id"],))
            if approval is None:
                raise BuildError("記事#%d の承認記録がありません" % article_id)
            context = db.loads(approval["context_json"])
            snapshot = db.loads(approval["amazon_snapshot_json"], {})
            published_at = entry.get("published_at") or art["last_published_at"] or timeutil.now_iso()
            model: dict = {}
            html = render.render_article_html(
                ctx, article_id, ver["id"], context=context, preview=False, media=media, snapshot=snapshot,
                published_at=art["first_published_at"] or published_at, modified_at=published_at,
                model_out=model)
            path = render.article_path(art["kind"], art["slug"])
            target = out_dir / path.strip("/") / "index.html"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(html, encoding="utf-8")
            notes += ["%s: %s" % (art["slug"], n) for n in model.get("notes", [])]
            pages.append({"article_id": article_id, "version_id": ver["id"], "kind": art["kind"],
                          "slug": art["slug"], "path": path, "title": model["title"],
                          "description": model["description"], "modified_at": published_at,
                          "context": context, "content_hash": ver["content_hash"],
                          "approval_content_hash": approval["content_hash"], "cards": model["cards"]})
        items = [p for p in pages if p["kind"] != "page"]
        items.sort(key=lambda p: p["modified_at"], reverse=True)
        (out_dir / "index.html").write_text(render.render_index(ctx, items), encoding="utf-8")
        (out_dir / "404.html").write_text(render.render_404(ctx), encoding="utf-8")
        base = str(settings.get(ctx, "base_url") or "").rstrip("/")
        entries = [{"loc": base + "/", "lastmod": max([p["modified_at"] for p in items], default=timeutil.now_iso())}]
        entries += [{"loc": base + p["path"], "lastmod": p["modified_at"]} for p in pages]
        (out_dir / "sitemap.xml").write_text(render.render_sitemap(ctx, entries), encoding="utf-8")
        (out_dir / "robots.txt").write_text(render.robots_txt(ctx), encoding="utf-8")
        assets_dir = out_dir / "assets"
        assets_dir.mkdir()
        for name in ("site.css", "amzn-expiry.js"):
            shutil.copyfile(PACKAGE_ROOT / "static" / "public" / name, assets_dir / name)
    except Exception:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise
    return {"build_id": build_id, "dir": out_dir, "pages": pages, "notes": notes,
            "media": dict(media.written)}


_IMG_SRC_RE = re.compile(r"<img[^>]+src=\"([^\"]+)\"")
_A_RE = re.compile(r"<a\s[^>]*href=\"(https://www\.amazon\.co\.jp/[^\"]*)\"[^>]*>")


def verify(ctx: Ctx, result: dict, expect_absent: Optional[List[str]] = None) -> dict:
    """Check the staged build before it goes live.  Raises VerificationError."""
    out_dir: Path = result["dir"]
    problems: List[str] = []
    checks: List[str] = []
    allowed_media = set(result["media"])
    for f in out_dir.rglob("*"):
        if f.is_dir():
            continue
        rel = f.relative_to(out_dir).as_posix()
        if f.name in ("sw.js", "service-worker.js") or f.suffix in (".appcache", ".webmanifest"):
            problems.append("Service Worker 等のキャッシュ設定が含まれています: %s" % rel)
        if rel.startswith("media/"):
            data = f.read_bytes()
            if f.name not in allowed_media:
                problems.append("登録外の画像ファイルがあります: %s" % rel)
            if imagemeta.has_metadata(data):
                problems.append("画像にメタデータ（EXIF等）が残っています: %s" % rel)
            continue
        if f.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"):
            problems.append("media/ 以外に画像ファイルがあります（Amazon画像の保存は禁止）: %s" % rel)
            continue
        if f.suffix in (".html", ".xml", ".txt", ".css", ".js"):
            text = f.read_text(encoding="utf-8")
            for msg in leaks.scan_text(ctx, text):
                problems.append("%s: %s" % (rel, msg))
            if "serviceWorker" in text:
                problems.append("%s: Service Worker の登録があります" % rel)
    for page in result["pages"]:
        target = out_dir / page["path"].strip("/") / "index.html"
        if not target.exists():
            problems.append("ページが生成されていません: %s" % page["path"])
            continue
        html = target.read_text(encoding="utf-8")
        context = page["context"]
        mode = context["monetization_mode"]
        if page["content_hash"] != page["approval_content_hash"]:
            problems.append("%s: 承認した版と内容のハッシュが一致しません" % page["path"])
        def shown(text) -> bool:
            return str(escape(text)) in html

        if "<title>" not in html or not shown(page["title"]):
            problems.append("%s: タイトルがありません" % page["path"])
        if context.get("base_url") and 'rel="canonical"' not in html:
            problems.append("%s: canonical がありません" % page["path"])
        if not shown(context["ai_label_text"]):
            problems.append("%s: AI利用の表示がありません" % page["path"])
        if page["kind"] != "page" and page["cards"]:
            if mode == "associates":
                if not shown(context["ad_label_text"]):
                    problems.append("%s: 記事冒頭の広告表示がありません" % page["path"])
                if not shown(settings.amazon_disclosure(context)):
                    problems.append("%s: Amazonアソシエイトの開示文がありません" % page["path"])
            for m in _A_RE.finditer(html):
                tag = m.group(0)
                url = m.group(1).replace("&amp;", "&")
                asin = url.split("/dp/")[1].split("?")[0].split("/")[0] if "/dp/" in url else ""
                if asin not in {c["asin"] for c in page["cards"]}:
                    problems.append("%s: 記事の商品ではないASINへのリンクがあります（%s）" % (page["path"], asin))
                for msg in links.validate(url, asin, mode, str(context.get("tracking_id") or "")):
                    problems.append("%s: %s" % (page["path"], msg))
                if mode == "associates" and 'rel="sponsored' not in tag:
                    problems.append("%s: アフィリエイトリンクに rel=sponsored がありません" % page["path"])
        for src in _IMG_SRC_RE.findall(html):
            if src.startswith("/media/"):
                if not (out_dir / src.lstrip("/")).exists():
                    problems.append("%s: 画像が見つかりません（%s）" % (page["path"], src))
            elif not amazon_api.is_allowed_image_url(src):
                problems.append("%s: 許可されていない画像の参照があります（%s）" % (page["path"], src[:80]))
            else:
                card = next((c for c in page["cards"] if c["image"] and c["image"]["src"] == src), None)
                if card is None or not card["image"]["expires"] or card["image"]["expires"] <= timeutil.now_iso():
                    problems.append("%s: 期限切れのAmazon画像URLがあります" % page["path"])
        checks.append(page["path"])
    for path in expect_absent or []:
        if (out_dir / path.strip("/") / "index.html").exists():
            problems.append("取り下げたページが残っています: %s" % path)
    if not (out_dir / "sitemap.xml").exists() or not (out_dir / "robots.txt").exists():
        problems.append("sitemap.xml / robots.txt がありません")
    report = {"checked_pages": checks, "notes": result["notes"], "problems": problems,
              "verified_at": timeutil.now_iso()}
    if problems:
        raise VerificationError("公開前の検証で問題が見つかりました", problems)
    return report


def switch_live(ctx: Ctx, build_id: str) -> Path:
    """Point the public directory at the verified build (atomic rename)."""
    target = ctx.config.builds_dir / build_id
    if not target.is_dir():
        raise BuildError("ビルドが見つかりません: %s" % build_id)
    out = ctx.config.public_out_dir
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp_link = out.parent / (".%s.%s.tmp" % (out.name, uuid.uuid4().hex[:6]))
    if out.exists() and not out.is_symlink():
        raise BuildError("公開出力先が通常のフォルダです。シンボリックリンクとして管理するため移動してください: %s" % out.name)
    os.symlink(target.resolve(), tmp_link)
    os.replace(tmp_link, out)  # atomic on POSIX
    return out


def current_build_id(ctx: Ctx) -> Optional[str]:
    out = ctx.config.public_out_dir
    if out.is_symlink():
        return Path(os.readlink(out)).name
    return None


def prune_builds(ctx: Ctx) -> None:
    keep = max(2, ctx.config.publish.keep_builds)
    live = current_build_id(ctx)
    rows = db.all_rows(ctx.conn, "SELECT id FROM builds ORDER BY created_at DESC, id DESC")
    for i, r in enumerate(rows):
        if i < keep or r["id"] == live:
            continue
        shutil.rmtree(ctx.config.builds_dir / r["id"], ignore_errors=True)


def discard(ctx: Ctx, build_id: str) -> None:
    shutil.rmtree(ctx.config.builds_dir / build_id, ignore_errors=True)
