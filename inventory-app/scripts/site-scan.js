#!/usr/bin/env node
// ヤフオクの落札相場・ヤフーフリマ・ラクマの売り切れから候補を集め、公式画像（参考画像）とサムネイルを画像照合する下調べ。
// 結果は data/imports/<site>-scan/<商品ID>.json、サムネイルは同じ場所の img/
// （記録はしない。同じ/似たの判定は scripts/judge-decide.js、記録は apply-market --site <site>）。
//
// 使い方: node scripts/site-scan.js --site yahoo|paypay|rakuma --keywords a.json[,b.json…] [--ids 0003,0004] [--delay 4] [--force]
//   keywords: { "<商品ID>": ["主キーワード", "予備キーワード"] }（メルカリ用と同じファイルを使える）
// ログインはしない。Cookie を送らない普通の取得で、ページに埋め込まれた一覧データを読む。1件ごとに数秒あける。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dhash, ham, officialHashes } from './image-hash.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.INVENTORY_DATA || path.join(ROOT, 'data');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const SITE = opt('--site') || 'yahoo';
const OUT = path.join(DATA, 'imports', `${SITE}-scan`);
const IMG = path.join(OUT, 'img');
const DELAY = (Number(opt('--delay')) || 4) * 1000;
const FORCE = args.includes('--force');
const ONLY = opt('--ids') ? new Set(opt('--ids').split(',')) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * (0.8 + Math.random() * 0.5)));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

export const closedUrl = (kw) => `https://auctions.yahoo.co.jp/closedsearch/closedsearch?p=${encodeURIComponent(kw)}&va=${encodeURIComponent(kw)}&b=1&n=50`;
export const itemUrl = (auctionId) => `https://page.auctions.yahoo.co.jp/jp/auction/${auctionId}`;

/** The closed-auction list embedded in the page (Next.js data). */
export function parseClosed(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('一覧データが見つかりません（ページの形式が変わった可能性）');
  const items = JSON.parse(m[1])?.props?.pageProps?.initialState?.search?.items?.listing?.items || [];
  return items.filter((it) => it.auctionId && Number(it.price) > 0).map((it) => ({
    auctionId: it.auctionId,
    title: String(it.title || ''),
    price: Math.round(Number(it.price)),
    endTime: String(it.endTime || '').slice(0, 10),
    condition: it.itemCondition || '',
    bids: it.bidCount ?? null,
    image: it.imageUrl || '',
    url: itemUrl(it.auctionId),
  }));
}

export const rakumaUrl = (kw) => `https://fril.jp/s?query=${encodeURIComponent(kw)}&transaction=soldout&sort=created_at&order=desc`;
const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** ラクマの検索結果（売り切れで絞った一覧）: 商品ごとのリンクの属性から読む。 */
export function parseRakuma(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a href="(https:\/\/item\.fril\.jp\/[0-9a-f]+)" class="link_search_image"[\s\S]*?data-rat-item_name="([^"]*)"[\s\S]*?data-rat-price="(\d+)"[\s\S]*?data-original="([^"]+)"/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const id = m[1].split('/').pop();
    out.push({ auctionId: id, title: unesc(m[2]), price: Number(m[3]), endTime: '', condition: '', bids: null, image: unesc(m[4]), url: m[1] });
  }
  return out.filter((x) => x.price > 0);
}

export const paypayUrl = (kw) => `https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(kw)}?sold=1`;

/** ヤフーフリマ（旧PayPayフリマ）の売り切れ一覧（Next.js data）。 */
export function parsePaypay(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('一覧データが見つかりません（ページの形式が変わった可能性）');
  const items = JSON.parse(m[1])?.props?.initialState?.searchState?.search?.result?.items || [];
  return items.filter((it) => it.id && it.itemStatus === 'SOLD' && Number(it.price) > 0).map((it) => ({
    auctionId: it.id,
    title: String(it.title || ''),
    price: Math.round(Number(it.price)),
    endTime: String(it.endTime || '').slice(0, 10),
    condition: '',
    bids: null,
    image: it.thumbnailImageUrl || '',
    url: `https://paypayfleamarket.yahoo.co.jp/item/${it.id}`,
  }));
}

const SEARCH = { yahoo: { url: closedUrl, parse: parseClosed, img: /^https:\/\/[a-z0-9.-]+\.yimg\.jp\// }, rakuma: { url: rakumaUrl, parse: parseRakuma, img: /^https:\/\/img\.fril\.jp\// }, paypay: { url: paypayUrl, parse: parsePaypay, img: /^https:\/\/[a-z0-9.-]+\.yimg\.jp\// } };

async function readClosed(kw) {
  const site = SEARCH[SITE];
  const res = await fetch(site.url(kw), { headers: { 'user-agent': UA, 'accept-language': 'ja-JP,ja;q=0.9', accept: 'text/html' }, credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return site.parse(await res.text());
}

async function saveThumb(it) {
  const f = path.join(IMG, `${it.auctionId}.jpg`);
  if (!fs.existsSync(f)) {
    if (!SEARCH[SITE].img.test(it.image)) return null;
    const res = await fetch(it.image, { headers: { 'user-agent': UA }, credentials: 'omit' });
    if (!res.ok) return null;
    fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
  }
  return f;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(IMG, { recursive: true });
  const KW = Object.assign({}, ...(opt('--keywords') || '').split(',').filter(Boolean).map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))));
  const ids = Object.keys(KW).filter((id) => (!ONLY || ONLY.has(id)) && (FORCE || !fs.existsSync(path.join(OUT, `${id}.json`)))).sort();
  console.log(`対象 ${ids.length}件`);
  let n = 0;
  for (const id of ids) {
    try {
      const { product, hashes } = await officialHashes(id);
      const seen = new Map();
      const used = [];
      for (const kw of KW[id]) {
        const items = await readClosed(kw);
        used.push({ keyword: kw, url: SEARCH[SITE].url(kw), count: items.length });
        for (const it of items) if (!seen.has(it.auctionId)) seen.set(it.auctionId, { ...it, keyword: kw });
        if (seen.size >= 8) break;
        await sleep(DELAY);
      }
      const items = [...seen.values()].slice(0, 30);
      for (const it of items) {
        const f = await saveThumb(it).catch(() => null);
        const th = f ? await dhash(f).catch(() => null) : null;
        it.dist = th && hashes.length ? Math.min(...hashes.map((h) => ham(h, th))) : null;
        it.thumb = f ? path.relative(OUT, f) : null;
      }
      items.sort((a, b) => (a.dist ?? 99) - (b.dist ?? 99));
      fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify({ id, name: product.name, amazonPrice: product.research?.amazonPrice ?? product.amazon?.price ?? null, officialCount: hashes.length, searches: used, items, scannedAt: new Date().toISOString() }, null, 1));
      n++;
      const best = items[0];
      console.log(`${id} ${items.length}件 最小距離${best?.dist ?? '-'} ${best ? `${best.price}円 ${best.title.slice(0, 30)}` : ''}`);
    } catch (e) {
      console.log(`${id} エラー ${e.message}`);
      if (/HTTP (403|429|503)/.test(e.message)) {
        console.log('アクセス制限のため中止（時間をおいて再実行すると続きから）');
        break;
      }
    }
    await sleep(DELAY);
  }
  console.log(`完了 ${n}件 → ${path.relative(ROOT, OUT)}`);
}
