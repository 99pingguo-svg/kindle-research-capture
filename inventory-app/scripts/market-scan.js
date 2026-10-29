#!/usr/bin/env node
// メルカリの売り切れ一覧から候補を集め、公式画像（参考画像）とサムネイルを画像照合する下調べ。
// 結果は data/imports/market-scan/<商品ID>.json（記録はしない。同じ/似たの判定と記録は Claude が save_market_research で行う）。
//
// 使い方: node scripts/market-scan.js --keywords data/imports/market-keywords.json [--ids 0003,0004] [--delay 6] [--force]
//   keywords: { "<商品ID>": ["主キーワード", "予備キーワード"] }
// ログインはしない（公開の検索ページだけを読む）。1件ごとに数秒あける。Playwright（WebKit）を使う。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dhash, ham, officialHashes } from './image-hash.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.INVENTORY_DATA || path.join(ROOT, 'data');
const OUT = path.join(DATA, 'imports', 'market-scan');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const KW = JSON.parse(fs.readFileSync(opt('--keywords') || path.join(DATA, 'imports', 'market-keywords.json'), 'utf8'));
const ONLY = opt('--ids') ? new Set(opt('--ids').split(',')) : null;
const DELAY = (Number(opt('--delay')) || 6) * 1000;
const FORCE = args.includes('--force');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const require = createRequire(process.env.PLAYWRIGHT_FROM || '/Users/yoshikuni/.hermes/node/lib/node_modules/');
const { webkit } = require('playwright');

export const soldUrl = (kw) => `https://jp.mercari.com/search?keyword=${encodeURIComponent(kw)}&status=sold_out&sort=created_time&order=desc`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-scan-'));

async function readSearch(page, kw) {
  await page.goto(soldUrl(kw), { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('a[href*="/item/"], a[href*="/shops/product/"]', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return page.evaluate(() => [...document.querySelectorAll('a[href*="/item/"], a[href*="/shops/product/"]')]
    .filter((a) => !/ad_id=/.test(a.href))
    .map((a) => {
      const alt = a.querySelector('img')?.alt || a.getAttribute('aria-label') || '';
      return {
        title: alt.replace(/のサムネイル.*$/, '').replace(/の画像.*$/, '').trim(),
        sold: /売り切れ/.test(alt) || /SOLD/.test(a.innerText),
        price: Number((a.innerText.match(/[\d,]{2,}/) || [''])[0].replace(/,/g, '')) || null,
        url: a.href.split('?')[0],
      };
    }));
}

async function thumbHash(url) {
  const m = /\/item\/(m\d+)/.exec(url);
  if (!m) return null;
  const res = await fetch(`https://static.mercdn.net/c!/w=240/thumb/photos/${m[1]}_1.jpg`);
  if (!res.ok) return null;
  const f = path.join(TMP, `${m[1]}.jpg`);
  fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
  const h = await dhash(f).catch(() => null);
  fs.rmSync(f, { force: true });
  return h;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(OUT, { recursive: true });
  const ids = Object.keys(KW).filter((id) => (!ONLY || ONLY.has(id)) && (FORCE || !fs.existsSync(path.join(OUT, `${id}.json`))));
  console.log(`対象 ${ids.length}件`);
  const browser = await webkit.launch();
  const page = await (await browser.newContext({ locale: 'ja-JP' })).newPage();
  let n = 0;
  for (const id of ids) {
    try {
      const { product, hashes } = await officialHashes(id);
      const seen = new Map();
      const used = [];
      for (const kw of KW[id]) {
        const items = (await readSearch(page, kw)).filter((x) => x.sold && x.price);
        used.push({ keyword: kw, url: soldUrl(kw), count: items.length });
        for (const it of items) if (!seen.has(it.url)) seen.set(it.url, { ...it, keyword: kw });
        if (seen.size >= 8) break;
        await sleep(DELAY);
      }
      const items = [...seen.values()].slice(0, 24);
      for (const it of items) {
        const th = await thumbHash(it.url).catch(() => null);
        it.dist = th && hashes.length ? Math.min(...hashes.map((h) => ham(h, th))) : null;
      }
      items.sort((a, b) => (a.dist ?? 99) - (b.dist ?? 99));
      fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify({ id, name: product.name, amazonPrice: product.research?.amazonPrice ?? product.amazon?.price ?? null, officialCount: hashes.length, searches: used, items, scannedAt: new Date().toISOString() }, null, 1));
      n++;
      const best = items[0];
      console.log(`${id} ${items.length}件 最小距離${best?.dist ?? '-'} ${best ? `${best.price}円 ${best.title.slice(0, 30)}` : ''}`);
    } catch (e) {
      console.log(`${id} エラー ${e.message}`);
    }
    await sleep(DELAY);
  }
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`完了 ${n}件 → ${path.relative(ROOT, OUT)}`);
}
