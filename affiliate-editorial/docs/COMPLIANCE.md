# 規約・ガイドラインの確認結果（2026年10月5日時点）

この作業環境からは `affiliate.amazon.co.jp` などの公式ページに直接接続できなかったため、以下は
**Web検索の結果と、Amazon が公開している Creators API の公式 Python SDK（Apache-2.0）のソース**から確認した内容です。
公開前に、本人が公式ページ（アソシエイト・セントラル）で現行の文面を確認し、管理画面の「規約確認」に記録してください。

## 1. カスタマーレビューと星評価

- アソシエイト・プログラム・ポリシーには、Product Advertising API（現 Creators API）で取得し、その要件に従う場合を除き、
  カスタマーレビューや星評価を「全部または一部でも」サイトで表示・使用しない旨の規定があると、複数の資料で確認しました。
- Creators API で取得できるのは `customerReviews.starRating` と `customerReviews.count` です。レビュー本文を取得する項目はありません
  （公式 SDK の `GetItemsResource` で確認）。

**アプリでの扱い**
- 星評価は「星評価の扱い」を `require_api_min` にした場合だけ、Creators API の値を24時間以内に更新して表示します。
  基準（既定 4.1）を下回った記事は定期更新で自動的に取り下げます。API の利用資格を得るまでは `none`（使わない）にしてください。
- 本文中の「★」「星4.5」「レビューでは〜」「購入者の声」などの表現は、公開前の検査で止めます。
- 収集済みレビュー（別プロジェクトで本人が集めたもの）は、本人が目で見て確認するための非公開資料として取り込めます。
  公開ページ・Claude への依頼ファイル・Antigravity CLI には一切渡しません。記事本文にレビューと同じ文（24文字以上）が含まれる場合は公開を止めます。
- レビューを自動で集める機能（スクレイピング）は作っていません。ログインの有無にかかわらず、Amazon の利用規約は自動的なデータ収集を禁じています。

## 2. 生成AIの利用

- 参加要件の改定で、プログラム・コンテンツ（商品情報・画像・レビューなど）と特別リンクを生成AIに関連して使用できない旨が明記されたことを確認しました。
- 2026年4月20日施行の運営規約改定で、AIや機械学習を使って作成したコンテンツには「AIにより作成」等の適切な表示が必要になりました。
  校正・翻訳などの一部利用も対象とする解説が多く、コンテンツに触れる前の目立つ位置での表示が推奨されています。

**アプリでの扱い**
- 公開する文章はすべて Antigravity CLI を通すため、全記事の冒頭に「AIにより作成」のラベルと説明文を表示し、フッターにも記載します（文言は設定で変更可）。
- Antigravity CLI と Claude に渡すのは、記事の文章と本人が「AI入力可」にした調査メモ・原稿だけです。Amazon 由来の情報
  （`source_original.json`、API の商品データ、収集済みレビュー）は渡しません。
- 本人のドラフトはご本人の分析にもとづく文章として扱いますが、レビューの言い回しが残っていると上記の検査で止まります。

## 3. 商品画像と商品データ

- SiteStripe の画像リンクは終了しています。画像は Creators API の `images.primary.*` の URL を無加工で表示します。
- 商品データと画像URLは24時間以内に更新が必要です。画像本体は保存・キャッシュ・中継しません（ビルド成果物・CDN・Service Worker を含む）。
- 承認後に API の画像が別の画像に変わった場合は、承認し直すまで画像を表示しません。
- PA-API 5 は 2026年5月15日に廃止され、Creators API に移行済みです。Creators API の利用には、承認済みアカウントに加えて
  **直近30日で10件の適格販売**が必要とされています（申請審査の「180日以内に3件」とは別の条件）。

**Creators API の呼び出し方（公式 SDK で確認）**
- 認証: OAuth2 client credentials。資格情報のバージョン 3.3 は `https://api.amazon.co.jp/auth/o2/token`（スコープ `creatorsapi::default`）、2.x は Cognito。
- 取得: `POST https://creatorsapi.amazon/catalog/v1/getItems`、ヘッダー `x-marketplace: www.amazon.co.jp`、本文 `{"partnerTag", "itemIds"(最大10), "resources"}`。

## 4. 広告表示（ステルスマーケティング対策）

- 記事冒頭に「広告」ラベルと「この記事にはアフィリエイト広告（Amazonアソシエイト）を含みます。」、サイト全体に
  「Amazonのアソシエイトとして、［運営名］は適格販売により収入を得ています。」を表示します（運営者名が未設定なら公開できません）。
- 商品提供・依頼がある記事は、関係の説明を記事冒頭に表示します。

## 5. 気をつけたい表現

- 「サクラなし」「信頼度が高い」などの断定は裏付けを示しにくく、景品表示法上のリスクがあります（確認事項として表示）。
- サイト名・ドメインに Amazon の商標を含めること、Amazon が推奨・保証しているように見せることは避けてください（「Amazonが認めた」などは止めます）。
- Amazon Vine のレビュー情報は API で取得・確認できないため、サイトに表示しません。

## 6. 公開前に本人が確認すること

1. アソシエイト・セントラルで、プログラム・ポリシー（レビュー・星評価・生成AI・画像）と運営規約の最新文面を読み、「規約確認」に記録する。
2. アカウント・登録サイト・トラッキングIDを設定する（ログインや作成はご本人が行い、IDだけを設定画面に入力します）。
3. Creators API は利用資格を満たしてから認証情報を作り、`var/config.json` または環境変数に設定する（Git には入れない）。

### 参照した情報源
- Amazon アソシエイト・プログラム・ポリシー: https://affiliate.amazon.co.jp/help/operating/policies/
- 運営規約の更新履歴: https://affiliate.amazon.co.jp/help/operating/compare
- Creators API の導入について: https://affiliate.amazon.co.jp/help/node/topic/G42ZATP8USCMBDDH
- Creators API のリソース一覧（Nager.AmazonCreatorsApi）: https://github.com/nager/Nager.AmazonCreatorsApi/blob/main/Resources.md
- Creators API 公式 Python SDK（python-amazon-paapi 7.1.0 に同梱の `creatorsapi_python_sdk`）
- 2026年4月20日改定の解説: https://ai.mixhost.jp/guide/amazon-associate-ai-created/ ほか
