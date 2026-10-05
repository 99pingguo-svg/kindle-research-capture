"""Image assets (素材) with rights and quality judged separately.

Amazon product images are *not* assets: they are never stored.  They are
shown only through the Creators API image URL (see amazon_api.py).
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path
from typing import List, Optional

from . import db, imagemeta, timeutil
from .core import Actor, Ctx, EditorialError, record_event

KIND_LABELS = {
    "self_photo": "自撮り写真",
    "original_work": "独自制作",
    "maker_licensed": "メーカー等の許諾素材",
    "generated": "生成画像",
    "manga": "漫画",
    "reference_photo": "参照用写真（公開不可）",
    "amazon_derived": "Amazon由来（公開不可）",
    "unknown": "由来不明",
}
NEVER_PUBLIC_KINDS = ("reference_photo", "amazon_derived")
RIGHTS_LABELS = {"unverified": "権利未確認", "verified": "権利確認済み", "denied": "公開不可", "expired": "期限切れ"}
QUALITY_LABELS = {"unreviewed": "品質未判定", "good": "品質良", "acceptable": "品質可", "rejected": "品質不採用"}

RIGHTS_FIELDS = (
    "kind", "title", "source", "rights_holder", "license_basis", "license_url", "license_expires_at",
    "rights_status", "commercial_ok", "modification_ok", "ai_input_ok", "has_people",
    "has_third_party_work", "third_party_cleared", "derived_from_amazon", "is_fictional_scene",
    "provenance_note", "parent_asset_id",
)
_TRISTATE = ("commercial_ok", "modification_ok", "ai_input_ok", "third_party_cleared")
_FLAGS = ("has_people", "has_third_party_work", "derived_from_amazon", "is_fictional_scene")


def get(ctx: Ctx, asset_id: int):
    row = db.one(ctx.conn, "SELECT * FROM assets WHERE id = ?", (asset_id,))
    if row is None:
        raise EditorialError("素材が見つかりません: %s" % asset_id)
    return row


def for_product(ctx: Ctx, product_id: int) -> List:
    return db.all_rows(ctx.conn, "SELECT * FROM assets WHERE product_id = ? ORDER BY id", (product_id,))


# ---------------------------------------------------------------- storage

_STORED_NAME_RE = re.compile(r"^[0-9a-f]{2}/[0-9a-f]{64}\.(jpg|png|webp|gif)$")


def private_path(ctx: Ctx, stored_name: str) -> Path:
    if not stored_name or not _STORED_NAME_RE.match(stored_name):
        raise EditorialError("保存名が不正です")
    return ctx.config.private_assets_dir / stored_name


def store_bytes(ctx: Ctx, data: bytes) -> dict:
    mime = imagemeta.sniff(data)
    if mime is None:
        raise EditorialError("画像として認識できないファイルです")
    sha = hashlib.sha256(data).hexdigest()
    stored_name = "%s/%s%s" % (sha[:2], sha, imagemeta.EXT[mime])
    path = private_path(ctx, stored_name)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    w, h = imagemeta.dimensions(data)
    return {"sha256": sha, "stored_name": stored_name, "bytes": len(data), "mime": mime,
            "width": w, "height": h}


def source_path(ctx: Ctx, root_alias: str, relpath: str) -> Path:
    root = ctx.config.source_roots.get(root_alias)
    if root is None:
        raise EditorialError("取り込み元 %s が設定されていません" % root_alias)
    root = Path(root).resolve()
    p = (root / relpath).resolve()
    if root != p and root not in p.parents:
        raise EditorialError("取り込み元の外を指すパスです")
    return p


def read_bytes(ctx: Ctx, asset) -> bytes:
    if asset["storage"] == "private":
        path = private_path(ctx, asset["stored_name"])
    else:
        path = source_path(ctx, asset["root_alias"], asset["relpath"])
    with open(path, "rb") as fh:
        return fh.read()


def file_problems(ctx: Ctx, asset) -> List[str]:
    if asset["storage"] != "private":
        return ["素材が非公開保管領域に取り込まれていません（参照のみ）"]
    try:
        data = read_bytes(ctx, asset)
    except (OSError, EditorialError):
        return ["素材ファイルが見つかりません"]
    if hashlib.sha256(data).hexdigest() != asset["sha256"]:
        return ["素材ファイルの内容が登録時のハッシュと一致しません"]
    if imagemeta.sniff(data) not in ("image/jpeg", "image/png", "image/webp"):
        return ["公開できる画像形式は JPEG / PNG / WebP のみです"]
    return []


def public_bytes(ctx: Ctx, asset) -> bytes:
    """Metadata-stripped bytes for the public build."""
    return imagemeta.strip_metadata(read_bytes(ctx, asset))


def create(ctx: Ctx, actor: Actor, product_id: Optional[int], kind: str, data: Optional[bytes] = None,
           *, root_alias: Optional[str] = None, relpath: Optional[str] = None,
           sha256: Optional[str] = None, title: Optional[str] = None,
           upstream_state: Optional[str] = None, quality_verdict: str = "unreviewed",
           provenance_note: Optional[str] = None) -> int:
    if kind not in KIND_LABELS:
        raise EditorialError("素材の種類が不正です")
    now = timeutil.now_iso()
    values = {
        "product_id": product_id, "kind": kind, "title": title, "root_alias": root_alias,
        "relpath": relpath, "upstream_state": upstream_state, "quality_verdict": quality_verdict,
        "provenance_note": provenance_note, "created_at": now, "updated_at": now,
        "derived_from_amazon": 1 if kind == "amazon_derived" else 0,
        "rights_status": "denied" if kind == "amazon_derived" else "unverified",
    }
    if data is not None:
        values.update(store_bytes(ctx, data))
        values["storage"] = "private"
    else:
        if not (root_alias and relpath and sha256):
            raise EditorialError("参照素材には取り込み元・相対パス・ハッシュが必要です")
        values.update({"storage": "source_link", "sha256": sha256})
    with db.tx(ctx.conn):
        existing = db.one(ctx.conn, "SELECT id FROM assets WHERE product_id IS ? AND sha256 = ?",
                          (product_id, values["sha256"]))
        if existing:
            return int(existing["id"])
        aid = db.insert(ctx.conn, "assets", values)
        record_event(ctx, actor, "asset", aid, "created",
                     {"product_id": product_id, "kind": kind, "sha256": values["sha256"],
                      "storage": values["storage"]})
    return aid


# ---------------------------------------------------------------- rights

def rights_problems(ctx: Ctx, asset, at: Optional[str] = None, _depth: int = 0) -> List[str]:
    """Why this asset may not be published right now (empty = publishable)."""
    at = at or timeutil.now_iso()
    problems: List[str] = []
    kind = asset["kind"]
    if kind in NEVER_PUBLIC_KINDS:
        problems.append("%sは公開に使えません" % KIND_LABELS[kind])
    if asset["derived_from_amazon"]:
        problems.append("Amazonの商品画像を元にした素材です（加工・漫画化しても制約は消えません）")
    if asset["rights_status"] != "verified":
        problems.append("権利状態が「%s」です" % RIGHTS_LABELS.get(asset["rights_status"], asset["rights_status"]))
    if asset["commercial_ok"] != 1:
        problems.append("商用公開の可否が確認されていません")
    if asset["license_expires_at"] and asset["license_expires_at"] <= at:
        problems.append("許諾期限（%s）を過ぎています" % timeutil.jst_label(asset["license_expires_at"]))
    if (asset["has_people"] or asset["has_third_party_work"]) and asset["third_party_cleared"] != 1:
        problems.append("人物・第三者の作品の写り込みについて確認が済んでいません")
    if kind in ("generated", "manga") and not (asset["provenance_note"] or "").strip():
        problems.append("生成画像・漫画の入力素材と制作経緯が記録されていません")
    if kind == "manga" and not asset["is_fictional_scene"]:
        problems.append("漫画は「架空の使用場面」である旨の設定が必要です")
    if kind == "maker_licensed" and not ((asset["license_basis"] or "").strip() and (asset["source"] or "").strip()):
        problems.append("メーカー等の許諾素材は提供元と許諾文の記録が必要です")
    if asset["parent_asset_id"]:
        if _depth > 8:
            problems.append("元素材の連鎖が深すぎます")
        else:
            parent = db.one(ctx.conn, "SELECT * FROM assets WHERE id = ?", (asset["parent_asset_id"],))
            if parent is None:
                problems.append("元素材が見つかりません")
            else:
                if parent["modification_ok"] != 1:
                    problems.append("元素材（#%d）の加工許可がありません" % parent["id"])
                for p in rights_problems(ctx, parent, at, _depth + 1):
                    problems.append("元素材#%d: %s" % (parent["id"], p))
    return problems


def selection_problems(ctx: Ctx, asset, crop: Optional[dict] = None) -> List[str]:
    """Rules for choosing an image in an article (publishable images only)."""
    problems = rights_problems(ctx, asset)
    if asset["quality_verdict"] == "rejected":
        problems.append("品質判定が「不採用」です")
    if crop and asset["modification_ok"] != 1:
        problems.append("加工許可がないためトリミングできません")
    problems += file_problems(ctx, asset)
    return problems


def ai_input_problems(ctx: Ctx, asset) -> List[str]:
    problems = []
    if asset["ai_input_ok"] != 1:
        problems.append("AIへの入力が許可されていません")
    if asset["kind"] in NEVER_PUBLIC_KINDS or asset["derived_from_amazon"]:
        problems.append("Amazon由来・参照用の素材はAIへ入力しません")
    if asset["rights_status"] != "verified":
        problems.append("権利が確認されていません")
    return problems


def _bool_or_none(value):
    if value in (None, "", "unknown"):
        return None
    if value in (True, 1, "1", "true", "yes", "on"):
        return 1
    if value in (False, 0, "0", "false", "no", "off"):
        return 0
    raise EditorialError("真偽値が不正です: %r" % (value,))


def update_rights(ctx: Ctx, actor: Actor, asset_id: int, values: dict) -> None:
    asset = get(ctx, asset_id)
    unknown = set(values) - set(RIGHTS_FIELDS)
    if unknown:
        raise EditorialError("更新できない項目です: %s" % ", ".join(sorted(unknown)))
    clean = {}
    for key, value in values.items():
        if isinstance(value, str):
            value = value.strip()
        if key in _TRISTATE:
            value = _bool_or_none(value)
        elif key in _FLAGS:
            value = 1 if _bool_or_none(value) else 0
        elif key == "kind":
            if value not in KIND_LABELS:
                raise EditorialError("素材の種類が不正です")
        elif key == "rights_status":
            if value not in RIGHTS_LABELS:
                raise EditorialError("権利状態が不正です")
        elif key == "license_expires_at":
            value = value or None
            if value:
                if len(value) == 10:  # date → end of that day in Japan time
                    value = timeutil.iso(timeutil.parse_jst_local(value + "T23:59"))
                else:
                    value = timeutil.iso(timeutil.parse_iso(value))
        elif key == "parent_asset_id":
            value = int(value) if value not in (None, "") else None
            if value == asset_id:
                raise EditorialError("自分自身を元素材にはできません")
            if value is not None:
                get(ctx, value)
        else:
            value = value or None
        clean[key] = value

    merged = dict(asset)
    merged.update(clean)
    if merged["kind"] == "amazon_derived":
        merged["derived_from_amazon"] = 1
        clean["derived_from_amazon"] = 1
    if merged["rights_status"] == "verified":
        missing = []
        if merged["kind"] in NEVER_PUBLIC_KINDS or merged["derived_from_amazon"]:
            raise EditorialError("Amazon由来・参照用の素材は「権利確認済み」にできません")
        for key, label in (("source", "出典"), ("rights_holder", "権利者"), ("license_basis", "許諾根拠")):
            if not (merged.get(key) or "").strip():
                missing.append(label)
        if merged.get("commercial_ok") is None:
            missing.append("商用公開の可否")
        if merged.get("modification_ok") is None:
            missing.append("加工の可否")
        if merged.get("ai_input_ok") is None:
            missing.append("AI入力の可否")
        if missing:
            raise EditorialError("「権利確認済み」にするには次の記録が必要です: " + "、".join(missing))
        if merged.get("license_expires_at") and merged["license_expires_at"] <= timeutil.now_iso():
            raise EditorialError("許諾期限を過ぎているため確認済みにできません")
    if "rights_status" in clean or any(k in clean for k in RIGHTS_FIELDS):
        clean["rights_checked_by"] = actor.name
        clean["rights_checked_at"] = timeutil.now_iso()
    clean["updated_at"] = timeutil.now_iso()

    before_ok = not rights_problems(ctx, asset)
    with db.tx(ctx.conn):
        db.update(ctx.conn, "assets", "id", asset_id, clean)
        record_event(ctx, actor, "asset", asset_id, "rights_updated",
                     {k: v for k, v in clean.items() if k not in ("updated_at",)})
        after = get(ctx, asset_id)
        after_ok = not rights_problems(ctx, after)
        crop_lost = asset["modification_ok"] == 1 and after["modification_ok"] != 1
        if (before_ok and not after_ok) or crop_lost:
            on_asset_blocked(ctx, actor, asset_id,
                             "素材#%d の権利状態が変わり公開できなくなったため" % asset_id
                             if not after_ok else "素材#%d の加工許可が取り消されたため" % asset_id)


def update_quality(ctx: Ctx, actor: Actor, asset_id: int, verdict: str, note: Optional[str] = None) -> None:
    if verdict not in QUALITY_LABELS:
        raise EditorialError("品質判定が不正です")
    asset = get(ctx, asset_id)
    with db.tx(ctx.conn):
        db.update(ctx.conn, "assets", "id", asset_id, {
            "quality_verdict": verdict, "quality_note": (note or "").strip() or None,
            "updated_at": timeutil.now_iso()})
        record_event(ctx, actor, "asset", asset_id, "quality_updated", {"verdict": verdict})
        if verdict == "rejected" and asset["quality_verdict"] != "rejected":
            on_asset_blocked(ctx, actor, asset_id, "素材#%d の品質判定が不採用になったため" % asset_id)


def add_processing_step(ctx: Ctx, actor: Actor, asset_id: int, step: str) -> None:
    asset = get(ctx, asset_id)
    history = db.loads(asset["processing_history"], [])
    history.append({"ts": timeutil.now_iso(), "by": actor.name, "step": step})
    with db.tx(ctx.conn):
        db.update(ctx.conn, "assets", "id", asset_id, {"processing_history": db.dumps(history),
                                                       "updated_at": timeutil.now_iso()})
        record_event(ctx, actor, "asset", asset_id, "processing_recorded", {"step": step})


def on_asset_blocked(ctx: Ctx, actor: Actor, asset_id: int, reason: str) -> None:
    """Invalidate approvals that use the asset and hide it from live pages."""
    from . import approvals, articles, jobs
    affected_live = False
    for art_id, where in articles.articles_using_asset(ctx, asset_id):
        if "head" in where or "approved" in where:
            approvals.invalidate_for_article(ctx, actor, art_id, reason, to_state="changes")
        if "live" in where:
            affected_live = True
            articles.add_system_comment(ctx, art_id, reason + "。公開中のページから該当画像を外しました。再確認してください。")
    if affected_live:
        jobs.enqueue_refresh(ctx, actor, reason="素材#%d の公開停止" % asset_id)


def expire_licenses(ctx: Ctx, actor: Actor) -> List[int]:
    now = timeutil.now_iso()
    rows = db.all_rows(ctx.conn, """SELECT id FROM assets WHERE rights_status = 'verified'
                                    AND license_expires_at IS NOT NULL AND license_expires_at <= ?""", (now,))
    expired = []
    for r in rows:
        with db.tx(ctx.conn):
            db.update(ctx.conn, "assets", "id", r["id"], {"rights_status": "expired", "updated_at": now})
            record_event(ctx, actor, "asset", r["id"], "license_expired", {})
            on_asset_blocked(ctx, actor, r["id"], "素材#%d の許諾期限が切れたため" % r["id"])
        expired.append(r["id"])
    return expired
