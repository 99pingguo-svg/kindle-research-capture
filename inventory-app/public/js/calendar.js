// Date range picker for the list (日付＝注文・購入・到着のいずれか).
// Tap a day = start, tap another = end. Tap the month title = whole month.
// Each day shows how many products have that date, so the busy days are visible at a glance.
import { h, clear, sheet } from './ui.js';

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const pad = (n) => String(n).padStart(2, '0');
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (s, n) => {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return iso(d);
};

/** "9/23(水)" — adds the year when it is not the current one. */
export function fmtDay(s, { weekday = true } = {}) {
  if (!s) return '';
  const d = parse(s);
  const y = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}/`;
  return `${y}${d.getMonth() + 1}/${d.getDate()}${weekday ? `(${WD[d.getDay()]})` : ''}`;
}

export function rangeLabel({ dateFrom, dateTo, dateNone }) {
  if (dateNone) return '日付なし';
  if (!dateFrom && !dateTo) return '全期間';
  if (dateFrom && dateTo && dateFrom === dateTo) return fmtDay(dateFrom);
  return `${fmtDay(dateFrom, { weekday: false }) || '…'} 〜 ${fmtDay(dateTo, { weekday: false }) || '…'}`;
}

function presets() {
  const t = iso(new Date());
  const now = new Date();
  const monthStart = (y, m) => iso(new Date(y, m, 1));
  const monthEnd = (y, m) => iso(new Date(y, m + 1, 0));
  return [
    { label: '今日', from: t, to: t },
    { label: '昨日', from: addDays(t, -1), to: addDays(t, -1) },
    { label: '直近7日', from: addDays(t, -6), to: t },
    { label: '直近30日', from: addDays(t, -29), to: t },
    { label: '今月', from: monthStart(now.getFullYear(), now.getMonth()), to: monthEnd(now.getFullYear(), now.getMonth()) },
    { label: '先月', from: monthStart(now.getFullYear(), now.getMonth() - 1), to: monthEnd(now.getFullYear(), now.getMonth() - 1) },
  ];
}

/**
 * products: summaries (used for per-day counts). Resolves to
 * { dateFrom, dateTo, dateNone } or undefined when cancelled.
 */
export function pickDateRange({ dateFrom = '', dateTo = '', dateNone = false }, products) {
  const counts = new Map();
  let undated = 0;
  let latest = '';
  for (const p of products) {
    if (!p.itemDate) {
      undated++;
      continue;
    }
    counts.set(p.itemDate, (counts.get(p.itemDate) || 0) + 1);
    if (p.itemDate > latest) latest = p.itemDate;
  }
  let start = dateNone ? '' : dateFrom;
  let end = dateNone ? '' : dateTo;
  const anchor = parse(end || start || latest || iso(new Date()));
  let year = anchor.getFullYear();
  let month = anchor.getMonth();

  return sheet((close) => {
    const summary = h('div', { class: 'cal-summary' });
    const grid = h('div');
    const countIn = (a, b) => {
      let n = 0;
      for (const [d, c] of counts) if (d >= a && d <= b) n += c;
      return n;
    };
    const renderSummary = () => {
      clear(summary);
      if (!start) summary.append(h('span', { class: 'muted' }, '開始日をタップ（もう一度タップで終了日）'));
      else {
        const a = start;
        const b = end || start;
        summary.append(h('strong', null, a === b ? fmtDay(a) : `${fmtDay(a)} 〜 ${fmtDay(b)}`), h('span', { class: 'muted' }, `  ${countIn(a, b)}件`));
      }
    };
    const tap = (d) => {
      if (!start || end) {
        start = d;
        end = '';
      } else if (d < start) {
        end = start;
        start = d;
      } else end = d;
      render();
    };
    const render = () => {
      renderSummary();
      clear(grid);
      const first = new Date(year, month, 1);
      const days = new Date(year, month + 1, 0).getDate();
      const mFrom = iso(first);
      const mTo = iso(new Date(year, month, days));
      const today = iso(new Date());
      const a = start;
      const b = end || start;
      const cells = [];
      for (let i = 0; i < first.getDay(); i++) cells.push(h('div', { class: 'cal-cell empty' }));
      for (let d = 1; d <= days; d++) {
        const s = iso(new Date(year, month, d));
        const n = counts.get(s) || 0;
        const inRange = a && s >= a && s <= b;
        const edge = s === a || s === b;
        const dow = (first.getDay() + d - 1) % 7;
        cells.push(h('button', {
          class: `cal-cell ${inRange ? 'in' : ''} ${edge ? 'edge' : ''} ${s === today ? 'today' : ''} ${n ? 'has' : ''} ${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}`,
          onclick: () => tap(s),
          'aria-label': `${month + 1}月${d}日 ${n}件`,
        }, h('span', { class: 'd' }, d), n ? h('span', { class: 'n' }, n) : null));
      }
      grid.append(
        h('div', { class: 'cal-head' },
          h('button', { class: 'icon-btn', 'aria-label': '前の月', onclick: () => { month--; if (month < 0) { month = 11; year--; } render(); } }, '‹'),
          h('button', { class: 'cal-title', title: 'タップでこの月全体', onclick: () => { start = mFrom; end = mTo; render(); } },
            `${year}年${month + 1}月`, h('span', { class: 'muted small' }, `  ${countIn(mFrom, mTo)}件 · 月全体`)),
          h('button', { class: 'icon-btn', 'aria-label': '次の月', onclick: () => { month++; if (month > 11) { month = 0; year++; } render(); } }, '›')),
        h('div', { class: 'cal-grid' }, WD.map((w, i) => h('div', { class: `cal-wd ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}` }, w)), cells));
    };
    render();
    const apply = (v) => close(v);
    return h('div', { class: 'cal' },
      h('h2', null, '📅 日付で絞り込み', h('span', { class: 'muted small', style: { fontWeight: 'normal', marginLeft: '8px' } }, '注文・購入・到着')),
      h('div', { class: 'cal-presets' },
        presets().map((p) => h('button', { class: 'chip', onclick: () => apply({ dateFrom: p.from, dateTo: p.to, dateNone: false }) }, p.label)),
        h('button', { class: 'chip', onclick: () => apply({ dateFrom: '', dateTo: '', dateNone: true }) }, `日付なし ${undated}`),
        h('button', { class: 'chip', onclick: () => apply({ dateFrom: '', dateTo: '', dateNone: false }) }, 'すべて')),
      grid,
      summary,
      h('div', { class: 'actions', style: { flexDirection: 'row', marginTop: '10px' } },
        h('button', { class: 'btn', style: { flex: 1 }, onclick: () => apply({ dateFrom: '', dateTo: '', dateNone: false }) }, 'クリア'),
        h('button', { class: 'btn primary', style: { flex: 2 }, onclick: () => (start ? apply({ dateFrom: start, dateTo: end || start, dateNone: false }) : close()) }, 'この期間で表示')));
  });
}
