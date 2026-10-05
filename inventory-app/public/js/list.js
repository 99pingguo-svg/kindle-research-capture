// 商品一覧: the main screen. Decision, camera, status, issues and bulk actions are all
// available per row so most work never needs the detail page.
import { h, clear, toast, showError, choose, sheet, yen } from './ui.js';
import { api } from './api.js';
import { state, setPref, on, FILTERS, matchesFilter, visibleProducts, applyProduct, loadAll, inDateRange, isDateSort, productsForCalendar } from './state.js';
import { pickDateRange, rangeLabel, fmtDay } from './calendar.js';
import { openCamera } from './camera.js';
import * as uploads from './uploads.js';

let els = null;

export function mountList() {
  const pane = document.getElementById('list-pane');
  const search = h('input', {
    type: 'search', placeholder: '商品名・型番・ブランド・JAN・ID', value: state.query, enterkeyhint: 'search',
    oninput: (e) => { state.query = e.target.value; renderItems(); renderChips(); },
  });
  els = {
    upload: h('span'),
    conn: h('span', { class: 'conn-indicator' }),
    chips: h('div', { class: 'chips' }),
    toolbar: h('div', { class: 'toolbar' }),
    list: h('div', { class: 'list' }),
    fab: h('div', { class: 'fab-row' }),
    bulk: h('div'),
  };
  pane.append(
    h('header', { class: 'topbar' },
      h('div', { class: 'topbar-row' },
        h('h1', null, '商品台帳'),
        els.conn, els.upload,
        h('button', { class: 'icon-btn', 'aria-label': '追加', onclick: addMenu }, '＋'),
        h('button', { class: 'icon-btn', 'aria-label': 'メニュー', onclick: mainMenu }, '⋯')),
      h('div', { class: 'search' }, search),
      els.chips, els.toolbar),
    els.list, els.fab, els.bulk);
  on('list', renderAll);
  on('uploads', renderUploadIndicator);
  on('uploaded', (ev) => {
    if (ev.summary) state.products.set(ev.productId, ev.summary);
    renderAll();
  });
  on('connection', (ok) => (els.conn.textContent = ok ? '' : '⚠ オフライン'));
  renderAll();
}

function renderAll() {
  if (!els) return;
  renderChips();
  renderToolbar();
  renderItems();
  renderFab();
  renderBulk();
}

function renderUploadIndicator(st = uploads.status()) {
  clear(els.upload);
  if (st.pending) {
    els.upload.append(h('button', {
      class: `upload-indicator ${st.failed ? 'err' : ''}`, style: { border: 'none' },
      onclick: () => (st.failed ? uploads.retryFailed() : uploads.kick()),
    }, st.failed ? `⚠ 送信失敗 ${st.failed}` : `↑ ${st.pending}`));
  }
}

function renderChips() {
  const all = [...state.products.values()].filter(inDateRange);
  const counts = Object.fromEntries(FILTERS.map((f) => [f.id, all.filter((p) => matchesFilter(p, f.id)).length]));
  clear(els.chips).append(
    ...FILTERS.filter((f) => counts[f.id] > 0 || ['all', 'shoot_plan', 'needs_photos', 'ready', state.prefs.filter].includes(f.id)).map((f) =>
      h('button', {
        class: `chip ${state.prefs.filter === f.id ? 'on' : ''}`,
        onclick: () => {
          setPref('filter', f.id);
          state.selected.clear();
          renderAll();
          els.list.scrollIntoView({ block: 'start' });
        },
      }, f.label, h('span', { class: 'n' }, counts[f.id]))));
}

function renderToolbar() {
  const n = visibleProducts().length;
  const ranged = !!(state.prefs.dateFrom || state.prefs.dateTo || state.prefs.dateNone);
  const sort = state.prefs.sort;
  clear(els.toolbar).append(
    h('span', { class: 'count' }, `${n}件`),
    h('button', { class: `btn small date-range ${ranged ? 'on' : ''}`, onclick: openRange, 'aria-label': '日付で絞り込み' }, '📅 ', rangeLabel(state.prefs)),
    ranged ? h('button', { class: 'btn small ghost', 'aria-label': '期間を解除', onclick: () => setRange({ dateFrom: '', dateTo: '', dateNone: false }) }, '✕') : '',
    h('span', { class: 'spacer' }),
    // One tap: newest ⇄ oldest. From any other order it jumps back to newest first.
    h('button', {
      class: `btn small ${isDateSort(sort) ? 'sort-on' : ''}`,
      onclick: () => { setPref('sort', sort === 'date_desc' ? 'date_asc' : 'date_desc'); renderAll(); },
    }, sort === 'date_asc' ? '古い順 ↑' : sort === 'date_desc' ? '新しい順 ↓' : '日付順にする'),
    h('select', { class: 'sort-more', onchange: (e) => { setPref('sort', e.target.value); renderAll(); }, 'aria-label': 'その他の並び順' },
      [['date_desc', '日付 新しい順'], ['date_asc', '日付 古い順'], ['id', 'ID順'], ['updated', '更新順'], ['name', '名前順'], ['stage', '状態順'], ['photos', '写真が少ない順']].map(([v, l]) =>
        h('option', { value: v, selected: sort === v }, l))),
    h('button', { class: 'btn small', onclick: toggleSelect }, state.selectMode ? '選択終了' : '選択'));
}

function setRange(r) {
  setPref('dateFrom', r.dateFrom);
  setPref('dateTo', r.dateTo);
  setPref('dateNone', r.dateNone);
  state.selected.clear();
  renderAll();
  els.list.scrollIntoView({ block: 'start' });
}

async function openRange() {
  const r = await pickDateRange(state.prefs, productsForCalendar());
  if (r) setRange(r);
}

function toggleSelect() {
  state.selectMode = !state.selectMode;
  state.selected.clear();
  renderAll();
}

const STATUS_CLASS = {
  unsorted: '', needs_photos: 'warn', shooting: 'info', ai_pending: 'ai', ai_processing: 'ai', needs_review: 'warn',
  ready: 'ok', queued: 'accent', mercari_entered: 'accent', final_check: 'accent', listed: 'ok', sold: '', hold: 'warn', no_sell: '', archived: '', trash: 'danger',
};

function badgesFor(p) {
  const b = [h('span', { class: `badge ${STATUS_CLASS[p.status.id] || ''}` }, p.status.label)];
  b.push(h('span', { class: `badge ${p.counts.actual ? '' : 'warn'}` }, `📷 ${p.counts.actual}`));
  if (p.counts.listing) b.push(h('span', { class: 'badge' }, `出品用 ${p.counts.listing}`));
  if (p.ai.label) b.push(h('span', { class: `badge ${p.ai.state === 'error' ? 'danger' : p.qc && !p.qc.stale && p.qc.result === 'pass' ? 'ok' : 'ai'}` }, (p.ai.state === 'processing' ? '⏳ ' : '') + p.ai.label));
  if (p.proposals) b.push(h('span', { class: 'badge ai' }, `AI提案 ${p.proposals}`));
  if (p.price != null) b.push(h('span', { class: 'badge' }, yen(p.price)));
  if (p.shootPlan) b.push(h('span', { class: 'badge info' }, '撮影予定'));
  return b;
}

function issuesFor(p) {
  if (['no_sell', 'archived', 'trash', 'sold', 'listed'].includes(p.status.id)) return null;
  const lines = [];
  for (const r of p.openPhotoRequests) lines.push(`📷 追加撮影: ${r.label}`);
  for (const i of p.issues) if (!i.startsWith('追加撮影')) lines.push(`⚠ ${i}`);
  if (!lines.length || p.decision !== 'sell') return null;
  return h('div', { class: 'issues' }, lines.slice(0, 2).map((l) => h('div', null, l)), lines.length > 2 && h('div', { class: 'muted' }, `ほか${lines.length - 2}件`));
}

function decisionSeg(p) {
  const opts = [['sell', '出品'], ['hold', '保留'], ['no_sell', '出さない']];
  return h('div', { class: 'seg', style: { marginTop: '7px' } },
    opts.map(([v, l]) => h('button', {
      class: `${v} ${p.decision === v ? 'on' : ''}`,
      onclick: async (e) => {
        e.stopPropagation();
        try {
          applyProduct(await api.post(`/api/products/${p.id}/decision`, { decision: p.decision === v ? 'undecided' : v }));
        } catch (err) {
          showError(err);
        }
      },
    }, l)));
}

function renderItems() {
  const items = visibleProducts();
  clear(els.list);
  if (!items.length) {
    els.list.append(h('div', { class: 'empty' },
      state.products.size ? '該当する商品はありません' : h('div', null,
        h('p', null, 'まだ商品がありません'),
        h('div', { class: 'row-actions', style: { justifyContent: 'center' } },
          h('button', { class: 'btn primary', onclick: () => (location.hash = '#/import') }, '商品リストを一括登録'),
          h('button', { class: 'btn', onclick: newAndShoot }, '📷 撮影から登録')))));
    return;
  }
  const frag = document.createDocumentFragment();
  const ids = items.map((p) => p.id);
  const groups = isDateSort() ? new Map() : null;
  if (groups) for (const p of items) groups.set(p.itemDate || '', (groups.get(p.itemDate || '') || 0) + 1);
  let lastDate = null;
  items.forEach((p, idx) => {
    if (groups && (p.itemDate || '') !== lastDate) {
      lastDate = p.itemDate || '';
      const d = lastDate;
      frag.append(h('button', {
        class: 'date-head',
        title: d ? 'タップでこの日だけ表示' : '日付のない商品だけ表示',
        onclick: () => setRange(d ? { dateFrom: d, dateTo: d, dateNone: false } : { dateFrom: '', dateTo: '', dateNone: true }),
      }, d ? fmtDay(d) : '日付なし', h('span', { class: 'n' }, `${groups.get(d)}件`)));
    }
    const selected = state.selected.has(p.id);
    const open = () => {
      if (state.selectMode) {
        selected ? state.selected.delete(p.id) : state.selected.add(p.id);
        renderItems();
        renderBulk();
      } else location.hash = `#/p/${p.id}`;
    };
    frag.append(h('article', { class: `item ${selected ? 'selected' : ''} ${state.detailId === p.id ? 'active' : ''}`, dataset: { id: p.id } },
      h('div', { class: 'thumb', style: p.thumb ? { backgroundImage: `url("${p.thumb}")` } : null, onclick: open },
        state.selectMode ? h('div', { class: 'select-check' }, selected ? '✓' : '') : !p.thumb && '📦',
        p.thumbIsReference && !state.selectMode && h('div', { class: 'ref-badge' }, '参考画像')),
      h('div', { class: 'item-main', onclick: open },
        h('div', { class: 'item-title' }, h('span', { class: 'pid' }, p.id), p.name || h('span', { class: 'muted' }, '名称未設定')),
        h('div', { class: 'item-sub' },
          // the date is in the group header when sorted by date; otherwise show it on the row
          !isDateSort() && (p.itemDate ? h('span', { class: 'item-date' }, fmtDay(p.itemDate)) : h('span', { class: 'item-date none' }, '日付なし')),
          [p.brand, p.model, p.location && `📍${p.location}`].filter(Boolean).join(' · ')),
        h('div', { class: 'badges' }, badgesFor(p)),
        issuesFor(p),
        !state.selectMode && !p.trashedAt && decisionSeg(p)),
      h('div', { class: 'item-side' },
        !p.trashedAt && h('button', {
          class: 'icon-btn cam', 'aria-label': `${p.name || p.id} を撮影`,
          onclick: (e) => { e.stopPropagation(); openCamera({ ids, index: idx }); },
        }, '📷'))));
  });
  els.list.append(frag);
}

function renderFab() {
  clear(els.fab);
  if (state.selectMode) return;
  const ids = visibleProducts().filter((p) => !p.trashedAt).map((p) => p.id);
  els.fab.append(
    h('button', { class: 'btn primary big', disabled: !ids.length, onclick: () => openCamera({ ids, index: 0 }) }, `📷 撮影モード（${ids.length}件）`));
}

function renderBulk() {
  clear(els.bulk);
  if (!state.selectMode) return;
  const ids = [...state.selected];
  const run = (op, value, label) => async () => {
    if (!ids.length) return toast('商品を選択してください');
    try {
      const r = await api.post('/api/bulk', { ids, op, value });
      for (const p of r.products) state.products.set(p.id, p);
      const failed = r.results.filter((x) => !x.ok);
      if (failed.length) toast(`${label}: ${ids.length - failed.length}件成功 / ${failed.length}件失敗\n${failed.slice(0, 3).map((f) => `${f.id}: ${f.error}`).join('\n')}`, { error: true });
      else toast(`${label}: ${ids.length}件`);
      renderAll();
    } catch (e) {
      showError(e);
    }
  };
  const visible = visibleProducts().map((p) => p.id);
  els.bulk.append(h('div', { class: 'bulkbar' },
    h('div', { class: 'row', style: { alignItems: 'center' } },
      h('strong', null, `${ids.length}件選択`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => { visible.forEach((id) => state.selected.add(id)); renderItems(); renderBulk(); } }, '全選択'),
      h('button', { class: 'btn small', onclick: () => { state.selected.clear(); renderItems(); renderBulk(); } }, '解除'),
      h('button', { class: 'btn small', onclick: toggleSelect }, '完了')),
    h('div', { class: 'row' },
      h('button', { class: 'btn small primary', onclick: run('ai', 'full', 'AI整理→原稿→QC を依頼') }, '🤖 AIまとめて'),
      h('button', { class: 'btn small', onclick: run('ai', 'organize', 'AI整理を依頼') }, 'AI整理'),
      h('button', { class: 'btn small', onclick: run('ai', 'draft', '原稿作成を依頼') }, '原稿'),
      h('button', { class: 'btn small', onclick: run('ai', 'qc', 'QCを依頼') }, 'QC'),
      h('button', { class: 'btn small', onclick: () => ids.length && openCamera({ ids }) }, '📷 撮影')),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: run('decision', 'sell', '出品する') }, '出品する'),
      h('button', { class: 'btn small', onclick: run('decision', 'hold', '保留') }, '保留'),
      h('button', { class: 'btn small', onclick: run('decision', 'no_sell', '出品しない') }, '出品しない'),
      h('button', { class: 'btn small', onclick: run('shootPlan', true, '撮影予定に追加') }, '撮影予定+'),
      h('button', { class: 'btn small', onclick: run('shootPlan', false, '撮影予定から外す') }, '撮影予定−')),
    h('div', { class: 'row' },
      h('button', { class: 'btn small primary', onclick: run('queue', null, 'メルカリ転記を依頼（出品待ち）') }, '🛒 転記依頼'),
      h('button', { class: 'btn small', onclick: run('unqueue', null, '出品待ちから戻す') }, '転記取消'),
      h('button', { class: 'btn small', onclick: () => ids.length && (location.href = `/api/export.zip?ids=${ids.join(',')}`) }, '書き出し'),
      state.prefs.filter === 'archived'
        ? h('button', { class: 'btn small', onclick: run('archive', false, 'アーカイブから戻す') }, 'アーカイブ解除')
        : h('button', { class: 'btn small', onclick: run('archive', true, 'アーカイブ') }, 'アーカイブ'),
      state.prefs.filter === 'trash'
        ? h('button', { class: 'btn small', onclick: run('restore', null, '復元') }, '復元')
        : h('button', { class: 'btn small danger', onclick: async () => { if (await choose(`${ids.length}件をゴミ箱へ移動しますか？`, [{ label: 'ゴミ箱へ移動', value: true, danger: true }])) run('trash', null, 'ゴミ箱へ')(); } }, '削除'))));
}

async function newAndShoot() {
  try {
    const { product } = await api.post('/api/products', { name: '' });
    applyProduct(product);
    openCamera({ ids: [product.id] });
  } catch (e) {
    showError(e);
  }
}

async function addMenu() {
  const v = await choose('商品を追加', [
    { label: '📷 撮影して登録（名前はあとでAIが特定）', value: 'shoot', primary: true },
    { label: '✏️ 名前・URLを入力して登録', value: 'form' },
    { label: '📋 商品リストを一括登録', value: 'import' },
  ]);
  if (v === 'shoot') newAndShoot();
  if (v === 'form') newProductForm();
  if (v === 'import') location.hash = '#/import';
}

export function newProductForm() {
  sheet((close) => {
    const name = h('input', { type: 'text', placeholder: '例: Anker PowerCore 10000', autofocus: true });
    const url = h('input', { type: 'url', placeholder: 'https://…（任意）' });
    const dupBox = h('div');
    let timer;
    const checkDup = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const d = await api.post('/api/duplicates', { name: name.value, links: url.value ? [url.value] : [] }).catch(() => []);
        clear(dupBox).append(...d.map((x) => h('div', { class: 'proposal', style: { borderColor: 'var(--warn)', background: 'var(--warn-weak)', marginBottom: '6px' } },
          `⚠ #${x.id} ${x.name} と同一商品の可能性（${x.reasons.join('・')}）`)));
      }, 350);
    };
    name.addEventListener('input', checkDup);
    url.addEventListener('change', checkDup);
    const create = async (shoot) => {
      try {
        const { product } = await api.post('/api/products', { name: name.value.trim(), links: url.value.trim() ? [url.value.trim()] : [] });
        applyProduct(product);
        close();
        if (shoot) openCamera({ ids: [product.id] });
        else location.hash = `#/p/${product.id}`;
      } catch (e) {
        showError(e);
      }
    };
    return h('div', null,
      h('h2', null, '商品を登録'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '商品名'), name),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '参考URL'), url),
      dupBox,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => create(true) }, '登録して撮影'),
        h('button', { class: 'btn', onclick: () => create(false) }, '登録'),
        h('button', { class: 'btn ghost', onclick: () => close() }, 'キャンセル')));
  });
}

async function mainMenu() {
  const v = await choose(null, [
    { label: '🕘 共同作業の履歴', value: '#/activity' },
    { label: '📋 商品リストを一括登録', value: '#/import' },
    { label: '📅 日付を一括反映（既存商品）', value: '#/dates' },
    { label: '⚙️ 設定・AI接続・書き出し', value: '#/settings' },
    { label: '↻ 再読み込み', value: 'reload' },
  ]);
  if (v === 'reload') {
    await loadAll().catch(showError);
    toast('更新しました');
  } else if (v) location.hash = v;
}
