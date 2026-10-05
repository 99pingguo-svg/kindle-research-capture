// Export to a layout that is useful without this app (spec §32):
// Products/0001/{product.json,listing.txt,history.jsonl,originals/,edited/,listing_photos/,references/}
import fs from 'node:fs';
import path from 'node:path';
import { listingText } from './store.js';
import { listingPhotos, statusOf } from './rules.js';
import { safeSegment } from './util.js';

const CSV_COLUMNS = [
  ['id', (p) => p.id],
  ['商品名', (p) => p.name],
  ['ブランド', (p) => p.brand],
  ['型番', (p) => p.model],
  ['JAN', (p) => p.jan],
  ['数量', (p) => p.quantity],
  ['色', (p) => p.color],
  ['ステータス', (p) => statusOf(p).label],
  ['出品判断', (p) => ({ undecided: '未定', sell: '出品する', hold: '保留', no_sell: '出品しない' })[p.decision]],
  ['保管場所', (p) => p.location],
  ['日付（注文・購入・到着）', (p) => p.itemDate],
  ['購入時期', (p) => p.purchaseDate],
  ['購入価格', (p) => p.purchasePrice],
  ['出品予定価格', (p) => p.plannedPrice],
  ['販売価格(出品)', (p) => p.listing.price],
  ['実際の販売価格', (p) => p.soldPrice],
  ['タイトル', (p) => p.listing.title],
  ['カテゴリー', (p) => p.listing.category],
  ['商品の状態', (p) => p.listing.condition],
  ['現物写真数', (p) => p.photos.filter((x) => x.kind === 'actual' && !x.deletedAt).length],
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
      const folder = ph.kind === 'reference' ? 'references' : ph.derivedFrom ? 'edited' : 'originals';
      entries.push({ name: `${base}/${folder}/${String(i).padStart(2, '0')}${tag}_${ph.id}${ext}`, file: path.join(dir, ph.files.original) });
    }
    listingPhotos(p).forEach((ph, idx) => {
      entries.push({ name: `${base}/listing_photos/${String(idx + 1).padStart(2, '0')}.jpg`, file: path.join(dir, ph.files.work) });
    });
  }
  return entries.filter((e) => !e.file || fs.existsSync(e.file));
}
