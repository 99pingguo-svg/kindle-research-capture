"""Scan public output for private data (paths, order numbers, secrets)."""

from __future__ import annotations

import re
from typing import List

from .core import Ctx

_PATTERNS = [
    (re.compile(r"/Users/[^\s\"'<>]+"), "Macのローカルパス"),
    (re.compile(r"/home/[a-z0-9_.-]+/"), "ローカルパス"),
    (re.compile(r"[A-Za-z]:\\\\[^\s\"'<>]+"), "Windowsのローカルパス"),
    (re.compile(r"file://"), "file:// URL"),
    (re.compile(r"\b\d{3}-\d{7}-\d{7}\b"), "Amazonの注文番号らしき文字列"),
    (re.compile(r"(?:注文番号|領収書|仕入れ値|仕入値|購入価格|原価)\s*[:：]"), "注文・仕入れ情報らしき記述"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "アクセスキーらしき文字列"),
    (re.compile(r"\b(?:sk|pk)-[A-Za-z0-9]{20,}"), "APIキーらしき文字列"),
    (re.compile(r"amzn1\.application-oa2-client\.[0-9a-f]+"), "Amazon認証情報らしき文字列"),
    (re.compile(r"<!--\s*(?:internal|private|内部)"), "内部コメント"),
    (re.compile(r"(?:source_original|manuscript|reference_inventory|promotion_completion_ledger)\.json"),
     "取り込み元のファイル名"),
]


def scan_text(ctx: Ctx, text: str) -> List[str]:
    found: List[str] = []
    for pattern, label in _PATTERNS:
        m = pattern.search(text)
        if m:
            found.append("公開データに%sが含まれています: %s" % (label, m.group(0)[:60]))
    for secret in ctx.config.secret_values():
        if secret and secret in text:
            found.append("公開データに非公開の設定値（パスや認証情報）が含まれています")
            break
    return found
