// Shared client state + a tiny change bus.
import { api } from './api.js';
import { termsOf, searchScore, norm } from './search.js';

const PREFS_KEY = 'daicho.prefs';
const PREFS_VERSION = 3;
const defaults = {
  v: PREFS_VERSION,
  filter: 'all',
  sort: 'date',
  desc: true,
  dateKind: 'itemDate',
  dateFrom: '',
  dateTo: '',
  dateNone: false,
  conds: [],
  hideDec: [],
  hideTgt: [],
  hideLists: [], // 観察ブラウザの一覧（vineOrders…orders, none=どれにも入っていない）で隠す
  hideDate: { kind: 'vineOrderDate', from: '', to: '' }, // この日付の範囲に入る商品を隠す（両方空なら隠さない）
  camAutoNext: true,
  camRequestAi: true,
  camKeepTag: false,
  view: 'check', // 一覧の表示: check＝あるかないか（軽い） / full＝詳しく（出品・相場まで）
};

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    // v2: the list is ordered by date (newest first) by default.
    if ((saved.v || 1) < 2) Object.assign(saved, { v: 2, sort: 'date_desc' });
    // v3: sort = key + desc flag; the single 📦 filter became a list of conditions.
    if (saved.v < 3) {
      // (SORTS is defined further down and not initialised yet while state is being built.)
      const [key, dir] = String(saved.sort || 'date_desc').split('_');
      const known = ['date', 'id', 'updated', 'name', 'stage', 'photos', 'net', 'market', 'ship'].includes(key) ? key : 'date';
      const descFirst = ['date', 'updated', 'net', 'market'].includes(known);
      Object.assign(saved, { v: PREFS_VERSION, sort: known, desc: dir ? dir === 'desc' : descFirst, conds: saved.ship ? [saved.ship] : [] });
      delete saved.ship;
    }
    return { ...defaults, ...saved };
  } catch {
    return { ...defaults };
  }
}

export const state = {
  meta: null,
  products: new Map(), // id -> summary
  query: '',
  nearIds: new Set(), // search results that only partly match (shown after the real matches)
  selectMode: false,
  selected: new Set(),
  detail: null, // full product currently open
  detailId: null,
  route: { name: 'list' },
  prefs: loadPrefs(),
  online: true,
};

export function setPref(k, v) {
  state.prefs[k] = v;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
  } catch {
    /* private mode */
  }
}

const listeners = new Map();
export function on(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic).delete(fn);
}
export function emit(topic, payload) {
  for (const fn of listeners.get(topic) || []) fn(payload);
}

export async function loadAll() {
  const list = await api.get('/api/products');
  state.products = new Map(list.map((p) => [p.id, p]));
  emit('list');
}

export async function refreshSummaries(ids) {
  if (!ids.length) return;
  const list = await api.get('/api/products?ids=' + ids.join(','));
  const found = new Set(list.map((p) => p.id));
  for (const p of list) state.products.set(p.id, p);
  for (const id of ids) if (!found.has(id)) state.products.delete(id);
  emit('list');
}

/** Store a full product returned by the API and update its list summary. */
export function applyProduct(full) {
  if (!full) return;
  if (full.summary) state.products.set(full.id, full.summary);
  if (state.detailId === full.id) {
    state.detail = full;
    emit('detail');
  }
  emit('list');
}

export const FILTERS = [
  { id: 'all', label: 'すべて' },
  { id: 'presence_unchecked', label: '未チェック' },
  { id: 'have', label: 'ある' },
  { id: 'gone', label: 'ない' },
  { id: 'presence_unknown', label: 'わからない' },
  { id: 'review_todo', label: 'レビュー予定' },
  { id: 'not_stock_checked', label: '現在の最新在庫チェック（未）' },
  { id: 'stock_checked', label: '最新在庫チェック済み' },
  { id: 'stock_unknown', label: '在庫状況「不明」' },
  { id: 'shoot_plan', label: '撮影予定' },
  { id: 'needs_photos', label: '写真不足' },
  { id: 'shot_today', label: '今日撮影済み' },
  { id: 'not_open_checked', label: '開封未チェック' },
  { id: 'open_checked', label: '開封チェック済み' },
  { id: 'undecided', label: '未判断' },
  { id: 'sell', label: '出品予定' },
  { id: 'draft', label: '下書き' },
  { id: 'to_mercari', label: '→メルカリ' },
  { id: 'to_jmty', label: '→ジモティー' },
  { id: 'to_yahoo', label: '→ヤフオク' },
  { id: 'to_paypay', label: '→ヤフーフリマ' },
  { id: 'to_rakuma', label: '→ラクマ' },
  { id: 'to_flea', label: '→フリマ' },
  { id: 'research_jmty', label: 'ジモティ候補' },
  { id: 'research_3000', label: '3000円以上' },
  { id: 'research_2300', label: '2300〜2999円' },
  { id: 'ai_queue', label: 'AI処理中' },
  { id: 'review', label: '要確認' },
  { id: 'qc_issue', label: 'QC問題' },
  { id: 'ready', label: '準備完了' },
  { id: 'queued', label: '出品待ち' },
  { id: 'mercari', label: 'メルカリ入力済' },
  { id: 'listed', label: '出品中' },
  { id: 'trading', label: '取引中' },
  { id: 'sold', label: '売却済み' },
  { id: 'hold', label: '保留' },
  { id: 'no_sell', label: '出さない' },
  { id: 'no_stock', label: '在庫なし' },
  { id: 'aside', label: '別枠' },
  { id: 'archived', label: 'アーカイブ' },
  { id: 'trash', label: 'ゴミ箱' },
];

const isToday = (iso) => !!iso && new Date(iso).toDateString() === new Date().toDateString();

/** Same semantics as server/mcp.js matchesFilter so the AI and the UI agree. */
export function matchesFilter(sm, filter) {
  const active = !sm.trashedAt && !sm.archived && !sm.asideAt;
  switch (filter) {
    case 'all': return active;
    case 'aside': return !sm.trashedAt && !sm.archived && !!sm.asideAt;
    case 'sell': return active && sm.decision === 'sell' && sm.stage !== 'sold';
    case 'draft': return active && sm.decision === 'draft' && sm.stage !== 'sold';
    case 'undecided': return active && sm.decision === 'undecided';
    case 'hold': return active && sm.decision === 'hold';
    case 'no_sell': return active && sm.decision === 'no_sell';
    case 'no_stock': return active && sm.decision === 'no_stock';
    case 'needs_photos': return active && !['no_sell', 'no_stock'].includes(sm.decision) && sm.stage !== 'sold' && (sm.counts.actual + (sm.counts.generated || 0) === 0 || sm.openPhotoRequests.length > 0 || sm.stage === 'needs_photos');
    case 'shot_today': return active && isToday(sm.lastPhotoAt);
    case 'shoot_plan': return active && sm.shootPlan;
    case 'have': return active && sm.presence === 'have';
    case 'gone': return sm.presence === 'gone' && !sm.trashedAt;
    case 'presence_unknown': return active && sm.presence === 'unknown';
    case 'presence_unchecked': return active && !sm.presence;
    case 'review_todo': return active && ['todo', 'drafted', 'approved'].includes(sm.review?.status || '');
    case 'open_checked': return active && !!sm.openCheckedAt;
    case 'not_open_checked': return active && !sm.openCheckedAt && !['no_sell', 'no_stock'].includes(sm.decision);
    case 'stock_checked': return active && !!sm.stockCheckedAt;
    case 'stock_unknown': return active && !!sm.stockUnknownAt;
    case 'not_stock_checked': return active && !sm.stockCheckedAt && !sm.stockUnknownAt && !['no_sell', 'no_stock'].includes(sm.decision) && sm.stage !== 'sold';
    case 'ai_queue': return active && ['pending', 'processing'].includes(sm.ai.state);
    case 'review': return active && (sm.stage === 'needs_review' || sm.proposals > 0 || (sm.qc && sm.qc.result !== 'pass'));
    case 'qc_issue': return active && !!sm.qc && (sm.qc.result !== 'pass' || sm.qc.stale);
    case 'ready': return active && sm.stage === 'ready';
    case 'queued': return active && sm.stage === 'queued';
    case 'mercari': return active && ['mercari_entered', 'final_check'].includes(sm.stage);
    case 'listed': return active && sm.stage === 'listed';
    case 'trading': return active && sm.stage === 'trading';
    case 'to_mercari': return active && (sm.targets || []).includes('mercari');
    case 'to_jmty': return active && (sm.targets || []).includes('jmty');
    case 'to_yahoo': return active && (sm.targets || []).includes('yahoo');
    case 'to_rakuma': return active && (sm.targets || []).includes('rakuma');
    case 'to_paypay': return active && (sm.targets || []).includes('paypay');
    case 'to_flea': return active && (sm.targets || []).includes('flea');
    case 'research_jmty': return active && /ジモティ/.test(sm.research?.group || '');
    case 'research_3000': return active && /3000円以上/.test(sm.research?.group || '');
    case 'research_2300': return active && /2300〜2999円/.test(sm.research?.group || '');
    case 'sold': return !sm.trashedAt && sm.stage === 'sold';
    case 'archived': return !sm.trashedAt && sm.archived;
    case 'trash': return !!sm.trashedAt;
    default: return active;
  }
}

const STAGE_RANK = ['needs_review', 'needs_photos', 'shooting', 'unsorted', 'ai_pending', 'ai_processing', 'ready', 'queued', 'mercari_entered', 'final_check', 'listed', 'sold'];

/** The three dates a product can carry. itemDate in a summary = the first known of (区別しない日付, 注文日, 到着日). */
export const DATE_KINDS = [
  { field: 'itemDate', label: '日付', long: '日付（代表）' },
  { field: 'orderDate', label: '注文日', long: '注文日・購入日' },
  { field: 'arrivalDate', label: '到着日', long: '到着日' },
  { field: 'vineOrderDate', label: 'Vine注文日', long: 'Vine注文日（観察ブラウザ）' },
  { field: 'shotDate', label: '撮影日', long: '撮影日（いちばん新しい現物写真）' },
  { field: 'firstShotDate', label: '初撮影日', long: '初めて撮った日（いちばん古い現物写真）' },
];
export const dateKindOf = (field = state.prefs.dateKind) => DATE_KINDS.find((k) => k.field === field) || DATE_KINDS[0];

/**
 * Sort keys. `desc` = the natural first direction, `dir` = [ascending label, descending label].
 * Products missing the value always go last, whichever direction.
 */
export const SORTS = [
  { id: 'date', label: '日付（代表）', date: 'itemDate', desc: true, dir: ['古い順', '新しい順'] },
  { id: 'order', label: '注文日・購入日', date: 'orderDate', desc: true, dir: ['古い順', '新しい順'] },
  { id: 'arrival', label: '到着日', date: 'arrivalDate', desc: true, dir: ['古い順', '新しい順'] },
  { id: 'vine', label: 'Vine注文日', date: 'vineOrderDate', desc: true, dir: ['古い順', '新しい順'] },
  { id: 'shot', label: '撮影日（新しい現物写真）', date: 'shotDate', desc: true, dir: ['古い順', '新しい順'] },
  { id: 'firstshot', label: '初めて撮った日', date: 'firstShotDate', desc: true, dir: ['古い順', '新しい順'] },
  { id: 'amazon', label: 'Amazon価格', desc: true, dir: ['安い順', '高い順'], value: (p) => p.research?.amazonPrice ?? null },
  { id: 'net', label: 'メルカリ手取り', desc: true, dir: ['少ない順', '多い順'], value: (p) => p.net?.net ?? null },
  { id: 'market', label: 'メルカリ相場', desc: true, dir: ['安い順', '高い順'], value: (p) => p.market?.median ?? null },
  { id: 'ymarket', label: 'ヤフオク相場', desc: true, dir: ['安い順', '高い順'], value: (p) => p.market?.yahoo?.median ?? null },
  { id: 'pmarket', label: 'ヤフーフリマ相場', desc: true, dir: ['安い順', '高い順'], value: (p) => p.market?.paypay?.median ?? null },
  { id: 'rmarket', label: 'ラクマ相場', desc: true, dir: ['安い順', '高い順'], value: (p) => p.market?.rakuma?.median ?? null },
  { id: 'ship', label: '送料', desc: false, dir: ['安い順', '高い順'], value: (p) => p.ship?.cheapest?.price ?? null },
  { id: 'size', label: 'サイズ（3辺合計）', desc: false, dir: ['小さい順', '大きい順'], value: (p) => p.ship?.dims?.sum ?? null },
  { id: 'category', label: '種類', desc: false, dir: ['一覧の順', '逆順'], value: (p) => { const i = (state.meta?.categories || []).indexOf(p.category); return i < 0 ? null : i; } },
  { id: 'name', label: '名前', desc: false, dir: ['あ→ん', 'ん→あ'], text: (p) => p.name || null },
  { id: 'stage', label: '作業の段階', desc: false, dir: ['前の段階から', '後の段階から'], value: (p) => { const i = STAGE_RANK.indexOf(p.stage); return i < 0 ? null : i; } },
  { id: 'photos', label: '現物写真の枚数', desc: false, dir: ['少ない順', '多い順'], value: (p) => p.counts?.actual ?? 0 },
  { id: 'updated', label: '更新日時', desc: true, dir: ['古い順', '新しい順'], text: (p) => p.updatedAt || null },
  { id: 'id', label: 'ID', desc: false, dir: ['小さい順', '大きい順'], text: (p) => p.id },
];
export const sortDef = (id = state.prefs.sort) => SORTS.find((x) => x.id === id) || SORTS[0];

/** 期間絞り込み（📅 で選んだ日付の種類で判定）。 */
export function inDateRange(p) {
  const { dateFrom, dateTo, dateNone } = state.prefs;
  const v = p[dateKindOf().field];
  if (dateNone) return !v;
  if (!dateFrom && !dateTo) return true;
  if (!v) return false;
  return (!dateFrom || v >= dateFrom) && (!dateTo || v <= dateTo);
}

const num = (x) => (x === '' || x == null || !Number.isFinite(Number(x)) ? null : Number(x));
/** 記録にある Amazon 価格（セール込みの表示価格）の範囲絞り込み。 */
export function inPriceRange(p) {
  const min = num(state.prefs.priceMin);
  const max = num(state.prefs.priceMax);
  const v = p.research?.amazonPrice ?? null;
  if (state.prefs.priceUnknown) return v == null;
  if (min == null && max == null) return true;
  if (v == null) return false;
  return (min == null || v >= min) && (max == null || v <= max);
}

export const NET_BANDS = [
  { id: 'loss', label: '赤字（0円以下）', test: (n) => n <= 0 },
  { id: 'n1', label: '¥1〜¥499', test: (n) => n > 0 && n < 500 },
  { id: 'n500', label: '¥500〜¥999', test: (n) => n >= 500 && n < 1000 },
  { id: 'n1000', label: '¥1,000〜¥2,999', test: (n) => n >= 1000 && n < 3000 },
  { id: 'n3000', label: '¥3,000〜', test: (n) => n >= 3000 },
];

/**
 * One condition "kind:id". Kinds: cat (種類) / dec (出品判断) / tgt (出品先) / photo / date (日付の有無) /
 * size / band (送料帯) / method (送り方) / market (相場) / net (手取り) / list (観察ブラウザの一覧) / img (画像取得) / aside (別枠).
 */
export function matchCond(p, cond) {
  const i = cond.indexOf(':');
  const kind = cond.slice(0, i);
  const id = cond.slice(i + 1);
  const s = p.ship || {};
  switch (kind) {
    case 'cat': return p.category === id;
    case 'dec': return p.decision === id;
    case 'tgt': return id === 'none' ? !(p.targets || []).length : (p.targets || []).includes(id);
    case 'photo': return id === 'none' ? !p.counts?.actual : !!p.counts?.actual;
    case 'stock': return id === 'checked' ? !!p.stockCheckedAt : id === 'unknown' ? !!p.stockUnknownAt : !p.stockCheckedAt && !p.stockUnknownAt && !['no_sell', 'no_stock'].includes(p.decision) && p.stage !== 'sold';
    case 'date': return { order: !!p.orderDate, noorder: !p.orderDate, arrival: !!p.arrivalDate, noarrival: !p.arrivalDate, any: !!p.itemDate, none: !p.itemDate }[id] ?? true;
    case 'size': return s.sizeClass === id;
    case 'band': return s.band === id;
    case 'method': return (s.options || []).some((o) => o.id === id);
    case 'market': return id === 'todo' ? !p.market?.checkedAt : p.market?.matchType === id;
    case 'ymarket': return id === 'todo' ? !p.market?.yahoo?.checkedAt : p.market?.yahoo?.matchType === id;
    case 'rmarket': return id === 'todo' ? !p.market?.rakuma?.checkedAt : p.market?.rakuma?.matchType === id;
    case 'pmarket': return id === 'todo' ? !p.market?.paypay?.checkedAt : p.market?.paypay?.matchType === id;
    case 'list': return id === 'none' ? !p.browser?.lists?.length : !!p.browser?.lists?.includes(id);
    case 'img': return (p.browser?.image?.status || (p.browser ? 'none' : '')) === id;
    case 'aside': return id === 'on' ? !!p.asideAt : !p.asideAt;
    case 'net': {
      if (id === 'unknown') return p.net?.net == null;
      const b = NET_BANDS.find((x) => x.id === id);
      return !!b && p.net?.net != null && b.test(p.net.net);
    }
    default: return true;
  }
}

const DECISION_CHIPS = ['undecided', 'sell', 'draft', 'hold', 'no_sell', 'no_stock'];
/**
 * 👁 表示切替: hide whole 出品判断 / 出品先 classes. A product with several destinations stays
 * while any of them is shown ('none' = no destination). A status chip that names the class itself
 * (e.g. 出さない, →ジモティー) still shows it.
 */
export function shownByClass(p, f = state.prefs.filter) {
  const hd = state.prefs.hideDec || [];
  const ht = state.prefs.hideTgt || [];
  if (hd.length && !DECISION_CHIPS.includes(f) && hd.includes(p.decision)) return false;
  const hl = state.prefs.hideLists || [];
  if (hl.length) {
    const lists = p.browser?.lists || [];
    // In several lists: hidden only when every one of them is hidden (like 出品先).
    if (lists.length ? lists.every((x) => hl.includes(x)) : hl.includes('none')) return false;
  }
  if (inHiddenDates(p)) return false;
  if (ht.length && !f.startsWith('to_')) {
    const t = p.targets || [];
    return t.length ? t.some((x) => !ht.includes(x)) : !ht.includes('none');
  }
  return true;
}
/** 日付の範囲で隠す: the chosen date of the product falls inside [from, to] (an open end = no limit). Products without that date stay. */
export function inHiddenDates(p, hd = state.prefs.hideDate) {
  if (!hd || (!hd.from && !hd.to)) return false;
  const v = p[hd.kind || 'vineOrderDate'];
  return !!v && (!hd.from || v >= hd.from) && (!hd.to || v <= hd.to);
}
export const hideDateOn = (v = state.prefs) => !!(v.hideDate && (v.hideDate.from || v.hideDate.to));
export const hidingOn = () => !!((state.prefs.hideDec || []).length || (state.prefs.hideTgt || []).length || (state.prefs.hideLists || []).length || hideDateOn());

/** Conditions of the same kind are alternatives (OR); different kinds must all hold (AND). */
export function inConds(p, conds = state.prefs.conds) {
  if (!conds?.length) return true;
  const byKind = new Map();
  for (const c of conds) {
    const k = c.slice(0, c.indexOf(':'));
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(c);
  }
  for (const list of byKind.values()) if (!list.some((c) => matchCond(p, c))) return false;
  return true;
}

export const priceRangeOn = () => !!(state.prefs.priceUnknown || num(state.prefs.priceMin) != null || num(state.prefs.priceMax) != null);
export const dateRangeOn = () => !!(state.prefs.dateFrom || state.prefs.dateTo || state.prefs.dateNone);

/** The date field the list is grouped by, or null when the sort is not by a date. */
export const groupDateField = () => sortDef().date || null;
export const isDateSort = () => !!groupDateField();

/** Products matching the status chip, search-free (before the date range), for calendar counts. */
export function productsForCalendar() {
  return [...state.products.values()].filter((p) => matchesFilter(p, state.prefs.filter) && shownByClass(p) && inPriceRange(p) && inConds(p));
}

/** The prefs that make up a saved view. */
export const VIEW_KEYS = ['filter', 'sort', 'desc', 'dateKind', 'dateFrom', 'dateTo', 'dateNone', 'priceMin', 'priceMax', 'priceUnknown', 'conds', 'hideDec', 'hideTgt', 'hideLists', 'hideDate'];
export const currentView = () => Object.fromEntries(VIEW_KEYS.map((k) => [k, state.prefs[k] ?? defaults[k] ?? '']));
export function applyView(view) {
  for (const k of VIEW_KEYS) setPref(k, k in view ? view[k] : defaults[k] ?? '');
  state.selected.clear();
}

// Names sort on a cached key (katakana = hiragana, width and case ignored) compared as plain strings:
// Intl.Collator('ja') gave the same order but took ~130 ms per sort of 480 names.
const nameKeys = new WeakMap();
const nameKey = (p) => {
  if (!p.name) return null;
  let k = nameKeys.get(p);
  if (k === undefined) nameKeys.set(p, (k = norm(p.name)));
  return k;
};
function compareBy(def, desc) {
  const textCmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  return (a, b) => {
    const get = def.date ? (p) => p[def.date] || null : def.id === 'name' ? nameKey : def.text || def.value;
    const va = get(a);
    const vb = get(b);
    if ((va == null) !== (vb == null)) return va == null ? 1 : -1; // missing last
    let c = 0;
    if (va != null) c = typeof va === 'number' ? va - vb : textCmp(String(va), String(vb));
    if (c) return desc ? -c : c;
    return desc && def.date ? (b.id < a.id ? -1 : 1) : a.id < b.id ? -1 : 1;
  };
}

export function visibleProducts() {
  const terms = termsOf(state.query);
  let items = [...state.products.values()].filter((p) => matchesFilter(p, state.prefs.filter) && shownByClass(p) && inDateRange(p) && inPriceRange(p) && inConds(p));
  state.nearIds = new Set();
  const cmp = compareBy(sortDef(), !!state.prefs.desc);
  if (!terms.length) return items.sort(cmp);
  // Real matches in the chosen order, then close ones (partial / misspelt) best first.
  const score = new Map();
  for (const p of items) {
    const s = searchScore(p, terms);
    if (s) score.set(p, s);
  }
  const exact = items.filter((p) => score.get(p) === 1).sort(cmp);
  const near = items.filter((p) => score.get(p) < 1).sort((a, b) => score.get(b) - score.get(a) || cmp(a, b));
  state.nearIds = new Set(near.map((p) => p.id));
  return exact.concat(near);
}
