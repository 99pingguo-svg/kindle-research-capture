#!/usr/bin/env node
// 公開用アプリの素材キット: 商品台帳から「外に出してよいもの」だけを書き出す（読むだけ・台帳は変えない）。
//   node scripts/export-public.js [--out exports/public-kit] [--with-own-photos]
// 入れるもの: 商品名・種類・説明原稿・価格・大きさ/送料の目安・相場の集計・手取りの見込み・AI仕上げの商品写真。
// 入れないもの: メモ・注文日/到着日/購入価格などの購入記録・Amazon管理番号・保管場所・AI作業の記録・
//   Amazon の公式画像（権利は Amazon と出品者）・AI紹介画像（出どころ要確認）・撮ったままの写真（--with-own-photos のときだけ）。
// 書き出しは毎回作り直す（古いキットは exports/ の中で置き換え）。サーバー（http://127.0.0.1:8787）が動いていること。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(ROOT, opt('--out', 'exports/public-kit'));
const WITH_OWN = args.includes('--with-own-photos');
const BASE = process.env.DAICHO_URL || 'http://127.0.0.1:8787';
const DATA = path.join(ROOT, 'data', 'products');

const get = async (url) => {
  const r = await fetch(`${BASE}${url}`, { headers: { 'x-actor': 'claude' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
};

const SITE = { mercari: 'メルカリ', paypay: 'ヤフーフリマ', rakuma: 'ラクマ', yahoo: 'ヤフオク' };
const marketOf = (m) => (m && m.median != null && ['same', 'similar'].includes(m.matchType)
  ? { median: m.median, low: m.low ?? null, high: m.high ?? null, count: m.count ?? 0, match: m.matchType, checkedAt: (m.checkedAt || '').slice(0, 10) || null }
  : null);

function photosOf(p, outDir) {
  const out = [];
  const listing = new Set(p.listingPhotoIds || []);
  const pick = p.photos.filter((ph) => !ph.deletedAt && ph.kind === 'actual' && (ph.source === 'studio' || (WITH_OWN && !ph.derivedFrom)));
  // Listing photos first, in the listing order; then the rest.
  pick.sort((a, b) => (listing.has(b.id) - listing.has(a.id)) || (p.listingPhotoIds.indexOf(a.id) - p.listingPhotoIds.indexOf(b.id)));
  for (const ph of pick) {
    const src = path.join(DATA, p.id, ph.files.work || ph.files.original);
    if (!fs.existsSync(src)) continue;
    const name = `${p.id}-${ph.id}.jpg`;
    fs.copyFileSync(src, path.join(outDir, name));
    const thumbSrc = path.join(DATA, p.id, ph.files.thumb || ph.files.work);
    if (fs.existsSync(thumbSrc)) fs.copyFileSync(thumbSrc, path.join(outDir, `${p.id}-${ph.id}.thumb.jpg`));
    out.push({
      file: `photos/${name}`,
      thumb: `photos/${p.id}-${ph.id}.thumb.jpg`,
      kind: ph.source === 'studio' ? 'finished' : 'own',
      background: ph.edit?.style || null,
      inListing: listing.has(ph.id),
      width: ph.width || null,
      height: ph.height || null,
    });
  }
  return out;
}

const summaryList = await get('/api/products');
fs.rmSync(OUT, { recursive: true, force: true });
const photoDir = path.join(OUT, 'photos');
fs.mkdirSync(photoDir, { recursive: true });

const products = [];
for (const s of summaryList) {
  if (s.trashedAt) continue;
  const p = await get(`/api/products/${s.id}`);
  const sm = p.summary;
  const L = p.listing || {};
  const am = p.amazon || {};
  const dims = sm.ship?.dims;
  products.push({
    id: p.id,
    name: p.name || '',
    category: sm.category || '',
    brand: p.brand || '',
    model: p.model || '',
    color: p.color || '',
    jan: p.jan || '',
    status: { decision: p.decision, archived: !!p.archived, targets: p.targets || [] },
    listing: { title: L.title || '', description: L.description || '', condition: L.condition || '', price: L.price ?? null },
    size: dims ? { cm: [dims.L, dims.W, dims.H], kg: dims.kg ?? null, estimated: !!dims.estimated } : null,
    shipping: sm.ship?.cheapest ? { label: sm.ship.cheapest.label, price: sm.ship.cheapest.price } : null,
    amazon: am.asin ? { asin: am.asin, url: `https://www.amazon.co.jp/dp/${am.asin}`, title: am.title || '', price: p.research?.amazonPrice ?? am.price ?? null } : null,
    market: Object.fromEntries(Object.entries({ mercari: p.market, paypay: p.marketPaypay, rakuma: p.marketRakuma, yahoo: p.marketYahoo })
      .map(([k, m]) => [k, marketOf(m)]).filter(([, v]) => v)),
    netEstimates: (sm.channelNets || []).map((n) => ({ site: n.channel, siteName: SITE[n.channel] || n.channel, net: n.net, basedOn: n.matchType })),
    facts: (p.facts || []).filter((f) => !f.proposal && f.value != null && f.value !== '').map((f) => ({ label: f.label || f.key, value: f.value })),
    photos: photosOf(p, photoDir),
    updatedAt: (p.updatedAt || '').slice(0, 10),
  });
}

const meta = {
  generatedAt: new Date().toISOString(),
  count: products.length,
  withPhotos: products.filter((x) => x.photos.length).length,
  photoFiles: products.reduce((n, x) => n + x.photos.length, 0),
  ownPhotosIncluded: WITH_OWN,
  categories: Object.entries(products.reduce((m, x) => ((m[x.category] = (m[x.category] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]),
};
fs.writeFileSync(path.join(OUT, 'products.json'), JSON.stringify(products, null, 1));
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
fs.copyFileSync(path.join(ROOT, 'docs', 'PUBLIC_KIT_SCHEMA.md'), path.join(OUT, 'README.md'));
console.log(`書き出し ${OUT}: 商品 ${meta.count}件・写真つき ${meta.withPhotos}件・写真 ${meta.photoFiles}枚${WITH_OWN ? '（撮ったままの写真を含む）' : ''}`);
