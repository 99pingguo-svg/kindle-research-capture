"""Synthetic demo data in a separate directory (never mixed with real data).

    python3 -m editorial demo            # creates var-demo/
    EDITORIAL_CONFIG=var-demo/config.json python3 -m editorial serve

The demo uses a pass-through polisher labelled "デモ用（整形なし）" so the
flow can be tried before Antigravity CLI is set up, and fake ASINs that do
not exist on Amazon.
"""

from __future__ import annotations

import json
import os
import struct
import sys
import zlib
from pathlib import Path

from . import approvals, articles, assets, auth, checks, content as content_mod, core, jobs, policy, polish, \
    products, settings, timeutil
from .config import PACKAGE_ROOT, load_config
from .core import Actor, EditorialError

DEMO_USER = "demo"
DEMO_PASSWORD = "demo-password-1234"
OWNER = Actor("user", DEMO_USER)


def _png(w: int, h: int, top, bottom) -> bytes:
    rows = []
    for y in range(h):
        t = y / max(1, h - 1)
        c = bytes(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        rows.append(b"\x00" + c * w)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))


PRODUCTS = [
    {"asin": "B0DEMO0001", "name": "デモ 折りたたみ収納ボックス", "slug": "demo-storage-box",
     "colors": ((214, 226, 235), (120, 150, 175)),
     "title": "折りたたみ収納ボックスの選び方と購入前の確認点",
     "summary": "棚やクローゼットに合わせて選ぶときの考え方と、買う前に測っておきたい寸法をまとめました。",
     "bodies": {
         "use": "衣類や小物をまとめて棚に収めるための箱です。使わないときは畳んで薄くしまえます。",
         "fit": "- 棚の高さに合わせて箱をそろえたい人に向いています\n- 重い物を積み重ねたい人には向きません",
         "choose": "置き場所の奥行きと高さを先に測り、箱の外寸と比べて選びます。取っ手の有無も出し入れのしやすさに関わります。",
         "caution": "外寸と内寸が違うため、入れたい物は内寸で確認してください。",
         "specs": "- 外寸: 幅38×奥行26×高さ25cm（メーカー公表値）\n- 素材: ポリエステル"}},
    {"asin": "B0DEMO0002", "name": "デモ コードレスハンディクリーナー", "slug": "demo-handy-cleaner",
     "colors": ((240, 228, 210), (190, 150, 110)),
     "title": "コードレスハンディクリーナーを選ぶときのポイント",
     "summary": "机まわりや車内の掃除に使う小型クリーナーを、重さと充電方式から選ぶための整理です。",
     "bodies": {
         "use": "机の上や車内など、掃除機を出すほどではない場所のゴミを吸い取ります。",
         "fit": "- こまめに片付けたい人に向いています\n- 部屋全体の掃除をこれ1台で済ませたい人には向きません",
         "choose": "片手で持つため、重さと持ち手の形を重視します。充電方式（USBか専用台か）も確認します。",
         "caution": "連続で使える時間は使い方で変わります。メーカーの公表値を目安にしてください。",
         "specs": ""}},
    {"asin": "B0DEMO0003", "name": "デモ 卓上ブックスタンド", "slug": "demo-book-stand",
     "colors": ((222, 236, 220), (110, 160, 120)),
     "title": "", "summary": "", "bodies": {}},
]


def create(target: Path) -> dict:
    target = target.resolve()
    if target.exists() and any(target.iterdir()):
        raise EditorialError("%s は空ではありません（デモは新しいフォルダに作ります）" % target)
    target.mkdir(parents=True, exist_ok=True)
    cfg_path = target / "config.json"
    cfg = {
        "data_dir": ".",
        "admin": {"host": "127.0.0.1", "port": 8711},
        "polish": {"command": [sys.executable, str(PACKAGE_ROOT / "demo_polisher.py")], "input_mode": "stdin",
                   "timeout_sec": 60, "require_for_publish": True, "tool_name": "デモ用（整形なし）"},
    }
    cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(cfg_path, 0o600)
    ctx = core.open_ctx(load_config(str(cfg_path)))
    auth.create_user(ctx, DEMO_USER, DEMO_PASSWORD)
    settings.set_many(ctx, OWNER, {
        "site_name": "デモ：暮らしの道具ノート", "site_tagline": "（デモ）選ぶ前に確認したいことを整理するサイト",
        "operator_name": "デモ運営", "editor_name": "デモ編集", "contact": "https://example.com/contact",
        "base_url": "https://example.com"})
    for key in policy.SOURCES:
        policy.record_review(ctx, OWNER, key, timeutil.today_jst().isoformat(), "デモ用の確認記録")

    def finish(aid: int, publish: bool) -> None:
        hv = articles.head(ctx, aid)
        polish.polish_article(ctx, OWNER, aid, hv["id"])
        articles.submit_for_review(ctx, OWNER, aid)
        if publish:
            hv = articles.head(ctx, aid)
            report = checks.evaluate(ctx, aid, hv["id"])
            approvals.approve(ctx, OWNER, aid, hv["id"], [w.key for w in report.warnings])
            jobs.enqueue_publish(ctx, OWNER, aid, hv["id"])
            jobs.run_due(ctx)

    for slug, title, summary, body in (
            ("about", "運営者情報", "このデモサイトの目的と運営者についてまとめています。",
             "### このサイトの目的\n商品を選ぶ前に確認したい点を整理しています（デモ）。\n\n### 訂正について\n誤りはお問い合わせからお知らせください。"),
            ("privacy", "プライバシーポリシー", "このデモサイトで扱う情報について説明します。",
             "### アクセス解析\n使用していません（デモ）。")):
        c = content_mod.empty("page")
        c.update({"title": title, "summary": summary})
        c["sections"][0]["body"] = body
        aid = articles.create(ctx, OWNER, "page", slug, [], c)
        finish(aid, publish=True)

    created = []
    for i, spec in enumerate(PRODUCTS):
        pid = products.create(ctx, OWNER, spec["name"], asin=spec["asin"])
        products.verify_asin(ctx, OWNER, pid, "デモ用（架空のASIN）")
        products.add_note(ctx, OWNER, pid, "own_research", "own", "デモ: 置き場所の寸法を気にする人が多い",
                          checked_on=timeutil.today_jst().isoformat())
        aid_img = assets.create(ctx, OWNER, pid, "self_photo", _png(800, 600, *spec["colors"]), title="デモ写真")
        assets.update_rights(ctx, OWNER, aid_img, {
            "rights_status": "verified", "source": "デモ用に生成", "rights_holder": "デモ運営",
            "license_basis": "このデモのために作った画像", "commercial_ok": "1", "modification_ok": "1",
            "ai_input_ok": "1"})
        assets.update_quality(ctx, OWNER, aid_img, "good")
        assets.create(ctx, OWNER, pid, "generated", _png(600, 600, spec["colors"][1], spec["colors"][0]),
                      title="デモ生成画像（権利未確認）")
        c = content_mod.empty("product")
        c["title"] = spec["title"] or spec["name"]
        c["summary"] = spec["summary"]
        for s in c["sections"]:
            s["body"] = spec["bodies"].get(s["key"], "")
        c["amazon_cards"] = [{"asin": spec["asin"], "show_image": True}]
        if spec["bodies"]:
            c["images"] = [{"asset_id": aid_img, "alt": "%sの外観（デモ画像）" % spec["name"], "caption": "デモ用の画像です"}]
            c["info_checked_on"] = timeutil.today_jst().isoformat()
            c["evidence"] = [{"kind": "maker_official", "claim": "寸法", "source": "https://example.com/maker/spec",
                              "checked_on": timeutil.today_jst().isoformat()}]
        aid = articles.create(ctx, OWNER, "product", spec["slug"], [pid], c)
        if i == 0:
            finish(aid, publish=True)
        elif i == 1:
            finish(aid, publish=False)
        else:
            articles.request_changes(ctx, OWNER, aid, "ドラフトを貼り付けてから、整形して確認待ちにしてください（デモ）")
        created.append(aid)
    ctx.conn.close()
    return {"dir": str(target), "config": str(cfg_path), "user": DEMO_USER, "password": DEMO_PASSWORD,
            "port": 8711, "articles": created}
