// 帳簿の画面: 年ごとの一覧（要確認・承認済み・載せない）、記録の追加と編集、承認、CSV。商品詳細の「🧾 帳簿」欄もここ。
// 税務上の扱いは決めつけない: 事実（日付・表示価格とその確認日）と、仮の仕訳・5つの税務メモを分けて書く。承認はユーザーだけ。
import { h, clear, toast, showError, choose, sheet, yen } from './ui.js';
import { api } from './api.js';

const pane = () => document.getElementById('detail-pane');
let meta = null; // { kinds, statuses }
const kindLabel = (id) => meta?.kinds.find((k) => k.id === id)?.label || id;
const STATUS_CLASS = { review: 'warn', approved: 'ok', excluded: '' };
const TAX = [['claim', '利用者の主張（業務上の必要性）'], ['actual', '実際の使用状況・証拠'], ['general', '現行税法上の一般的な処理'], ['expert', '税理士・税務署等の確認結果'], ['filed', '確定申告で実際に採用した処理']];
const today = () => new Date().toLocaleDateString('sv-SE');

async function setStatus(e, status, done) {
  let reason = '';
  if (status === 'excluded') {
    reason = prompt('帳簿に載せない理由（例: 税務上の記録が不要と確認した）', '') ?? null;
    if (reason === null) return;
  }
  try {
    await api.post(`/api/books/${encodeURIComponent(e.id)}/status`, { status, reason });
    toast({ approved: '承認しました', review: '要確認に戻しました', excluded: '帳簿に載せないにしました' }[status]);
    done();
  } catch (err) {
    showError(err);
  }
}

/** Add or edit one record. `base` pre-fills a new one (e.g. from a product). */
export function editRecord(entry, done, base = {}) {
  const e = entry || { kind: base.kind || 'use', date: today(), productId: base.productId || '', asin: base.asin || '', title: base.title || '', facts: {}, valuation: {}, journal: [], tax: {} };
  const debit = e.journal?.find((l) => l.side === 'debit');
  const credit = e.journal?.find((l) => l.side === 'credit');
  const f = {
    kind: h('select', null, (meta?.kinds || []).map((k) => h('option', { value: k.id, selected: k.id === e.kind }, k.label))),
    date: h('input', { type: 'date', value: e.date }),
    title: h('input', { type: 'text', value: e.title || '', placeholder: '商品名・内容' }),
    productId: h('input', { type: 'text', value: e.productId || '', placeholder: '台帳の商品ID（任意）', style: { width: '9em' } }),
    amount: h('input', { type: 'number', value: e.facts?.amount ?? '', placeholder: '金額（実際に払った・受け取った額）' }),
    listPrice: h('input', { type: 'number', value: e.facts?.listPrice ?? '', placeholder: 'Amazon表示価格' }),
    listPriceAt: h('input', { type: 'date', value: e.facts?.listPriceAt || '' }),
    value: h('input', { type: 'number', value: e.valuation?.value ?? '', placeholder: '税務上の評価額（決まっていれば）' }),
    basis: h('input', { type: 'text', value: e.valuation?.basis || '', placeholder: '評価の根拠' }),
    debitAcc: h('input', { type: 'text', value: debit?.account || '', placeholder: '借方の科目' }),
    creditAcc: h('input', { type: 'text', value: credit?.account || '', placeholder: '貸方の科目' }),
    jAmount: h('input', { type: 'number', value: debit?.amount ?? credit?.amount ?? '', placeholder: '仕訳の金額' }),
    note: h('textarea', { rows: 2, placeholder: 'メモ（何に使った・どうなった・証拠のありか など）' }, e.facts?.note || ''),
    ...Object.fromEntries(TAX.map(([k]) => [`tax_${k}`, h('textarea', { rows: 2 }, e.tax?.[k] || '')])),
  };
  const row = (label, ...els) => h('label', { class: 'field' }, h('span', { class: 'small muted' }, label), ...els);
  return sheet((close) => h('div', null,
    h('h2', null, entry ? `記録の編集（${entry.id}）` : '帳簿に記録を追加'),
    h('p', { class: 'muted small' }, '税務上どう扱うかは決めなくて大丈夫です（要確認のまま残せます）。仕訳は空でも構いません。'),
    row('種類', f.kind), row('日付', f.date), row('内容', f.title), row('台帳の商品ID', f.productId), row('金額', f.amount),
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, row('表示価格', f.listPrice), row('その確認日', f.listPriceAt)),
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, row('税務評価額', f.value), row('評価の根拠', f.basis)),
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, row('仕訳 借方', f.debitAcc), row('貸方', f.creditAcc), row('金額', f.jAmount)),
    row('メモ', f.note),
    h('details', null, h('summary', { class: 'small' }, '税務上の扱いのメモ（5つを分けて残す）'), ...TAX.map(([k, label]) => row(label, f[`tax_${k}`]))),
    h('div', { class: 'actions sticky-actions' },
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const num = (el) => (el.value === '' ? null : Number(el.value));
          const amt = num(f.jAmount);
          const journal = [f.debitAcc.value.trim() && { side: 'debit', account: f.debitAcc.value.trim(), amount: amt ?? 0 },
            f.creditAcc.value.trim() && { side: 'credit', account: f.creditAcc.value.trim(), amount: amt ?? 0 }].filter(Boolean);
          const body = {
            kind: f.kind.value, date: f.date.value, title: f.title.value, productId: f.productId.value.trim(),
            facts: { amount: num(f.amount), listPrice: num(f.listPrice), listPriceAt: f.listPriceAt.value, note: f.note.value },
            valuation: { value: num(f.value), basis: f.basis.value }, journal,
            tax: Object.fromEntries(TAX.map(([k]) => [k, f[`tax_${k}`].value])),
          };
          try {
            if (entry) await api.patch(`/api/books/${encodeURIComponent(entry.id)}`, body);
            else await api.post('/api/books', { ...body, ...body.facts, value: body.valuation.value, basis: body.valuation.basis, asin: e.asin });
            toast(entry ? '保存しました' : '記録しました');
            close();
            done?.();
          } catch (err) {
            showError(err);
          }
        },
      }, entry ? '保存' : '記録する'),
      h('button', { class: 'btn ghost', onclick: () => close() }, 'キャンセル'))));
}

function entryCard(e, done, { showProduct = true } = {}) {
  const j = e.journal.length ? e.journal.map((l) => `${l.side === 'debit' ? '借' : '貸'} ${l.account} ${yen(l.amount)}`).join(' / ') : '仕訳なし';
  return h('div', { class: 'card', style: { padding: '10px', margin: '6px 0' } },
    h('div', { class: 'row', style: { gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
      h('strong', null, e.date), h('span', { class: 'badge' }, kindLabel(e.kind)),
      h('span', { class: `badge ${STATUS_CLASS[e.status]}` }, meta?.statuses[e.status] || e.status),
      h('span', { class: 'muted small' }, e.id)),
    h('div', null, showProduct && e.productId ? h('a', { href: `#/p/${e.productId}` }, `${e.productId} `) : '', e.title || ''),
    h('div', { class: 'small muted' },
      [e.facts.listPrice != null && `表示価格 ${yen(e.facts.listPrice)}${e.facts.listPriceAt ? `（${e.facts.listPriceAt}確認）` : ''}`,
        e.facts.amount != null && `金額 ${yen(e.facts.amount)}`, e.valuation.value != null && `評価額 ${yen(e.valuation.value)}`, j].filter(Boolean).join('・')),
    e.facts.note && h('div', { class: 'small muted' }, e.facts.note),
    e.status === 'excluded' && e.excludedReason && h('div', { class: 'small muted' }, `載せない理由: ${e.excludedReason}`),
    h('div', { class: 'row', style: { gap: '6px', marginTop: '6px', flexWrap: 'wrap' } },
      e.status !== 'approved' && h('button', { class: 'btn small', onclick: () => editRecord(e, done) }, '編集'),
      e.status === 'review' && h('button', { class: 'btn small primary', onclick: () => setStatus(e, 'approved', done) }, '承認'),
      e.status === 'review' && h('button', { class: 'btn small ghost', onclick: () => setStatus(e, 'excluded', done) }, '載せない'),
      e.status !== 'review' && h('button', { class: 'btn small ghost', onclick: () => setStatus(e, 'review', done) }, e.status === 'approved' ? '承認を取り消す' : '要確認に戻す')));
}

async function loadMeta() {
  if (!meta) meta = await api.get('/api/books?kind=__none__');
  return meta;
}

let view = { year: String(new Date().getFullYear()), status: '', kind: '' };

export async function showBooks() {
  const p = pane();
  clear(p);
  p.scrollTop = 0;
  const body = h('div', null, h('p', { class: 'muted' }, '読み込み中…'));
  p.append(h('div', { class: 'detail' },
    h('header', { class: 'topbar', style: { margin: '0 -12px' } },
      h('div', { class: 'detail-head' },
        h('button', { class: 'icon-btn', onclick: () => (location.hash = '#/'), 'aria-label': '戻る' }, '‹'),
        h('div', { class: 'name' }, '🧾 帳簿'))),
    body));
  try {
    await loadMeta();
    const q = new URLSearchParams({ year: view.year, ...(view.status ? { status: view.status } : {}), ...(view.kind ? { kind: view.kind } : {}) });
    const [list, sum] = await Promise.all([api.get(`/api/books?${q}`), api.get(`/api/books/summary?year=${view.year}`)]);
    const years = [...new Set([String(new Date().getFullYear()), view.year, '2025', '2026'])].sort().reverse();
    const set = (k, v) => { view = { ...view, [k]: v }; showBooks(); };
    const accounts = Object.entries(sum.approvedAccounts);
    clear(body).append(h('div', null,
      h('div', { class: 'card' },
        h('p', { class: 'small muted' }, '念のための記録です。税務上どう扱うかは決めつけず、「要確認」のまま残します。承認・載せないはあなただけが決められます。Vine受領と同じ額を自動で経費にすることはしません。'),
        h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
          h('select', { onchange: (e) => set('year', e.target.value) }, years.map((y) => h('option', { value: y, selected: y === view.year }, `${y}年`))),
          h('select', { onchange: (e) => set('status', e.target.value) }, [['', 'すべての状態'], ...Object.entries(meta.statuses)].map(([v, l]) => h('option', { value: v, selected: v === view.status }, l))),
          h('select', { onchange: (e) => set('kind', e.target.value) }, [['', 'すべての種類'], ...meta.kinds.map((k) => [k.id, k.label])].map(([v, l]) => h('option', { value: v, selected: v === view.kind }, l))),
          h('button', { class: 'btn small primary', onclick: () => editRecord(null, showBooks) }, '＋ 記録を追加'),
          h('a', { class: 'btn small', href: `/api/books/export.csv?year=${view.year}` }, 'CSV（Excel可）'))),
      h('div', { class: 'card small' },
        h('div', null, `${sum.year}年: ${sum.total}件（要確認 ${sum.review}件）`),
        h('div', null, `Vine受領の表示価格の合計 ${yen(sum.vine.shownPriceTotal)}${sum.vine.withoutPrice ? `・表示価格なし ${sum.vine.withoutPrice}件` : ''}（税務上の評価額ではありません）`),
        sum.byKind.length ? h('div', { class: 'muted' }, sum.byKind.map((k) => `${k.label} ${k.count}`).join('・')) : '',
        accounts.length ? h('div', { class: 'muted' }, `承認済みの仕訳: ${accounts.map(([a, v]) => `${a} 借${yen(v.debit)} 貸${yen(v.credit)}`).join('・')}`) : ''),
      list.entries.length ? list.entries.map((e) => entryCard(e, showBooks)) : h('p', { class: 'muted' }, 'この条件の記録はありません。')));
  } catch (e) {
    showError(e);
  }
}

/** 商品詳細の「🧾 帳簿」欄: その商品の記録と、よく使う記録のワンタップ追加。 */
export function booksCard(p) {
  const box = h('div', { class: 'card' }, h('h3', null, '🧾 帳簿'), h('p', { class: 'muted small' }, '読み込み中…'));
  const render = async () => {
    try {
      await loadMeta();
      const list = await api.get(`/api/books?productId=${encodeURIComponent(p.id)}`);
      const quick = [['use', '使用・体験'], ['consumed', '消費した'], ['disposed', '廃棄した'], ['kept', '保管・継続使用']];
      clear(box).append(h('div', null,
        h('h3', null, '🧾 帳簿'),
        list.entries.length ? list.entries.map((e) => entryCard(e, render, { showProduct: false })) : h('p', { class: 'muted small' }, 'まだ記録はありません。'),
        h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
          quick.map(([kind, label]) => h('button', { class: 'btn small', onclick: () => editRecord(null, render, { kind, productId: p.id, asin: p.summary?.browser?.asin || '', title: p.name || '' }) }, `＋ ${label}`)))));
    } catch (e) {
      clear(box).append(h('h3', null, '🧾 帳簿'), h('p', { class: 'muted small' }, `読み込めません: ${e.message}`));
    }
  };
  render();
  return box;
}
