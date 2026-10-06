# 編集管理アプリと商品紹介サイト（最小版）

Amazon.co.jp 向けの商品紹介サイトを、**本人が承認した版だけ**公開するための非公開の編集管理アプリです。
Mac と iPhone のブラウザから使います。399商品プロジェクトの既存データを読み取り専用で取り込み、
最初の 5〜10 商品で「取り込み → ドラフト → 文章整形 → 確認・修正 → 承認 → 公開」を一巡させることを目標にしています。

> このフォルダにはプログラムと合成データ（テスト用）だけを置いています。商品データ・原稿・画像・
> 収集済みレビュー・設定ファイル（パスや認証情報）は `var/` に保存され、Git には入りません。
> このリポジトリは公開リポジトリなので、実データやパスをコミットしないでください。

## 流れ

```
取り込み（読み取り専用）／本人のドラフト
  → Antigravity CLI で文章整形（公開する文章はすべて通す）
  → 本人が確認・修正（差分表示、Mac/iPhone のプレビュー）
  → 本人が「この版」を承認（版ID＋ハッシュ＋広告表示などの設定を固定）
  → 即時公開 または 予約公開（日本時間で指定）
  → 公開前の再検査 → 検証済みのビルドだけを公開先へ切り替え
```

- 公開先は現在 **ダミー（ローカルのフォルダ `var/public_site`）** です。実際の一般公開は、公開先と対象を本人が決めてから設定します。
- 予約公開・定期更新は、手動実行（管理画面のボタンや `tick` コマンド）が基本です。自動にする場合だけ `--scheduler` を付けます。

## Mac での準備

必要なもの: Python 3.9 以上（Mac 標準の `python3` で可）と Jinja2。

```bash
cd affiliate-editorial
python3 -m pip install --user -r requirements.txt
python3 -m editorial init                 # var/ と設定ひな形・固定ページの下書きを作る
open var/config.json                      # 取り込み元 O/OP/R/S のパスを書き換える（このファイルは公開しない）
python3 -m editorial create-user owner    # 本人用の管理者（1名のみ）
python3 -m editorial serve                # http://127.0.0.1:8710/
```

### まず試してみる（デモ）

実データを入れる前に、架空の商品で画面と流れを試せます（実データとは別のフォルダに作ります）。

```bash
python3 -m editorial demo                                      # var-demo/ を作る
EDITORIAL_CONFIG=var-demo/config.json python3 -m editorial serve
# http://127.0.0.1:8711/  ユーザー demo / パスワード demo-password-1234
EDITORIAL_CONFIG=var-demo/config.json python3 -m editorial serve-public   # 公開側の見え方
```

デモでは文章整形を「デモ用（整形なし）」で代用しています。不要になったら `var-demo/` を削除してください。

### Antigravity CLI（文章整形）

`var/config.json` の `polish.command` で呼び出し方を指定します（既定は `["agy", "-p", "{prompt}"]`）。
事前に Antigravity CLI をインストールしてログインしておいてください。整形では記事の文章だけを JSON で渡し、
返ってきた JSON の項目・空欄・長さを検査してから新しい版として保存します。整形後に文章を直した場合は再整形が必要です
（公開前の判定で止まります）。数値が増えた場合などは承認時の確認事項として表示されます。

### iPhone から使う（商品台帳と同じく Tailscale 推奨）

管理画面は既定で `127.0.0.1`（Mac の中だけ）で待ち受けます。iPhone からは Tailscale Serve で HTTPS にして使います。

1. Mac と iPhone に Tailscale を入れ、同じアカウントでログインする。
2. Mac で `tailscale serve --bg 8710` を実行し、表示された `https://<mac名>.<tailnet>.ts.net` を iPhone の Safari で開く。
3. `var/config.json` の `admin.secure_cookies` を `true` にする（HTTPS 前提の Cookie になります）。

商品台帳（8787番）と同時に使う場合は、`tailscale serve --bg --https=8443 8710` のように別のポートを割り当ててください。
ログインは本人1名、セッションは12時間で切れます。

### Claude と共同で管理する（MCP）

商品台帳と同じく、Claude はアプリの MCP（`/mcp`）から直接作業できます。

```bash
python3 -m editorial create-ai-token claude-mac   # 表示された値を控える（再表示されません）
export EDITORIAL_MCP_TOKEN=ed_xxxxxxxx              # Claude を起動するシェルで設定
python3 -m editorial serve                         # 管理画面と /mcp を起動
claude                                             # affiliate-editorial/ で起動すると .mcp.json と手順書が読み込まれます
```

Claude ができるのは、記事・修正指示・公開前判定・AIに使ってよいメモを読み、下書きや修正案を「提案」として保存し、
コメントやメーカー公開情報のメモを残すところまでです。承認・公開・予約・整形・素材の権利・設定は本人だけが行います。
収集済みレビュー・Amazon のデータ・選定メモは Claude に渡りません。頼み方の例: 「修正指示を処理して」「確認待ちの記事で公開を止めている理由をまとめて」。
不要になったトークンは `revoke-ai-token claude-mac` で取り消せます。

## 日々の使い方

| やりたいこと | 操作 |
| --- | --- |
| 既存データの形式を確かめる | `python3 -m editorial survey`（読み取りのみ。結果は `var/reports/`） |
| 5〜10商品を取り込む | `python3 -m editorial import --asins B0XXXXXXXX,B0YYYYYYYY` |
| 本人のドラフトを入れる | `python3 -m editorial import-drafts drafts/`、または編集画面の「ドラフトを貼り付けて取り込む」 |
| 収集済みレビューを確認用に入れる | `python3 -m editorial import-review-refs reviews.json`（非公開・AI入力不可） |
| 文章を整形する | 編集画面の「文章を整形する」、または `python3 -m editorial polish <記事ID>` |
| 素材の権利・品質を記録する | 商品・素材 → 素材 → 「権利の記録」「品質判定」 |
| 承認・予約・公開・取り下げ・復元 | 編集画面の「確認・承認」タブ |
| まとめて承認する | 「一括承認」（件数・商品名・版・除外件数を確認して承認） |
| Claude に修正を頼む | 記事に修正指示を残し、Claude に「修正指示を処理して」と頼む（MCP）→ 履歴タブで提案の差分を見て採用。MCP を使わない場合は依頼ファイルの書き出し／`import-claude` |
| 規約の確認を記録する | 「規約確認」（公開に必要な資料の確認が古いと公開が止まります） |
| ダミー公開先を見る | `python3 -m editorial serve-public` → http://127.0.0.1:8720/ |

### ドラフトの書式

```markdown
---
asin: B0XXXXXXXX
---
# 記事タイトル
概要（最初の見出しまでの文章）

## 何に使うか
…
## 向く人・向かない人
- …
## 選ぶときのポイント
…
## 購入前の注意
…
## 確認できた仕様
…
```

見出しが上の5つに当たる部分はその欄に入り、それ以外の見出しは追加の見出しになります。本人がすでに手を入れた記事では、
ドラフトは上書きせず「提案」として保存されます。

**レビューを参考にした内容の書き方**: 「レビューでは〜」「購入者の声」「★4.3」のように、レビューや星評価を出典として示す書き方は
公開前の検査で止まります（Amazon の規約上、公式API以外のレビュー・評価は表示・利用できません）。
分析で得た共通点は「〜が気になる人は、購入前に〇〇を確認しておくと安心です」のように、運営者自身の案内として書いてください。
収集済みレビューと同じ文（24文字以上）が含まれる場合も止まります。

## 守っていること（抜粋）

- 承認は「特定の版」に付き、版ID・内容ハッシュ・公開設定（広告表示・トラッキングID・運営者名など）を固定します。承認後に本文・画像・並び順・リンク・設定が変わると、未公開の承認と予約は無効になります。
- 公開処理は承認した版だけを扱い、「最新の下書き」を自動で公開しません。二重クリック・再送・複数ワーカーでも同じ公開は1回だけです。
- 画像は品質判定と権利判定を別に管理し、権利確認済み・商用可・期限内の素材だけを公開に使えます。Amazon 由来の素材は加工しても公開できません。トリミングは加工許可がある素材だけです。
- Amazon の商品画像は保存せず、Creators API の画像URLを無加工で表示します。24時間以内に更新できないデータは表示しません（画像なしのテキストリンクになります）。
- 公開用のデータは許可項目だけで作り、ローカルパス・注文情報・内部メモ・認証情報・画像のEXIFが出ないことを公開前に検査します。
- 取り込み元のフォルダは読み取り専用で開き、ハッシュが合わないもの・由来が分からないものは保留一覧に送ります。

Mac 上の Claude への引き継ぎは [docs/HANDOFF.md](docs/HANDOFF.md)。詳しくは [docs/DESIGN.md](docs/DESIGN.md)（設計）、[docs/OPERATIONS.md](docs/OPERATIONS.md)（運用）、
[docs/COMPLIANCE.md](docs/COMPLIANCE.md)（規約の確認結果と未確認事項）、[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)（受入テスト）を見てください。

## テスト

```bash
python3 -m unittest discover -s tests -t tests
```

合成データだけで、企画書8章の受入テスト（未承認と改訂、素材の権利、ASINとリンク、Amazonデータ期限、予約と二重実行、
失敗と復元、スマートフォン操作、同期と同時編集、情報漏えいと不正入力、表示と検索設定）と文章整形・CLIを確認します。
Claude 用 MCP の権限境界（`test_13_mcp.py`）も確認します。Python 3.9 / 3.11 / 3.13 で確認済みです。
