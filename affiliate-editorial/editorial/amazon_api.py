"""Amazon Creators API client (GetItems) and the 24-hour data cache.

What is stored: ASIN, title, detail URL, the *URL* of the primary image, the
image id parsed from that URL, star rating and review count.  Image bytes
are never downloaded, cached, proxied or re-hosted.  Data older than 24 hours
is treated as unavailable, so pages fall back to a plain text link.

Request format follows Amazon's official creatorsapi-python-sdk:
POST https://creatorsapi.amazon/catalog/v1/getItems with an OAuth2 bearer
token (client credentials) and the ``x-marketplace`` header.
"""

from __future__ import annotations

import difflib
import json
import re
import time
import urllib.error
import urllib.request
from datetime import timedelta
from typing import Dict, List, Optional
from urllib.parse import urlencode, urlparse

from . import db, settings, timeutil
from .config import AmazonConfig
from .core import Actor, Ctx, EditorialError, record_event

VALID_HOURS = 24          # Amazon: refresh product data and image URLs within 24 hours
REFRESH_AFTER_HOURS = 12  # refresh early so pages never carry data older than 24 hours

RESOURCES = [
    "itemInfo.title",
    "images.primary.large",
    "customerReviews.starRating",
    "customerReviews.count",
    "parentASIN",
]

IMAGE_HOSTS = ("m.media-amazon.com", "images-fe.ssl-images-amazon.com",
               "images-na.ssl-images-amazon.com", "images-amazon.com")
_IMAGE_ID_RE = re.compile(r"/images/[IG]/([A-Za-z0-9+%-]+)")

_TOKEN_ENDPOINTS = {
    "2.1": "https://creatorsapi.auth.us-east-1.amazoncognito.com/oauth2/token",
    "2.2": "https://creatorsapi.auth.eu-south-2.amazoncognito.com/oauth2/token",
    "2.3": "https://creatorsapi.auth.us-west-2.amazoncognito.com/oauth2/token",
    "3.1": "https://api.amazon.com/auth/o2/token",
    "3.2": "https://api.amazon.co.uk/auth/o2/token",
    "3.3": "https://api.amazon.co.jp/auth/o2/token",
}


class AmazonApiError(EditorialError):
    pass


class NotConfigured(AmazonApiError):
    pass


def image_id_from_url(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    m = _IMAGE_ID_RE.search(urlparse(url).path)
    return m.group(1) if m else None


def is_allowed_image_url(url: Optional[str]) -> bool:
    if not url:
        return False
    p = urlparse(url)
    return p.scheme == "https" and (p.hostname or "") in IMAGE_HOSTS


class CreatorsApiClient:
    def __init__(self, cfg: AmazonConfig, opener=None):
        self.cfg = cfg
        self._opener = opener or urllib.request.urlopen
        self._token: Optional[str] = None
        self._token_expires = 0.0

    @property
    def configured(self) -> bool:
        return self.cfg.configured

    def _post(self, url: str, body: bytes, headers: Dict[str, str]) -> dict:
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with self._opener(req, timeout=self.cfg.timeout_sec) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            raise AmazonApiError("Creators API がエラーを返しました（HTTP %s）: %s" % (exc.code, detail))
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise AmazonApiError("Creators API に接続できません: %s" % exc)
        except ValueError:
            raise AmazonApiError("Creators API の応答を読めません")

    def token(self) -> str:
        if self._token and time.time() < self._token_expires:
            return self._token
        if not self.configured:
            raise NotConfigured("Creators API の認証情報が設定されていません")
        version = self.cfg.version
        endpoint = self.cfg.auth_endpoint or _TOKEN_ENDPOINTS.get(version)
        if not endpoint:
            raise AmazonApiError("未対応の認証情報バージョンです: %s" % version)
        if version.startswith("3."):
            body = json.dumps({"grant_type": "client_credentials", "client_id": self.cfg.credential_id,
                               "client_secret": self.cfg.credential_secret,
                               "scope": "creatorsapi::default"}).encode("utf-8")
            headers = {"Content-Type": "application/json"}
        else:
            body = urlencode({"grant_type": "client_credentials", "client_id": self.cfg.credential_id,
                              "client_secret": self.cfg.credential_secret,
                              "scope": "creatorsapi/default"}).encode("utf-8")
            headers = {"Content-Type": "application/x-www-form-urlencoded"}
        data = self._post(endpoint, body, headers)
        if "access_token" not in data:
            raise AmazonApiError("アクセストークンを取得できませんでした")
        self._token = data["access_token"]
        self._token_expires = time.time() + int(data.get("expires_in", 3600)) - 30
        return self._token

    def get_items(self, asins: List[str], partner_tag: str) -> Dict[str, dict]:
        """Returns {asin: {"ok": True, ...fields} | {"ok": False, "code", "message"}}."""
        if not asins:
            return {}
        if len(asins) > 10:
            raise AmazonApiError("GetItems は1回10件までです")
        token = self.token()
        auth = "Bearer %s" % token if self.cfg.version.startswith("3.") \
            else "Bearer %s, Version %s" % (token, self.cfg.version)
        body = json.dumps({"partnerTag": partner_tag, "itemIds": asins, "resources": RESOURCES}).encode("utf-8")
        data = self._post(self.cfg.api_host.rstrip("/") + "/catalog/v1/getItems", body, {
            "Authorization": auth, "Content-Type": "application/json", "Accept": "application/json",
            "x-marketplace": self.cfg.marketplace})
        return parse_get_items(asins, data)


def parse_get_items(asins: List[str], data: dict) -> Dict[str, dict]:
    out: Dict[str, dict] = {}
    for item in ((data.get("itemsResult") or {}).get("items") or []):
        asin = item.get("asin")
        if not asin:
            continue
        large = (((item.get("images") or {}).get("primary") or {}).get("large") or {})
        reviews = item.get("customerReviews") or {}
        rating = (reviews.get("starRating") or {}).get("value")
        title = (((item.get("itemInfo") or {}).get("title") or {}).get("displayValue"))
        out[asin] = {
            "ok": True,
            "asin": asin,
            "title": title,
            "detail_page_url": item.get("detailPageURL"),
            "image_url": large.get("url"),
            "image_width": large.get("width"),
            "image_height": large.get("height"),
            "star_rating": float(rating) if rating is not None else None,
            "review_count": int(reviews["count"]) if reviews.get("count") is not None else None,
            "parent_asin": item.get("parentASIN"),
        }
    for err in data.get("errors") or []:
        message = str(err.get("message") or "")
        for asin in asins:
            if asin not in out and asin in message:
                out[asin] = {"ok": False, "code": err.get("code") or "Error", "message": message[:300]}
    for asin in asins:
        out.setdefault(asin, {"ok": False, "code": "NotReturned", "message": "応答に含まれていません"})
    return out


# ---------------------------------------------------------------- cache

def get_item(ctx: Ctx, asin: str) -> Optional[dict]:
    row = db.one(ctx.conn, "SELECT * FROM amazon_items WHERE asin = ?", (asin,))
    return dict(row) if row else None


def is_fresh(item: Optional[dict], at: Optional[str] = None) -> bool:
    """Data may be shown only within 24 hours of a successful fetch."""
    if not item or item.get("status") not in ("ok", "error") or not item.get("expires_at"):
        return False
    return item["expires_at"] > (at or timeutil.now_iso())


def needs_refresh(item: Optional[dict]) -> bool:
    if not item or not item.get("fetched_at"):
        return True
    age = timeutil.now() - timeutil.parse_iso(item["fetched_at"])
    return age >= timedelta(hours=REFRESH_AFTER_HOURS) or not is_fresh(item)


def refresh(ctx: Ctx, actor: Actor, asins: List[str], force: bool = False) -> dict:
    """Fetch current data for ASINs.  Never raises for per-item failures."""
    asins = sorted({a for a in asins if a})
    summary = {"requested": len(asins), "updated": 0, "failed": 0, "skipped": 0,
               "image_changed": [], "title_changed": [], "errors": []}
    if not asins:
        return summary
    client = ctx.amazon
    if not getattr(client, "configured", False):
        summary["skipped"] = len(asins)
        summary["errors"].append("Creators API が未設定のため取得していません（画像なしのテキストリンクで表示します）")
        return summary
    tag = settings.get(ctx, "tracking_id")
    if not tag:
        summary["skipped"] = len(asins)
        summary["errors"].append("トラッキングIDが未設定のため Creators API を呼べません")
        return summary
    todo = [a for a in asins if force or needs_refresh(get_item(ctx, a))]
    summary["skipped"] = len(asins) - len(todo)
    for i in range(0, len(todo), 10):
        chunk = todo[i:i + 10]
        try:
            results = client.get_items(chunk, tag)
        except AmazonApiError as exc:
            results = {a: {"ok": False, "code": "RequestFailed", "message": str(exc)} for a in chunk}
            summary["errors"].append(str(exc))
        for asin in chunk:
            _store(ctx, actor, asin, results.get(asin) or {"ok": False, "code": "NotReturned", "message": ""},
                   summary, client)
    return summary


def _store(ctx: Ctx, actor: Actor, asin: str, result: dict, summary: dict, client) -> None:
    now = timeutil.now_iso()
    prev = get_item(ctx, asin)
    marketplace = getattr(getattr(client, "cfg", None), "marketplace", "www.amazon.co.jp")
    with db.tx(ctx.conn):
        if result.get("ok") and result.get("asin") == asin:
            image_url = result.get("image_url") if is_allowed_image_url(result.get("image_url")) else None
            image_id = image_id_from_url(image_url)
            image_changed = bool(prev and prev.get("image_id") and image_id and prev["image_id"] != image_id)
            title_changed = bool(prev and prev.get("title") and result.get("title") and difflib.SequenceMatcher(
                None, prev["title"], result["title"]).ratio() < 0.6)
            values = {
                "asin": asin, "marketplace": marketplace, "status": "ok", "fetched_at": now,
                "expires_at": timeutil.iso(timeutil.now() + timedelta(hours=VALID_HOURS)),
                "title": result.get("title"), "detail_page_url": result.get("detail_page_url"),
                "image_url": image_url, "image_width": result.get("image_width"),
                "image_height": result.get("image_height"), "image_id": image_id,
                "star_rating": result.get("star_rating"), "review_count": result.get("review_count"),
                "parent_asin": result.get("parent_asin"), "error": None,
            }
            summary["updated"] += 1
            if image_changed:
                summary["image_changed"].append(asin)
            if title_changed:
                summary["title_changed"].append(asin)
            note = None
        else:
            code = result.get("code") or "Error"
            if code in ("ItemNotFound", "InvalidParameterValue", "ItemNotAccessible"):
                # The item is gone or not available: hide everything at once.
                values = {"asin": asin, "marketplace": marketplace, "status": "not_found",
                          "fetched_at": prev.get("fetched_at") if prev else None, "expires_at": now,
                          "title": None, "detail_page_url": None, "image_url": None, "image_width": None,
                          "image_height": None, "image_id": None, "star_rating": None, "review_count": None,
                          "parent_asin": None, "error": "%s: %s" % (code, result.get("message", ""))}
            else:
                # Keep the last good data only until its 24-hour expiry.
                values = dict(prev) if prev else {"asin": asin, "marketplace": marketplace}
                values.update({"status": "error", "error": "%s: %s" % (code, result.get("message", ""))})
            image_changed = title_changed = False
            summary["failed"] += 1
            note = values["error"]
        cols = ["asin", "marketplace", "status", "fetched_at", "expires_at", "title", "detail_page_url",
                "image_url", "image_width", "image_height", "image_id", "star_rating", "review_count",
                "parent_asin", "error"]
        row = {c: values.get(c) for c in cols}
        ctx.conn.execute("INSERT OR REPLACE INTO amazon_items (%s) VALUES (%s)" % (
            ",".join(cols), ",".join("?" for _ in cols)), [row[c] for c in cols])
        db.insert(ctx.conn, "amazon_refresh_log", {
            "asin": asin, "ts": now, "status": row["status"], "image_id": row["image_id"],
            "image_changed": 1 if image_changed else 0, "title_changed": 1 if title_changed else 0,
            "star_rating": row["star_rating"], "note": note})
        if image_changed or title_changed:
            record_event(ctx, actor, "amazon_item", asin, "content_changed",
                         {"image_changed": image_changed, "title_changed": title_changed})


def asins_in_use(ctx: Ctx) -> List[str]:
    """ASINs on live pages and in articles waiting for approval/publication."""
    out = set()
    for r in db.all_rows(ctx.conn, """SELECT head_version_id, live_version_id, state FROM articles
                                      WHERE state NOT IN ('rejected','archived') OR publication_status='live'"""):
        for vid in (r["head_version_id"], r["live_version_id"]):
            if vid:
                row = db.one(ctx.conn, "SELECT content_json FROM article_versions WHERE id = ?", (vid,))
                for card in db.loads(row["content_json"], {}).get("amazon_cards", []):
                    out.add(card["asin"])
    return sorted(out)
