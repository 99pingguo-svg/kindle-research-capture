// 日付ID（ユーザー指定 2026-11-15）: 注文の一覧（商品名・Amazon のリンク・注文日）から、商品に8桁の番号をつける。
//   令和の年2桁＋月2桁＋日2桁＋その日の注文順1桁＋その日の注文数1桁。例: 令和8年10月10日に8個注文した8番目 → 08101088。
//   いちばん新しい日で注文数が8に届いていない間は、その日の注文がまだ増えるかもしれないので最後を「?」にする（0811151?）。
//   次の一覧でそれより新しい日が入っていれば、その日は締まったとして「?」を数に置き換える。8件（1日の上限）なら一覧を待たずに締まる。
// 注文順: 一覧は日付順（新しい順か古い順かは日付から判断）に並んでいて、同じ日の中も同じ向きに時刻順。
//   観察ブラウザは、後から集めた注文を一覧の末尾に足す（firstSeen が10分以上あく所で区切る）。後の区切りの行は、前の区切りより後の注文。
// 日ごとの並びは <data>/date-ids/orders.json に覚えておき、新しい一覧が来たら足す（知っている注文の順番は変えず、知らない注文を後ろへ）。
// 注文番号の入ったリンク（order-details）は覚えない。商品とは ASIN、なければ商品名（先頭30字）で結ぶ。
import fs from 'node:fs';
import path from 'node:path';
import { AppError, nowIso, readJson, writeJson, clone } from './util.js';
import { asinOf } from './dates.js';

export const DAILY_MAX = 8; // Vine の1日の注文上限
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BATCH_GAP_MS = 10 * 60_000;
const APPLE_EPOCH_MS = 978307200000; // the app's firstSeen: seconds since 2001-01-01
const MAX_IMPORTS = 30;

/** 2026-10-10 → "081010" (令和). Dates before 令和 (2019-05-01) have no ID. */
export function reiwaDate(date) {
  const m = DATE_RE.exec(String(date || ''));
  if (!m) return null;
  const y = Number(m[1]) - 2018;
  if (y < 1 || y > 99 || (y === 1 && `${m[2]}${m[3]}` < '0501')) return null;
  return `${String(y).padStart(2, '0')}${m[2]}${m[3]}`;
}

/** total null = the day is not settled yet → "?". */
export function formatDateId(date, seq, total) {
  const base = reiwaDate(date);
  if (!base || !Number.isInteger(seq) || seq < 1 || seq > 9 || (total != null && (total < seq || total > 9))) return '';
  return `${base}${seq}${total == null ? '?' : total}`;
}

/** Same key as the observation browser's ReviewItem.titleKey (spaces and case ignored, first 30 characters). */
export const titleKey = (t) => String(t || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '').slice(0, 30);

const okDate = (v) => {
  const s = String(v || '').trim();
  return DATE_RE.test(s) && Number(s.slice(0, 4)) >= 2019 && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : '';
};

/**
 * The observation browser's text export (商品名 ⇥ リンク ⇥ 注文日 ⇥ 到着日 ⇥ 日付), or any "商品名 ⇥ リンク ⇥ 注文日" lines.
 * Lines without a usable order date are skipped (counted). Order-details links are not kept, only the ASIN of a product link.
 */
export function parseOrderList(text) {
  const rows = [];
  let skipped = 0;
  for (const raw of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const cols = raw.split('\t').map((c) => c.trim());
    const title = cols[0] || '';
    const date = okDate(cols[2]) || okDate(cols[4]);
    if (!title || !date) { skipped++; continue; }
    rows.push({ title, asin: asinOf(cols[1]) || '', date });
  }
  return { rows, skipped };
}

/** JSON rows: the app's vine-orders.json ({ asin, title, ordered, firstSeen }) or the same shape with date/seenAt. */
export function rowsFromJson(list) {
  const rows = [];
  let skipped = 0;
  for (const x of Array.isArray(list) ? list : []) {
    const date = okDate(x?.ordered) || okDate(x?.date);
    const title = String(x?.title || '').trim();
    if (!date || !title) { skipped++; continue; }
    const asin = /^[A-Z0-9]{10}$/.test(String(x.asin || '').toUpperCase()) ? String(x.asin).toUpperCase() : '';
    const f = x.firstSeen ?? x.seenAt;
    const seenMs = typeof f === 'number' ? f * 1000 + APPLE_EPOCH_MS : f ? Date.parse(f) : NaN;
    rows.push({ title, asin, date, ...(Number.isFinite(seenMs) ? { seenMs } : {}) });
  }
  return { rows, skipped };
}

const fullKey = (t) => String(t || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
/** The same order in two lists: same ASIN, else the same name (one list may cut a long name shorter than the other). */
const same = (a, b) => {
  if (a.asin && b.asin) return a.asin === b.asin;
  const x = fullKey(a.title);
  const y = fullKey(b.title);
  return x === y || (Math.min(x.length, y.length) >= 30 && (x.startsWith(y) || y.startsWith(x)));
};

/**
 * List order → each day's orders, oldest first. Every line is one order: the same item in two colours ordered the same day
 * is two lines with the same name, and both count.
 * odd: days with a row whose date differs from both neighbours that agree with each other (the page itself is out of order there).
 */
export function daysFromList(rows) {
  const batches = [];
  let cur = [];
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    if (cur.length && r.seenMs != null && prev?.seenMs != null && r.seenMs - prev.seenMs > BATCH_GAP_MS) { batches.push(cur); cur = []; }
    cur.push(r);
  });
  if (cur.length) batches.push(cur);
  const days = new Map();
  const odd = new Set();
  for (const b of batches) {
    let down = 0;
    let up = 0;
    for (let i = 1; i < b.length; i++) {
      if (b[i].date < b[i - 1].date) down++;
      else if (b[i].date > b[i - 1].date) up++;
      if (i < b.length - 1 && b[i - 1].date === b[i + 1].date && b[i].date !== b[i - 1].date) odd.add(b[i].date);
    }
    // A batch of one day only has no direction of its own: the app's lists run newest first.
    const timeline = down >= up ? [...b].reverse() : b;
    for (const r of timeline) {
      if (!days.has(r.date)) days.set(r.date, []);
      days.get(r.date).push({ title: r.title, asin: r.asin });
    }
  }
  return { days, odd };
}

/** Product → ASINs and the names it may be listed under (for orders without a product link). */
function productIndex(products) {
  const byAsin = new Map();
  const byTitle = new Map(); // first 30 characters → candidates; the full names decide (see matchRow)
  const names = new Map(); // product id → its full names
  const add = (m, k, id) => { if (!k) return; if (!m.has(k)) m.set(k, new Set()); m.get(k).add(id); };
  for (const p of products) {
    if (p.trashedAt) continue;
    for (const l of p.links || []) add(byAsin, asinOf(l.url), p.id);
    add(byAsin, p.browser?.asin, p.id);
    add(byAsin, p.amazon?.asin, p.id);
    add(byAsin, /ASIN:\s*([A-Z0-9]{10})/.exec(p.notes || '')?.[1], p.id);
    const full = /Amazonの商品名:\s*(.+)/.exec(p.notes || '')?.[1];
    for (const t of [p.name, full, p.amazon?.title]) {
      const k = titleKey(t);
      if (k.length < 12) continue;
      add(byTitle, k, p.id);
      if (!names.has(p.id)) names.set(p.id, []);
      names.get(p.id).push(fullKey(t));
    }
  }
  const trashed = new Map();
  for (const p of products) if (p.trashedAt) for (const l of p.links || []) if (asinOf(l.url)) trashed.set(asinOf(l.url), p.id);
  return { byAsin, byTitle, names, trashed };
}

function matchRow(ix, r) {
  if (r.asin) {
    const ids = [...(ix.byAsin.get(r.asin) || [])];
    if (ids.length === 1) return { productId: ids[0], by: 'ASIN' };
    if (ids.length > 1) return { productId: null, reason: `同じASINの商品が${ids.length}つ（${ids.join('・')}）` };
    if (ix.trashed.has(r.asin)) return { productId: null, reason: `ゴミ箱の商品（${ix.trashed.get(r.asin)}）` };
  }
  // By name only when one name is the start of the other (the 台帳 keeps the part before " | ", cut at 120 characters):
  // two colours or types of one brand share the first 30 characters but differ after that.
  const mine = [fullKey(r.title), fullKey(r.title.split(' | ')[0])];
  const keys = [...new Set(mine.map((k) => k.slice(0, 30)))].filter((k) => k.length >= 12);
  const fits = (id) => (ix.names.get(id) || []).some((n) => mine.some((m) => m.startsWith(n) || n.startsWith(m)));
  const ids = [...new Set(keys.flatMap((k) => [...(ix.byTitle.get(k) || [])]))].filter(fits);
  if (ids.length === 1) return { productId: ids[0], by: '商品名' };
  if (ids.length > 1) return { productId: null, reason: `商品名が${ids.length}つの商品に当たる（${ids.join('・')}）` };
  return { productId: null, reason: '台帳にない' };
}

export class DateIds {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'date-ids', 'orders.json');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.book = readJson(this.file, null) || { days: {}, imports: [] };
  }

  /**
   * Fold a list into the day records (never shrinks a day, never reorders known orders).
   * A day is settled when it has DAILY_MAX orders, or when a list shows it together with a newer day.
   */
  static fold(book, rows, { at = nowIso(), from = '' } = {}) {
    const next = clone(book);
    const { days, odd } = daysFromList(rows);
    const dates = [...days.keys()].sort();
    const newest = dates.at(-1);
    let added = 0;
    let touched = false;
    for (const date of dates) {
      const d = next.days[date] || { rows: [], closed: false, warn: [] };
      const wasClosed = d.closed;
      let n = 0;
      const used = new Set(); // each known order answers one line (two same-name orders match in turn)
      for (const r of days.get(date)) {
        const hit = d.rows.find((o) => !used.has(o) && same(o, r));
        if (hit) {
          used.add(hit);
          if (!hit.asin && r.asin) { hit.asin = r.asin; touched = true; }
          if (r.title.length > hit.title.length) { hit.title = r.title; touched = true; }
        } else {
          const row = { title: r.title, asin: r.asin };
          used.add(row); // a second same-name line in this list is another order
          d.rows.push(row);
          n++;
        }
      }
      const warn = new Set(d.warn || []);
      if (n && wasClosed) warn.add('締まった後に増えた');
      if (odd.has(date)) warn.add('一覧の並びで前後と日付が合わない注文がある（順番は一覧の位置のまま）');
      if (d.rows.length > DAILY_MAX) warn.add(`1日${DAILY_MAX}件より多い`);
      d.closed = wasClosed || date < newest || d.rows.length >= DAILY_MAX;
      d.warn = [...warn];
      if (n || !next.days[date] || d.closed !== wasClosed || String(warn.size) !== String((next.days[date]?.warn || []).length)) { d.updatedAt = at; touched = true; }
      next.days[date] = d;
      added += n;
    }
    next.imports = [{ at, from, rows: rows.length, days: dates.length, added, minDate: dates[0] || '', maxDate: newest || '' }, ...(next.imports || [])].slice(0, MAX_IMPORTS);
    return { book: next, added, touched };
  }

  /** Every known order with its ID and the product it belongs to (newest day first). */
  static plan(book, products) {
    const ix = productIndex(products);
    const byId = new Map(products.map((p) => [p.id, p]));
    const out = [];
    for (const date of Object.keys(book.days).sort().reverse()) {
      const d = book.days[date];
      const total = d.closed ? d.rows.length : null;
      d.rows.forEach((r, i) => {
        const dateId = d.rows.length > 9 ? '' : formatDateId(date, i + 1, total);
        out.push({ date, seq: i + 1, total, dateId, title: r.title, asin: r.asin, ...matchRow(ix, r) });
      });
    }
    // One product, one order: when two orders point at the same product, neither is written.
    const count = new Map();
    for (const o of out) if (o.productId) count.set(o.productId, (count.get(o.productId) || 0) + 1);
    for (const o of out) {
      if (o.productId && count.get(o.productId) > 1) { o.reason = `同じ商品に${count.get(o.productId)}つの注文が当たる（${o.productId}）`; o.productId = null; }
      const p = o.productId && byId.get(o.productId);
      o.productName = p ? p.name : '';
      o.current = p ? p.dateId || '' : '';
      o.change = !!p && !!o.dateId && o.current !== o.dateId;
    }
    return out;
  }

  /** Products (not in the trash) holding an ID that no order gives them any more. */
  static removals(plan, products) {
    const given = new Set(plan.filter((o) => o.productId && o.dateId).map((o) => o.productId));
    return products.filter((p) => p.dateId && !p.trashedAt && !given.has(p.id)).map((p) => ({ id: p.id, name: p.name, from: p.dateId, to: '' }));
  }

  /** Re-tie the known orders to the products as they are now (a product added later gets its ID). No new list needed. */
  refresh(store, actor = 'system') {
    const plan = DateIds.plan(this.book, store.list());
    const todo = [...plan.filter((o) => o.change).map((o) => ({ id: o.productId, to: o.dateId })), ...DateIds.removals(plan, store.list())];
    if (todo.length >= 10) store.saveSnapshot(actor, { label: `日付IDを付け直す前（${todo.length}件）`, kind: 'before' });
    let n = 0;
    for (const o of todo) {
      try { store.setDateId(o.id, actor, o.to); n++; } catch (e) { console.error('日付ID:', o.id, e.message); }
    }
    return n;
  }

  /** Products added or renamed (観察ブラウザ連携・手で登録・ほかのエージェント) get their ID a few seconds later. */
  watch(store) {
    let timer = null;
    store.on('change', (ev) => {
      if (ev.type !== 'product' || ev.action === 'date_id' || !Object.keys(this.book.days).length) return;
      clearTimeout(timer);
      timer = setTimeout(() => { const n = this.refresh(store); if (n) console.log(`日付ID: ${n}件を付け直し`); }, 5000);
    });
  }

  view(products) {
    const orders = DateIds.plan(this.book, products);
    const days = Object.keys(this.book.days).sort().reverse().map((date) => {
      const d = this.book.days[date];
      return { date, closed: d.closed, count: d.rows.length, warn: d.warn || [], orders: orders.filter((o) => o.date === date) };
    });
    return { days, imports: this.book.imports || [], max: DAILY_MAX, pending: orders.filter((o) => o.change).length };
  }

  /**
   * Import a list (text or JSON rows), then write the IDs that changed onto the products.
   * dryRun: report only. Bulk writes (10+ products) are preceded by an automatic save point.
   */
  importList(store, actor, { text, rows, from = '', dryRun = true } = {}) {
    const parsed = rows ? rowsFromJson(rows) : parseOrderList(text);
    if (!parsed.rows.length) throw new AppError(400, '注文日のある行が見つかりません（商品名 ⇥ リンク ⇥ 注文日 の形）');
    const { book, added, touched } = DateIds.fold(this.book, parsed.rows, { from });
    const plan = DateIds.plan(book, store.list());
    const changes = plan.filter((o) => o.change);
    const removals = DateIds.removals(plan, store.list());
    const result = {
      rows: parsed.rows.length, skipped: parsed.skipped, added, days: Object.keys(book.days).length,
      open: Object.entries(book.days).filter(([, d]) => !d.closed).map(([date, d]) => ({ date, count: d.rows.length })),
      warn: Object.entries(book.days).filter(([, d]) => d.warn?.length).map(([date, d]) => ({ date, warn: d.warn })),
      matched: plan.filter((o) => o.productId).length, unmatched: plan.filter((o) => !o.productId).length,
      unmatchedWhy: plan.filter((o) => !o.productId).reduce((m, o) => { const k = String(o.reason || '').split('（')[0]; m[k] = (m[k] || 0) + 1; return m; }, {}),
      changes: [...changes.map((o) => ({ id: o.productId, name: o.productName, from: o.current, to: o.dateId, date: o.date })), ...removals],
      applied: 0, errors: [], dryRun,
    };
    if (dryRun) return result;
    if (!touched && !result.changes.length) return { ...result, unchanged: true }; // the same list again (sync runs every 30 minutes)
    this.book = book;
    writeJson(this.file, book);
    if (result.changes.length >= 10) result.snapshot = store.saveSnapshot(actor, { label: `日付IDをつける前（${result.changes.length}件）`, kind: 'before' }).id;
    for (const o of result.changes) {
      try {
        store.setDateId(o.id, actor, o.to);
        result.applied++;
      } catch (e) {
        result.errors.push({ id: o.id, error: e.message });
      }
    }
    return result;
  }
}
