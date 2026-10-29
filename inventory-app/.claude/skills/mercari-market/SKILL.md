---
name: mercari-market
description: 商品台帳の商品について、メルカリ・ヤフオク・ラクマで最近売れた価格（売り切れ・落札相場）を調べて記録する手順。「相場を調べて」と頼まれたときだけ使う。同じ商品は画像照合が基本、無ければ似た商品。多数はローカルAIで。
---

# メルカリ相場（売り切れ）の調べ方

頼まれたときだけ行う（定期実行しない）。ブラウザは内蔵ブラウザ（ログイン不要。メルカリにも Google にもサインインしない）。

## 1. 対象を取る
MCP `market_queue`（ids を指定 / 省略時は未調査・30日より古いもの）。各商品に `officialImage`（Amazon の公式画像）、`imageUrl`（その画像での画像検索）、`soldUrl`（商品名での売り切れ検索）、送料の目安がある。

## 2. 同じ商品を探す（基本）
1. `imageUrl`（Google レンズ）を開き、同じ見た目の商品の別名・ブランド・型番・特徴語を拾う。
2. その言葉で メルカリの売り切れ検索を開く:
   `https://jp.mercari.com/search?keyword=<言葉>&status=sold_out&sort=created_time&order=desc`
3. 一覧を読み取る（広告 `ad_id=` は除く）:
   ```js
   [...document.querySelectorAll('a[href*="/item/"], a[href*="/shops/product/"]')].filter(a=>!/ad_id=/.test(a.href)).map(a=>{const alt=a.querySelector('img')?.alt||'';return {title:alt.replace(/のサムネイル.*$/,''), sold:/売り切れ/.test(alt), price:Number((a.innerText.match(/[\d,]+/)||[''])[0].replace(/,/g,''))||null, url:a.href.split('?')[0]}})
   ```
4. 画面を見て、公式画像と**形・色・付属品・数量が同じ**ものだけを `same` にする。タイトルが似ていても見た目が違えば `similar`。

## 3. 無ければ似た商品
同じ用途・同じくらいの品質・同じ数量のものを `similar` として 3〜8 件。純正品と互換品、セット数違い、中古と新品の差は note に書く。極端な値（別物・ジャンク・まとめ売り）は入れない。

## 4. 記録
MCP `save_market_research`:
- `match_type`: same / similar / none（どちらの相場か）
- `method`: image（画像検索で同じ物を見つけた）/ keyword
- `query`, `search_url`（実際に使った売り切れ検索の URL）
- `examples`: 売れた例 {title, price, url(jp.mercari.com の商品ページ), match}
- `note`: 同じ物が無かった理由、除外したもの

中央値・手取り（相場 − 手数料10% − いちばん安いメルカリ便の送料、仕入れ額は含まない）はサーバーが計算する。価格の確定はユーザーだけ。

## 多数をまとめて（ヤフオク・ラクマ・メルカリ）— ローカルAIで安く、精度は落とさない
Claude が1件ずつ見ると使用量が大きいので、候補の判定は Mac 上のローカルAI（無料）に任せる。
1. キーワード: `data/imports/market-keywords*.json`（{ID: [主, 予備]}）。無い商品は Claude が短い検索語を作って足す。
2. 候補集め: `node scripts/site-scan.js --site yahoo|paypay|rakuma --keywords <files>`（メルカリは `market-scan.js`）。ログイン・Cookie なし、数秒おき。
3. 判定: `node scripts/judge-tasks.js --site <site> > tasks.jsonl` → `python3 scripts/local_judge.py --backend ollama:qwen3.5:4b --in tasks.jsonl --out r.jsonl`
4. 決定: `node scripts/judge-decide.js --site <site> --results r.jsonl > dec.json` → `node scripts/apply-market.js dec.json --site <site>`
- 同じ商品は「公式画像とほぼ同じ写真」（dHash 距離10以下、AIが同じと言えば12以下）だけ。AI の「同じ」単独は半分が似た商品だった（2026-10-29、Claude 判定済み約600候補で確認）。
- LFM3-VL-2B（外付けSSD）も試したが「同じ」の一致率が qwen3.5:4b より低いので既定は qwen3.5:4b。
