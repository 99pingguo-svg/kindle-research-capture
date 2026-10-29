// 商品一覧: the main screen. Decision, camera, status, issues and bulk actions are all
// available per row so most work never needs the detail page.
import { h, clear, toast, showError, choose, sheet, yen } from './ui.js';
import { api } from './api.js';
import {
  state, setPref, on, FILTERS, matchesFilter, visibleProducts, applyProduct, loadAll, inDateRange, inPriceRange, inConds, matchCond, productsForCalendar,
  priceRangeOn, dateRangeOn, NET_BANDS, SORTS, sortDef, DATE_KINDS, dateKindOf, groupDateField, currentView, applyView, shownByClass, hidingOn,
} from './state.js';
import { pickDateRange, rangeLabel, fmtDay } from './calendar.js';
import { openCamera } from './camera.js';
import * as uploads from './uploads.js';
import { openNativeSetup, shootWithNativeCamera } from './native.js';

let els = null;

export function mountList() {
  const pane = document.getElementById('list-pane');
  const search = h('input', {
    type: 'search', placeholder: '商品名・型番・ブランド・JAN・ID', value: state.query, enterkeyhint: 'search',
    oninput: (e) => { state.query = e.target.value; scheduleRender(); },
  });
  els = {
    upload: h('span'),
    conn: h('span', { class: 'conn-indicator' }),
    chips: h('div', { class: 'chips' }),
    toolbar: h('div', { class: 'toolbar' }),
    condbar: h('div', { class: 'cond-bar' }),
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
      els.chips, els.toolbar, els.condbar),
    els.list, els.fab, els.bulk);
  // Group headings stick just below the (variable-height) sticky header.
  const topbar = pane.querySelector('.topbar');
  new ResizeObserver(() => pane.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`)).observe(topbar);
  on('list', scheduleRender);
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
  // Filter and sort once per redraw; the toolbar count, the rows and the camera button share it.
  const items = visibleProducts();
  renderChips();
  renderToolbar(items);
  renderItems(items);
  renderFab(items);
  renderBulk();
}

// Typing and bursts of live updates redraw once per frame instead of once per event.
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderAll();
  });
}

/** Back to the first result. (Scrolling the list itself to the top would leave it under the sticky header.) */
function toTop() {
  for (let el = els.list.parentElement; el && el !== document.body; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
      el.scrollTop = 0;
      return;
    }
  }
  window.scrollTo(0, 0);
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
  // Counts follow the other filters (期間・価格帯・絞り込み) so they match what a tap would show.
  const all = [...state.products.values()].filter((p) => inDateRange(p) && inPriceRange(p) && inConds(p));
  const counts = Object.fromEntries(FILTERS.map((f) => [f.id, all.filter((p) => matchesFilter(p, f.id) && shownByClass(p, f.id)).length]));
  clear(els.chips).append(
    ...FILTERS.filter((f) => counts[f.id] > 0 || ['all', 'shoot_plan', 'needs_photos', 'ready', state.prefs.filter].includes(f.id)).map((f) =>
      h('button', {
        class: `chip ${state.prefs.filter === f.id ? 'on' : ''}`,
        onclick: () => {
          setPref('filter', f.id);
          state.selected.clear();
          renderAll();
          toTop();
        },
      }, f.label, h('span', { class: 'n' }, counts[f.id]))));
}

function renderToolbar(items = visibleProducts()) {
  const n = items.length;
  const dk = dateKindOf();
  const def = sortDef();
  const desc = !!state.prefs.desc;
  const nConds = state.prefs.conds.length;
  clear(els.toolbar).append(
    h('span', { class: 'count' }, `${n}件`),
    h('button', { class: `btn small date-range ${dateRangeOn() ? 'on' : ''}`, onclick: openRange, 'aria-label': `${dk.label}で絞り込み` },
      '📅 ', dk.field !== 'itemDate' ? `${dk.label} ` : '', rangeLabel(state.prefs, dk.label)),
    h('button', { class: `btn small date-range ${priceRangeOn() ? 'on' : ''}`, onclick: openPriceRange, 'aria-label': 'Amazon価格で絞り込み' }, '💴 ', priceRangeLabel()),
    h('button', { class: `btn small date-range ${nConds ? 'on' : ''}`, onclick: openConds, 'aria-label': '種類・判断・サイズ・送料・相場などで絞り込み' }, '🔍 ', nConds ? `絞り込み ${nConds}` : '絞り込み'),
    h('button', { class: `btn small date-range ${hidingOn() ? 'on' : ''}`, onclick: openShowHide, 'aria-label': '出品判断・出品先ごとに表示／非表示' }, '👁 ', hidingOn() ? `非表示 ${(state.prefs.hideDec || []).length + (state.prefs.hideTgt || []).length}` : '判断・出品先'),
    h('button', { class: 'btn small', onclick: openViews, 'aria-label': '保存した表示' }, '★ 表示'),
    h('span', { class: 'spacer' }),
    h('select', {
      class: 'sort-more', 'aria-label': '並び順',
      onchange: (e) => {
        const d = SORTS.find((x) => x.id === e.target.value);
        setPref('sort', d.id);
        setPref('desc', d.desc);
        // Sorting by a date also makes 📅 work on that date.
        if (d.date) setPref('dateKind', d.date);
        renderAll();
      },
    }, SORTS.map((x) => h('option', { value: x.id, selected: x.id === def.id }, x.label))),
    h('button', { class: 'btn small sort-on', 'aria-label': '並び順の向きを切り替え', onclick: () => { setPref('desc', !desc); renderAll(); } },
      `${def.dir[desc ? 1 : 0]} ${desc ? '↓' : '↑'}`),
    h('button', { class: 'btn small', onclick: toggleSelect }, state.selectMode ? '選択終了' : '選択'));
  renderCondBar();
}

/** Active conditions as removable chips, plus one tap to clear every filter. */
function renderCondBar() {
  const conds = state.prefs.conds;
  const any = conds.length || dateRangeOn() || priceRangeOn() || hidingOn();
  clear(els.condbar);
  if (!any) return;
  const dk = dateKindOf();
  // (native append: drop the false placeholders and flatten the per-condition chips)
  els.condbar.append(...[
    dateRangeOn() && h('button', { class: 'cond-chip', onclick: () => setRange({ dateFrom: '', dateTo: '', dateNone: false }) }, `${dk.label} ${rangeLabel(state.prefs, dk.label)}`, h('span', { class: 'x' }, '✕')),
    priceRangeOn() && h('button', { class: 'cond-chip', onclick: () => setPriceRange({ priceMin: '', priceMax: '', priceUnknown: false }) }, `Amazon ${priceRangeLabel()}`, h('span', { class: 'x' }, '✕')),
    hidingOn() && h('button', { class: 'cond-chip hide', onclick: () => setHidden([], []) }, `非表示: ${hiddenLabels(state.prefs).join('・')}`, h('span', { class: 'x' }, '✕')),
    ...conds.map((c) => h('button', { class: 'cond-chip', onclick: () => setConds(conds.filter((x) => x !== c)) }, condLabel(c), h('span', { class: 'x' }, '✕'))),
    h('button', { class: 'btn small ghost', onclick: clearAllFilters }, 'すべて解除'),
  ].filter(Boolean));
}

function clearAllFilters() {
  for (const [k, v] of Object.entries({ dateFrom: '', dateTo: '', dateNone: false, priceMin: '', priceMax: '', priceUnknown: false, conds: [], hideDec: [], hideTgt: [] })) setPref(k, v);
  state.selected.clear();
  renderAll();
}

function setRange(r) {
  setPref('dateFrom', r.dateFrom);
  setPref('dateTo', r.dateTo);
  setPref('dateNone', r.dateNone);
  state.selected.clear();
  renderAll();
  toTop();
}

const yenOr = (v) => (v === '' || v == null ? '' : yen(Number(v)));
function priceRangeLabel() {
  const { priceMin, priceMax, priceUnknown } = state.prefs;
  if (priceUnknown) return 'Amazon価格なし';
  if (!priceRangeOn()) return '価格帯';
  return `${yenOr(priceMin)}〜${yenOr(priceMax)}`;
}
function setPriceRange(r) {
  for (const [k, v] of Object.entries(r)) setPref(k, v);
  state.selected.clear();
  renderAll();
  toTop();
}
const SIZE_SOURCE = { package: '梱包サイズ', product: '本体サイズ＋梱包分の目安', estimate: '商品名・写真からの見立て' };
const CONF = { high: '高', mid: '中', low: '低' };
const MATCH_LABEL = { same: '同じ商品', similar: '似た商品', none: '見つからず' };
const DATE_COND = { order: '注文日あり', noorder: '注文日なし', arrival: '到着日あり', noarrival: '到着日なし', any: '日付あり', none: '日付なし' };
const kindOf = (c) => c.slice(0, c.indexOf(':'));

function condLabel(c) {
  const kind = kindOf(c);
  const id = c.slice(kind.length + 1);
  const sh = state.meta.delivery || {};
  switch (kind) {
    case 'cat': return id;
    case 'dec': return id === 'undecided' ? '未判断' : state.meta.decisions.find((d) => d.id === id)?.label || id;
    case 'tgt': return id === 'none' ? '出品先なし' : `→${channelName(id)}`;
    case 'photo': return id === 'none' ? '現物写真なし' : '現物写真あり';
    case 'date': return DATE_COND[id] || id;
    case 'size': return sh.sizeClasses?.find((x) => x.id === id)?.label.replace(/（.*/, '') || id;
    case 'band': return `送料${sh.bands?.find((x) => x.id === id)?.label.replace(/（.*/, '') || id}`;
    case 'method': return sh.methods?.find((x) => x.id === id)?.label || id;
    case 'market': return id === 'todo' ? '相場 未調査' : `相場 ${MATCH_LABEL[id]}`;
    case 'ymarket': return id === 'todo' ? 'ヤフオク 未調査' : `ヤフオク ${MATCH_LABEL[id]}`;
    case 'rmarket': return id === 'todo' ? 'ラクマ 未調査' : `ラクマ ${MATCH_LABEL[id]}`;
    case 'net': return id === 'unknown' ? '手取り 不明' : `手取り ${NET_BANDS.find((x) => x.id === id)?.label || id}`;
    default: return c;
  }
}

function setConds(conds) {
  setPref('conds', conds);
  state.selected.clear();
  renderAll();
}

/**
 * Pick any number of conditions. Within one heading they are alternatives (どれか),
 * across headings all must hold. Each count = what that heading would show with this choice.
 */
function openConds() {
  const sh = state.meta.delivery || { sizeClasses: [], bands: [], methods: [], groups: [] };
  const base = [...state.products.values()].filter((p) => matchesFilter(p, state.prefs.filter) && shownByClass(p) && inDateRange(p) && inPriceRange(p));
  sheet((close) => {
    const body = h('div');
    const render = () => {
      const conds = state.prefs.conds;
      const baseFor = new Map();
      const countOf = (c) => {
        const k = kindOf(c);
        if (!baseFor.has(k)) baseFor.set(k, base.filter((p) => inConds(p, conds.filter((x) => kindOf(x) !== k))));
        return baseFor.get(k).filter((p) => matchCond(p, c)).length;
      };
      const chip = (c, label = condLabel(c)) => {
        const on = conds.includes(c);
        const n = countOf(c);
        return h('button', {
          class: `btn small ${on ? 'primary' : ''}`, disabled: !on && !n,
          onclick: () => { setConds(on ? conds.filter((x) => x !== c) : [...conds, c]); render(); },
        }, label, h('span', { class: 'muted' }, ` ${n}`));
      };
      const section = (title, chips, note) => [
        h('h3', { class: 'small', style: { margin: '14px 0 6px' } }, title, note && h('span', { class: 'muted', style: { fontWeight: 'normal' } }, `  ${note}`)),
        h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } }, chips)];
      const shown = base.filter((p) => inConds(p, conds)).length;
      clear(body).append(
        h('h2', null, '🔍 絞り込み'),
        h('p', { class: 'muted small' }, '同じ見出しの中で複数選ぶと「どれか」、見出しをまたぐと「全部に当てはまる」ものを表示します。数字は選んだときの件数。'),
        ...section('種類', (state.meta.categories || []).map((c) => chip(`cat:${c}`)), '未設定の商品は商品名からの推定'),
        // 出品判断・出品先 are shown/hidden with 👁 (and old dec:/tgt: conditions still work).
        ...section('日付', Object.keys(DATE_COND).map((id) => chip(`date:${id}`))),
        ...section('写真', [chip('photo:has'), chip('photo:none')]),
        ...section('サイズ', sh.sizeClasses.map((c) => chip(`size:${c.id}`, c.label))),
        ...section('いちばん安いメルカリ便の送料', sh.bands.map((b) => chip(`band:${b.id}`, b.label))),
        ...sh.groups.flatMap((g) => section(`この方法で送れる（${g.label}）`, sh.methods.filter((m) => m.group === g.id).map((m) => chip(`method:${m.id}`)))),
        ...section('メルカリ相場（売り切れ）', [chip('market:same', '同じ商品の相場'), chip('market:similar', '似た商品の相場'), chip('market:none', '見つからず'), chip('market:todo', '未調査')]),
        ...section('ヤフオク相場（落札）', [chip('ymarket:same', '同じ商品の相場'), chip('ymarket:similar', '似た商品の相場'), chip('ymarket:none', '見つからず'), chip('ymarket:todo', '未調査')]),
        ...section('ラクマ相場（売り切れ）', [chip('rmarket:same', '同じ商品の相場'), chip('rmarket:similar', '似た商品の相場'), chip('rmarket:none', '見つからず'), chip('rmarket:todo', '未調査')]),
        ...section('メルカリでの手取り（仕入れ額は含まない）', [...NET_BANDS.map((b) => chip(`net:${b.id}`, b.label)), chip('net:unknown', '不明')],
          '相場（無ければ販売価格）−手数料10%−いちばん安いメルカリ便'),
        h('div', { class: 'actions sticky-actions' },
          h('button', { class: 'btn primary', onclick: () => { close(); toTop(); } }, `${shown}件を表示`),
          conds.length > 0 && h('button', { class: 'btn', onclick: () => { setConds([]); render(); } }, '絞り込みを解除')));
    };
    render();
    return body;
  });
}

const decLabel = (id) => (id === 'undecided' ? '未判断' : state.meta.decisions.find((d) => d.id === id)?.label || id);
const tgtLabel = (id) => (id === 'none' ? '出品先なし' : channelName(id));
const hiddenLabels = (v) => [...(v.hideDec || []).map(decLabel), ...(v.hideTgt || []).map(tgtLabel)];

function setHidden(hideDec, hideTgt) {
  setPref('hideDec', hideDec);
  setPref('hideTgt', hideTgt);
  state.selected.clear();
  renderAll();
}

/** 👁 Show or hide whole classes: each 出品判断 and each 出品先 (several at once). */
function openShowHide() {
  sheet((close) => {
    const body = h('div');
    const all = [...state.products.values()].filter((p) => matchesFilter(p, 'all'));
    const render = () => {
      const hd = state.prefs.hideDec || [];
      const ht = state.prefs.hideTgt || [];
      const toggle = (list, id, key) => {
        const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
        key === 'dec' ? setHidden(next, ht) : setHidden(hd, next);
        render();
      };
      const btn = (shown, label, n, onclick) => h('button', { class: `show-toggle ${shown ? 'on' : ''}`, 'aria-pressed': String(shown), onclick },
        h('span', { class: 'tick' }, shown ? '✓' : ''), label, h('span', { class: 'muted' }, ` ${n}`));
      const decs = ['undecided', ...state.meta.decisions.filter((d) => d.id !== 'undecided').map((d) => d.id)];
      const tgts = [...(state.meta.channels || []).map((c) => c.id), 'none'];
      const tgtCount = (id) => all.filter((p) => (id === 'none' ? !(p.targets || []).length : (p.targets || []).includes(id))).length;
      const shownNow = all.filter((p) => shownByClass(p, 'all')).length;
      clear(body).append(
        h('h2', null, '👁 表示する商品'),
        h('p', { class: 'muted small' }, 'チェックを外した判断・出品先の商品を一覧から隠します（いくつでも）。出品先が複数ある商品は、どれか1つでも表示中なら出ます。上の「出さない」「→ジモティー」などのチップを選んだときは、その分は隠しません。'),
        h('h3', { class: 'small', style: { margin: '12px 0 6px' } }, '出品判断'),
        h('div', { class: 'show-grid' }, decs.map((id) => btn(!hd.includes(id), decLabel(id), all.filter((p) => p.decision === id).length, () => toggle(hd, id, 'dec')))),
        h('h3', { class: 'small', style: { margin: '14px 0 6px' } }, '出品先'),
        h('div', { class: 'show-grid' }, tgts.map((id) => btn(!ht.includes(id), tgtLabel(id), tgtCount(id), () => toggle(ht, id, 'tgt')))),
        h('div', { class: 'actions sticky-actions' },
          h('button', { class: 'btn primary', onclick: () => { close(); toTop(); } }, `${shownNow}件を表示`),
          hidingOn() && h('button', { class: 'btn', onclick: () => { setHidden([], []); render(); } }, 'すべて表示')));
    };
    render();
    return body;
  });
}

/** Saved views (filters + sort), stored in the app's settings so the iPhone and the Mac share them. */
function viewSummary(v) {
  const f = FILTERS.find((x) => x.id === v.filter);
  const d = SORTS.find((x) => x.id === v.sort) || SORTS[0];
  const dk = DATE_KINDS.find((k) => k.field === v.dateKind) || DATE_KINDS[0];
  const parts = [];
  if (f && f.id !== 'all') parts.push(f.label);
  if (v.dateFrom || v.dateTo || v.dateNone) parts.push(`${dk.label} ${rangeLabel(v, dk.label)}`);
  if (v.priceUnknown) parts.push('Amazon価格なし');
  else if (v.priceMin !== '' && v.priceMin != null || v.priceMax !== '' && v.priceMax != null) parts.push(`Amazon ${yenOr(v.priceMin)}〜${yenOr(v.priceMax)}`);
  if ((v.hideDec || []).length || (v.hideTgt || []).length) parts.push(`非表示: ${hiddenLabels(v).join('・')}`);
  for (const c of v.conds || []) parts.push(condLabel(c));
  parts.push(`${d.label} ${d.dir[v.desc ? 1 : 0]}`);
  return parts.join(' · ');
}

function openViews() {
  sheet((close) => {
    const body = h('div');
    const save = async (views) => {
      try {
        state.meta.settings = await api.put('/api/settings', { listViews: views });
        render();
      } catch (e) {
        showError(e);
      }
    };
    const render = () => {
      const views = state.meta.settings.listViews || [];
      const name = h('input', { type: 'text', placeholder: '名前（例: 注文が新しい順・スマホ用品）', maxlength: 40, style: { flex: 1, minWidth: 0 } });
      clear(body).append(
        h('h2', null, '★ 保存した表示'),
        h('p', { class: 'muted small' }, '絞り込みと並び順の組み合わせを名前をつけて保存し、ワンタップで呼び出せます（iPhone と Mac で共通）。'),
        views.length ? h('div', { class: 'view-list' }, views.map((v, i) => h('div', { class: 'view-row' },
          h('button', { class: 'view-open', onclick: () => { applyView(v.view); close(); renderAll(); toTop(); } },
            h('strong', null, v.name), h('div', { class: 'small muted' }, viewSummary(v.view))),
          h('button', { class: 'btn small ghost', 'aria-label': `${v.name}を上へ`, disabled: i === 0, onclick: () => { const a = [...views]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; save(a); } }, '↑'),
          h('button', { class: 'btn small ghost danger', 'aria-label': `${v.name}を削除`, onclick: async () => {
            if (await choose(`「${v.name}」を削除しますか？`, [{ label: '削除', value: true, danger: true }])) save(views.filter((_, j) => j !== i));
          } }, '✕')))) : h('p', { class: 'muted small' }, 'まだありません。'),
        h('h3', { class: 'small', style: { margin: '14px 0 6px' } }, '今の表示を保存'),
        h('div', { class: 'small muted', style: { marginBottom: '6px' } }, viewSummary(currentView())),
        h('div', { class: 'row', style: { gap: '6px' } }, name,
          h('button', { class: 'btn small primary', onclick: async () => {
            const n = name.value.trim();
            if (!n) return toast('名前を入れてください');
            const i = views.findIndex((v) => v.name === n);
            if (i >= 0 && !(await choose(`「${n}」を今の表示で上書きしますか？`, [{ label: '上書き', value: true }]))) return;
            const next = [...views];
            if (i >= 0) next[i] = { name: n, view: currentView() };
            else next.push({ name: n, view: currentView() });
            save(next);
            toast(`「${n}」を保存しました`);
          } }, '保存')),
        h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => close() }, '閉じる')));
    };
    render();
    return body;
  });
}

/** Filter by the recorded Amazon price (sale price included): presets or any range. */
function openPriceRange() {
  sheet((close) => {
    const min = h('input', { type: 'text', inputmode: 'numeric', placeholder: '下限（円）', value: state.prefs.priceUnknown ? '' : state.prefs.priceMin ?? '' });
    const max = h('input', { type: 'text', inputmode: 'numeric', placeholder: '上限（円）', value: state.prefs.priceUnknown ? '' : state.prefs.priceMax ?? '' });
    const pick = (r) => { close(); setPriceRange({ priceUnknown: false, priceMin: '', priceMax: '', ...r }); };
    const clean = (el) => el.value.normalize('NFKC').replace(/[^\d]/g, '');
    return h('div', null,
      h('h2', null, 'Amazon価格で絞り込み'),
      h('p', { class: 'muted small' }, '価格確認の記録（セール価格を含む表示価格・新品）で絞り込みます。'),
      h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } },
        h('button', { class: 'btn small', onclick: () => pick({ priceMax: 999 }) }, '〜¥999'),
        h('button', { class: 'btn small', onclick: () => pick({ priceMin: 1000, priceMax: 1999 }) }, '¥1,000〜¥1,999'),
        h('button', { class: 'btn small', onclick: () => pick({ priceMax: 2299 }) }, '〜¥2,299'),
        h('button', { class: 'btn small', onclick: () => pick({ priceMin: 2300, priceMax: 2999 }) }, '¥2,300〜¥2,999'),
        h('button', { class: 'btn small', onclick: () => pick({ priceMin: 3000 }) }, '¥3,000〜'),
        h('button', { class: 'btn small', onclick: () => pick({ priceMin: 5000 }) }, '¥5,000〜'),
        h('button', { class: 'btn small', onclick: () => pick({ priceUnknown: true }) }, 'Amazon価格なし')),
      h('div', { class: 'grid2', style: { marginTop: '10px' } }, h('label', { class: 'field' }, min), h('label', { class: 'field' }, max)),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => pick({ priceMin: clean(min), priceMax: clean(max) }) }, 'この範囲で絞り込む'),
        h('button', { class: 'btn', onclick: () => pick({}) }, '解除'),
        h('button', { class: 'btn ghost', onclick: () => close() }, 'キャンセル')));
  });
}

/** Set a price on the selected products: a fixed amount or a % of the Amazon price, into the common or a destination price. */
function openBulkPrice(ids) {
  if (!ids.length) return toast('商品を選択してください');
  const products = ids.map((id) => state.products.get(id)).filter(Boolean);
  const fields = [['listing.price', 'common', '共通の販売価格'], ...(state.meta.channels || []).map((c) => [`override.${c.id}.price`, c.id, `${c.label}の価格`])];
  sheet((close) => {
    const field = h('select', null, fields.map(([v, , l]) => h('option', { value: v }, l)));
    const mode = h('select', null, h('option', { value: 'percent' }, 'Amazon価格の％'), h('option', { value: 'fixed' }, '金額を指定'));
    const amount = h('input', { type: 'text', inputmode: 'numeric', value: '60' });
    const unit = h('span', { class: 'muted' }, '％');
    const round = h('select', null, [[10, '10円単位'], [100, '100円単位'], [1, '1円単位']].map(([v, l]) => h('option', { value: v }, l)));
    const preview = h('div', { class: 'small', style: { margin: '8px 0', whiteSpace: 'pre-wrap' } });
    const key = () => fields.find(([v]) => v === field.value)[1];
    const calc = (p) => {
      const n = Number(amount.value.normalize('NFKC').replace(/[^\d.]/g, ''));
      const r = Number(round.value);
      if (mode.value === 'fixed') return Number.isFinite(n) ? Math.round(n / r) * r : null;
      const base = p.research?.amazonPrice;
      return base == null || !Number.isFinite(n) ? null : Math.round((base * n) / 100 / r) * r;
    };
    const update = () => {
      unit.textContent = mode.value === 'fixed' ? '円' : '％';
      const k = key();
      const set = products.filter((p) => p.prices?.[k] != null);
      const none = products.filter((p) => calc(p) == null);
      const low = (k === 'common' || k === 'mercari') ? products.filter((p) => calc(p) != null && calc(p) < 300) : [];
      preview.textContent = [
        `${products.length}件が対象。設定済み ${set.length}件${none.length ? `・Amazon価格なしで対象外 ${none.length}件` : ''}${low.length ? `・メルカリ下限300円未満 ${low.length}件` : ''}`,
        ...products.slice(0, 4).map((p) => `#${p.id} ${String(p.name || '').slice(0, 14)}: ${p.prices?.[k] != null ? yen(p.prices[k]) : '未設定'} → ${calc(p) != null ? yen(calc(p)) : '対象外'}`),
        products.length > 4 ? '…' : '',
      ].join('\n');
    };
    for (const el of [field, mode, amount, round]) el.addEventListener('input', update);
    for (const el of [field, mode, round]) el.addEventListener('change', update);
    update();
    const apply = async () => {
      const k = key();
      const already = products.filter((p) => p.prices?.[k] != null).length;
      let overwrite = true;
      if (already) {
        const v = await choose(`${already}件はすでに価格が入っています。`, [{ label: '上書きする', value: 'all' }, { label: '未設定のものだけ', value: 'empty' }]);
        if (!v) return;
        overwrite = v === 'all';
      }
      close();
      try {
        const value = { field: field.value, mode: mode.value, round: Number(round.value), overwrite, ...(mode.value === 'fixed' ? { amount: amount.value } : { percent: amount.value.normalize('NFKC').replace(/[^\d.]/g, '') }) };
        const r = await api.post('/api/bulk', { ids: products.map((p) => p.id), op: 'price', value });
        for (const p of r.products) state.products.set(p.id, p);
        const ok = r.results.filter((x) => x.ok && !x.skipped).length;
        const skipped = r.results.filter((x) => x.skipped).length;
        const failed = r.results.filter((x) => !x.ok);
        toast(`価格を設定: ${ok}件${skipped ? ` / 対象外 ${skipped}件` : ''}${failed.length ? ` / 失敗 ${failed.length}件\n${failed.slice(0, 2).map((f) => `${f.id}: ${f.error}`).join('\n')}` : ''}`, failed.length ? { error: true } : undefined);
        renderAll();
      } catch (e) {
        showError(e);
      }
    };
    return h('div', null,
      h('h2', null, `💴 価格を設定（${products.length}件）`),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '設定する価格'), field),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '決め方'), mode),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '丸め'), round)),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '値'), h('div', { class: 'row', style: { alignItems: 'center', gap: '6px' } }, amount, unit)),
      preview,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: apply }, '設定する'),
        h('button', { class: 'btn ghost', onclick: () => close() }, 'キャンセル')));
  });
}

async function openRange() {
  const dk = dateKindOf();
  const r = await pickDateRange(state.prefs, productsForCalendar(), {
    field: dk.field, label: dk.long, kinds: DATE_KINDS,
    onKind: (f) => { setPref('dateKind', f); renderAll(); openRange(); },
  });
  if (r) setRange(r);
}

function toggleSelect() {
  state.selectMode = !state.selectMode;
  state.selected.clear();
  renderAll();
}

const STATUS_CLASS = {
  unsorted: '', needs_photos: 'warn', shooting: 'info', ai_pending: 'ai', ai_processing: 'ai', needs_review: 'warn',
  ready: 'ok', queued: 'accent', mercari_entered: 'accent', final_check: 'accent', listed: 'ok', trading: 'accent', sold: '', hold: 'warn', no_sell: '', no_stock: '', archived: '', trash: 'danger',
};

const CHANNEL_STATUS_LABEL = { entered: '下書き', transfer_ok: '下書き', transfer_ng: '下書き要修正', listed: '出品中', stopped: '公開停止', trading: '取引中', sold: '売却済み', removed: '見つからない' };
const channelName = (id) => state.meta.channels?.find((c) => c.id === id)?.label || id;

function badgesFor(p) {
  const b = [h('span', { class: `badge ${STATUS_CLASS[p.status.id] || ''}` }, p.status.label)];
  b.push(h('span', { class: `badge ${p.counts.actual ? '' : 'warn'}` }, `📷 ${p.counts.actual}`));
  if (p.research?.group) {
    const g = p.research.group.replace(/^\d\s+/, '');
    b.push(h('span', { class: `badge ${/ジモティ/.test(g) ? 'warn' : /3000/.test(g) ? 'ok' : ''}`, title: `Amazon価格: ${p.research.amazonPrice != null ? yen(p.research.amazonPrice) : '未確定'}` },
      `${g}${p.research.amazonPrice != null && !/円/.test(g) ? '' : ''}${p.research.amazonPrice != null ? `・A${yen(p.research.amazonPrice)}` : ''}`));
  }
  const sh = p.ship;
  if (sh?.dims) b.push(h('span', { class: 'badge', title: `${sh.dims.L}×${sh.dims.W}×${sh.dims.H}cm${sh.dims.kg != null ? `・${sh.dims.kg}kg` : ''}（${SIZE_SOURCE[sh.dims.source] || ''}）` },
    `📦 ${sh.cheapest ? `${sh.cheapest.label} ${yen(sh.cheapest.price)}` : 'メルカリ便なし'}`));
  if (sh?.dims?.source === 'estimate') b.push(h('span', { class: 'badge est', title: 'サイズは商品名・写真からの見立て' }, `見立て・確信度${CONF[sh.dims.confidence] || '低'}`));
  if (p.market?.checkedAt) {
    b.push(h('span', { class: `badge ${p.market.matchType === 'same' ? 'ok' : p.market.matchType === 'similar' ? 'info' : 'warn'}`, title: `メルカリ売り切れ ${p.market.count}件${p.market.low != null ? `（${yen(p.market.low)}〜${yen(p.market.high)}）` : ''}` },
      p.market.median != null ? `相場 ${yen(p.market.median)}（${MATCH_LABEL[p.market.matchType]}）` : '相場 見つからず'));
  }
  for (const [key, name] of [['yahoo', 'ヤフオク'], ['rakuma', 'ラクマ']]) {
    const y = p.market?.[key];
    if (!y?.checkedAt) continue;
    b.push(h('span', { class: `badge ${y.matchType === 'same' ? 'ok' : y.matchType === 'similar' ? 'info' : 'warn'}`, title: `${name} ${y.count}件${y.low != null ? `（${yen(y.low)}〜${yen(y.high)}）` : ''}` },
      y.median != null ? `${name} ${yen(y.median)}（${MATCH_LABEL[y.matchType]}）` : `${name} 見つからず`));
  }
  if (p.net?.net != null) {
    const n = p.net;
    const v = n.net;
    const from = n.basis === 'market' ? `${n.siteLabel}の${n.matchType === 'same' ? '同じ商品' : '似た商品'}の相場` : '販売価格';
    b.push(h('span', { class: `badge ${v <= 0 ? 'danger' : v < 500 ? 'warn' : 'ok'}`, title: `${from} ${yen(n.price)} − 手数料 ${yen(n.fee)} − 送料 ${yen(n.ship)}（${n.shipLabel}）` },
      `${n.reference ? '参考手取り' : '手取り'} ${yen(v)}${n.basis === 'listing' ? '（販売価格）' : n.site !== 'mercari' ? `（${n.siteLabel}）` : ''}`));
  }

  if (p.counts.generated) b.push(h('span', { class: 'badge' }, `生成 ${p.counts.generated}`));
  if (p.counts.listing) b.push(h('span', { class: 'badge' }, `出品用 ${p.counts.listing}`));
  for (const [ch, st] of Object.entries(p.channels || {})) {
    const label = CHANNEL_STATUS_LABEL[st];
    if (label) b.push(h('span', { class: `badge ${st === 'trading' ? 'accent' : st === 'listed' ? 'ok' : ''}` }, `${channelName(ch)}: ${label}`));
  }
  if (p.ai.label) b.push(h('span', { class: `badge ${p.ai.state === 'error' ? 'danger' : p.qc && !p.qc.stale && p.qc.result === 'pass' ? 'ok' : 'ai'}` }, (p.ai.state === 'processing' ? '⏳ ' : '') + p.ai.label));
  if (p.proposals) b.push(h('span', { class: 'badge ai' }, `AI提案 ${p.proposals}`));
  if (p.price != null) b.push(h('span', { class: 'badge' }, yen(p.price)));
  if (p.shootPlan) b.push(h('span', { class: 'badge info' }, '撮影予定'));
  return b;
}

function issuesFor(p) {
  if (['no_sell', 'no_stock', 'archived', 'trash', 'sold', 'listed'].includes(p.status.id)) return null;
  const lines = [];
  for (const r of p.openPhotoRequests) lines.push(`📷 追加撮影: ${r.label}`);
  for (const i of p.issues) if (!i.startsWith('追加撮影')) lines.push(`⚠ ${i}`);
  if (!lines.length || !['sell', 'draft'].includes(p.decision)) return null;
  return h('div', { class: 'issues' }, lines.slice(0, 2).map((l) => h('div', null, l)), lines.length > 2 && h('div', { class: 'muted' }, `ほか${lines.length - 2}件`));
}

/** Where to offer it: three small toggles (＊ = suggested by the price research). */
function targetSeg(p) {
  const targets = p.targets || [];
  const suggested = p.suggestedTargets || [];
  return h('div', { class: 'seg targets', style: { marginTop: '6px' } },
    (state.meta.channels || []).map((c) => h('button', {
      class: `${targets.includes(c.id) ? 'on' : ''} ${!targets.includes(c.id) && suggested.includes(c.id) ? 'suggested' : ''}`,
      title: suggested.includes(c.id) ? 'おすすめ（価格・大きさの調査から）' : '',
      onclick: async (e) => {
        e.stopPropagation();
        try {
          const next = targets.includes(c.id) ? targets.filter((x) => x !== c.id) : [...targets, c.id];
          applyProduct(await api.put(`/api/products/${p.id}/targets`, { targets: next }));
        } catch (err) {
          showError(err);
        }
      },
    }, `${c.label.replace(/ー$/, '')}${!targets.includes(c.id) && suggested.includes(c.id) ? '＊' : ''}`)));
}

function decisionSeg(p) {
  const opts = state.meta.decisions.filter((d) => d.id !== 'undecided').map((d) => [d.id, d.label]);
  return h('div', { class: 'seg decisions', style: { marginTop: '7px' } },
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

// Rows are drawn a chunk at a time as the list scrolls: drawing all ~470 rows (and loading every
// thumbnail) at once made each search, sort and update slow on the phone.
const FIRST_ROWS = 20;
const MORE_ROWS = 40;
let listRun = null; // the list being shown: items, headings, how many rows are drawn
let moreObserver = null;
const mini = (u) => u && u.replace(/\.thumb\.jpg$/, '.mini.jpg'); // 256px list-size thumbnail

function listViewKey() {
  const pr = state.prefs;
  return JSON.stringify([pr.filter, pr.sort, pr.desc, pr.dateKind, pr.dateFrom, pr.dateTo, pr.dateNone, pr.priceMin, pr.priceMax, pr.priceUnknown, pr.conds, state.query, state.selectMode]);
}

function renderItems(items = visibleProducts()) {
  const viewKey = listViewKey();
  // Same view (a live update, a decision tap…): keep at least as many rows so the scroll position stays.
  const keep = listRun && listRun.viewKey === viewKey ? listRun.shown : 0;
  clear(els.list);
  moreObserver?.disconnect();
  if (!items.length) {
    listRun = null;
    els.list.append(h('div', { class: 'empty' },
      state.products.size ? '該当する商品はありません' : h('div', null,
        h('p', null, 'まだ商品がありません'),
        h('div', { class: 'row-actions', style: { justifyContent: 'center' } },
          h('button', { class: 'btn primary', onclick: () => (location.hash = '#/import') }, '商品リストを一括登録'),
          h('button', { class: 'btn', onclick: newAndShoot }, '📷 撮影から登録')))));
    return;
  }
  // Headings: by day when sorted by a date, by 種類 when sorted by 種類 (counts cover the whole list).
  const gField = groupDateField();
  const byCat = sortDef().id === 'category';
  const keyOf = gField ? (p) => p[gField] || '' : byCat ? (p) => p.category || '' : null;
  const groups = keyOf ? new Map() : null;
  if (groups) for (const p of items) groups.set(keyOf(p), (groups.get(keyOf(p)) || 0) + 1);
  listRun = { items, ids: items.map((p) => p.id), gField, gKind: gField ? DATE_KINDS.find((k) => k.field === gField) : null, keyOf, groups, lastKey: null, shown: 0, viewKey };
  appendRows(Math.max(FIRST_ROWS, keep));
}

function appendRows(n) {
  const run = listRun;
  if (!run) return;
  const frag = document.createDocumentFragment();
  const end = Math.min(run.items.length, run.shown + n);
  for (let idx = run.shown; idx < end; idx++) {
    const p = run.items[idx];
    if (run.groups && run.keyOf(p) !== run.lastKey) {
      run.lastKey = run.keyOf(p);
      frag.append(groupHead(run, run.lastKey));
    }
    frag.append(rowEl(p, idx, run));
  }
  run.shown = end;
  els.list.querySelector('.list-more')?.remove();
  els.list.append(frag);
  if (end >= run.items.length) return;
  const more = h('button', { class: 'list-more', onclick: () => appendRows(MORE_ROWS) }, `続きを表示（残り ${run.items.length - end}件）`);
  els.list.append(more);
  moreObserver ||= new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) appendRows(MORE_ROWS);
  }, { root: scrollRoot(), rootMargin: '1200px 0px' });
  moreObserver.observe(more);
}

/** The element the list scrolls in (the pane on wide screens), or null for the page itself. */
function scrollRoot() {
  for (let el = els.list.parentElement; el && el !== document.body; el = el.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
  }
  return null;
}

function groupHead(run, d) {
  const { gField, gKind, groups } = run;
  return gField
    ? h('button', {
      class: 'date-head',
      title: d ? `タップでこの${gKind.label}だけ表示` : `${gKind.label}のない商品だけ表示`,
      onclick: () => { setPref('dateKind', gField); setRange(d ? { dateFrom: d, dateTo: d, dateNone: false } : { dateFrom: '', dateTo: '', dateNone: true }); },
    }, d ? `${gField === 'itemDate' ? '' : `${gKind.label} `}${fmtDay(d)}` : `${gKind.label}なし`, h('span', { class: 'n' }, `${groups.get(d)}件`))
    : h('button', {
      class: 'date-head', title: 'タップでこの種類だけ表示',
      onclick: () => setConds([...state.prefs.conds.filter((c) => kindOf(c) !== 'cat'), `cat:${d}`]),
    }, d || '種類なし', h('span', { class: 'n' }, `${groups.get(d)}件`));
}

/** Sites whose sold prices are researched. From the list one tap opens the sold item nearest the median (else the search). */
const SITES = [
  { id: 'mercari', label: 'メルカリ', what: '売り切れ', url: (m) => m.soldUrl, stats: (m) => m },
  { id: 'yahoo', label: 'ヤフオク', what: '落札相場', url: (m) => m.yahooUrl, stats: (m) => m.yahoo },
  { id: 'rakuma', label: 'ラクマ', what: '売り切れ', url: (m) => m.rakumaUrl, stats: (m) => m.rakuma },
];
function marketLinks(p) {
  const m = p.market;
  if (!m) return null;
  return h('div', { class: 'mk-links' }, SITES.map((s) => {
    const st = s.stats(m);
    const ref = st?.ref;
    const kind = ref ? (ref.match === 'same' ? '同じ商品' : '似た商品') : '';
    const href = ref?.url || s.url(m);
    return href && h('a', {
      class: `mk-link ${s.id} ${ref ? 'item' : ''}`, href, target: '_blank', rel: 'noopener noreferrer',
      title: ref ? `${s.label}で売れた${kind}（${yen(ref.price)}）を開く（別ウィンドウ）` : `${s.label}の${s.what}を検索（別ウィンドウ）`,
      'aria-label': ref ? `${p.name || p.id} の${s.label}の参考商品を開く` : `${p.name || p.id} を${s.label}の${s.what}で検索`,
      onclick: (e) => e.stopPropagation(),
    }, `${s.label} ↗`,
    st?.median != null ? h('span', { class: 'v' }, yen(st.median), ref?.match === 'similar' ? h('small', null, '似') : null) : h('span', { class: 'go' }, s.what));
  }));
}

function rowEl(p, idx, run) {
  const selected = state.selected.has(p.id);
  const open = (e) => {
    if (!state.selectMode) return void (location.hash = `#/p/${p.id}`);
    // Toggle just this row instead of redrawing the list.
    const on = !state.selected.has(p.id);
    on ? state.selected.add(p.id) : state.selected.delete(p.id);
    const row = e.currentTarget.closest('.item');
    row.classList.toggle('selected', on);
    const check = row.querySelector('.select-check');
    if (check) check.textContent = on ? '✓' : '';
    renderBulk();
  };
  return h('article', { class: `item ${selected ? 'selected' : ''} ${state.detailId === p.id ? 'active' : ''}`, dataset: { id: p.id } },
    h('div', { class: 'thumb', style: p.thumb ? { backgroundImage: `url("${mini(p.thumb)}")` } : null, onclick: open },
      state.selectMode ? h('div', { class: 'select-check' }, selected ? '✓' : '') : !p.thumb && '📦',
      p.thumbIsReference && !state.selectMode && h('div', { class: 'ref-badge' }, '公式画像'),
      p.official && !state.selectMode && h('div', { class: 'official-inset', title: '公式画像（Amazon）', style: { backgroundImage: `url("${mini(p.official)}")` } })),
    h('div', { class: 'item-main', onclick: open },
      h('div', { class: 'item-title' }, h('span', { class: 'pid' }, p.id), p.name || h('span', { class: 'muted' }, '名称未設定')),
      h('div', { class: 'item-sub' },
        rowDates(p, run.gField),
        h('span', { class: `item-cat ${p.categoryGuessed ? 'guess' : ''}`, title: p.categoryGuessed ? '商品名からの推定（詳細画面で設定できます）' : '種類' }, p.category, p.categoryGuessed ? '?' : ''),
        [p.brand, p.model, p.location && `📍${p.location}`].filter(Boolean).join(' · ')),
      h('div', { class: 'badges' }, badgesFor(p)),
      marketLinks(p),
      issuesFor(p),
      !state.selectMode && !p.trashedAt && decisionSeg(p),
      !state.selectMode && !p.trashedAt && targetSeg(p)),
    h('div', { class: 'item-side' },
      !p.trashedAt && h('button', {
        class: 'icon-btn cam', 'aria-label': `${p.name || p.id} を撮影`,
        onclick: (e) => { e.stopPropagation(); openCamera({ ids: run.ids, index: idx }); },
      }, '📷'),
      !p.trashedAt && h('button', {
        class: 'icon-btn link native', 'aria-label': `${p.name || p.id} を純正カメラで撮る`, title: 'iPhone の「カメラ」アプリで撮る（スタイル等そのまま）',
        onclick: (e) => { e.stopPropagation(); shootWithNativeCamera(p.id, { ids: run.ids, index: idx }); },
      }, '📸'),
      p.sourceUrl && h('a', {
        class: 'icon-btn link', href: p.sourceUrl, target: '_blank', rel: 'noopener noreferrer',
        title: '購入ページを開く（別ウィンドウ）', 'aria-label': `${p.name || p.id} の購入ページを開く`,
        onclick: (e) => e.stopPropagation(),
      }, '🔗'),
      ));
}

/** Date chips on a row: 注文 / 到着 when known, else the undistinguished date. The grouped-by date is already in the heading. */
function rowDates(p, grouped) {
  const out = [];
  const short = (d) => fmtDay(d, { weekday: false });
  const shown = grouped ? p[grouped] : null;
  if (p.orderDate && grouped !== 'orderDate' && p.orderDate !== shown) out.push(h('span', { class: 'item-date' }, `注文 ${short(p.orderDate)}`));
  if (p.arrivalDate && grouped !== 'arrivalDate' && p.arrivalDate !== shown) out.push(h('span', { class: 'item-date arrival' }, `到着 ${short(p.arrivalDate)}`));
  if (!p.orderDate && !p.arrivalDate && p.itemDate && !grouped) out.push(h('span', { class: 'item-date' }, fmtDay(p.itemDate)));
  if (!p.itemDate && !grouped) out.push(h('span', { class: 'item-date none' }, '日付なし'));
  return out;
}

function renderFab(items = visibleProducts()) {
  clear(els.fab);
  if (state.selectMode) return;
  const ids = items.filter((p) => !p.trashedAt).map((p) => p.id);
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
      else toast(`${label}: ${ids.length}件${r.snapshot ? '（変更前の状態を自動保存）' : ''}`);
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
      h('button', { class: 'btn small', onclick: () => ids.length && openCamera({ ids }) }, '📷 撮影'),
      h('button', { class: 'btn small', onclick: () => openBulkPrice(ids) }, '💴 価格を設定')),
    h('div', { class: 'row' },
      ...state.meta.decisions.filter((d) => d.id !== 'undecided').map((d) => h('button', { class: 'btn small', onclick: run('decision', d.id, d.label) }, d.label)),
      ...(state.meta.channels || []).map((c) => h('button', { class: 'btn small', onclick: run('addTarget', c.id, `出品先に${c.label}`) }, `→${c.label}`)),
      h('button', { class: 'btn small', onclick: run('suggestedTargets', null, 'おすすめの出品先') }, '→おすすめ'),
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
    { label: '📒 更新台帳（素材の更新・出品先の確認）', value: '#/ledger' },
    { label: '💾 状態の保存・ロールバック', value: '#/snapshots' },
    { label: '📋 商品リストを一括登録', value: '#/import' },
    { label: '📅 日付を一括反映（既存商品）', value: '#/dates' },
    { label: '🖼 公式画像を ZIP でダウンロード', value: 'official' },
    { label: '📸 純正カメラ連携の設定', value: 'native' },
    { label: '⚙️ 設定・AI接続・書き出し', value: '#/settings' },
    { label: '↻ 再読み込み', value: 'reload' },
  ]);
  if (v === 'reload') {
    await loadAll().catch(showError);
    toast('更新しました');
  } else if (v === 'official') openOfficialZip();
  else if (v === 'native') openNativeSetup();
  else if (v) location.hash = v;
}

/** Official images of the products that have nothing else yet, as one ZIP (all of them, or those in the current list). */
async function openOfficialZip() {
  const only = (p) => !p.trashedAt && !p.counts.actual && !p.counts.generated && p.counts.reference > 0;
  const here = visibleProducts().filter(only).map((p) => p.id);
  const narrowed = here.length !== [...state.products.values()].filter(only).length;
  let all;
  let mine = null;
  try {
    [all, mine] = await Promise.all([api.get('/api/export/official-stats'), narrowed && here.length ? api.get(`/api/export/official-stats?ids=${here.join(',')}`) : null]);
  } catch (e) {
    return showError(e);
  }
  const mb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)}GB` : `${Math.max(1, Math.round(b / 1e6))}MB`);
  const label = (s) => `${s.products}商品・${s.images}枚・約${mb(s.bytes)}`;
  sheet((close) => {
    // Let the download start before the sheet goes away.
    const later = () => setTimeout(() => close(), 300);
    return h('div', null,
      h('h2', null, '🖼 公式画像をまとめてダウンロード'),
      h('p', { class: 'muted small' }, '公式画像しか入っていない商品（撮影・生成した画像がまだ無いもの）の公式画像を、商品ごとのフォルダ（ID_商品名）に分けた ZIP にします。一覧.csv（ID・商品名・種類・Amazon価格・購入ページ）付き。'),
      all.products ? h('div', { class: 'actions' },
        mine && h('a', { class: 'btn primary', href: `/api/export/official.zip?ids=${here.join(',')}`, download: '', onclick: later }, `今の一覧の分だけ（${label(mine)}）`),
        h('a', { class: `btn ${mine ? '' : 'primary'}`, href: '/api/export/official.zip', download: '', onclick: later }, `全部（${label(all)}）`),
        h('button', { class: 'btn ghost', onclick: () => close() }, 'キャンセル')) : h('p', null, '該当する商品はありません。'),
      h('p', { class: 'muted small' }, '大きいので Wi-Fi でのダウンロードがおすすめです。iPhone では「ファイル」アプリの「ダウンロード」に入ります。'));
  });
}
