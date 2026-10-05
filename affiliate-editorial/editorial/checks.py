"""Approval and publish gates (公開直前の必須判定).

``evaluate`` returns blocking problems and warnings.  Warnings must be
acknowledged explicitly at approval time; blocks cannot be overridden.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

from . import articles, assets as assets_mod, content as content_mod, db, lint, links, policy, products, settings
from .core import Ctx, sha256_text


@dataclass
class Problem:
    code: str
    message: str
    severity: str = "block"

    @property
    def key(self) -> str:
        return "%s:%s" % (self.code, sha256_text(self.message)[:10])


@dataclass
class GateReport:
    blocks: List[Problem] = field(default_factory=list)
    warnings: List[Problem] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.blocks

    def block(self, code: str, message: str) -> None:
        self.blocks.append(Problem(code, message, "block"))

    def warn(self, code: str, message: str) -> None:
        self.warnings.append(Problem(code, message, "warn"))


class _LintProblem(Problem):
    def __init__(self, finding: lint.Finding):
        super().__init__(finding.code, "%s（「%s」）" % (finding.message, finding.excerpt), finding.severity)
        self._key = finding.key

    @property
    def key(self) -> str:  # type: ignore[override]
        return self._key


def evaluate(ctx: Ctx, article_id: int, version_id: int, purpose: str = "approve",
             context: dict = None, scan_render: bool = True) -> GateReport:
    from . import amazon_api, polish
    report = GateReport()
    art = articles.get(ctx, article_id)
    ver = articles.version(ctx, version_id)
    if ver["article_id"] != article_id or ver["track"] != "main":
        report.block("version", "この記事の本線の版ではありません")
        return report
    if purpose == "approve":
        if art["state"] != "review":
            report.block("state", "確認待ちの記事ではありません（%s）" % articles.STATE_LABELS[art["state"]])
        if art["head_version_id"] != version_id:
            report.block("stale", "最新の版ではありません")
    if art["state"] in ("rejected", "archived") and purpose != "preview":
        report.block("state", "「%s」の記事は公開できません" % articles.STATE_LABELS[art["state"]])

    content = articles.version_content(ver)
    context = context or settings.publish_context(ctx)
    site = settings.get_all(ctx)
    mode = context["monetization_mode"]
    is_page = art["kind"] == "page"

    # --- site information (運営者情報・問い合わせ・公開URL)
    if context["operator_name"] in ("", settings.PLACEHOLDER_OPERATOR):
        report.block("settings", "運営者名が設定されていません")
    if not context["editor_name"]:
        report.block("settings", "編集責任者が設定されていません")
    if context["site_name"] in ("", settings.DEFAULTS["site_name"]):
        report.block("settings", "サイト名が設定されていません")
    if not context["base_url"]:
        report.block("settings", "公開URL（base_url）が設定されていません")
    if not site.get("contact"):
        report.block("settings", "問い合わせ方法が設定されていません")
    if mode == "associates":
        if not context["tracking_id"]:
            report.block("settings", "アソシエイトのトラッキングIDが設定されていません")
        elif not settings.TRACKING_ID_RE.match(str(context["tracking_id"])):
            report.block("settings", "トラッキングIDの形式が正しくありません")
        if not context["ad_label_text"]:
            report.block("disclosure", "記事冒頭の広告表示の文言が空です")
    if not context["ai_label_text"] or not context["ai_disclosure_text"]:
        report.block("disclosure", "AI利用の表示文言が空です")
    if not is_page:
        about = articles.get_by_slug(ctx, "about")
        if about is None or about["publication_status"] != "live":
            report.block("page_about", "運営者情報ページ（about）が公開されていません")
        privacy = articles.get_by_slug(ctx, "privacy")
        if privacy is None or privacy["publication_status"] != "live":
            report.warn("page_privacy", "プライバシーポリシーのページ（privacy）が公開されていません")

    # --- content
    if not content["title"]:
        report.block("content", "タイトルが空です")
    if not content["summary"]:
        report.block("content", "概要（説明文）が空です")
    secs = content_mod.section_map(content)
    if not is_page:
        for key in content_mod.REQUIRED_PRODUCT_SECTIONS:
            sec = secs.get(key)
            if sec is None or not sec["body"].strip():
                label = dict(content_mod.PRODUCT_SECTIONS)[key]
                report.block("content", "「%s」の本文が空です" % label)
        if not content["info_checked_on"]:
            report.block("evidence", "情報確認日が入力されていません")
        specs = secs.get("specs")
        if specs and specs["body"].strip() and not any(e["checked_on"] for e in content["evidence"]):
            report.block("evidence", "「確認できた仕様」に対応する根拠（出典と確認日）が記録されていません")
        if content["content_basis"] == "hands_on" and not any(
                e["kind"] == "own_test" and e["checked_on"] for e in content["evidence"]):
            report.block("evidence", "「実際の試用」とするには本人の試用記録（確認日つき）が必要です")
    elif not any(s["body"].strip() for s in content["sections"]):
        report.block("content", "本文が空です")
    if content["relationship"] != "none" and not content["relationship_note"]:
        report.block("disclosure", "商品提供・依頼の関係を説明する文が必要です")
    for img in content["images"]:
        if not img["alt"]:
            report.block("content", "画像#%d に代替テキスト（alt）がありません" % img["asset_id"])

    # --- products, ASIN and links
    article_products = products.products_for_article(ctx, article_id)
    for p in article_products:
        if p["status"] != "active":
            report.block("product", "商品「%s」が%sです" % (p["name"], "保留中" if p["status"] == "held" else "保管中"))
    by_asin = {p["asin"]: p for p in article_products if p["asin"]}
    if not is_page and not content["amazon_cards"]:
        report.warn("links", "商品へのリンク（商品カード）がありません")
    for card in content["amazon_cards"]:
        p = by_asin.get(card["asin"])
        if p is None:
            report.block("asin", "ASIN %s はこの記事の商品ではありません" % card["asin"])
            continue
        if not products.is_valid_asin(p["asin"]):
            report.block("asin", "商品「%s」のASINが正しくありません" % p["name"])
        if not p["asin_verified_at"]:
            report.block("asin", "商品「%s」のASIN対応が確認されていません" % p["name"])
        url = links.product_url(card["asin"], mode, str(context["tracking_id"] or ""))
        for msg in links.validate(url, card["asin"], mode, str(context["tracking_id"] or "")):
            report.block("link", "%s: %s" % (card["asin"], msg))
        item = amazon_api.get_item(ctx, card["asin"])
        fresh = amazon_api.is_fresh(item)
        if card["show_image"] and not (fresh and item["image_url"]):
            report.warn("amazon_data", "%s の公式画像URLが取得できていないため、画像なしのテキストリンクで表示します"
                        % card["asin"])
        if fresh and item["asin"] != card["asin"]:
            report.block("asin", "APIの返したASINが一致しません: %s" % card["asin"])
        if context["rating_policy"] == "require_api_min" and not is_page:
            if not fresh or item["star_rating"] is None:
                report.block("rating", "%s の星評価が24時間以内に公式APIから取得されていません" % card["asin"])
            elif float(item["star_rating"]) < float(context["rating_min"]):
                report.block("rating", "%s の星評価（%.1f）がサイト基準（%.1f以上）を下回っています"
                             % (card["asin"], item["star_rating"], float(context["rating_min"])))
    if context["rating_policy"] == "require_api_min" and not is_page and not content["amazon_cards"]:
        report.block("rating", "星評価の基準を確認するため、商品カードが必要です")

    # --- images: rights and quality are separate checks; both must pass
    for img in content["images"]:
        row = db.one(ctx.conn, "SELECT * FROM assets WHERE id = ?", (img["asset_id"],))
        if row is None:
            report.block("rights", "画像#%d の素材が見つかりません" % img["asset_id"])
            continue
        for msg in assets_mod.rights_problems(ctx, row):
            report.block("rights", "画像#%d: %s" % (row["id"], msg))
        if row["quality_verdict"] == "rejected":
            report.block("quality", "画像#%d: 品質判定が不採用です" % row["id"])
        elif row["quality_verdict"] == "unreviewed":
            report.warn("quality", "画像#%d: 品質がまだ判定されていません" % row["id"])
        if img["sha256"] != row["sha256"]:
            report.block("rights", "画像#%d: 選択後に素材ファイルが変わっています" % row["id"])
        for msg in assets_mod.file_problems(ctx, row):
            report.block("file", "画像#%d: %s" % (row["id"], msg))
        if img["crop"] and row["modification_ok"] != 1:
            report.block("rights", "画像#%d: 加工許可がないのにトリミングされています" % row["id"])

    # --- wording
    for f in lint.check_fields(content_mod.text_fields(content), content["content_basis"] == "hands_on"):
        problem = _LintProblem(f)
        (report.blocks if f.severity == lint.BLOCK else report.warnings).append(problem)

    # --- collected customer reviews are a private reference, never source text
    from . import review_refs
    names = [p["name"] for p in article_products]
    for p in article_products:
        item = amazon_api.get_item(ctx, p["asin"]) if p["asin"] else None
        if item and item.get("title"):
            names.append(item["title"])
    for frag in review_refs.overlaps(ctx, [p["id"] for p in article_products], content_mod.all_text(content),
                                     ignore=names):
        report.block("review_copy", "収集済みレビューと同じ文が含まれています（「%s…」）。レビューの転載・要約は公開できません。"
                     % frag[:16])

    # --- every public sentence goes through the polishing step
    if ctx.config.polish.require_for_publish and not polish.is_polished(ctx, article_id, ver):
        report.block("polish", "%s での文章整形が済んでいません（整形後に文章を直した場合も再整形が必要です）"
                     % ctx.config.polish.tool_name)
    for msg in polish.latest_warnings(ctx, article_id, ver) or []:
        report.warn("polish_diff", "整形の確認: %s" % msg)

    # --- official policy reviews
    max_age = int(site.get("policy_review_max_age_days") or 31)
    for msg in policy.problems(ctx, policy.required_keys(context, content), max_age):
        report.block("policy", msg)

    # --- private data must not reach the rendered page
    if scan_render and not any(p.code in ("version",) for p in report.blocks):
        from . import leaks, render
        try:
            html = render.render_article_html(ctx, article_id, version_id, context=context, preview=False)
        except Exception as exc:  # rendering problems are reported, not raised
            report.block("render", "公開用HTMLを作れません: %s" % exc)
        else:
            for msg in leaks.scan_text(ctx, html):
                report.block("leak", msg)
    return report
