// 観察ブラウザ連携: 一覧の行の印（どの一覧か・画像取得）と、画像取得の状況のシート。
// データは Mac の sync（観察ブラウザ連携）が書き、台帳は読むだけ。
import { h, clear, sheet, showError, fmtDate } from './ui.js';
import { api } from './api.js';
import { state } from './state.js';

const SHORT = { vineOrders: 'Vine注文', reviewPending: 'レビュー待ち', reviewed: 'レビュー済み', orders: '注文履歴' };
const IMG_CLASS = { ok: 'ok', later: 'warn', gave_up: '', none: 'warn' };

/** Row badges: the Vine lists the product is in, and whether its picture was fetched. 注文履歴 alone is too common to badge. */
export function browserBadges(p) {
  const b = p.browser;
  if (!b?.lists?.length) return [];
  const vine = b.lists.filter((id) => id !== 'orders');
  if (!vine.length) return [];
  const out = [h('span', { class: 'badge info', title: b.vineOrderDate ? `Vine注文日 ${b.vineOrderDate}` : '観察ブラウザの一覧' }, `🔭 ${vine.map((id) => SHORT[id] || id).join('・')}`)];
  const st = b.image?.status || 'none';
  if (st !== 'ok') out.push(h('span', { class: `badge ${IMG_CLASS[st] || ''}`, title: '観察ブラウザ連携の画像取得' }, `画像 ${state.meta.imageStates?.[st] || st}`));
  return out;
}

const until = (iso) => (iso && Date.parse(iso) > Date.now() ? fmtDate(iso) : null);

export function openBrowserSync() {
  sheet((close) => {
    const body = h('div', null, h('h2', null, '🔭 観察ブラウザの画像取得'), h('p', { class: 'muted' }, '読み込み中…'));
    api.get('/api/browser-sync').then((r) => {
      const run = r.lastRun || {};
      const paused = until(r.pausedUntil);
      // h() drops false/null children (native append would print them).
      clear(body).append(h('div', null,
        h('h2', null, '🔭 観察ブラウザの画像取得'),
        !r.available
          ? h('p', { class: 'muted' }, 'まだ一度も動いていません（Mac の観察ブラウザ連携が書き出しを受け取ると動きます）。')
          : h('p', { class: 'small' },
            `最後に取得した: ${fmtDate(run.at || r.updatedAt)}　取得 ${run.ok ?? 0}件・次回 ${run.later ?? 0}件・あきらめ ${run.gave_up ?? 0}件（商品ページ ${run.pages ?? 0}件）`),
        r.robot && h('div', { class: 'notice warn' },
          h('strong', null, 'Amazon のロボット確認で止まっています。'),
          h('p', { class: 'small' }, `Mac のデスクトップの「Amazonのロボット確認」を開くと、ログアウト状態の窓で確認画面が出ます。ご自身で確認を済ませると続きを取ります。${paused ? `開かなければ ${paused} に自動で再開します。` : ''}`)),
        !r.robot && paused && h('p', { class: 'small warn' }, `休み中（${paused} まで）`),
        h('table', { class: 'mini-table' },
          h('thead', null, h('tr', null, ['一覧', '件数', '取得済み', '次回', 'あきらめ', '未取得'].map((t) => h('th', null, t)))),
          h('tbody', null, r.perList.map((l) => h('tr', null, h('td', null, l.label), ...[l.total, l.ok, l.later, l.gave_up, l.none].map((n) => h('td', { style: { textAlign: 'right' } }, n)))))),
        h('p', { class: 'muted small' }, '画像を取るのは Vine注文・レビュー待ち・レビュー済み の商品だけです（注文履歴は数だけ）。'),
        r.missing.length > 0 && h('h3', { class: 'small', style: { margin: '12px 0 6px' } }, `画像がまだの Vine 商品（${r.missing.length}件）`),
        r.missing.length > 0 && h('div', { class: 'list compact' }, r.missing.map((m) => h('button', {
          class: 'btn small ghost', style: { display: 'block', textAlign: 'left', width: '100%' },
          onclick: () => { close(); location.hash = `#/p/${m.id}`; },
        }, `${m.id}　${m.name || m.asin}　（${state.meta.imageStates?.[m.status] || m.status}）`))),
        h('div', { class: 'actions sticky-actions' }, h('button', { class: 'btn', onclick: () => close() }, '閉じる'))));
    }).catch((e) => { close(); showError(e); });
    return body;
  });
}
