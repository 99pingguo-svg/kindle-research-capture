"""Product links are generated from the ASIN, never typed in by hand."""

from __future__ import annotations

from typing import List
from urllib.parse import parse_qs, urlencode, urlparse

from .settings import TRACKING_ID_RE

AMAZON_HOST = "www.amazon.co.jp"


def product_url(asin: str, mode: str, tracking_id: str) -> str:
    url = "https://%s/dp/%s" % (AMAZON_HOST, asin)
    if mode == "associates":
        url += "?" + urlencode({"tag": tracking_id})
    return url


def rel_for(mode: str) -> str:
    # Affiliate links are marked sponsored (Google: qualify outbound links).
    return "sponsored noopener" if mode == "associates" else "noopener"


def validate(url: str, asin: str, mode: str, tracking_id: str) -> List[str]:
    problems: List[str] = []
    try:
        parsed = urlparse(url)
    except ValueError:
        return ["リンクURLを解析できません"]
    if parsed.scheme != "https" or parsed.hostname != AMAZON_HOST:
        problems.append("リンク先が www.amazon.co.jp ではありません")
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 2 or parts[0] != "dp" or parts[1] != asin:
        problems.append("リンク先のASINが商品のASIN（%s）と一致しません" % asin)
    query = parse_qs(parsed.query)
    tags = query.get("tag", [])
    if mode == "associates":
        if not tracking_id:
            problems.append("トラッキングIDが設定されていません")
        elif not TRACKING_ID_RE.match(tracking_id):
            problems.append("トラッキングIDの形式が正しくありません")
        elif tags != [tracking_id]:
            problems.append("リンクのトラッキングIDが設定と一致しません")
    elif tags:
        problems.append("収益化しない設定なのにトラッキングIDが付いています")
    return problems
