"""Record of official-policy reviews (規約の確認記録).

Publishing is blocked when a policy that applies to the article has not been
reviewed recently.  The app only keeps the record; reading the official page
and judging the change is done by a person.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Dict, List, Optional

from . import db, timeutil
from .core import Actor, Ctx, EditorialError, record_event

SOURCES: Dict[str, Dict[str, str]] = {
    "A1": {"title": "Amazon 商品画像の利用に関するヘルプ",
           "url": "https://affiliate.amazon.co.jp/help/node/topic/GKT6X2R3NGW5V23K"},
    "A2": {"title": "Amazon SiteStripe画像リンクの終了",
           "url": "https://affiliate.amazon.co.jp/help/node/topic/GSJU9B4KLG76TGEL"},
    "A3": {"title": "Amazon アソシエイト・プログラム・ポリシー（運営規約の別紙）",
           "url": "https://affiliate.amazon.co.jp/help/operating/policies/"},
    "A4a": {"title": "PA-API 5 廃止と Creators API 移行",
            "url": "https://affiliate.amazon.co.jp/creatorsapi/docs/en-us/paapiv5-deprecation"},
    "A4b": {"title": "Creators API introduction（利用資格）",
            "url": "https://affiliate.amazon.co.jp/creatorsapi/docs/en-us/introduction"},
    "A4c": {"title": "Creators API reference",
            "url": "https://affiliate.amazon.co.jp/creatorsapi/docs/en-us/api-reference"},
    "A5a": {"title": "Amazon アソシエイト参加の開示",
            "url": "https://affiliate.amazon.co.jp/help/node/topic/GPXFHVYZMTGPUMPE"},
    "A5b": {"title": "Amazon アソシエイト・プログラム運営規約",
            "url": "https://affiliate.amazon.co.jp/help/operating/agreement/"},
    "A6": {"title": "Amazon 申請の審査について",
           "url": "https://affiliate.amazon.co.jp/help/node/topic/G8TW5AE9XL2VX9VM"},
    "A7": {"title": "運営規約の更新履歴（2026年4月20日改定: AI作成コンテンツの表示）",
           "url": "https://affiliate.amazon.co.jp/help/operating/compare"},
    "G1": {"title": "Google 生成AIコンテンツの使用に関するガイダンス",
           "url": "https://developers.google.com/search/docs/fundamentals/using-gen-ai-content?hl=ja"},
    "G2": {"title": "Google ウェブ検索のスパムに関するポリシー",
           "url": "https://developers.google.com/search/docs/essentials/spam-policies?hl=ja"},
    "G3a": {"title": "Google 質の高いレビューを書く",
            "url": "https://developers.google.com/search/docs/specialty/ecommerce/write-high-quality-reviews?hl=ja"},
    "G3b": {"title": "Google 有用で信頼性の高いユーザー第一のコンテンツ",
            "url": "https://developers.google.com/search/docs/fundamentals/creating-helpful-content?hl=ja"},
    "G4": {"title": "Google 検索の技術要件",
           "url": "https://developers.google.com/search/docs/essentials/technical?hl=ja"},
    "G5": {"title": "Google 外部リンクを区別する",
           "url": "https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links?hl=ja"},
    "G6": {"title": "Google 商品の構造化データ",
           "url": "https://developers.google.com/search/docs/appearance/structured-data/product?hl=ja"},
    "G7": {"title": "Google 画像SEOのおすすめの方法",
           "url": "https://developers.google.com/search/docs/appearance/google-images?hl=ja"},
    "G8a": {"title": "Google 重複するURLの正規化",
            "url": "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls?hl=ja"},
    "G8b": {"title": "Google サイトマップの作成と送信",
            "url": "https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap?hl=ja"},
    "C1": {"title": "消費者庁 ステルスマーケティングに関するQ&A",
           "url": "https://www.caa.go.jp/policies/policy/representation/fair_labeling/faq/stealth_marketing/"},
}


def record_review(ctx: Ctx, actor: Actor, source_key: str, checked_on: str, summary: str = "",
                  changes: str = "", next_due: Optional[str] = None) -> int:
    if source_key not in SOURCES:
        raise EditorialError("不明な資料キーです: %s" % source_key)
    try:
        checked = date.fromisoformat(checked_on)
    except ValueError:
        raise EditorialError("確認日は YYYY-MM-DD で入力してください")
    if checked > timeutil.today_jst():
        raise EditorialError("確認日に未来の日付は入れられません")
    if next_due:
        try:
            due = date.fromisoformat(next_due)
        except ValueError:
            raise EditorialError("次回見直し日は YYYY-MM-DD で入力してください")
    else:
        due = checked + timedelta(days=30)
    with db.tx(ctx.conn):
        rid = db.insert(ctx.conn, "policy_reviews", {
            "source_key": source_key, "url": SOURCES[source_key]["url"], "checked_on": checked.isoformat(),
            "checked_by": actor.name, "summary": (summary or "").strip() or None,
            "changes": (changes or "").strip() or None, "next_due": due.isoformat(),
            "created_at": timeutil.now_iso()})
        record_event(ctx, actor, "policy", source_key, "reviewed",
                     {"checked_on": checked.isoformat(), "next_due": due.isoformat(),
                      "changes": bool((changes or "").strip())})
    return rid


def latest(ctx: Ctx) -> Dict[str, dict]:
    out: Dict[str, dict] = {}
    for row in db.all_rows(ctx.conn, "SELECT * FROM policy_reviews ORDER BY checked_on, id"):
        out[row["source_key"]] = dict(row)
    return out


def required_keys(context: dict, content: Optional[dict]) -> List[str]:
    keys = ["C1", "A7", "G2"]
    if context.get("monetization_mode") == "associates":
        keys += ["A3", "A5a", "A5b"]
    if content and content.get("amazon_cards"):
        keys += ["A1", "A3", "A4b"]
    if context.get("rating_policy") == "require_api_min":
        keys += ["A3", "A4b"]
    seen, out = set(), []
    for k in keys:
        if k not in seen:
            seen.add(k)
            out.append(k)
    return out


def problems(ctx: Ctx, keys: List[str], max_age_days: int) -> List[str]:
    found = latest(ctx)
    today = timeutil.today_jst()
    out = []
    for key in keys:
        row = found.get(key)
        title = "%s %s" % (key, SOURCES[key]["title"])
        if row is None:
            out.append("%s の確認記録がありません" % title)
            continue
        checked = date.fromisoformat(row["checked_on"])
        if (today - checked).days > max_age_days:
            out.append("%s の確認が%d日以上前です（%s）" % (title, max_age_days, row["checked_on"]))
        elif date.fromisoformat(row["next_due"]) < today:
            out.append("%s の次回見直し日（%s）を過ぎています" % (title, row["next_due"]))
    return out


def overview(ctx: Ctx, max_age_days: int) -> List[dict]:
    found = latest(ctx)
    today = timeutil.today_jst()
    rows = []
    for key, src in SOURCES.items():
        row = found.get(key)
        status = "未確認"
        if row:
            checked = date.fromisoformat(row["checked_on"])
            if (today - checked).days > max_age_days or date.fromisoformat(row["next_due"]) < today:
                status = "要再確認"
            else:
                status = "確認済み"
        rows.append({"key": key, "title": src["title"], "url": src["url"], "latest": row, "status": status})
    return rows
