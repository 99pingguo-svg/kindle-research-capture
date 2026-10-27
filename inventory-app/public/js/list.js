// 商品一覧: the main screen. Decision, camera, status, issues and bulk actions are all
// available per row so most work never needs the detail page.
import { h, clear, toast, showError, choose, sheet, yen } from './ui.js';
import { api } from './api.js';
import { state, setPref, on, FILTERS, matchesFilter, visibleProducts, applyProduct, loadAll, inDateRange, isDateSort, productsForCalendar, priceRangeOn, inShipFilter, NET_BANDS } from './state.js';
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
    h('button', { class: `btn small date-range ${priceRangeOn() ? 'on' : ''}`, onclick: openPriceRange, 'aria-label': 'Amazon価格で絞り込み' }, '💴 ', priceRangeLabel()),
    priceRangeOn() ? h('button', { class: 'btn small ghost', 'aria-label': '価格帯を解除', onclick: () => setPriceRange({ priceMin: '', priceMax: '', priceUnknown: false }) }, '✕') : '',
    h('button', { class: `btn small date-range ${state.prefs.ship ? 'on' : ''}`, onclick: openShipFilter, 'aria-label': 'サイズ・送料・相場で絞り込み' }, '📦 ', shipFilterLabel()),
    state.prefs.ship ? h('button', { class: 'btn small ghost', 'aria-label': 'サイズ・送料の絞り込みを解除', onclick: () => setShipFilter('') }, '✕') : '',
    h('span', { class: 'spacer' }),
    // One tap: newest ⇄ oldest. From any other order it jumps back to newest first.
    h('button', {
      class: `btn small ${isDateSort(sort) ? 'sort-on' : ''}`,
      onclick: () => { setPref('sort', sort === 'date_desc' ? 'date_asc' : 'date_desc'); renderAll(); },
    }, sort === 'date_asc' ? '古い順 ↑' : sort === 'date_desc' ? '新しい順 ↓' : '日付順にする'),
    h('select', { class: 'sort-more', onchange: (e) => { setPref('sort', e.target.value); renderAll(); }, 'aria-label': 'その他の並び順' },
      [['date_desc', '日付 新しい順'], ['date_asc', '日付 古い順'], ['id', 'ID順'], ['updated', '更新順'], ['name', '名前順'], ['stage', '状態順'], ['photos', '写真が少ない順'], ['net', '手取りが多い順'], ['market', '相場が高い順'], ['ship', '送料が安い順']].map(([v, l]) =>
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
  els.list.scrollIntoView({ block: 'start' });
}
const SIZE_SOURCE = { package: '梱包サイズ', product: '本体サイズ＋梱包分の目安', estimate: '商品名・写真からの見立て' };
const CONF = { high: '高', mid: '中', low: '低' };
const MATCH_LABEL = { same: '同じ商品', similar: '似た商品', none: '見つからず' };
function shipFilterLabel() {
  const f = state.prefs.ship;
  if (!f) return 'サイズ・送料';
  const [kind, id] = f.split(':');
  const sh = state.meta.delivery || {};
  if (kind === 'size') return sh.sizeClasses?.find((x) => x.id === id)?.label.replace(/（.*/, '') || id;
  if (kind === 'band') return `送料${sh.bands?.find((x) => x.id === id)?.label.replace(/（.*/, '') || id}`;
  if (kind === 'method') return sh.methods?.find((x) => x.id === id)?.label || id;
  if (kind === 'market') return id === 'todo' ? '相場 未調査' : `相場 ${MATCH_LABEL[id]}`;
  if (kind === 'net') return id === 'unknown' ? '手取り 不明' : `手取り ${NET_BANDS.find((x) => x.id === id)?.label || id}`;
  return f;
}
function setShipFilter(v) {
  setPref('ship', v);
  state.selected.clear();
  renderAll();
  els.list.scrollIntoView({ block: 'start' });
}
/** Size class, cheapest Mercari shipping band, a specific way of sending, market research, and the Mercari-only net. */
function openShipFilter() {
  const sh = state.meta.delivery || { sizeClasses: [], bands: [], methods: [], groups: [] };
  const all = [...state.products.values()].filter((p) => matchesFilter(p, state.prefs.filter) && !p.trashedAt);
  const n = (f) => all.filter((p) => inShipFilter(p, f)).length;
  sheet((close) => {
    const chip = (f, label) => h('button', { class: `btn small ${state.prefs.ship === f ? 'primary' : ''}`, onclick: () => { close(); setShipFilter(f); } }, label, h('span', { class: 'muted' }, ` ${n(f)}`));
    const section = (title, chips) => [h('h3', { class: 'small', style: { margin: '12px 0 6px' } }, title), h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } }, chips)];
    return h('div', null,
      h('h2', null, 'サイズ・送料・相場で絞り込み'),
      h('p', { class: 'muted small' }, `同じ物を新品でメルカリに出す場合の目安。サイズ・重さは Amazon の梱包サイズ（無ければ本体サイズ＋梱包分）。送料は${sh.source || 'メルカリ公式の料金表'}。手取り＝相場（無ければ設定した販売価格）−手数料10%−いちばん安いメルカリ便の送料。仕入れ額は含みません。`),
      ...section('サイズ', sh.sizeClasses.map((c) => chip(`size:${c.id}`, c.label))),
      ...section('いちばん安いメルカリ便の送料', sh.bands.map((b) => chip(`band:${b.id}`, b.label))),
      ...sh.groups.flatMap((g) => section(`この方法で送れる（${g.label}）`, sh.methods.filter((m) => m.group === g.id).map((m) => chip(`method:${m.id}`, m.label)))),
      ...section('メルカリ相場（売り切れ）', [chip('market:same', '同じ商品の相場'), chip('market:similar', '似た商品の相場'), chip('market:none', '見つからず'), chip('market:todo', '未調査')]),
      ...section('メルカリでの手取り（仕入れ額は含まない）', [...NET_BANDS.map((b) => chip(`net:${b.id}`, b.label)), chip('net:unknown', '不明')]),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => { close(); setShipFilter(''); } }, '解除'),
        h('button', { class: 'btn ghost', onclick: () => close() }, 'キャンセル')));
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
    `📦 ${sh.cheapest ? `${sh.cheapest.label} ${yen(sh.cheapest.price)}` : 'メルカリ便なし'}`,
    sh.dims.source === 'estimate' && h('small', { class: 'est' }, ` 見立て・確信度${CONF[sh.dims.confidence] || '低'}`)));
  if (p.market?.checkedAt) {
    b.push(h('span', { class: `badge ${p.market.matchType === 'same' ? 'ok' : p.market.matchType === 'similar' ? 'info' : 'warn'}`, title: `メルカリ売り切れ ${p.market.count}件${p.market.low != null ? `（${yen(p.market.low)}〜${yen(p.market.high)}）` : ''}` },
      p.market.median != null ? `相場 ${yen(p.market.median)}（${MATCH_LABEL[p.market.matchType]}）` : '相場 見つからず'));
  }
  if (p.net?.net != null) {
    const v = p.net.net;
    b.push(h('span', { class: `badge ${v <= 0 ? 'danger' : v < 500 ? 'warn' : 'ok'}`, title: `${p.net.basis === 'market' ? '相場' : '販売価格'} ${yen(p.net.price)} − 手数料 ${yen(p.net.fee)} − 送料 ${yen(p.net.ship)}（${p.net.shipLabel}）` },
      `手取り ${yen(v)}${p.net.basis === 'listing' ? '（販売価格）' : ''}`));
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
        p.thumbIsReference && !state.selectMode && h('div', { class: 'ref-badge' }, '公式画像'),
        p.official && !state.selectMode && h('div', { class: 'official-inset', title: '公式画像（Amazon）', style: { backgroundImage: `url("${p.official}")` } })),
      h('div', { class: 'item-main', onclick: open },
        h('div', { class: 'item-title' }, h('span', { class: 'pid' }, p.id), p.name || h('span', { class: 'muted' }, '名称未設定')),
        h('div', { class: 'item-sub' },
          // the date is in the group header when sorted by date; otherwise show it on the row
          !isDateSort() && (p.itemDate ? h('span', { class: 'item-date' }, fmtDay(p.itemDate)) : h('span', { class: 'item-date none' }, '日付なし')),
          [p.brand, p.model, p.location && `📍${p.location}`].filter(Boolean).join(' · ')),
        h('div', { class: 'badges' }, badgesFor(p)),
        issuesFor(p),
        !state.selectMode && !p.trashedAt && decisionSeg(p),
        !state.selectMode && !p.trashedAt && targetSeg(p)),
      h('div', { class: 'item-side' },
        !p.trashedAt && h('button', {
          class: 'icon-btn cam', 'aria-label': `${p.name || p.id} を撮影`,
          onclick: (e) => { e.stopPropagation(); openCamera({ ids, index: idx }); },
        }, '📷'),
        p.sourceUrl && h('a', {
          class: 'icon-btn link', href: p.sourceUrl, target: '_blank', rel: 'noopener noreferrer',
          title: '購入ページを開く（別ウィンドウ）', 'aria-label': `${p.name || p.id} の購入ページを開く`,
          onclick: (e) => e.stopPropagation(),
        }, '🔗'),
        p.market?.soldUrl && h('a', {
          class: 'icon-btn link', href: p.market.soldUrl, target: '_blank', rel: 'noopener noreferrer',
          title: 'メルカリで売り切れを検索（別ウィンドウ）', 'aria-label': `${p.name || p.id} をメルカリの売り切れで検索`,
          onclick: (e) => e.stopPropagation(),
        }, '🔎'))));
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
    { label: '⚙️ 設定・AI接続・書き出し', value: '#/settings' },
    { label: '↻ 再読み込み', value: 'reload' },
  ]);
  if (v === 'reload') {
    await loadAll().catch(showError);
    toast('更新しました');
  } else if (v) location.hash = v;
}
