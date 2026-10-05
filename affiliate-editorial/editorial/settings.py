"""Site settings that shape the public pages.

Values that change what a reader sees (operator name, disclosures, tracking
ID, base URL ...) form the *publish context*.  An approval stores a snapshot
of that context; changing it afterwards requires a new approval.
"""

from __future__ import annotations

import re
from typing import Dict
from urllib.parse import urlparse

from . import TEMPLATE_VERSION, db, timeutil
from .core import Actor, Ctx, EditorialError, canonical_hash, record_event

PLACEHOLDER_OPERATOR = "［運営名］"

AMAZON_DISCLOSURE_TEMPLATE = "Amazonのアソシエイトとして、{operator}は適格販売により収入を得ています。"

DEFAULTS: Dict[str, object] = {
    "site_name": "（サイト名未設定）",
    "site_tagline": "",
    "operator_name": PLACEHOLDER_OPERATOR,
    "editor_name": "",
    "contact": "",
    "base_url": "",
    # editorial_only: no Associates tag, plain product links.
    # associates: tagged links, rel=sponsored, Amazon disclosure required.
    "monetization_mode": "editorial_only",
    "tracking_id": "",
    # none: star ratings are never shown or used on the site.
    # require_api_min: every product article needs a fresh Creators API
    # rating >= rating_min; ratings are shown only from that API data.
    "rating_policy": "none",
    "rating_min": 4.1,
    "ad_label_text": "この記事にはアフィリエイト広告（Amazonアソシエイト）を含みます。",
    "ai_label_text": "AIにより作成",
    "ai_disclosure_text": "この記事は、運営者が集めた情報をもとに生成AIで文章を作成・整形し、運営者が内容を確認して公開しています。",
    "policy_review_max_age_days": 31,
}

# Settings that are part of the publish context (affect rendered articles).
CONTEXT_KEYS = (
    "site_name", "operator_name", "editor_name", "base_url", "monetization_mode",
    "tracking_id", "rating_policy", "rating_min", "ad_label_text", "ai_label_text",
    "ai_disclosure_text",
)

TRACKING_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,60}-22$")


def ensure_defaults(ctx: Ctx) -> None:
    now = timeutil.now_iso()
    for key, value in DEFAULTS.items():
        ctx.conn.execute(
            "INSERT OR IGNORE INTO settings(key, value_json, updated_at, updated_by) VALUES (?,?,?,?)",
            (key, db.dumps(value), now, "default"))


def get_all(ctx: Ctx) -> Dict[str, object]:
    out = dict(DEFAULTS)
    for row in ctx.conn.execute("SELECT key, value_json FROM settings"):
        out[row["key"]] = db.loads(row["value_json"])
    return out


def get(ctx: Ctx, key: str):
    return get_all(ctx).get(key)


def validate(values: Dict[str, object]) -> Dict[str, object]:
    out: Dict[str, object] = {}
    for key, value in values.items():
        if key not in DEFAULTS:
            raise EditorialError("不明な設定項目です: %s" % key)
        if isinstance(value, str):
            value = value.strip()
        if key == "base_url" and value:
            value = str(value).rstrip("/")
            parsed = urlparse(value)
            local = parsed.hostname in ("localhost", "127.0.0.1")
            if parsed.scheme not in ("https",) and not (parsed.scheme == "http" and local):
                raise EditorialError("公開URLは https:// で始めてください")
            if not parsed.netloc or parsed.query or parsed.fragment:
                raise EditorialError("公開URLの形式が正しくありません")
        if key == "monetization_mode" and value not in ("editorial_only", "associates"):
            raise EditorialError("収益化モードが不正です")
        if key == "rating_policy" and value not in ("none", "require_api_min"):
            raise EditorialError("星評価ポリシーが不正です")
        if key == "rating_min":
            try:
                value = round(float(value), 1)
            except (TypeError, ValueError):
                raise EditorialError("星評価の下限は数値で入力してください")
            if not 1.0 <= value <= 5.0:
                raise EditorialError("星評価の下限は1.0〜5.0です")
        if key == "policy_review_max_age_days":
            value = int(value)
            if not 1 <= value <= 120:
                raise EditorialError("規約確認の有効日数は1〜120日です")
        if key == "tracking_id" and value and not TRACKING_ID_RE.match(str(value)):
            raise EditorialError("トラッキングIDの形式が正しくありません（例: example-22）")
        out[key] = value
    return out


def set_many(ctx: Ctx, actor: Actor, values: Dict[str, object]) -> list:
    """Save settings.  Returns the list of changed keys.

    If a context key changes, unpublished approvals and schedules are
    invalidated (live pages keep the context they were approved with).
    """
    clean = validate(values)
    current = get_all(ctx)
    changed = [k for k, v in clean.items() if current.get(k) != v]
    if not changed:
        return []
    now = timeutil.now_iso()
    with db.tx(ctx.conn):
        for key in changed:
            ctx.conn.execute(
                "INSERT INTO settings(key, value_json, updated_at, updated_by) VALUES (?,?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, "
                "updated_at=excluded.updated_at, updated_by=excluded.updated_by",
                (key, db.dumps(clean[key]), now, actor.name))
        record_event(ctx, actor, "settings", None, "settings_changed",
                     {"keys": changed, "old": {k: current.get(k) for k in changed if k != "tracking_id"},
                      "new": {k: clean[k] for k in changed if k != "tracking_id"}})
        if any(k in CONTEXT_KEYS for k in changed):
            from . import approvals
            approvals.invalidate_all_unpublished(
                ctx, actor, "公開設定（%s）が変更されたため" % ", ".join(k for k in changed if k in CONTEXT_KEYS))
    return changed


def publish_context(ctx: Ctx) -> Dict[str, object]:
    s = get_all(ctx)
    out = {k: s[k] for k in CONTEXT_KEYS}
    out["template_version"] = TEMPLATE_VERSION
    return out


def context_hash(context: Dict[str, object]) -> str:
    return canonical_hash(context)


def amazon_disclosure(context: Dict[str, object]) -> str:
    return AMAZON_DISCLOSURE_TEMPLATE.format(operator=context.get("operator_name") or PLACEHOLDER_OPERATOR)
