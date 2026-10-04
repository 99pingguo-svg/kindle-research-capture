// Shared client state + a tiny change bus.
import { api } from './api.js';

const PREFS_KEY = 'daicho.prefs';
const defaults = {
  filter: 'all',
  sort: 'id',
  camAutoNext: true,
  camRequestAi: true,
  camKeepTag: false,
};

function loadPrefs() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}

export const state = {
  meta: null,
  products: new Map(), // id -> summary
  query: '',
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
  { id: 'shoot_plan', label: '撮影予定' },
  { id: 'needs_photos', label: '写真不足' },
  { id: 'shot_today', label: '今日撮影済み' },
  { id: 'undecided', label: '未判断' },
  { id: 'sell', label: '出品予定' },
  { id: 'ai_queue', label: 'AI処理中' },
  { id: 'review', label: '要確認' },
  { id: 'qc_issue', label: 'QC問題' },
  { id: 'ready', label: '準備完了' },
  { id: 'queued', label: '出品待ち' },
  { id: 'mercari', label: 'メルカリ入力済' },
  { id: 'listed', label: '出品中' },
  { id: 'sold', label: '売却済み' },
  { id: 'hold', label: '保留' },
  { id: 'no_sell', label: '出品しない' },
  { id: 'archived', label: 'アーカイブ' },
  { id: 'trash', label: 'ゴミ箱' },
];

const isToday = (iso) => !!iso && new Date(iso).toDateString() === new Date().toDateString();

/** Same semantics as server/mcp.js matchesFilter so the AI and the UI agree. */
export function matchesFilter(sm, filter) {
  const active = !sm.trashedAt && !sm.archived;
  switch (filter) {
    case 'all': return active;
    case 'sell': return active && sm.decision === 'sell' && sm.stage !== 'sold';
    case 'undecided': return active && sm.decision === 'undecided';
    case 'hold': return active && sm.decision === 'hold';
    case 'no_sell': return active && sm.decision === 'no_sell';
    case 'needs_photos': return active && sm.decision !== 'no_sell' && sm.stage !== 'sold' && (sm.counts.actual === 0 || sm.openPhotoRequests.length > 0 || sm.stage === 'needs_photos');
    case 'shot_today': return active && isToday(sm.lastPhotoAt);
    case 'shoot_plan': return active && sm.shootPlan;
    case 'ai_queue': return active && ['pending', 'processing'].includes(sm.ai.state);
    case 'review': return active && (sm.stage === 'needs_review' || sm.proposals > 0 || (sm.qc && sm.qc.result !== 'pass'));
    case 'qc_issue': return active && !!sm.qc && (sm.qc.result !== 'pass' || sm.qc.stale);
    case 'ready': return active && sm.stage === 'ready';
    case 'queued': return active && sm.stage === 'queued';
    case 'mercari': return active && ['mercari_entered', 'final_check'].includes(sm.stage);
    case 'listed': return active && sm.stage === 'listed';
    case 'sold': return !sm.trashedAt && sm.stage === 'sold';
    case 'archived': return !sm.trashedAt && sm.archived;
    case 'trash': return !!sm.trashedAt;
    default: return active;
  }
}

const STAGE_RANK = ['needs_review', 'needs_photos', 'shooting', 'unsorted', 'ai_pending', 'ai_processing', 'ready', 'queued', 'mercari_entered', 'final_check', 'listed', 'sold'];

export function visibleProducts() {
  const q = state.query.trim().toLowerCase().normalize('NFKC');
  let items = [...state.products.values()].filter((p) => matchesFilter(p, state.prefs.filter));
  if (q) {
    const terms = q.split(/\s+/);
    items = items.filter((p) => {
      const hay = [p.id, p.name, p.brand, p.model, p.jan, p.notes, p.location, p.title].join(' ').toLowerCase().normalize('NFKC');
      return terms.every((t) => hay.includes(t));
    });
  }
  const sort = state.prefs.sort;
  items.sort((a, b) => {
    if (sort === 'updated') return b.updatedAt.localeCompare(a.updatedAt);
    if (sort === 'name') return (a.name || '￿').localeCompare(b.name || '￿', 'ja');
    if (sort === 'stage') return STAGE_RANK.indexOf(a.stage) - STAGE_RANK.indexOf(b.stage) || a.id.localeCompare(b.id);
    if (sort === 'photos') return a.counts.actual - b.counts.actual || a.id.localeCompare(b.id);
    return a.id.localeCompare(b.id);
  });
  return items;
}
