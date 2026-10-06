# 運用手順

## 最初の一巡（5〜10商品）

1. `python3 -m editorial init` → `var/config.json` に取り込み元 O / OP（O の親）/ R / S のパスを書く。
2. `python3 -m editorial survey` で形式を確認する（何も取り込まない）。不足項目や想定外の形式があれば、取り込み前に相談する。
3. 対象の ASIN を5〜10件選び、`python3 -m editorial import --asins …`。保留一覧を確認する。
4. 管理画面の「設定」でサイト名・運営者名・編集責任者・問い合わせ・公開URL（仮でも可）を入れる。
5. 「規約確認」で必要な資料を読み、確認を記録する。
6. 固定ページ about / privacy の下書きを直し、整形 → 確認依頼 → 承認 → 公開（ダミー）する。
7. 商品ごとに: ASIN の対応を確認 → 素材の権利と品質を記録 → ドラフトを取り込む → 整形 → 確認・修正 → 承認 → 公開（ダミー）。
8. `python3 -m editorial serve-public` でダミー公開先を Mac と iPhone で確認する。

一般公開（実際のドメインへの公開）は、公開先・対象・時期を本人が承認してから設定します。

## アソシエイトとAPI

- アソシエイトのアカウント作成・ログイン・申請はご本人が行います。トラッキングID（`xxxx-22`）が決まったら「設定」に入力し、
  収益化モードを「Amazonアソシエイトのリンク付き」にします（未公開の承認は再承認が必要になります）。
- Creators API は、利用資格（直近30日で適格販売10件など）を満たしてから認証情報を作成し、`var/config.json` の
  `amazon.enabled / credential_id / version` と、環境変数 `EDITORIAL_AMAZON_CREDENTIAL_SECRET` を設定します。
- API を使い始めたら、Amazon データを24時間以内に保つため `python3 -m editorial tick` を数時間おきに実行します
  （`serve --scheduler` でも可）。launchd の例:

```xml
<!-- ~/Library/LaunchAgents/local.editorial.tick.plist（例。設定は本人が判断してから） -->
<key>ProgramArguments</key>
<array><string>/usr/bin/python3</string><string>-m</string><string>editorial</string><string>tick</string></array>
<key>WorkingDirectory</key><string>/path/to/affiliate-editorial</string>
<key>StartInterval</key><integer>10800</integer>
```

## 失敗したとき

- 公開ジョブが失敗した場合、公開先は直前の状態のままです。「公開ジョブ」で原因を確認し、内容の問題なら記事を直して再承認、
  一時的な問題なら「同じ命令を再試行」を押します。
- 取り下げは記事の「確認・承認」タブから。過去の承認版は「過去の承認版を復元する」から、権利を再検査して公開します。
- 取り込み元に接続できない場合は何も変更しません。Mac の接続を確認してから実行し直します。

## Claude との分担

- 基本は MCP: 記事に修正指示を残し、`affiliate-editorial/` で起動した Claude Code に「修正指示を処理して」と頼みます
  （手順書 `.claude/skills/editorial-ai/SKILL.md`）。Claude の提案は編集画面の「履歴」タブで差分を見て採用・見送りを選びます。
  提案は本人の文章を上書きせず、状態も変えません。
- MCP を使わない場合は「Claude への依頼ファイルを書き出す」（`export-claude`）→ 提案ファイルを `import-claude <file>` で取り込み。
  どちらも、Claude に渡るのは記事の文章・修正指示・本人が「AI入力可」にした調査メモと原稿だけです。
- `python3 -m editorial events --since <番号>` で承認・公開などの変更を時系列で読めます。

## バックアップ

`var/` を丸ごと（暗号化したディスクなど非公開の場所へ）バックアップしてください。DB・非公開素材・ビルド・設定が含まれます。
公開リポジトリやクラウドの公開領域には置かないでください。
