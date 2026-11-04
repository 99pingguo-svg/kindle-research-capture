// Amazon の価格の履歴（ユーザー指定 2026-11-05）。帳簿の「受領時の価格と評価の根拠」に使う。
// 方針:
//   - 観測ごとに1行を追記するだけ（上書き・削除しない）。売っている価格（price）と参考価格（basisPrice・取り消し線の価格）を分けて持つ。
//   - 価格を取りに行くのは Mac の観察ブラウザ連携（ログアウト状態の商品ページ・sync/images.mjs）と scripts/amazon-info.js。台帳は受け取るだけ。
//   - どの商品をいつ確かめるか（dueAsins）は台帳が決める: Vine提供品を、受領直後は早めに、その後しばらく週1回、以後は3か月に1回。
// 保存先: <data>/prices/observations.jsonl（1行 = { at, asin, productId, price, basisPrice, availability, source, by }）
import fs from 'node:fs';
import path from 'node:path';
import { AppError, nowIso, appendJsonl, readJsonl } from './util.js';
import { isVineProvided } from './browser-sync.js';

const ASIN = /^[A-Z0-9]{10}$/;
const DAY = 86400000;
const yenOrNull = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) < 1e8 ? Math.round(Number(v)) : (() => { throw new AppError(400, `価格が数値ではありません: ${v}`); })());
const days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;

/** The receipt date the books use: 到着日, else the Vine order date. */
export function receiptDateOf(p) {
  const lists = p.browser?.lists || {};
  const pick = (k) => ['vineOrders', 'reviewPending', 'reviewed'].map((l) => lists[l]?.[k]).find(Boolean) || '';
  return p.arrivalDate || pick('delivered') || pick('ordered') || p.orderDate || '';
}

export class Prices {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'prices', 'observations.jsonl');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.byAsin = new Map();
    for (const o of readJsonl(this.file)) this.index(o);
  }

  index(o) {
    if (!this.byAsin.has(o.asin)) this.byAsin.set(o.asin, []);
    this.byAsin.get(o.asin).push(o);
  }

  /** One observation from a logged-out product page (or the amazon-info script). Every check is kept, even an unchanged price. */
  add(input, actor) {
    const asin = String(input?.asin || '').toUpperCase();
    if (!ASIN.test(asin)) throw new AppError(400, `ASIN が不正です: ${input?.asin}`);
    const at = input.at && !Number.isNaN(Date.parse(input.at)) ? new Date(input.at).toISOString() : nowIso();
    const o = {
      at, asin, productId: String(input.productId || '').slice(0, 20),
      price: yenOrNull(input.price), basisPrice: yenOrNull(input.basisPrice),
      availability: String(input.availability || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      source: String(input.source || 'unknown').slice(0, 60), by: actor,
    };
    appendJsonl(this.file, o);
    this.index(o);
    return o;
  }

  history(asin) {
    return [...(this.byAsin.get(String(asin || '').toUpperCase()) || [])].sort((a, b) => (a.at < b.at ? -1 : 1));
  }

  /**
   * The shown price to use for a date: the priced check closest to it, preferring one on or before the date
   * (within 14 days), else the closest after it (within 14 days). Also the low/high of every priced check within ±30 days.
   */
  near(asin, date) {
    const priced = this.history(asin).filter((o) => o.price != null);
    if (!priced.length || !date) return null;
    const day = `${date.slice(0, 10)}T23:59:59Z`;
    const before = priced.filter((o) => o.at <= day && days(o.at, day) <= 14).at(-1);
    const after = priced.find((o) => o.at > day && days(o.at, day) <= 14);
    const pick = before || after;
    const around = priced.filter((o) => days(o.at, day) <= 30);
    const range = around.length ? { min: Math.min(...around.map((o) => o.price)), max: Math.max(...around.map((o) => o.price)), count: around.length } : null;
    return pick ? { ...pick, range, side: before ? 'before' : 'after' } : { range };
  }

  last(asin) { return this.history(asin).at(-1) || null; }

  /**
   * Which Vine products to check next (newest receipt first): never checked → now; within 60 days of receipt → weekly;
   * after that → every 90 days. Trashed products are skipped.
   */
  dueAsins(products, limit = 20, now = Date.now()) {
    const due = [];
    for (const p of products) {
      if (p.trashedAt || !isVineProvided(p) || !ASIN.test(p.browser?.asin || '')) continue;
      const asin = p.browser.asin;
      const received = receiptDateOf(p);
      const last = this.last(asin);
      const age = last ? (now - Date.parse(last.at)) / DAY : Infinity;
      const sinceReceipt = received ? (now - Date.parse(received)) / DAY : 0;
      const every = sinceReceipt <= 60 ? 7 : 90;
      if (age < every) continue;
      due.push({ asin, productId: p.id, received, lastAt: last?.at || null, rank: last ? 1 : 0 });
    }
    return due.sort((a, b) => a.rank - b.rank || (b.received > a.received ? 1 : b.received < a.received ? -1 : 0)).slice(0, limit);
  }
}
