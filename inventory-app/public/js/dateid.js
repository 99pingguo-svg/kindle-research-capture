// 日付ID（令和の年月日6桁＋その日の注文順＋その日の注文数、締まっていない日は最後が ?）: 一覧の印・詳細の表示・⋯の取り込みシート。
// 番号を決めるのはサーバー（server/dateid.js）。観察ブラウザ連携が Vine 注文の一覧を送るたびに自動で付け直す。
import { h, clear, sheet, toast, showError, copyText, fmtDate } from './ui.js';
import { api } from './api.js';
import { describeDateId as describeCode } from './datecode.js';

/** "0811151?" → 令和8年11月15日・1番目・その日の数はまだ */
export function describeDateId(id) {
  const m = /^(\d{2})(\d{2})(\d{2})(\d)([\d?])$/.exec(id || '');
  if (!m) return '';
  const [, y, mo, d, seq, total] = m;
  return `令和${Number(y)}年${Number(mo)}月${Number(d)}日の注文・${seq}番目${total === '?' ? '（その日の注文数はまだ決まっていない）' : `（全${total}個）`}`;
}

export function dateIdBadge(p) {
  if (!p.dateId) return null;
  return h('span', { class: `badge dateid ${p.dateId.endsWith('?') ? 'open' : ''}`, title: `日付ID: ${describeDateId(p.dateId)}${p.productCode ? `\n商品ID: ${describeCode(p.productCode)}` : ''}` }, `🔢 ${p.dateId}${p.productCode ? ` ${p.productCode}` : ''}`);
}

/** Detail: the ID in large digits with a copy button (for labels). */
export function dateIdInfo(p) {
  const id = p.summary?.dateId || p.dateId;
  const code = p.summary?.productCode || p.productCode;
  if (!id && !code) return null;
  const line = (label, v, text) => v && h('div', { class: 'dateid-info small' },
    h('span', { class: 'muted' }, label), h('b', { class: 'dateid-num' }, v), h('span', { class: 'muted' }, text),
    h('button', { class: 'btn small ghost', onclick: () => copyText(v, `${v} をコピーしました`) }, '📋 コピー'));
  return h('div', null, line('日付ID', id, describeDateId(id)), line('商品ID', code, describeCode(code)));
}

const DAYS_STEP = 20;

/** ⋯ → 🔢 日付ID: what is known per day, and importing an order list (file or pasted text) with a preview first. */
export function openDateIds() {
  sheet((close) => {
    const body = h('div', { class: 'dateid-sheet' }, h('h2', null, '🔢 日付ID（注文順の番号）'), h('p', { class: 'muted' }, '読み込み中…'));
    let shown = DAYS_STEP;
    let view = null;
    const load = () => api.get('/api/date-ids').then((v) => { view = v; render(); }).catch((e) => { close(); showError(e); });

    const preview = h('div');
    const runImport = async (input, from) => {
      let r;
      try { r = await api.post('/api/date-ids/import', { ...input, from, dryRun: true }); } catch (e) { return showError(e); }
      clear(preview).append(h('div', { class: 'notice' },
        h('p', { class: 'small' }, `${r.rows}件の注文（${r.days}日分）・新しく覚える注文 ${r.added}件。台帳の商品に結べた ${r.matched}件・結べない ${r.unmatched}件（${Object.entries(r.unmatchedWhy || {}).map(([k, n]) => `${k} ${n}`).join('・') || '—'}）${r.skipped ? `・注文日のない行 ${r.skipped}件は飛ばす` : ''}。`),
        r.open.length > 0 && h('p', { class: 'small warn' }, `まだ締まっていない日: ${r.open.map((o) => `${o.date}（${o.count}件）`).join('・')} → 最後の数字は「?」。次の一覧で新しい日が入るか、8件になると決まります。`),
        r.warn.length > 0 && h('p', { class: 'small warn' }, `確かめたい日: ${r.warn.map((w) => `${w.date}（${w.warn.join('・')}）`).join(' ／ ')}`),
        r.changes.length
          ? h('div', null,
            h('p', { class: 'small' }, `番号をつける・変える商品 ${r.changes.length}件${r.changes.length >= 10 ? '（先に自動のセーブポイントを作ります）' : ''}:`),
            h('div', { class: 'dateid-changes small' }, r.changes.slice(0, 12).map((c) => h('div', null, `#${c.id} ${c.from || '（なし）'} → `, h('b', null, `${c.to || 'なし'} ${c.code || ''}`), ` ${c.name || ''}`))),
            r.changes.length > 12 && h('p', { class: 'muted small' }, `ほか ${r.changes.length - 12}件`))
          : h('p', { class: 'small' }, '商品の番号は今のままで変わりません。'),
        h('div', { class: 'actions' },
          h('button', {
            class: 'btn primary',
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                const done = await api.post('/api/date-ids/import', { ...input, from, dryRun: false });
                toast(`日付IDを反映しました（${done.applied}件）${done.errors.length ? `・失敗 ${done.errors.length}件` : ''}`, { error: !!done.errors.length });
                clear(preview);
                load();
              } catch (err) { e.target.disabled = false; showError(err); }
            },
          }, r.changes.length ? `反映する（${r.changes.length}件）` : '注文の並びだけ覚える'),
          h('button', { class: 'btn ghost', onclick: () => clear(preview) }, 'やめる'))));
    };

    const picker = h('input', {
      type: 'file', accept: '.txt,.tsv,.json,text/plain,application/json', style: { display: 'none' },
      onchange: async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        const text = await f.text();
        let input = { text };
        if (/\.json$/i.test(f.name) || /^\s*\[/.test(text)) {
          try { input = { rows: JSON.parse(text) }; } catch { /* not JSON: read as text */ }
        }
        runImport(input, f.name);
      },
    });
    const paste = h('textarea', { rows: 4, placeholder: '商品名 ⇥ リンク ⇥ 注文日 の行を貼り付け（観察ブラウザの「Vine注文」の書き出しそのまま）', style: { width: '100%', display: 'none' } });

    function render() {
      const days = view.days.slice(0, shown);
      const open = view.days.filter((d) => !d.closed);
      clear(body).append(
        h('h2', null, '🔢 日付ID（注文順の番号）'),
        h('p', { class: 'muted small' }, `日付ID＝令和の年月日6桁＋その日の注文順＋その日の注文数（例 08101088）。商品ID＝[年][月][何番目＝大文字][日][注文数＝小文字]、数字は 0＝5、YRSFWLQB＝1〜8（例 0300Q00b＝令和8年10月10日・8個中7番目）。いちばん新しい日で${view.max}個に届いていない間は最後が「?」になり、次の一覧が来たときに決まります。観察ブラウザ連携が Vine 注文を受け取ると自動で付け直します。`),
        h('p', { class: 'small' }, view.days.length
          ? `覚えている注文 ${view.days.reduce((n, d) => n + d.count, 0)}件・${view.days.length}日分${open.length ? `・まだ締まっていない日 ${open.map((d) => d.date).join('・')}` : ''}${view.imports[0] ? `　最後の取り込み ${fmtDate(view.imports[0].at)}（${view.imports[0].from || '—'}）` : ''}`
          : 'まだ注文の一覧を取り込んでいません。'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', onclick: () => picker.click() }, '📄 一覧ファイルを選ぶ'),
          h('button', { class: 'btn', onclick: () => { paste.style.display = paste.style.display === 'none' ? '' : 'none'; paste.focus(); } }, '📋 貼り付ける'),
          view.pending > 0 && h('button', {
            class: 'btn small', title: '覚えている注文を、今の台帳の商品にもう一度結びます',
            onclick: async () => { try { const r = await api.post('/api/date-ids/refresh', {}); toast(`付け直しました（${r.applied}件）`); load(); } catch (e) { showError(e); } },
          }, `番号がまだ入っていない ${view.pending}件を付け直す`)),
        picker, paste,
        preview,
        ...days.map((d) => h('div', { class: 'dateid-day' },
          h('div', { class: 'dateid-day-head small' },
            h('b', null, d.date), ` ${d.count}件`, !d.closed && h('span', { class: 'badge dateid open' }, 'まだ締まっていない'),
            d.warn.length > 0 && h('span', { class: 'badge warn', title: d.warn.join('\n') }, '⚠ 確かめたい')),
          ...d.orders.map((o) => h('button', {
            class: `dateid-row ${o.productId ? '' : 'none'}`, disabled: !o.productId,
            title: o.productId ? '' : o.reason || '',
            onclick: () => { if (o.productId) { close(); location.hash = `#/p/${o.productId}`; } },
          }, h('b', { class: 'dateid-num' }, o.dateId || '—'), h('b', { class: 'dateid-num' }, o.code || ''), h('span', null, o.productId ? `#${o.productId} ${o.productName}` : o.title), !o.productId && h('span', { class: 'muted' }, `（${o.reason}）`))))),
        shown < view.days.length && h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => { shown += DAYS_STEP; render(); } }, `もっと見る（あと${view.days.length - shown}日）`)),
        h('div', { class: 'actions sticky-actions' }, h('button', { class: 'btn', onclick: () => close() }, '閉じる')));
    }

    paste.addEventListener('input', () => {
      clearTimeout(paste.timer);
      paste.timer = setTimeout(() => { if (paste.value.trim()) runImport({ text: paste.value }, '貼り付け'); }, 600);
    });
    load();
    return body;
  });
}
