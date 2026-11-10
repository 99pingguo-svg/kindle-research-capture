import { api, connectEvents, actor } from './api.js';
import { state, loadAll, refreshSummaries, emit } from './state.js';
import { showError } from './ui.js';
import { mountList } from './list.js';
import { mountDetail, showDetail, reload as reloadDetail } from './detail.js';
import { showActivity, showImport, showSettings, showLedger, showDateImport, showSnapshots } from './pages.js';
import * as uploads from './uploads.js';
import { watchNativeReturn } from './native.js';
import { initGlobalAmazonShortcut } from './amazon-search.js';
import { showBooks } from './books.js';

const app = document.getElementById('app');

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const m = /^\/p\/([^/]+)/.exec(hash);
  if (m) {
    app.classList.add('show-detail');
    showDetail(m[1]);
  } else if (['/activity', '/import', '/settings', '/ledger', '/dates', '/snapshots', '/books'].includes(hash)) {
    app.classList.add('show-detail');
    state.detailId = null;
    state.detail = null;
    ({ '/activity': showActivity, '/import': showImport, '/settings': showSettings, '/ledger': showLedger, '/dates': showDateImport, '/snapshots': showSnapshots, '/books': showBooks })[hash]();
  } else {
    app.classList.remove('show-detail');
    showDetail(null);
  }
  emit('list');
}

// Batch SSE updates: many AI writes in a burst become one refresh.
let pendingIds = new Set();
let flushTimer = null;
function onServerEvent(ev) {
  if (ev.type === 'settings') {
    api.get('/api/meta').then((m) => (state.meta = m)).catch(() => {});
    return;
  }
  if (ev.type === 'tray') return emit('tray'); // 純正カメラの写真がトレイに届いた
  if (ev.type !== 'product') return;
  pendingIds.add(ev.id);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(async () => {
    const ids = [...pendingIds];
    pendingIds = new Set();
    try {
      await refreshSummaries(ids);
      if (ids.includes(state.detailId)) await reloadDetail();
    } catch {
      /* offline; next event or reload will catch up */
    }
  }, 300);
}

async function boot() {
  try {
    // Settings and the product list in parallel (the list does not need the settings to load).
    await Promise.all([api.get('/api/meta').then((m) => (state.meta = m)), loadAll()]);
  } catch (e) {
    document.getElementById('list-pane').textContent = `サーバーに接続できません: ${e.message}`;
    return;
  }
  if (actor !== 'user') {
    // An AI agent working this tab (?as=<name>): say so on every screen.
    const name = actor[0].toUpperCase() + actor.slice(1);
    document.body.prepend(Object.assign(document.createElement('div'), { className: 'agent-banner', textContent: `🤖 ${name} として操作中（記録は ${name} の名前。ある/ない・出品判断・出品先・設定などユーザー専用の操作はできません）` }));
  }
  mountList();
  mountDetail();
  watchNativeReturn();
  initGlobalAmazonShortcut();
  window.addEventListener('hashchange', route);
  route();
  connectEvents(onServerEvent, (ok) => {
    state.online = ok;
    emit('connection', ok);
    if (ok) uploads.kick();
  });
  uploads.kick();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  // Ask the browser to keep queued photos even under storage pressure.
  navigator.storage?.persist?.().catch(() => {});
}

window.addEventListener('unhandledrejection', (e) => showError(e.reason));
boot();
