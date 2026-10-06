# 受入テストの対応表（企画書8章）

`python3 -m unittest discover -s tests -t tests` で実行します（合成データのみ。Python 3.9 / 3.11 / 3.13 で確認）。

| 企画書のテスト | 合格条件 | テスト |
| --- | --- | --- |
| 未承認と改訂 | 下書き・不採用は公開不可。承認後の本文・画像変更で未公開の承認と予約が無効 | `test_01_approval_and_revision.py` |
| 素材の権利 | 品質採用でも権利未確認・不可・期限切れなら公開不可。加工許可のない素材はトリミング不可 | `test_02_rights.py` |
| ASINとリンク | 別商品のASIN、壊れたURL、未設定・不正なトラッキングIDを検出して停止 | `test_03_asin_links.py` |
| Amazonデータ期限 | 期限切れ・API失敗時に古い画像・情報を残さない。画像本体を保存しない | `test_04_amazon_data.py` |
| 予約と二重実行 | 日本時間の指定日時に同じ版が1度だけ公開。二重送信・複数ワーカー・過去日時 | `test_05_schedule_idempotency.py` |
| 失敗と復元 | 途中失敗を成功扱いにしない。同じ命令を安全に再試行。取り下げと復元 | `test_06_failure_restore.py` |
| スマートフォン | 本文修正・画像選択・差戻し・個別/一括承認・予約取消。二重送信と未保存の検知 | `test_07_mobile_web.py` |
| 同期と同時編集 | 同じ取り込みで重複しない。差分のみ。本人の修正を上書きしない。切断・欠落を通知 | `test_08_import_sync.py` |
| 情報漏えいと不正入力 | 未認証で取得不可。公開データにパス・注文情報なし。原稿内の命令文で状態が変わらない | `test_09_privacy_security.py` |
| 表示と検索設定 | 読めるHTML、広告表示、sponsored、canonical、サイトマップ、alt、構造化データの整合 | `test_10_display_seo.py` |
| （追加）文章整形 | 公開文章はすべて整形を通す。整形後の文章変更は再整形が必要。出力の検査 | `test_11_polish.py` |
| （追加）コマンド | 初期化・管理者作成・調査・判定がコマンドで動く | `test_12_cli.py` |
| （追加）Claude の MCP | トークン認証・Origin 確認。読めるのは AI 可の情報だけ、書けるのは提案・コメント・メーカー情報メモだけ | `test_13_mcp.py` |

実機の iPhone での操作感と、実際の Antigravity CLI・Creators API との接続は、この環境では確認できていません
（Antigravity CLI はコマンドの代わりに同じ呼び出し方の偽スクリプトで、Creators API は公式SDKと同じ要求形式の偽応答で検証しています）。
