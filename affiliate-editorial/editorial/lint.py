"""Wording checks for public text.

These are heuristics: they stop the clearest problems (invented ratings,
reviews quoted or summarised, hands-on claims without hands-on evidence,
implied Amazon endorsement) and ask the owner to confirm softer ones
(prices, superlatives, health claims).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List

from .core import sha256_text

BLOCK = "block"
WARN = "warn"


@dataclass
class Rule:
    code: str
    severity: str
    pattern: re.Pattern
    message: str
    only_without_hands_on: bool = False


RULES: List[Rule] = [
    Rule("review_use", BLOCK, re.compile(
        r"(レビュー|口コミ|クチコミ|評判|カスタマーレビュー)(では|で|によると|を見ると|を見る限り|を分析|を読む|の多く|に多い|に共通|でも|の傾向)"),
        "カスタマーレビューの引用・要約に見える表現です。Amazonのレビューや星評価は公式API経由以外で表示・使用できません。"),
    Rule("review_voice", BLOCK, re.compile(
        r"(購入者|利用者|ユーザー|レビュアー|買った人|使った人)(の|から|による)(声|評価|感想|意見|口コミ)"),
        "購入者の声・評価をまとめた表現です。レビュー内容を記事に使うことはできません。"),
    Rule("vine", BLOCK, re.compile(r"(Vine|ヴァイン|バイン)\s*(メンバー|プログラム|レビュー|先取り)"),
        "Amazon Vineのレビュー情報はAPIで取得・確認できないため、サイトに表示できません。"),
    Rule("star_text", BLOCK, re.compile(
        r"[★☆]|星\s*[0-9０-９](?:[.．][0-9０-９])?|(?:評価|レーティング)\s*[0-9０-９][.．][0-9０-９]|[0-9０-９][.．][0-9０-９]\s*(?:点|つ星)"),
        "星評価を本文に書くことはできません（表示は公式APIデータの自動表示のみ）。"),
    Rule("ranking", BLOCK, re.compile(
        r"(売れ筋|ランキング|人気)\s*(?:1|１|No\.?\s*1|第1位|第１位|一位)|No\.?\s?1|ナンバーワン|売上\s*(?:1|１)\s*位"),
        "売上順位・No.1などの表記は根拠を示せないため使えません。"),
    Rule("amazon_endorse", BLOCK, re.compile(r"Amazon(?:が|も|の)(?:認め|推奨|保証|公認|お墨付き)"),
        "Amazonによる推奨・保証を示す表現は使えません。"),
    Rule("hands_on", BLOCK, re.compile(
        r"使ってみ|試してみ|実際に使|実際に試|実測|計測し|体験レビュー|使用感|使い心地を確か|購入してみ|手に取って"),
        "実際の試用記録がない記事で、体験を示す表現が使われています。",
        only_without_hands_on=True),
    Rule("sakura_claim", WARN, re.compile(r"(サクラ|やらせ|ステマ)(?:なし|ではない|がない|ゼロ|排除|一切)"),
        "「サクラなし」などの断定は裏付けを示しにくい表現です。"),
    Rule("price", WARN, re.compile(r"[¥￥]\s*[0-9０-９]|[0-9０-９][0-9０-９,，]*\s*円"),
        "価格は変わるため固定表示しない方針です。「価格はAmazonでご確認ください」などにしてください。"),
    Rule("superlative", WARN, re.compile(r"最強|最高峰|業界最安|日本一|世界一|最安値|絶対に|間違いなし|必ず(?:満足|効)"),
        "根拠を示しにくい最上級表現です（優良誤認のおそれ）。"),
    Rule("health", WARN, re.compile(r"治る|治す|効く|効果がある|改善する|予防できる|痩せる|若返"),
        "効果・効能をうたう表現です（医薬品等の広告規制に注意）。"),
    Rule("maker_endorse", WARN, re.compile(r"メーカー(?:推奨|おすすめ|公認)|公式推奨"),
        "メーカーの推奨は、確認できた根拠がある場合だけ書いてください。"),
]


@dataclass
class Finding:
    code: str
    severity: str
    message: str
    field: str
    excerpt: str

    @property
    def key(self) -> str:
        return "%s:%s" % (self.code, sha256_text(self.field + "|" + self.excerpt)[:10])


def check_fields(fields: dict, hands_on: bool) -> List[Finding]:
    out: List[Finding] = []
    for field, text in fields.items():
        if not text:
            continue
        for rule in RULES:
            if rule.only_without_hands_on and hands_on:
                continue
            m = rule.pattern.search(text)
            if not m:
                continue
            start = max(0, m.start() - 12)
            excerpt = text[start:m.end() + 12].replace("\n", " ")
            out.append(Finding(rule.code, rule.severity, rule.message, field, excerpt))
    return out
