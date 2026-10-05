"""Command line entry point:  python3 -m editorial <command> ...

Everything that touches external systems (source folders, Creators API,
Antigravity CLI, publishing) is an explicit command; nothing runs on its own
unless the owner starts the scheduler.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
import threading
from pathlib import Path

from . import (amazon_api, articles, auth, bridge, checks, content as content_mod, core, db, drafts, importer, jobs,
               policy, polish, review_refs, settings, timeutil)
from .config import APP_ROOT, ConfigError, load_config
from .core import Actor, EditorialError

CONFIG_TEMPLATE = {
    "data_dir": "var",
    "source_roots": {
        "O": "/Users/<name>/path/to/O",
        "OP": "/Users/<name>/path/to/O_parent",
        "R": "/Users/<name>/path/to/R",
        "S": "/Users/<name>/path/to/S",
    },
    "access_guide": "/Users/<name>/path/to/access_guide.md",
    "admin": {"host": "127.0.0.1", "port": 8710, "secure_cookies": False, "run_scheduler": False},
    "amazon": {"enabled": False, "version": "3.3", "marketplace": "www.amazon.co.jp"},
    "polish": {"command": ["agy", "-p", "{prompt}"], "input_mode": "arg", "timeout_sec": 600,
               "require_for_publish": True},
    "publish": {"target": "local_dir", "keep_builds": 5},
}

ABOUT_DRAFT = {
    "title": "運営者情報",
    "summary": "このサイトの目的と運営者、お問い合わせ先、情報の確認と訂正の方針をまとめています。",
    "sections": [{"key": "body", "heading": "本文", "body": (
        "### このサイトの目的\n商品を選ぶときに確認しておきたい用途・向き不向き・注意点を、運営者が確認した情報をもとに整理しています。\n\n"
        "### 情報の確認と訂正\n記事ごとに情報確認日と確認した情報源を記載しています。誤りに気づいた場合は、下記のお問い合わせ先からお知らせください。確認のうえ訂正します。\n\n"
        "### 広告とAIの利用について\n記事には広告（アフィリエイトリンク）を含む場合があり、その旨を記事の冒頭に表示します。"
        "記事の文章は生成AIで作成・整形し、運営者が内容を確認してから公開しています。")}],
}
PRIVACY_DRAFT = {
    "title": "プライバシーポリシー",
    "summary": "このサイトで扱う情報と外部サイトへのリンクについて説明します。",
    "sections": [{"key": "body", "heading": "本文", "body": (
        "### アクセス解析とCookie\n現在、このサイトはアクセス解析ツールや広告配信のためのCookieを使用していません。導入する場合は、このページで内容をお知らせします。\n\n"
        "### 外部サイトへのリンク\n商品ページなど外部サイトへのリンク先では、それぞれのサイトのプライバシーポリシーが適用されます。\n\n"
        "### お問い合わせ\nお問い合わせでいただいた情報は、返信と記事の訂正のためだけに使用します。")}],
}


def _ctx(args):
    cfg = load_config(args.config)
    return core.open_ctx(cfg)


def _me() -> Actor:
    return Actor("user", os.environ.get("EDITORIAL_ACTOR") or getpass.getuser() or "owner")


def _print(obj) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2, default=str))


def cmd_init(args) -> None:
    cfg_path = Path(args.config or os.environ.get("EDITORIAL_CONFIG") or APP_ROOT / "var" / "config.json")
    if not cfg_path.exists():
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        cfg_path.write_text(json.dumps(CONFIG_TEMPLATE, ensure_ascii=False, indent=2), encoding="utf-8")
        os.chmod(cfg_path, 0o600)
        print("設定ファイルのひな形を作りました: %s（取り込み元のパスを書き換えてください。公開しないでください）" % cfg_path)
    cfg = load_config(str(cfg_path))
    ctx = core.open_ctx(cfg)
    system = Actor("system", "init")
    for slug, draft in (("about", ABOUT_DRAFT), ("privacy", PRIVACY_DRAFT)):
        if articles.get_by_slug(ctx, slug) is None:
            initial = content_mod.empty("page")
            initial.update(draft)
            articles.create(ctx, system, "page", slug, [], initial, author_kind="system", note="ひな形")
            print("固定ページの下書きを作りました: /%s/" % slug)
    print("データの保存先: %s" % cfg.data_dir)


def cmd_create_user(args) -> None:
    ctx = _ctx(args)
    password = os.environ.get("EDITORIAL_PASSWORD") or getpass.getpass("パスワード（12文字以上）: ")
    if not os.environ.get("EDITORIAL_PASSWORD") and getpass.getpass("もう一度: ") != password:
        raise EditorialError("パスワードが一致しません")
    auth.create_user(ctx, args.username, password)
    print("管理者 %s を作りました" % args.username)


def cmd_set_password(args) -> None:
    ctx = _ctx(args)
    password = os.environ.get("EDITORIAL_PASSWORD") or getpass.getpass("新しいパスワード（12文字以上）: ")
    auth.set_password(ctx, args.username, password)
    print("パスワードを変更し、ログイン中のセッションを終了しました")


def _scheduler_loop(cfg, interval: int, stop: threading.Event) -> None:
    ctx = core.open_ctx(cfg)  # separate connection for the background thread
    while not stop.is_set():
        try:
            for r in jobs.tick(ctx):
                print("[scheduler] job %s: %s" % (r.get("job_id"), r.get("status")))
        except Exception as exc:  # keep the loop alive; failures are recorded per job
            print("[scheduler] error: %s" % exc, file=sys.stderr)
        stop.wait(interval)


def cmd_serve(args) -> None:
    from .web.app import App, serve
    from .web.views import register
    ctx = _ctx(args)
    if not db.scalar(ctx.conn, "SELECT COUNT(*) FROM users"):
        raise EditorialError("管理者がいません。先に create-user を実行してください。")
    host = args.host or ctx.config.admin.host
    port = args.port or ctx.config.admin.port
    if host not in ("127.0.0.1", "localhost", "::1") and not ctx.config.admin.secure_cookies:
        print("注意: 127.0.0.1 以外で待ち受けます。iPhoneから使う場合は Tailscale などの暗号化された経路か、"
              "HTTPSのリバースプロキシを使い、admin.secure_cookies を true にしてください。", file=sys.stderr)
    app = App(ctx)
    register(app)
    stop = threading.Event()
    if ctx.config.admin.run_scheduler or args.scheduler:
        t = threading.Thread(target=_scheduler_loop, args=(ctx.config, ctx.config.admin.scheduler_interval_sec, stop),
                             daemon=True)
        t.start()
        print("予約公開・定期更新のスケジューラを起動しました（%d秒ごと）" % ctx.config.admin.scheduler_interval_sec)
    try:
        serve(app, host, port)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()


def cmd_survey(args) -> None:
    ctx = _ctx(args)
    report = importer.survey(ctx, sample_products=args.samples)
    out = ctx.config.reports_dir / ("survey-%s.json" % timeutil.now().strftime("%Y%m%d-%H%M%S"))
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("取り込み元の調査結果（読み取りのみ・何も取り込んでいません）: %s" % out)
    for alias, info in report["roots"].items():
        print("  %s: %s" % (alias, "接続中" if info["available"] else "未接続"))
    for name, entry in report["entry_points"].items():
        status = "あり" if entry.get("exists") else "なし"
        missing = entry.get("missing_fields")
        print("  %-18s %s %s" % (name, status, ("不足項目: %s" % ", ".join(missing)) if missing else ""))
    print("  商品フォルダ: %d件" % report["products_dir"].get("count", 0))


def cmd_import(args) -> None:
    ctx = _ctx(args)
    asins = [a for a in (args.asins or "").replace(" ", ",").split(",") if a]
    if args.asins_file:
        asins += [line.strip() for line in Path(args.asins_file).read_text(encoding="utf-8").splitlines()
                  if line.strip() and not line.startswith("#")]
    _print(importer.import_products(ctx, _me(), asins, allow_many=args.allow_many))


def cmd_import_drafts(args) -> None:
    ctx = _ctx(args)
    _print(drafts.import_paths(ctx, _me(), args.paths))


def cmd_import_review_refs(args) -> None:
    ctx = _ctx(args)
    _print(review_refs.import_file(ctx, _me(), args.file))
    print("※ 収集済みレビューは本人の目視確認用です。公開ページ・AIへの入力には使われません。")


def cmd_export_claude(args) -> None:
    ctx = _ctx(args)
    ids = [int(x) for x in (args.articles or "").split(",") if x.strip()] or None
    print(bridge.export_tasks(ctx, _me(), ids, args.out))


def cmd_import_claude(args) -> None:
    ctx = _ctx(args)
    _print(bridge.import_proposals(ctx, _me(), args.file))


def cmd_events(args) -> None:
    ctx = _ctx(args)
    _print(bridge.export_events(ctx, args.since))


def cmd_polish(args) -> None:
    ctx = _ctx(args)
    art = articles.get(ctx, args.article)
    _print(polish.polish_article(ctx, _me(), args.article, art["head_version_id"]))


def cmd_check(args) -> None:
    ctx = _ctx(args)
    art = articles.get(ctx, args.article)
    report = checks.evaluate(ctx, args.article, art["head_version_id"], purpose="approve")
    _print({"blocks": [p.message for p in report.blocks], "warnings": [p.message for p in report.warnings]})


def cmd_tick(args) -> None:
    ctx = _ctx(args)
    _print(jobs.tick(ctx))


def cmd_refresh(args) -> None:
    ctx = _ctx(args)
    jobs.enqueue_refresh(ctx, _me(), "コマンドから実行")
    _print(jobs.run_due(ctx))


def cmd_amazon_refresh(args) -> None:
    ctx = _ctx(args)
    asins = [a for a in (args.asins or "").split(",") if a] or amazon_api.asins_in_use(ctx)
    _print(amazon_api.refresh(ctx, _me(), asins, force=args.force))


def cmd_policy_review(args) -> None:
    ctx = _ctx(args)
    keys = list(policy.SOURCES) if args.all else args.keys
    for key in keys:
        policy.record_review(ctx, _me(), key, args.checked_on or timeutil.today_jst().isoformat(),
                             args.summary or "", args.changes or "")
    print("記録しました: %s" % ", ".join(keys))


def cmd_serve_public(args) -> None:
    import functools
    import http.server
    ctx = _ctx(args)
    root = ctx.config.public_out_dir
    if not root.exists():
        raise EditorialError("まだ公開（ダミー）されたサイトがありません")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root.resolve()))
    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler) as httpd:
        print("ダミー公開先の確認用: http://127.0.0.1:%d/  （Ctrl+C で終了）" % args.port)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


def cmd_status(args) -> None:
    ctx = _ctx(args)
    by_state = {r["state"]: r["n"] for r in db.all_rows(ctx.conn, "SELECT state, COUNT(*) n FROM articles GROUP BY state")}
    _print({
        "articles": by_state,
        "live": db.scalar(ctx.conn, "SELECT COUNT(*) FROM articles WHERE publication_status='live'"),
        "products": db.scalar(ctx.conn, "SELECT COUNT(*) FROM products"),
        "assets": db.scalar(ctx.conn, "SELECT COUNT(*) FROM assets"),
        "holds_open": db.scalar(ctx.conn, "SELECT COUNT(*) FROM holds WHERE resolved_at IS NULL"),
        "jobs_failed": db.scalar(ctx.conn, "SELECT COUNT(*) FROM publish_jobs WHERE status='failed'"),
        "review_refs": review_refs.stats(ctx)["total"],
        "amazon_api": "設定済み" if ctx.amazon.configured else "未設定",
        "polish_command": ctx.config.polish.command[0],
        "settings_missing": [k for k in ("operator_name", "editor_name", "contact", "base_url", "site_name")
                             if settings.get(ctx, k) in ("", settings.PLACEHOLDER_OPERATOR, settings.DEFAULTS["site_name"])],
    })


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python3 -m editorial", description="非公開の編集管理と公開サイト生成")
    p.add_argument("--config", help="設定ファイル（既定: var/config.json または EDITORIAL_CONFIG）")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="データ保存先・DB・設定ひな形・固定ページの下書きを作る").set_defaults(fn=cmd_init)
    s = sub.add_parser("create-user", help="管理者（本人）を作る")
    s.add_argument("username")
    s.set_defaults(fn=cmd_create_user)
    s = sub.add_parser("set-password", help="パスワードを変更する")
    s.add_argument("username")
    s.set_defaults(fn=cmd_set_password)
    s = sub.add_parser("serve", help="管理画面を起動する")
    s.add_argument("--host")
    s.add_argument("--port", type=int)
    s.add_argument("--scheduler", action="store_true", help="予約公開・定期更新を自動で処理する")
    s.set_defaults(fn=cmd_serve)
    s = sub.add_parser("survey", help="取り込み元の形式を読み取り専用で調べる（取り込みはしない）")
    s.add_argument("--samples", type=int, default=3)
    s.set_defaults(fn=cmd_survey)
    s = sub.add_parser("import", help="指定した商品（5〜10件）を取り込む")
    s.add_argument("--asins", help="カンマ区切りのASIN")
    s.add_argument("--asins-file", help="1行1ASINのファイル")
    s.add_argument("--allow-many", action="store_true")
    s.set_defaults(fn=cmd_import)
    s = sub.add_parser("import-drafts", help="本人が用意したドラフト（.md / .json）を取り込む")
    s.add_argument("paths", nargs="+")
    s.set_defaults(fn=cmd_import_drafts)
    s = sub.add_parser("import-review-refs", help="収集済みレビューを本人の確認用として取り込む（非公開・AI入力不可）")
    s.add_argument("file")
    s.set_defaults(fn=cmd_import_review_refs)
    s = sub.add_parser("export-claude", help="Claude向けの依頼ファイルを書き出す")
    s.add_argument("--articles")
    s.add_argument("--out")
    s.set_defaults(fn=cmd_export_claude)
    s = sub.add_parser("import-claude", help="Claudeの提案ファイルを取り込む（提案として保存）")
    s.add_argument("file")
    s.set_defaults(fn=cmd_import_claude)
    s = sub.add_parser("events", help="変更イベントを書き出す（Claudeが承認済み等を読む用）")
    s.add_argument("--since", type=int, default=0)
    s.set_defaults(fn=cmd_events)
    s = sub.add_parser("polish", help="記事の文章を Antigravity CLI で整形する")
    s.add_argument("article", type=int)
    s.set_defaults(fn=cmd_polish)
    s = sub.add_parser("check", help="記事の公開前判定を表示する")
    s.add_argument("article", type=int)
    s.set_defaults(fn=cmd_check)
    sub.add_parser("tick", help="予約公開と定期更新を1回処理する（cron/launchd用）").set_defaults(fn=cmd_tick)
    sub.add_parser("refresh", help="Amazonデータ・許諾期限を更新してサイトを作り直す").set_defaults(fn=cmd_refresh)
    s = sub.add_parser("amazon-refresh", help="Creators API から商品データを取得する")
    s.add_argument("--asins")
    s.add_argument("--force", action="store_true")
    s.set_defaults(fn=cmd_amazon_refresh)
    s = sub.add_parser("policy-review", help="規約・ガイドラインの確認を記録する")
    s.add_argument("keys", nargs="*")
    s.add_argument("--all", action="store_true")
    s.add_argument("--checked-on")
    s.add_argument("--summary")
    s.add_argument("--changes")
    s.set_defaults(fn=cmd_policy_review)
    s = sub.add_parser("serve-public", help="ダミー公開先をローカルで表示する")
    s.add_argument("--port", type=int, default=8720)
    s.set_defaults(fn=cmd_serve_public)
    sub.add_parser("status", help="現在の状況を表示する").set_defaults(fn=cmd_status)
    return p


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.fn(args)
    except (EditorialError, ConfigError) as exc:
        print("エラー: %s" % exc, file=sys.stderr)
        problems = getattr(exc, "problems", None)
        for p in problems or []:
            print("  ・%s" % getattr(p, "message", p), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
