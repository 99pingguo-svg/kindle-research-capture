// メルカリの売上の読み取り（ユーザー指定 2026-11-05）。メルカリに依存する読み方はこのファイルだけ。
// 個人のメルカリには公式の CSV 書き出しがないため（2026-11 時点）、利用者が自分で用意した文字を読む:
//   (1) 見出し行のある CSV / TSV（自分で作った表・表計算ソフトの書き出しなど）
//   (2) 取引画面や販売履歴をコピーして貼った文字（「販売価格」「販売手数料」「配送料」「販売利益」の並び）
//   (3) それもなければ「商品名の行」と「¥金額だけの行」の組
// メルカリへ自動で取りに行くことはしない（規約に反する自動取得を前提にしない）。読めた結果は取り込む前に画面で確かめる。
import { normalizeDate } from '../schema.js';

const HEAD = {
  date: /^(日付|取引日|売上日|購入日|購入日時|売却日|販売日|取引完了日|完了日|売上確定日)$/,
  title: /^(商品名|タイトル|商品|品名)$/,
  price: /^(販売価格|価格|売上金額|金額|売価)$/,
  fee: /^(販売手数料|手数料)$/,
  shipping: /^(配送料|送料)$/,
  proceeds: /^(販売利益|利益|手取り|入金額|売上)$/,
  itemId: /^(商品ID|取引ID|ID)$/i,
};
const LABEL = { price: /^販売価格/, fee: /^販売手数料/, shipping: /^配送料/, proceeds: /^販売利益/ };
const YEN = /[¥￥]\s*-?\s*([\d,]+)|(-?[\d,]+)\s*円/;
const ITEM_ID = /\bm\d{8,13}\b/;

const amount = (s) => {
  const m = YEN.exec(String(s || '')) || /^\s*-?([\d,]+)\s*$/.exec(String(s || ''));
  if (!m) return null;
  const n = Number((m[1] || m[2]).replace(/[,-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const dateIn = (s) => {
  const t = String(s || '').normalize('NFKC');
  const m = /(20\d{2})\s*[\/.\-年]\s*(\d{1,2})\s*[\/.\-月]\s*(\d{1,2})/.exec(t);
  return m ? normalizeDate(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`) || '' : '';
};

function splitRow(line, sep) {
  if (sep === '\t') return line.split('\t').map((c) => c.trim());
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function fromTable(lines) {
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const head = splitRow(lines[0].replace(/^﻿/, ''), sep);
  const col = Object.fromEntries(Object.entries(HEAD).map(([k, re]) => [k, head.findIndex((h) => re.test(h.normalize('NFKC').trim()))]));
  if (col.title < 0 || (col.price < 0 && col.proceeds < 0)) return null;
  const rows = [];
  for (const line of lines.slice(1)) {
    const c = splitRow(line, sep);
    const get = (k) => (col[k] >= 0 ? c[col[k]] : '');
    if (!get('title')) continue;
    rows.push({ date: dateIn(get('date')), title: get('title').slice(0, 200), price: amount(get('price')), fee: amount(get('fee')),
      shipping: amount(get('shipping')), proceeds: amount(get('proceeds')), itemId: (ITEM_ID.exec(get('itemId')) || [''])[0], format: 'table' });
  }
  return rows;
}

const isLabel = (l) => Object.values(LABEL).some((re) => re.test(l));
const isNoise = (l) => isLabel(l) || ITEM_ID.test(l) && l.length < 20 || amount(l) != null && l.replace(YEN, '').trim().length < 3 || !!dateIn(l) && l.length < 30 || l.length < 4;

function fromLabels(lines) {
  const anchors = lines.map((l, i) => (LABEL.price.test(l) ? i : -1)).filter((i) => i >= 0);
  if (!anchors.length) return null;
  const rows = [];
  let zoneEnd = -1; // last line used by the previous item
  anchors.forEach((a, k) => {
    const next = anchors[k + 1] ?? lines.length;
    const r = { date: '', title: '', price: null, fee: null, shipping: null, proceeds: null, itemId: '', format: 'labels' };
    let end = a;
    for (let i = a; i < next; i++) {
      const key = Object.keys(LABEL).find((x) => LABEL[x].test(lines[i]));
      if (!key) continue;
      const v = amount(lines[i].replace(LABEL[key], '')) ?? amount(lines[i + 1]);
      if (r[key] == null) r[key] = v;
      end = i;
    }
    for (let i = a - 1; i > zoneEnd; i--) if (!isNoise(lines[i])) { r.title = lines[i].slice(0, 200); break; }
    // The date shown with a sale (購入日時など) is below its amounts, so look after the 販売価格 line first, then above it.
    for (let i = a + 1; i < next && !r.date; i++) r.date = dateIn(lines[i]);
    for (let i = a - 1; i > zoneEnd && !r.date; i--) r.date = dateIn(lines[i]);
    for (let i = zoneEnd + 1; i < next && !r.itemId; i++) r.itemId = (ITEM_ID.exec(lines[i]) || [''])[0];
    zoneEnd = end + 1;
    rows.push(r);
  });
  return rows;
}

function fromPairs(lines) {
  const rows = [];
  let lastDate = '';
  lines.forEach((l, i) => {
    lastDate = dateIn(l) || lastDate;
    if (amount(l) == null || l.replace(YEN, '').trim().length >= 3) return;
    const title = [...lines.slice(Math.max(0, i - 3), i)].reverse().find((x) => !isNoise(x));
    if (title) rows.push({ date: lastDate, title: title.slice(0, 200), price: amount(l), fee: null, shipping: null, proceeds: null, itemId: '', format: 'pairs' });
  });
  return rows;
}

/** Parse what the user pasted or uploaded. Returns rows with the four amounts filled where they could be read. */
export function parseMercariSales(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.normalize('NFKC').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!lines.length) return { rows: [], format: 'empty' };
  const rows = (/[,\t]/.test(lines[0]) && fromTable(lines)) || fromLabels(lines) || fromPairs(lines);
  for (const r of rows) {
    // Fill the one missing amount when the other three are known (販売利益 = 販売価格 − 手数料 − 配送料).
    if (r.proceeds == null && r.price != null && r.fee != null && r.shipping != null) r.proceeds = r.price - r.fee - r.shipping;
    if (r.price == null && r.proceeds != null && r.fee != null && r.shipping != null) r.price = r.proceeds + r.fee + r.shipping;
  }
  return { rows, format: rows[0]?.format || 'none' };
}
