"""Shared fixtures for the acceptance tests (synthetic data only)."""

from __future__ import annotations

import io
import json
import re
import shutil
import struct
import sys
import tempfile
import unittest
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional
from urllib.parse import urlencode, urlsplit

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from editorial import (approvals, articles, assets, checks, core, policy, polish, products, settings,  # noqa: E402
                       timeutil)
from editorial.config import load_config  # noqa: E402
from editorial.core import Actor  # noqa: E402

OWNER = Actor("user", "owner")
ASIN_A = "B0TESTAAA1"
ASIN_B = "B0TESTBBB2"
START = datetime(2026, 10, 5, 3, 0, tzinfo=timezone.utc)  # 12:00 JST


def png_bytes(w: int = 8, h: int = 6, text_chunk: bool = True, color=b"\x20\x80\xc0") -> bytes:
    raw = b"".join(b"\x00" + color * w for _ in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    if text_chunk:
        out += chunk(b"tEXt", b"Comment\x00made on /Users/someone/Desktop")
    out += chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    return out


def jpeg_with_exif() -> bytes:
    """A structurally valid (tiny) JPEG stream with an EXIF APP1 segment."""
    def seg(marker, payload):
        return b"\xff" + bytes([marker]) + struct.pack(">H", len(payload) + 2) + payload
    app0 = seg(0xE0, b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")
    app1 = seg(0xE1, b"Exif\x00\x00MM\x00*\x00\x00\x00\x08GPS-SECRET")
    com = seg(0xFE, b"camera serial 1234")
    sof = seg(0xC0, b"\x08\x00\x10\x00\x20\x01\x01\x11\x00")
    sos = seg(0xDA, b"\x01\x01\x00\x00\x3f\x00")
    return b"\xff\xd8" + app0 + app1 + com + sof + sos + b"\x12\x34\x56" + b"\xff\xd9"


class FakePolisher:
    """Stands in for Antigravity CLI: returns the same JSON, lightly edited."""
    name = "FakeAntigravity"

    def __init__(self):
        self.calls = []
        self.fail = False

    @staticmethod
    def transform(key, value):
        if value and (key.endswith("body") or key == "summary") and not value.endswith("。"):
            return value + "。"
        return value

    def available(self):
        return True

    def run(self, prompt: str) -> str:
        self.calls.append(prompt)
        if self.fail:
            from editorial.polish import PolishError
            raise PolishError("fake failure")
        data = json.loads(prompt[prompt.index("{"):])
        return "```json\n" + json.dumps({k: self.transform(k, v) for k, v in data.items()}, ensure_ascii=False) + "\n```"


class FakeAmazon:
    """Stands in for the Creators API client."""

    def __init__(self):
        self.configured = True
        self.calls = []
        self.items: Dict[str, dict] = {}
        self.fail = False

    def get_items(self, asins, partner_tag):
        self.calls.append((tuple(asins), partner_tag))
        if self.fail:
            from editorial.amazon_api import AmazonApiError
            raise AmazonApiError("network down")
        out = {}
        for a in asins:
            if a in self.items:
                out[a] = dict({"ok": True, "asin": a}, **self.items[a])
            else:
                out[a] = {"ok": False, "code": "ItemNotFound", "message": "ItemNotFound %s" % a}
        return out

    def set_item(self, asin, image_id="41abcDEFgL", rating=4.5, count=120, title="テスト商品 公式名"):
        self.items[asin] = {
            "title": title, "detail_page_url": "https://www.amazon.co.jp/dp/%s?tag=x-22" % asin,
            "image_url": "https://m.media-amazon.com/images/I/%s._SL500_.jpg" % image_id,
            "image_width": 500, "image_height": 500, "star_rating": rating, "review_count": count,
            "parent_asin": None}


class EditorialTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="editorial-test-"))
        self.source = self.tmp / "source"
        self.source.mkdir()
        timeutil.set_now(START)
        self.config = load_config(overrides={
            "data_dir": str(self.tmp / "var"),
            "source_roots": {"O": str(self.source / "O"), "OP": str(self.source), "R": str(self.source / "R")},
        })
        self.ctx = core.open_ctx(self.config)
        self.polisher = FakePolisher()
        self.ctx.polisher = self.polisher
        self.amazon = FakeAmazon()
        self.amazon.configured = False
        self.ctx.amazon = self.amazon

    def tearDown(self):
        timeutil.set_now(None)
        self.ctx.conn.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ------------------------------------------------------------ builders
    def configure_site(self, mode: str = "editorial_only", tracking_id: str = ""):
        values = {"site_name": "テストの選び方ノート", "operator_name": "テスト運営", "editor_name": "編集 花子",
                  "contact": "https://example.com/contact", "base_url": "https://example.com",
                  "monetization_mode": mode}
        if tracking_id:
            values["tracking_id"] = tracking_id
        settings.set_many(self.ctx, OWNER, values)
        for key in policy.SOURCES:
            policy.record_review(self.ctx, OWNER, key, timeutil.today_jst().isoformat(), "テスト確認")

    def publish_about(self):
        about = articles.create(self.ctx, OWNER, "page", "about", [])
        hv = articles.head(self.ctx, about)
        c = articles.version_content(hv)
        c.update({"title": "運営者情報", "summary": "このサイトについて"})
        c["sections"][0]["body"] = "商品選びの参考になる情報を整理しています"
        vid = articles.save(self.ctx, OWNER, about, hv["id"], c)
        polish.polish_article(self.ctx, OWNER, about, vid)
        articles.submit_for_review(self.ctx, OWNER, about)
        self.approve_and_publish(about)
        return about

    def approve(self, article_id: int) -> int:
        art = articles.get(self.ctx, article_id)
        report = checks.evaluate(self.ctx, article_id, art["head_version_id"])
        if report.blocks:
            raise AssertionError("unexpected blocks: %s" % [p.message for p in report.blocks])
        return approvals.approve(self.ctx, OWNER, article_id, art["head_version_id"], [w.key for w in report.warnings])

    def approve_and_publish(self, article_id: int):
        from editorial import jobs
        self.approve(article_id)
        art = articles.get(self.ctx, article_id)
        jobs.enqueue_publish(self.ctx, OWNER, article_id, art["head_version_id"])
        results = jobs.run_due(self.ctx)
        failed = [r for r in results if r["status"] != "succeeded"]
        if failed:
            raise AssertionError("publish failed: %s" % failed)
        return results

    def make_asset(self, product_id: int, verified: bool = True, data: Optional[bytes] = None, **rights) -> int:
        aid = assets.create(self.ctx, OWNER, product_id, rights.pop("kind", "self_photo"), data or png_bytes())
        if verified:
            values = {"rights_status": "verified", "source": "本人撮影", "rights_holder": "本人",
                      "license_basis": "本人が撮影した写真", "commercial_ok": "1", "modification_ok": "1",
                      "ai_input_ok": "1"}
            values.update(rights)
            assets.update_rights(self.ctx, OWNER, aid, values)
            assets.update_quality(self.ctx, OWNER, aid, "good")
        return aid

    def make_product(self, asin: str = ASIN_A, name: str = "テスト商品") -> int:
        pid = products.create(self.ctx, OWNER, name, asin=asin)
        products.verify_asin(self.ctx, OWNER, pid, "商品ページで型番が一致")
        return pid

    def fill_content(self, article_id: int, asin: str = ASIN_A, image_ids=(), **overrides) -> int:
        hv = articles.head(self.ctx, article_id)
        c = articles.version_content(hv)
        c["title"] = "テスト商品の選び方と注意点"
        c["summary"] = "テスト商品がどんな人に向くか、選ぶときの注意点を整理しました"
        bodies = {"use": "毎日の片付けに使う道具です", "fit": "- 狭い部屋で使いたい人に向いています\n- 大容量が必要な人には向きません",
                  "choose": "サイズと重さを比べて選びます", "caution": "設置場所の寸法を事前に測ってください",
                  "specs": "幅30cm・重さ1.2kg（メーカー公表値）"}
        for s in c["sections"]:
            s["body"] = bodies.get(s["key"], s["body"])
        c["images"] = [{"asset_id": i, "alt": "商品を横から見た写真", "caption": "本体の外観"} for i in image_ids]
        c["amazon_cards"] = [{"asin": asin, "show_image": True}] if asin else []
        c["info_checked_on"] = timeutil.today_jst().isoformat()
        c["evidence"] = [{"kind": "maker_official", "claim": "寸法と重さ", "source": "https://maker.example.com/spec",
                          "checked_on": timeutil.today_jst().isoformat()}]
        c.update(overrides)
        return articles.save(self.ctx, OWNER, article_id, hv["id"], c)

    def ready_article(self, asin: str = ASIN_A, with_image: bool = True, slug: str = "test-item",
                      polish_it: bool = True, **overrides):
        pid = products.find_by_asin(self.ctx, asin)["id"] if products.find_by_asin(self.ctx, asin) else \
            self.make_product(asin)
        image_ids = [self.make_asset(pid)] if with_image else []
        aid = articles.create(self.ctx, OWNER, "product", slug, [pid])
        vid = self.fill_content(aid, asin, image_ids, **overrides)
        if polish_it:
            polish.polish_article(self.ctx, OWNER, aid, vid)
        articles.submit_for_review(self.ctx, OWNER, aid)
        return aid, pid, image_ids


class WsgiClient:
    """Minimal browser for the admin WSGI app (cookies, forms, redirects)."""

    def __init__(self, app):
        self.app = app
        self.cookies: Dict[str, str] = {}

    def request(self, method: str, url: str, data: Optional[dict] = None, files: Optional[dict] = None):
        parts = urlsplit(url)
        body = b""
        ctype = ""
        if files:
            boundary = "----test-boundary"
            chunks = []
            for k, vals in (data or {}).items():
                for v in (vals if isinstance(vals, list) else [vals]):
                    chunks.append(("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n"
                                   % (boundary, k, v)).encode("utf-8"))
            for k, (fname, payload) in files.items():
                chunks.append(("--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
                               "Content-Type: application/octet-stream\r\n\r\n" % (boundary, k, fname)).encode("utf-8")
                              + payload + b"\r\n")
            chunks.append(("--%s--\r\n" % boundary).encode())
            body = b"".join(chunks)
            ctype = "multipart/form-data; boundary=%s" % boundary
        elif data is not None:
            pairs = []
            for k, v in data.items():
                for item in (v if isinstance(v, list) else [v]):
                    pairs.append((k, item))
            body = urlencode(pairs).encode("utf-8")
            ctype = "application/x-www-form-urlencoded"
        environ = {
            "REQUEST_METHOD": method, "PATH_INFO": parts.path, "QUERY_STRING": parts.query,
            "CONTENT_TYPE": ctype, "CONTENT_LENGTH": str(len(body)), "wsgi.input": io.BytesIO(body),
            "wsgi.url_scheme": "http", "REMOTE_ADDR": "127.0.0.1", "SERVER_NAME": "localhost", "SERVER_PORT": "80",
            "HTTP_COOKIE": "; ".join("%s=%s" % kv for kv in self.cookies.items()),
        }
        captured = {}

        def start_response(status, headers):
            captured["status"] = int(status.split()[0])
            captured["headers"] = headers
        out = b"".join(self.app(environ, start_response))
        for k, v in captured["headers"]:
            if k == "Set-Cookie":
                name, _, rest = v.partition("=")
                value = rest.split(";", 1)[0]
                if "Max-Age=0" in v:
                    self.cookies.pop(name, None)
                else:
                    self.cookies[name] = value
        return Resp(captured["status"], dict(captured["headers"]), out)

    def get(self, url):
        return self.request("GET", url)

    def post(self, url, data=None, files=None):
        return self.request("POST", url, data or {}, files)

    def login(self, username="owner", password="correct horse battery"):
        page = self.get("/login")
        token = re.search(r'name="_prelogin" value="([^"]+)"', page.text).group(1)
        return self.post("/login", {"_prelogin": token, "username": username, "password": password, "next": "/"})

    def form_tokens(self, url):
        page = self.get(url)
        csrf = re.search(r'name="_csrf" value="([^"]+)"', page.text).group(1)
        nonce = re.search(r'name="_nonce" value="([^"]+)"', page.text).group(1)
        return page, csrf, nonce


class Resp:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = headers
        self.body = body

    @property
    def text(self):
        return self.body.decode("utf-8", "replace")

    @property
    def location(self):
        return self.headers.get("Location")
