// 帳簿（ユーザー指定 2026-11-04）: Vine 商品の受領・使用・処分・売却、運営費、収入を「念のため」記録しておく。
// 方針:
//   - 事実（日付・表示価格とその確認日時・どうしたか）と、税務上の扱い（評価額・仕訳）を分けて持つ。
//   - 自動で作るのは事実の記録と「要確認」の仕訳候補だけ。承認・対象外にするのはユーザーのみ。承認後は自動で書き換えない。
//   - Vine 受領と同額を自動で経費にすることはしない（経費は使用・消費の実態を見てユーザーが記録・承認する）。
//   - 税務上の扱いは 5 つを分けて残す: 利用者の主張・実際の使用状況・一般的な取扱い・専門家の確認結果・申告で採用した処理。
//   - 変更はすべて audit.jsonl に残す（いつ・誰が・何を・前後）。
// 保存先: <data>/books/journal.json（正本）と audit.jsonl。
import path from 'node:path';
import { AppError, nowIso, readJson, writeJson, appendJsonl, readJsonl } from './util.js';
import { normalizeDate } from './schema.js';
import { isVineProvided } from './browser-sync.js';

export const BOOK_KINDS = [
  { id: 'vine_receipt', label: 'Vine受領' },
  { id: 'review_published', label: 'レビュー投稿' },
  { id: 'use', label: '使用・体験の記録' },
  { id: 'consumed', label: '消費' },
  { id: 'disposed', label: '廃棄' },
  { id: 'kept', label: '保管・継続使用' },
  { id: 'sold', label: '売却（Vine以外で入手した物）' },
  { id: 'purchase', label: '購入・仕入れ' },
  { id: 'expense', label: '経費・運営費' },
  { id: 'income', label: '収入（広告・アフィリエイト等）' },
  { id: 'other', label: 'その他' },
];
export const BOOK_STATUSES = { review: '要確認', approved: '承認済み', excluded: '帳簿に載せない' };
const KIND_IDS = BOOK_KINDS.map((k) => k.id);
const TAX_KEYS = ['claim', 'actual', 'general', 'expert', 'filed']; // 主張・実際・一般的な取扱い・専門家の確認・申告で採用
const VINE_DEBIT = 'Vine受領品';
const VINE_CREDIT = '現物収入（Vine）';

const isUser = (actor) => actor === 'user';
const forbidAi = (actor, what) => { if (!isUser(actor)) throw new AppError(403, `${what}はユーザーのみ実行できます（AIの権限外）`, 'forbidden'); };
const yen = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Math.round(Number(v)) : (() => { throw new AppError(400, `金額が数値ではありません: ${v}`); })());
const text = (v, max = 2000) => String(v ?? '').slice(0, max);
const clone = (x) => JSON.parse(JSON.stringify(x));

function cleanJournal(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.slice(0, 20).map((l) => {
    if (!['debit', 'credit'].includes(l?.side)) throw new AppError(400, '仕訳の借方・貸方の指定が不正です');
    return { side: l.side, account: text(l.account, 60), amount: yen(l.amount) ?? 0 };
  });
}

export class Books {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'books');
    this.file = path.join(this.dir, 'journal.json');
    this.auditFile = path.join(this.dir, 'audit.jsonl');
    this.db = readJson(this.file, { nextSeq: 1, entries: [] });
    this.db.works ||= []; // 作品（YouTube・ブログなど）。商品とは多対多（work.productIds）
    this.db.nextWork ||= 1;
  }

  /** 活動の理念（利用者の主張）。説明資料の第1部。ユーザーだけが書く。 */
  setStatement(textValue, actor) {
    forbidAi(actor, '活動の理念の記入');
    const before = { id: 'statement', text: this.db.statement || '' };
    this.db.statement = text(textValue, 20000);
    this.save();
    this.audit(actor, { id: 'statement', text: this.db.statement }, 'statement', before);
    return { statement: this.db.statement };
  }

  // ---------- 作品（コンテンツ）: 企画・撮影・公開と、登場する商品・生活記録 ----------
  listWorks({ productId } = {}) {
    return this.db.works.filter((w) => !productId || w.productIds.includes(productId))
      .sort((a, b) => ((b.publishedAt || b.plannedAt || b.createdAt) > (a.publishedAt || a.plannedAt || a.createdAt) ? 1 : -1));
  }

  getWork(id) {
    const w = this.db.works.find((x) => x.id === id);
    if (!w) throw new AppError(404, `作品がありません: ${id}`);
    return w;
  }

  cleanWork(input, base = {}) {
    const url = text(input.url ?? base.url, 500).trim();
    if (url && !/^https?:\/\//.test(url)) throw new AppError(400, 'URLは http(s):// で始めてください');
    const date = (v, k) => (v === undefined ? base[k] || '' : v ? normalizeDate(v) || (() => { throw new AppError(400, `${k} の日付が不正です`); })() : '');
    const ids = input.productIds === undefined ? base.productIds || [] : [...new Set((Array.isArray(input.productIds) ? input.productIds : String(input.productIds).split(/[\s,、]+/)).map((x) => String(x).trim()).filter(Boolean))].slice(0, 200);
    return {
      title: text(input.title ?? base.title, 200), platform: ['youtube', 'blog', 'x', 'instagram', 'other'].includes(input.platform ?? base.platform) ? input.platform ?? base.platform : 'other',
      url, status: ['planned', 'filming', 'published', 'dropped'].includes(input.status ?? base.status) ? input.status ?? base.status : 'planned',
      plannedAt: date(input.plannedAt, 'plannedAt'), filmedAt: date(input.filmedAt, 'filmedAt'), publishedAt: date(input.publishedAt, 'publishedAt'),
      productIds: ids, note: text(input.note ?? base.note, 4000),
    };
  }

  createWork(input, actor) {
    const w = { id: `W${String(this.db.nextWork).padStart(5, '0')}`, ...this.cleanWork(input || {}), createdAt: nowIso(), updatedAt: nowIso(), by: actor };
    this.db.nextWork += 1;
    this.db.works.push(w);
    this.save();
    this.audit(actor, w, 'work:create');
    return w;
  }

  updateWork(id, patch, actor) {
    const w = this.getWork(id);
    const before = clone(w);
    Object.assign(w, this.cleanWork(patch || {}, w));
    if (JSON.stringify(before) === JSON.stringify(w)) return w;
    w.updatedAt = nowIso();
    this.save();
    this.audit(actor, w, 'work:update', before);
    return w;
  }

  save() { writeJson(this.file, this.db); }

  audit(actor, entry, action, before) {
    appendJsonl(this.auditFile, { at: nowIso(), actor, id: entry.id, action, before: before ?? null, after: clone(entry) });
  }

  get(id) {
    const e = this.db.entries.find((x) => x.id === id);
    if (!e) throw new AppError(404, `帳簿の記録がありません: ${id}`);
    return e;
  }

  list({ year, status, kind, productId } = {}) {
    return this.db.entries.filter((e) => (!year || e.date.startsWith(String(year))) && (!status || e.status === status)
      && (!kind || e.kind === kind) && (!productId || e.productId === productId))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1));
  }

  history(id) { return readJsonl(this.auditFile).filter((a) => a.id === id); }

  newId(date) {
    const id = `B${date.slice(0, 4)}-${String(this.db.nextSeq).padStart(5, '0')}`;
    this.db.nextSeq += 1;
    return id;
  }

  /** A record typed in by the user or proposed by an AI (always 要確認 until the user approves). */
  create(input, actor) {
    const kind = KIND_IDS.includes(input?.kind) ? input.kind : (() => { throw new AppError(400, `記録の種類が不正です: ${input?.kind}`); })();
    const date = normalizeDate(input.date || '') || (() => { throw new AppError(400, '日付は 2026-11-04 の形式で入力してください'); })();
    const entry = {
      id: this.newId(date), kind, date,
      productId: text(input.productId, 20), asin: text(input.asin, 10).toUpperCase(), title: text(input.title, 200),
      facts: { amount: yen(input.amount), listPrice: yen(input.listPrice), listPriceAt: text(input.listPriceAt, 30), listPriceSource: text(input.listPriceSource, 100), note: text(input.note) },
      valuation: { value: yen(input.value), basis: text(input.basis, 500) },
      journal: cleanJournal(input.journal),
      tax: Object.fromEntries(TAX_KEYS.map((k) => [k, text(input.tax?.[k])])),
      evidence: (Array.isArray(input.evidence) ? input.evidence : []).slice(0, 20).map((x) => ({ label: text(x?.label, 100), ref: text(x?.ref, 500) })),
      status: 'review', autoKey: null, source: isUser(actor) ? 'user' : actor,
      createdAt: nowIso(), updatedAt: nowIso(), approvedAt: null, approvedBy: null, excludedReason: '',
    };
    this.db.entries.push(entry);
    this.save();
    this.audit(actor, entry, 'create');
    return entry;
  }

  /** Edit the facts, valuation, journal or the five tax notes. An approved record must be reopened by the user first. */
  update(id, patch, actor) {
    const e = this.get(id);
    if (e.status === 'approved') throw new AppError(409, '承認済みの記録は、先に「承認を取り消す」と変更できます', 'locked');
    const before = clone(e);
    if (patch.date !== undefined) e.date = normalizeDate(patch.date) || (() => { throw new AppError(400, '日付の形式が不正です'); })();
    if (patch.kind !== undefined) { if (!KIND_IDS.includes(patch.kind)) throw new AppError(400, '記録の種類が不正です'); e.kind = patch.kind; }
    for (const k of ['productId', 'asin', 'title']) if (patch[k] !== undefined) e[k] = text(patch[k], k === 'title' ? 200 : 20);
    for (const k of ['amount', 'listPrice']) if (patch.facts?.[k] !== undefined) e.facts[k] = yen(patch.facts[k]);
    for (const k of ['listPriceAt', 'listPriceSource', 'note']) if (patch.facts?.[k] !== undefined) e.facts[k] = text(patch.facts[k]);
    if (patch.valuation?.value !== undefined) e.valuation.value = yen(patch.valuation.value);
    if (patch.valuation?.basis !== undefined) e.valuation.basis = text(patch.valuation.basis, 500);
    if (patch.journal !== undefined) { e.journal = cleanJournal(patch.journal); e.journalEdited = true; }
    if (patch.date !== undefined || patch.facts !== undefined) e.factsEdited = true; // the link no longer refreshes them
    for (const k of TAX_KEYS) if (patch.tax?.[k] !== undefined) e.tax[k] = text(patch.tax[k]);
    if (patch.evidence !== undefined) e.evidence = (patch.evidence || []).slice(0, 20).map((x) => ({ label: text(x?.label, 100), ref: text(x?.ref, 500) }));
    if (JSON.stringify(before) === JSON.stringify(e)) return e;
    if (e.status === 'excluded' && !isUser(actor)) throw new AppError(403, '「帳簿に載せない」にした記録はユーザーのみ変更できます', 'forbidden');
    e.updatedAt = nowIso();
    this.save();
    this.audit(actor, e, 'update', before);
    return e;
  }

  setStatus(id, status, actor, reason = '') {
    forbidAi(actor, status === 'approved' ? '帳簿の承認' : '帳簿の状態の変更');
    if (!BOOK_STATUSES[status]) throw new AppError(400, `状態が不正です: ${status}`);
    const e = this.get(id);
    if (e.status === status) return e;
    const before = clone(e);
    e.status = status;
    e.approvedAt = status === 'approved' ? nowIso() : null;
    e.approvedBy = status === 'approved' ? actor : null;
    e.excludedReason = status === 'excluded' ? text(reason, 300) : '';
    e.updatedAt = nowIso();
    this.save();
    this.audit(actor, e, `status:${status}`, before);
    return e;
  }

  /**
   * From the 観察ブラウザ link: one Vine受領 record per Vine product (the receipt date is 到着日, else the Vine order date),
   * and one レビュー投稿 record when it is in レビュー済み. Facts are refreshed only while the record is still 要確認.
   * Returns { created, updated }.
   */
  syncFromProducts(products, actor = 'import') {
    let created = 0, updated = 0;
    const byKey = new Map(this.db.entries.filter((e) => e.autoKey).map((e) => [e.autoKey, e]));
    const put = (key, make) => {
      const want = make();
      if (!want) return;
      const cur = byKey.get(key);
      if (!cur) {
        const entry = { ...want, id: this.newId(want.date), autoKey: key, status: 'review', source: 'sync', createdAt: nowIso(), updatedAt: nowIso(), approvedAt: null, approvedBy: null, excludedReason: '' };
        this.db.entries.push(entry);
        byKey.set(key, entry);
        this.audit(actor, entry, 'create');
        created++;
        return;
      }
      if (cur.status !== 'review') return; // the user's decision stands
      const before = clone(cur);
      const next = { ...cur, productId: want.productId, asin: want.asin, title: want.title,
        date: cur.factsEdited ? cur.date : want.date, facts: cur.factsEdited ? cur.facts : { ...cur.facts, ...want.facts },
        journal: cur.journalEdited || cur.factsEdited ? cur.journal : want.journal };
      if (JSON.stringify(next) === JSON.stringify(cur)) return;
      Object.assign(cur, next, { updatedAt: nowIso() });
      this.audit(actor, cur, 'sync', before);
      updated++;
    };
    for (const p of products) {
      if (p.trashedAt || !isVineProvided(p)) continue;
      const b = p.browser;
      const lists = b.lists || {};
      const vineOrdered = ['vineOrders', 'reviewPending', 'reviewed'].map((k) => lists[k]?.ordered).find(Boolean) || '';
      const arrived = p.arrivalDate || ['vineOrders', 'reviewPending', 'reviewed'].map((k) => lists[k]?.delivered).find(Boolean) || '';
      const price = p.amazon?.price ?? p.research?.amazonPrice ?? null;
      put(`vine_receipt:${p.id}`, () => {
        const date = arrived || vineOrdered || p.orderDate || '';
        if (!date) return null;
        return {
          kind: 'vine_receipt', date, productId: p.id, asin: b.asin, title: p.name || '',
          facts: {
            amount: null, listPrice: price, listPriceAt: price != null ? (p.amazon?.fetchedAt || '').slice(0, 10) : '',
            listPriceSource: price != null ? 'Amazon商品ページの表示価格（ログアウト状態で自動取得）' : '',
            note: [arrived ? '' : '受領日（到着日）が不明のため Vine注文日で仮置き', price == null ? '表示価格が取れていない（要確認）' : '確認日の表示価格。受領時の価格と違うことがある'].filter(Boolean).join('。'),
          },
          valuation: { value: null, basis: '' },
          // 仮の仕訳: 表示価格を仮の金額にしたもの。税務上の評価額・計上の要否は未確定（要確認）。経費は自動で作らない。
          journal: price != null ? [{ side: 'debit', account: VINE_DEBIT, amount: price }, { side: 'credit', account: VINE_CREDIT, amount: price }] : [],
          tax: Object.fromEntries(TAX_KEYS.map((k) => [k, ''])),
          evidence: [{ label: 'Amazon商品ページ', ref: `https://www.amazon.co.jp/dp/${b.asin}` }, { label: '台帳の商品', ref: `#/p/${p.id}` }],
        };
      });
      if (lists.reviewed) {
        put(`review_published:${p.id}`, () => ({
          kind: 'review_published', date: (b.syncedAt || nowIso()).slice(0, 10), productId: p.id, asin: b.asin, title: p.name || '',
          facts: { amount: null, listPrice: null, listPriceAt: '', listPriceSource: '', note: '観察ブラウザの「レビュー済み」で確認した日（投稿日そのものは不明）' },
          valuation: { value: null, basis: '' }, journal: [], tax: Object.fromEntries(TAX_KEYS.map((k) => [k, ''])),
          evidence: [{ label: 'Amazon商品ページ', ref: `https://www.amazon.co.jp/dp/${b.asin}` }],
        }));
      }
    }
    if (created || updated) this.save();
    return { created, updated };
  }

  /** Year totals: per kind and status, the shown-price total of Vine receipts, and approved journal totals per account. */
  summary(year) {
    const rows = this.list({ year });
    const byKind = Object.fromEntries(BOOK_KINDS.map((k) => [k.id, { label: k.label, count: 0, review: 0, approved: 0, excluded: 0 }]));
    const accounts = {};
    let vinePrice = 0, vineNoPrice = 0;
    for (const e of rows) {
      byKind[e.kind].count++;
      byKind[e.kind][e.status]++;
      if (e.kind === 'vine_receipt' && e.status !== 'excluded') e.facts.listPrice != null ? (vinePrice += e.facts.listPrice) : vineNoPrice++;
      if (e.status !== 'approved') continue;
      for (const l of e.journal) {
        const a = (accounts[l.account] ||= { debit: 0, credit: 0 });
        a[l.side] += l.amount;
      }
    }
    return { year: String(year), total: rows.length, review: rows.filter((e) => e.status === 'review').length,
      byKind: Object.values(byKind).filter((k) => k.count), vine: { shownPriceTotal: vinePrice, withoutPrice: vineNoPrice }, approvedAccounts: accounts };
  }

  /** 仕訳帳＋記録の CSV (Excel で開ける UTF-8 BOM 付き)。 */
  csv(year) {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['取引ID', '日付', '種類', '状態', '商品ID', 'ASIN', '商品名', '借方', '貸方', '金額', '表示価格', '表示価格の確認日', '価格の出どころ', '税務評価額', '評価の根拠', 'メモ', '利用者の主張', '実際の使用状況', '一般的な取扱い', '専門家の確認', '申告で採用'];
    const out = [head.map(q).join(',')];
    for (const e of [...this.list({ year })].reverse()) {
      const debit = e.journal.filter((l) => l.side === 'debit');
      const credit = e.journal.filter((l) => l.side === 'credit');
      const n = Math.max(1, debit.length, credit.length);
      for (let i = 0; i < n; i++) {
        out.push([e.id, e.date, BOOK_KINDS.find((k) => k.id === e.kind)?.label, BOOK_STATUSES[e.status], e.productId, e.asin, e.title,
          debit[i]?.account, credit[i]?.account, debit[i]?.amount ?? credit[i]?.amount ?? e.facts.amount,
          e.facts.listPrice, e.facts.listPriceAt, e.facts.listPriceSource, e.valuation.value, e.valuation.basis, e.facts.note,
          ...TAX_KEYS.map((k) => e.tax[k])].map(q).join(','));
      }
    }
    return '﻿' + out.join('\r\n') + '\r\n';
  }
}
