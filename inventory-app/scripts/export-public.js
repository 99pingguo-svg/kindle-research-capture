#!/usr/bin/env node
// 公開用アプリの素材キット: 商品台帳から「外に出してよいもの」だけを書き出す（読むだけ・台帳は変えない）。
//   node scripts/export-public.js [--out exports/public-kit] [--with-own-photos]
// 入れるもの: 商品名・種類・説明原稿・価格・大きさ/送料の目安・相場の集計・手取りの見込み・AI仕上げで切り抜いた商品写真。
// 写真は全部、付いている情報（EXIF・撮影機器・位置など）を消して保存し直す。消せなかった写真は入れない。
// Amazon 管理番号（X00…）の倉庫ラベルが写っている写真は、番号とバーコードをぼかし、読み直して読めないことを確かめてから入れる（読めたら入れない）。
// 入れないもの: メモ・注文日/到着日/購入価格などの購入記録・Amazon管理番号・保管場所・AI作業の記録・
//   Amazon の公式画像（権利は Amazon と出品者）・AI紹介画像（出どころ要確認）・撮ったままの写真（--with-own-photos のときだけ）。
// 書き出しは毎回作り直す（古いキットは exports/ の中で置き換え）。サーバー（http://127.0.0.1:8787）が動いていること。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fnskusIn } from '../public/js/search.js';

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

const OCR = path.join(ROOT, 'tools', 'bin', 'ocr');
let skippedLabels = 0;
let blurredLabels = 0;
const jobs = []; // [source, destination, max edge, boxes to blur] — re-encoded without metadata at the end
const readOcr = (file) => JSON.parse(execFileSync(OCR, [file], { timeout: 30000 }).toString());
/**
 * Where an Amazon warehouse label (X00…) shows in the photo: [] = none, [boxes] = text lines / barcodes to blur
 * (fractions of the image, top-left origin), null = cannot tell (fails closed: the photo is left out).
 */
function labelBoxes(file) {
  if (!fs.existsSync(OCR)) throw new Error('tools/bin/ocr がありません（npm run build:ocr）');
  try {
    const r = readOcr(file);
    if (!r.ok) return null;
    const hit = (t) => fnskusIn(t).length > 0;
    const boxes = [...(r.lines || []).filter((l) => hit(l.text)).map((l) => l.box), ...(r.barcodeBoxes || []).filter((b) => hit(b.value)).map((b) => b.box)];
    if (!boxes.length && hit([...(r.barcodes || []), ...(r.lines || []).map((l) => l.text)].join(' '))) return null; // found but no position
    return boxes;
  } catch {
    return null;
  }
}
const stillShowsLabel = (file) => {
  try {
    const r = readOcr(file);
    return !r.ok || fnskusIn([...(r.barcodes || []), ...(r.lines || []).map((l) => l.text)].join(' ')).length > 0;
  } catch {
    return true;
  }
};

/** Re-save every image without any metadata (EXIF, GPS, maker notes, XMP). Returns the destinations that succeeded. */
function writeClean(list) {
  const prog = [
    'import sys, json',
    'from PIL import Image, ImageOps',
    'ok = []',
    'from PIL import ImageFilter',
    'for src, dst, edge, boxes in json.load(sys.stdin):',
    '    try:',
    '        im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")',
    '        im.thumbnail((edge, edge))',
    '        W, H = im.size',
    '        for x, y, w, h in boxes:',  // the label number / barcode, with a margin, blurred beyond reading
    '            mx, my = w * 0.25 + 0.01, h * 0.6 + 0.01',
    '            l, t, r, b = max(0, int((x - mx) * W)), max(0, int((y - my) * H)), min(W, int((x + w + mx) * W)), min(H, int((y + h + my) * H))',
    '            if r - l > 2 and b - t > 2:',
    '                region = im.crop((l, t, r, b))',
    '                im.paste(region.filter(ImageFilter.GaussianBlur(max(6, (b - t) * 0.6))), (l, t))',
    '        im.save(dst, "JPEG", quality=88, optimize=True)',  // no exif= / icc_profile= → nothing carried over
    '        if Image.open(dst).getexif(): raise ValueError("metadata left")',
    '        ok.append(dst)',
    '    except Exception as e:',
    '        print("skip", src, e, file=sys.stderr)',
    'print(json.dumps(ok))',
  ].join('\n');
  const out = execFileSync('python3', ['-c', prog], { input: JSON.stringify(list), maxBuffer: 64 * 1024 * 1024 }).toString();
  return new Set(JSON.parse(out));
}

function photosOf(p, outDir) {
  const out = [];
  const listing = new Set(p.listingPhotoIds || []);
  // Default: only real cut-outs (white / grey background). Colour-only finishes keep the room around the product,
  // so they count as "own photos" and come only with --with-own-photos.
  const cutOut = (ph) => ph.source === 'studio' && ph.edit?.auto === 'studio' && !!ph.edit?.style;
  const own = (ph) => (!ph.derivedFrom && ph.source !== 'studio') || (ph.source === 'studio' && !cutOut(ph));
  const pick = p.photos.filter((ph) => !ph.deletedAt && ph.kind === 'actual' && (cutOut(ph) || (WITH_OWN && own(ph))));
  // Listing photos first, in the listing order; then the rest.
  pick.sort((a, b) => (listing.has(b.id) - listing.has(a.id)) || (p.listingPhotoIds.indexOf(a.id) - p.listingPhotoIds.indexOf(b.id)));
  for (const ph of pick) {
    const src = path.join(DATA, p.id, ph.files.work || ph.files.original);
    if (!fs.existsSync(src)) continue;
    const boxes = labelBoxes(src);
    if (boxes === null) { skippedLabels++; continue; }
    if (boxes.length) blurredLabels++;
    const name = `${p.id}-${ph.id}.jpg`;
    const thumbSrc = path.join(DATA, p.id, ph.files.thumb || ph.files.work);
    jobs.push([src, path.join(outDir, name), 2048, boxes], [fs.existsSync(thumbSrc) ? thumbSrc : src, path.join(outDir, `${p.id}-${ph.id}.thumb.jpg`), 400, boxes]);
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

// Re-encode all photos clean; drop any photo whose main image or thumbnail could not be cleaned (fail closed).
const clean = writeClean(jobs);
// Blurred photos are read again: if the number can still be read, the photo is left out.
for (const [, dst, edge, boxes] of jobs) {
  if (edge !== 2048 || !boxes.length || !clean.has(dst)) continue;
  if (stillShowsLabel(dst)) { clean.delete(dst); clean.delete(dst.replace(/\.jpg$/, '.thumb.jpg')); skippedLabels++; blurredLabels--; }
}
for (const x of products) {
  x.photos = x.photos.filter((ph) => clean.has(path.join(photoDir, path.basename(ph.file))) && clean.has(path.join(photoDir, path.basename(ph.thumb))));
}
for (const f of fs.readdirSync(photoDir)) if (!clean.has(path.join(photoDir, f))) fs.rmSync(path.join(photoDir, f), { force: true });

const meta = {
  generatedAt: new Date().toISOString(),
  count: products.length,
  withPhotos: products.filter((x) => x.photos.length).length,
  photoFiles: products.reduce((n, x) => n + x.photos.length, 0),
  ownPhotosIncluded: WITH_OWN,
  skippedLabelPhotos: skippedLabels,
  blurredLabelPhotos: blurredLabels,
  photoMetadata: 'removed',
  categories: Object.entries(products.reduce((m, x) => ((m[x.category] = (m[x.category] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]),
};
fs.writeFileSync(path.join(OUT, 'products.json'), JSON.stringify(products, null, 1));
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
fs.copyFileSync(path.join(ROOT, 'docs', 'PUBLIC_KIT_SCHEMA.md'), path.join(OUT, 'README.md'));
fs.copyFileSync(path.join(ROOT, 'docs', 'HANDOFF_PUBLIC_APP.md'), path.join(OUT, 'HANDOFF.md'));
console.log(`書き出し ${OUT}: 商品 ${meta.count}件・写真つき ${meta.withPhotos}件・写真 ${meta.photoFiles}枚（倉庫ラベルをぼかした ${blurredLabels}枚・読めてしまい除外 ${skippedLabels}枚・写真の付属情報は消去）${WITH_OWN ? '・撮ったままの写真を含む' : ''}`);
