// Export to a layout that is useful without this app (spec §32):
// Products/0001/{product.json,listing.txt,history.jsonl,originals/,edited/,listing_photos/,references/}
import fs from 'node:fs';
import path from 'node:path';
import { listingText } from './store.js';
import { listingPhotos, statusOf, livePhotos } from './rules.js';
import { safeSegment } from './util.js';
import { guessCategory } from './category.js';

const CSV_COLUMNS = [
  ['id', (p) => p.id],
  ['商品名', (p) => p.name],
  ['ブランド', (p) => p.brand],
  ['型番', (p) => p.model],
  ['JAN', (p) => p.jan],
  ['数量', (p) => p.quantity],
  ['色', (p) => p.color],
  ['ステータス', (p) => statusOf(p).label],
  ['出品判断', (p) => ({ undecided: '未定', sell: '出品する', draft: '下書き', hold: '保留', no_sell: '出品しない', no_stock: '在庫なし' })[p.decision]],
  ['保管場所', (p) => p.location],
  ['日付（区別しない）', (p) => p.itemDate],
  ['注文日・購入日', (p) => p.orderDate],
  ['到着日', (p) => p.arrivalDate],
  ['種類', (p) => p.category || guessCategory(p.name)],
  ['購入時期', (p) => p.purchaseDate],
  ['購入価格', (p) => p.purchasePrice],
  ['出品予定価格', (p) => p.plannedPrice],
  ['販売価格(出品)', (p) => p.listing.price],
  ['実際の販売価格', (p) => p.soldPrice],
  ['タイトル', (p) => p.listing.title],
  ['カテゴリー', (p) => p.listing.category],
  ['商品の状態', (p) => p.listing.condition],
  ['現物写真数', (p) => p.photos.filter((x) => x.kind === 'actual' && !x.deletedAt).length],
  ['生成画像数', (p) => p.photos.filter((x) => x.kind === 'generated' && !x.deletedAt).length],
  ['出品用写真数', (p) => listingPhotos(p).length],
  ['QC', (p) => (p.qc ? p.qc.result : '')],
  ['メルカリURL', (p) => p.channels.mercari?.itemUrl || ''],
  ['URL', (p) => p.links.map((l) => l.url).join(' ')],
  ['メモ', (p) => p.notes],
  ['更新日時', (p) => p.updatedAt],
];

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function productsCsv(products) {
  const lines = [CSV_COLUMNS.map((c) => c[0]).join(',')];
  for (const p of products) lines.push(CSV_COLUMNS.map(([, f]) => csvCell(f(p))).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n'; // BOM so Excel/Numbers read UTF-8
}

export function exportEntries(store, products, { photos = true } = {}) {
  const entries = [{ name: 'Products/products.csv', data: productsCsv(products) }];
  for (const p of products) {
    const base = `Products/${p.id}`;
    const dir = store.dir(p.id);
    entries.push({ name: `${base}/product.json`, data: JSON.stringify(p, null, 2) });
    entries.push({ name: `${base}/listing.txt`, data: listingText(p) });
    entries.push({ name: `${base}/history.jsonl`, file: path.join(dir, 'history.jsonl') });
    if (!photos) continue;
    const live = p.photos.filter((x) => !x.deletedAt);
    let i = 0;
    for (const ph of live) {
      i++;
      const tag = ph.tag ? `_${safeSegment(ph.tag)}` : '';
      const ext = path.extname(ph.files.original) || '.jpg';
      const folder = ph.kind === 'reference' ? 'references' : ph.kind === 'generated' ? 'generated' : ph.derivedFrom ? 'edited' : 'originals';
      entries.push({ name: `${base}/${folder}/${String(i).padStart(2, '0')}${tag}_${ph.id}${ext}`, file: path.join(dir, ph.files.original) });
    }
    listingPhotos(p).forEach((ph, idx) => {
      entries.push({ name: `${base}/listing_photos/${String(idx + 1).padStart(2, '0')}.jpg`, file: path.join(dir, ph.files.work) });
    });
  }
  return entries.filter((e) => !e.file || fs.existsSync(e.file));
}

/** Products whose photos are all official (reference) images — nothing shot or generated yet. */
export const officialOnly = (p) => {
  const live = livePhotos(p);
  return live.length > 0 && live.every((ph) => ph.kind === 'reference');
};

/**
 * ZIP of the official images of official-only products, one folder per product
 * ("<id>_<商品名>/01.jpg …") plus 一覧.csv to find them again.
 */
export function officialEntries(store, products) {
  const rows = [['ID', '商品名', '種類', 'Amazon価格', '枚数', 'フォルダ', '購入ページ']];
  const entries = [];
  for (const p of products.filter(officialOnly)) {
    const folder = `${p.id}_${safeSegment(p.name || '名称未設定').slice(0, 30)}`;
    const photos = livePhotos(p).filter((ph) => fs.existsSync(path.join(store.dir(p.id), ph.files.original)));
    photos.forEach((ph, i) => {
      const ext = path.extname(ph.files.original) || '.jpg';
      entries.push({ name: `公式画像/${folder}/${String(i + 1).padStart(2, '0')}${ext}`, file: path.join(store.dir(p.id), ph.files.original) });
    });
    const url = p.links?.find((l) => l.type === 'purchase')?.url || p.links?.[0]?.url || '';
    rows.push([p.id, p.name, p.category || guessCategory(p.name), p.research?.amazonPrice ?? p.amazon?.price ?? '', photos.length, folder, url]);
  }
  const csv = '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  return [{ name: '公式画像/一覧.csv', data: csv }, ...entries];
}

/** Size of that ZIP before downloading it. */
export function officialStats(store, products) {
  const list = products.filter(officialOnly);
  let images = 0;
  let bytes = 0;
  for (const p of list) {
    for (const ph of livePhotos(p)) {
      try {
        bytes += fs.statSync(path.join(store.dir(p.id), ph.files.original)).size;
        images++;
      } catch {
        /* missing file: left out of the ZIP too */
      }
    }
  }
  return { products: list.length, images, bytes };
}

/**
 * 素材Zip（作品づくり・投稿用）: 商品ごとのフォルダに 公式画像・撮った写真・AI仕上げ・紹介画像と、情報（人が読む 情報.txt と
 * エージェントが読む info.json）、レビューの下書き。browserImage(asin) は観察ブラウザが取った公式画像（参考画像がない商品だけ使う）。
 */
export function materialsEntries(store, products, { browserImage = () => null, settings = {} } = {}) {
  const rows = [['ID', '商品名', '種類', '置き場', 'あるかないか', 'レビュー', '形式', 'ASIN', 'フォルダ']];
  const entries = [];
  const PRES = { have: 'ある', gone: 'ない', unknown: 'わからない' };
  const REVIEW = { '': '未定', skip: 'しない', todo: 'する', drafted: '下書きあり', approved: '投稿OK', posted: '投稿済み' };
  for (const p of products) {
    const folder = `素材/${p.id}_${safeSegment(p.name || '名称未設定').slice(0, 30)}`;
    const dir = store.dir(p.id);
    const live = livePhotos(p).filter((ph) => fs.existsSync(path.join(dir, ph.files.original)));
    const files = [];
    const add = (sub, list, pick = (ph) => ph.files.original) => list.forEach((ph, i) => {
      const f = path.join(dir, pick(ph));
      if (!fs.existsSync(f)) return;
      const name = `${sub}/${String(i + 1).padStart(2, '0')}${path.extname(f) || '.jpg'}`;
      entries.push({ name: `${folder}/${name}`, file: f });
      files.push(name);
    });
    const refs = live.filter((ph) => ph.kind === 'reference');
    add('公式画像', refs);
    const asin = p.browser?.asin || p.amazon?.asin || '';
    if (!refs.length && asin) {
      const f = browserImage(asin);
      if (f && fs.existsSync(f)) { entries.push({ name: `${folder}/公式画像/01.jpg`, file: f }); files.push('公式画像/01.jpg'); }
    }
    add('写真', live.filter((ph) => ph.kind === 'actual' && !ph.derivedFrom && ph.source !== 'studio'));
    add('仕上げ', live.filter((ph) => ph.kind === 'actual' && ph.source === 'studio'), (ph) => ph.files.work || ph.files.original);
    add('紹介画像', live.filter((ph) => ph.kind === 'generated'));
    const category = p.category || guessCategory(p.name);
    const place = p.location || settings.categoryPlaces?.[category] || '';
    const presence = p.decision === 'no_stock' ? 'gone' : p.stockCheckedAt ? 'have' : p.stockUnknownAt ? 'unknown' : null;
    const rp = p.reviewPlan || {};
    const url = asin ? `https://www.amazon.co.jp/dp/${asin}` : (p.links?.find((l) => l.type === 'purchase')?.url || '');
    const info = {
      id: p.id, name: p.name, category, place, presence,
      amazon: { asin, url, title: p.amazon?.title || '', price: p.research?.amazonPrice ?? p.amazon?.price ?? null },
      vineLists: Object.keys(p.browser?.lists || {}),
      review: { status: rp.status || '', formats: rp.formats || [], note: rp.note || '', draft: rp.draft || '', url: rp.url || '' },
      listing: { decision: p.decision, targets: p.targets || [], title: p.listing?.title || '', description: p.listing?.description || '', price: p.listing?.price ?? null },
      files,
    };
    entries.push({ name: `${folder}/info.json`, data: JSON.stringify(info, null, 2) });
    entries.push({ name: `${folder}/情報.txt`, data: [
      `商品名: ${p.name || ''}`, `Amazon: ${info.amazon.title}`, `URL: ${url}`, `種類: ${category}`, `置き場: ${place || '（未設定）'}`,
      `あるかないか: ${PRES[presence] || '未確認'}`, `レビュー: ${REVIEW[info.review.status] || '未定'}${info.review.formats.length ? `（${info.review.formats.join('・')}）` : ''}`,
      info.review.note && `レビューのメモ: ${info.review.note}`, `出品先: ${(p.targets || []).join('・') || 'なし'}`,
      info.listing.title && `出品タイトル: ${info.listing.title}`, info.listing.description && `\n説明:\n${info.listing.description}`,
    ].filter(Boolean).join('\n') + '\n' });
    if (info.review.draft) entries.push({ name: `${folder}/レビュー下書き.txt`, data: info.review.draft + '\n' });
    rows.push([p.id, p.name, category, place, PRES[presence] || '未確認', REVIEW[info.review.status] || '未定', info.review.formats.join('・'), asin, folder]);
  }
  const csv = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  return [{ name: '素材/一覧.csv', data: csv }, ...entries];
}
