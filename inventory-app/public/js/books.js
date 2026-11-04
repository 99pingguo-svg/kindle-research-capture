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

const journalText = (lines) => lines.map((l) => `${l.side === 'debit' ? '借' : '貸'} ${l.account} ${yen(l.amount)}`).join(' / ');

/** The rule / local-AI suggestion on a 要確認 record: what it proposes, what to check, and「候補を使う」(user only). */
function suggestionBox(e, done) {
  const s = e.suggestion;
  if (!s || e.status !== 'review') return '';
  const flags = (s.flags || []).map((f) => meta?.flags?.[f]).filter(Boolean);
  const used = !!s.appliedAt;
  return h('div', { class: 'notice small', style: { margin: '6px 0' } },
    h('div', null, `${used ? '✓ 使った候補' : '💡 分類の候補'}（${s.by === 'rules' ? '決まりごと' : 'ローカルAI'}）: `,
      [s.kind && s.kind !== e.kind && kindLabel(s.kind), s.journal?.length && journalText(s.journal), s.productId && !e.productId && `商品 ${s.productId}`].filter(Boolean).join('・') || '仕訳の候補なし'),
    s.reason && h('div', { class: 'muted' }, s.reason),
    !e.productId && s.candidates?.length ? h('div', { class: 'muted' }, '似た商品: ', ...s.candidates.map((c) => h('a', { href: `#/p/${c.productId}`, style: { marginRight: '6px' } }, `${c.productId} ${c.name || ''}（${c.score}）`))) : '',
    ...flags.map((t) => h('div', { class: 'warn' }, `⚠ ${t}`)),
    !used && (s.journal?.length || (s.productId && !e.productId) || (s.kind && s.kind !== e.kind)) ? h('button', {
      class: 'btn small', style: { marginTop: '4px' },
      onclick: async () => { try { await api.post(`/api/books/${encodeURIComponent(e.id)}/apply-suggestion`, {}); toast('候補を記録に入れました（要確認のまま）'); done(); } catch (err) { showError(err); } },
    }, '候補を使う') : '');
}

function entryCard(e, done, { showProduct = true } = {}) {
  const j = e.journal.length ? journalText(e.journal) : '仕訳なし';
  const f = e.facts;
  const sale = e.kind === 'sold' && [f.fee != null && `手数料 ${yen(f.fee)}`, f.shipping != null && `送料 ${yen(f.shipping)}`, f.proceeds != null && `手取り ${yen(f.proceeds)}`, f.cost != null && `取得原価 ${yen(f.cost)}`].filter(Boolean).join('・');
  return h('div', { class: 'card', style: { padding: '10px', margin: '6px 0' } },
    h('div', { class: 'row', style: { gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
      h('strong', null, e.date), h('span', { class: 'badge' }, kindLabel(e.kind)),
      h('span', { class: `badge ${STATUS_CLASS[e.status]}` }, meta?.statuses[e.status] || e.status),
      h('span', { class: 'muted small' }, e.id)),
    h('div', null, showProduct && e.productId ? h('a', { href: `#/p/${e.productId}` }, `${e.productId} `) : '', e.title || ''),
    h('div', { class: 'small muted' },
      [e.facts.listPrice != null && `表示価格 ${yen(e.facts.listPrice)}${e.facts.listPriceAt ? `（${e.facts.listPriceAt}確認）` : ''}`,
        e.facts.amount != null && `${e.kind === 'sold' ? '販売価格' : '金額'} ${yen(e.facts.amount)}`, sale, e.valuation.value != null && `評価額 ${yen(e.valuation.value)}`, j].filter(Boolean).join('・')),
    e.facts.note && h('div', { class: 'small muted' }, e.facts.note),
    suggestionBox(e, done),
    e.status === 'excluded' && e.excludedReason && h('div', { class: 'small muted' }, `載せない理由: ${e.excludedReason}`),
    h('div', { class: 'row', style: { gap: '6px', marginTop: '6px', flexWrap: 'wrap' } },
      e.status !== 'approved' && h('button', { class: 'btn small', onclick: () => editRecord(e, done) }, '編集'),
      e.status === 'review' && h('button', { class: 'btn small primary', onclick: () => setStatus(e, 'approved', done) }, '承認'),
      e.status === 'review' && h('button', { class: 'btn small ghost', onclick: () => setStatus(e, 'excluded', done) }, '載せない'),
      e.status !== 'review' && h('button', { class: 'btn small ghost', onclick: () => setStatus(e, 'review', done) }, e.status === 'approved' ? '承認を取り消す' : '要確認に戻す')));
}

/** 要確認の記録に分類の候補を付ける（決まりごと → 分からないものだけローカルAI）。記録そのものは変えない。 */
async function classifyAll(done) {
  toast('分類の候補を作っています（ローカルAIは1件数秒）…');
  try {
    const r = await api.post('/api/books/classify', { useAi: true });
    toast([`候補 ${r.rules + r.ai}件（決まりごと ${r.rules}・ローカルAI ${r.ai}）`, r.unknown && `分からない ${r.unknown}件`, r.waiting && `残り ${r.waiting}件は次回`, r.aiNote].filter(Boolean).join('・'));
    done();
  } catch (e) {
    showError(e);
  }
}

/** メルカリの売上: 取引画面・販売履歴をコピーした文字か CSV を貼る → 読めた結果を確かめる → 取り込む（売却の記録・要確認）。 */
function importMercari(done) {
  const ta = h('textarea', { rows: 8, placeholder: '取引画面や販売履歴の文字をコピーして貼る（「販売価格」「販売手数料」「配送料」「販売利益」の並び）／CSV（見出し: 日付・商品名・販売価格・販売手数料・配送料・販売利益）' });
  const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/*', onchange: async () => { if (file.files[0]) ta.value = await file.files[0].text(); } });
  const out = h('div');
  const ACT = { new: '新しく記録', update: '台帳の売却記録に追記', duplicate: '取り込み済み', locked: '承認済みのため触らない', skip: '読めない' };
  const send = async (dryRun, close) => {
    try {
      const r = await api.post('/api/books/import/mercari', { text: ta.value, dryRun });
      if (!dryRun) { toast(`取り込みました: 新しく ${r.counts.new}件・追記 ${r.counts.update}件`); close(); done?.(); return; }
      const rows = r.rows;
      clear(out).append(h('div', null,
        h('p', { class: 'small muted' }, rows.length ? `${rows.length}件読めました（形: ${{ table: '表', labels: '取引画面の文字', pairs: '商品名と金額' }[r.format] || r.format}）。内容を確かめてから取り込んでください。` : '読めませんでした。貼った文字の形を変えてみてください。'),
        rows.length ? h('table', { class: 'mini-table' },
          h('thead', null, h('tr', null, ...['日付', '商品名', '販売価格', '手数料', '送料', '手取り', '台帳の商品', '扱い'].map((t) => h('th', null, t)))),
          h('tbody', null, rows.map((x) => h('tr', null, h('td', null, x.date || '—'), h('td', null, x.title), ...['price', 'fee', 'shipping', 'proceeds'].map((k) => h('td', { style: { textAlign: 'right' } }, x[k] == null ? '—' : yen(x[k]))),
            h('td', null, x.link ? x.link : x.vine ? `⚠ Vine提供品 ${x.match.productId} と一致（結び付けない）` : x.match?.candidates?.length ? `候補 ${x.match.candidates.map((c) => c.productId).join('・')}` : '—'),
            h('td', null, ACT[x.action] || x.action))))) : '',
        rows.some((x) => ['new', 'update'].includes(x.action)) ? h('button', { class: 'btn primary', onclick: () => send(false, close) }, `取り込む（${rows.filter((x) => ['new', 'update'].includes(x.action)).length}件）`) : ''));
    } catch (e) {
      showError(e);
    }
  };
  let close;
  sheet((c) => {
    close = c;
    return h('div', null,
      h('h2', null, '🛒 メルカリの売上を取り込む'),
      h('p', { class: 'small muted' }, '個人のメルカリには公式の CSV 書き出しがないため、ご自身でコピーした文字や作った表を読みます（メルカリへ自動で取りに行くことはしません）。取り込んだ記録は「要確認」で、同じ取引は二重に入りません。Vine提供品と一致したものには印が付きます。'),
      ta, h('div', { class: 'row', style: { gap: '6px', alignItems: 'center', margin: '6px 0' } }, file,
        h('button', { class: 'btn', onclick: () => send(true, close) }, '読んでみる'), h('button', { class: 'btn ghost', onclick: () => c() }, '閉じる')),
      out);
  });
}

async function loadMeta() {
  if (!meta) meta = await api.get('/api/books?kind=__none__');
  return meta;
}

let view = { year: String(new Date().getFullYear()), status: '', kind: '', tab: 'records' };
const TABS = [['records', '記録'], ['works', '作品'], ['tax', '税額の試算'], ['report', '説明資料']];
const PLATFORMS = { youtube: 'YouTube', blog: 'ブログ', x: 'X', instagram: 'Instagram', other: 'その他' };
const WORK_STATUS = { planned: '企画', filming: '撮影中', published: '公開済み', dropped: '中止' };

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
  const tabs = h('div', { class: 'chips', style: { margin: '8px 0' } }, TABS.map(([id, label]) =>
    h('button', { class: `chip ${view.tab === id ? 'on' : ''}`, onclick: () => { view.tab = id; showBooks(); } }, label)));
  body.before(tabs);
  if (view.tab === 'works') return renderWorks(body);
  if (view.tab === 'tax') return renderTax(body);
  if (view.tab === 'report') return renderReport(body);
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
          h('button', { class: 'btn small', onclick: () => importMercari(showBooks) }, '🛒 メルカリの売上を取り込む'),
          h('button', { class: 'btn small', onclick: () => classifyAll(showBooks) }, '💡 分類の候補を出す'),
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
      const [list, works, pr] = await Promise.all([api.get(`/api/books?productId=${encodeURIComponent(p.id)}`), api.get(`/api/works?productId=${encodeURIComponent(p.id)}`),
        api.get(`/api/products/${encodeURIComponent(p.id)}/prices`).catch(() => ({ history: [] }))]);
      const hist = pr.history.slice(-12).reverse();
      const quick = [['use', '使用・体験'], ['consumed', '消費した'], ['disposed', '廃棄した'], ['kept', '保管・継続使用']];
      clear(box).append(h('div', null,
        h('h3', null, '🧾 帳簿'),
        list.entries.length ? list.entries.map((e) => entryCard(e, render, { showProduct: false })) : h('p', { class: 'muted small' }, 'まだ記録はありません。'),
        h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
          quick.map(([kind, label]) => h('button', { class: 'btn small', onclick: () => editRecord(null, render, { kind, productId: p.id, asin: p.summary?.browser?.asin || '', title: p.name || '' }) }, `＋ ${label}`))),
        hist.length ? h('details', { style: { marginTop: '8px' } }, h('summary', { class: 'small' }, `Amazon の価格の履歴（${pr.history.length}回確認・最新 ${hist[0].price == null ? '価格なし' : yen(hist[0].price)}）`),
          h('table', { class: 'mini-table' }, h('thead', null, h('tr', null, ...['確認日', '価格', '参考価格', '在庫', '出どころ'].map((t) => h('th', null, t)))),
            h('tbody', null, hist.map((o) => h('tr', null, h('td', null, o.at.slice(0, 10)), h('td', { style: { textAlign: 'right' } }, o.price == null ? '—' : yen(o.price)),
              h('td', { style: { textAlign: 'right' } }, o.basisPrice == null ? '—' : yen(o.basisPrice)), h('td', null, o.availability || '—'),
              h('td', { class: 'small' }, o.source === 'amazon-info' ? '台帳の取得' : 'ログアウト状態の商品ページ')))))) : '',
        h('h3', { class: 'small', style: { marginTop: '10px' } }, '作品'),
        works.length ? works.map((w) => workCard(w, render)) : h('p', { class: 'muted small' }, '紐付いた作品はまだありません。'),
        h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
          h('button', { class: 'btn small', onclick: () => editWork(null, render, { productIds: [p.id] }) }, '＋ この商品の作品'),
          h('a', { class: 'btn small', href: `/api/books/report/product/${encodeURIComponent(p.id)}`, target: '_blank' }, '📄 この商品の説明資料'))));
    } catch (e) {
      clear(box).append(h('h3', null, '🧾 帳簿'), h('p', { class: 'muted small' }, `読み込めません: ${e.message}`));
    }
  };
  render();
  return box;
}

// ---------- 作品（YouTube・ブログ…）: 企画・撮影・公開と、登場する商品（多対多） ----------
export function editWork(work, done, base = {}) {
  const w = work || { title: '', platform: 'youtube', status: 'planned', url: '', plannedAt: today(), filmedAt: '', publishedAt: '', productIds: base.productIds || [], note: '' };
  const f = {
    title: h('input', { type: 'text', value: w.title, placeholder: '作品の題・企画名' }),
    platform: h('select', null, Object.entries(PLATFORMS).map(([v, l]) => h('option', { value: v, selected: v === w.platform }, l))),
    status: h('select', null, Object.entries(WORK_STATUS).map(([v, l]) => h('option', { value: v, selected: v === w.status }, l))),
    url: h('input', { type: 'url', value: w.url, placeholder: 'https://…（公開したら）' }),
    plannedAt: h('input', { type: 'date', value: w.plannedAt }), filmedAt: h('input', { type: 'date', value: w.filmedAt }), publishedAt: h('input', { type: 'date', value: w.publishedAt }),
    productIds: h('input', { type: 'text', value: w.productIds.join(', '), placeholder: '登場する商品のID（例: 0475, 0476）' }),
    note: h('textarea', { rows: 4, placeholder: '企画の中身・撮っていない時間の出来事・生活の変化など' }, w.note),
  };
  const row = (label, el) => h('label', { class: 'field' }, h('span', { class: 'small muted' }, label), el);
  return sheet((close) => h('div', null,
    h('h2', null, work ? `作品の編集（${work.id}）` : '作品を追加'),
    row('題', f.title), h('div', { class: 'row', style: { gap: '6px' } }, row('媒体', f.platform), row('状態', f.status)), row('URL', f.url),
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, row('企画日', f.plannedAt), row('撮影日', f.filmedAt), row('公開日', f.publishedAt)),
    row('登場する商品', f.productIds), row('メモ', f.note),
    h('div', { class: 'actions sticky-actions' },
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
          try {
            if (work) await api.patch(`/api/works/${encodeURIComponent(work.id)}`, body);
            else await api.post('/api/works', body);
            toast('保存しました');
            close();
            done?.();
          } catch (e) {
            showError(e);
          }
        },
      }, '保存'),
      h('button', { class: 'btn ghost', onclick: () => close() }, 'キャンセル'))));
}

function workCard(w, done) {
  return h('div', { class: 'card', style: { padding: '10px', margin: '6px 0' } },
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
      h('strong', null, w.title || '（題なし）'), h('span', { class: 'badge' }, PLATFORMS[w.platform]), h('span', { class: `badge ${w.status === 'published' ? 'ok' : ''}` }, WORK_STATUS[w.status]), h('span', { class: 'muted small' }, w.id)),
    h('div', { class: 'small muted' }, `企画 ${w.plannedAt || '—'}・撮影 ${w.filmedAt || '—'}・公開 ${w.publishedAt || '—'}`),
    w.url && h('div', { class: 'small' }, h('a', { href: w.url, target: '_blank', rel: 'noopener' }, w.url)),
    w.productIds.length > 0 && h('div', { class: 'small' }, '商品: ', ...w.productIds.map((id) => h('a', { href: `#/p/${id}`, style: { marginRight: '6px' } }, id))),
    w.note && h('div', { class: 'small muted' }, w.note),
    h('button', { class: 'btn small', style: { marginTop: '6px' }, onclick: () => editWork(w, done) }, '編集'));
}

async function renderWorks(body) {
  try {
    const works = await api.get('/api/works');
    clear(body).append(h('div', null,
      h('p', { class: 'small muted' }, '1つの作品に何個でも商品を、1つの商品に何本でも作品を紐付けられます。撮っていない時間の出来事や生活の変化もメモに残せます。'),
      h('button', { class: 'btn small primary', onclick: () => editWork(null, showBooks) }, '＋ 作品を追加'),
      works.length ? works.map((w) => workCard(w, showBooks)) : h('p', { class: 'muted' }, 'まだ作品はありません。')));
  } catch (e) {
    showError(e);
  }
}

// ---------- 税額の試算（目安）。入力はこの端末にだけ保存（サーバーに残さない） ----------
const TAX_KEY = 'daicho.taxInput';
function loadTaxInput() {
  try { return { year: new Date().getFullYear(), vineIncome: 1000000, expense: 0, otherIncome: 0, kind: 'misc', blue: 'none', disability: 'none', socialInsurance: 0, otherDeductions: 0, nhi: {}, pensionLimit: {}, ...JSON.parse(localStorage.getItem(TAX_KEY) || '{}') }; } catch { return { year: new Date().getFullYear() }; }
}
async function renderTax(body) {
  const v = loadTaxInput();
  const num = (k, ph, obj = v) => h('input', { type: 'number', value: obj[k] ?? '', placeholder: ph, oninput: (e) => { obj[k] = e.target.value; } });
  const sel = (k, opts) => h('select', { onchange: (e) => { v[k] = e.target.value; } }, opts.map(([val, l]) => h('option', { value: val, selected: String(v[k]) === String(val) }, l)));
  const row = (label, el) => h('label', { class: 'field' }, h('span', { class: 'small muted' }, label), el);
  const out = h('div');
  const run = async () => {
    try { localStorage.setItem(TAX_KEY, JSON.stringify(v)); } catch {}
    try {
      const r = await api.post('/api/tax/simulate', v);
      const s = r.single;
      if (s.error) return clear(out).append(h('p', { class: 'warn' }, s.error));
      const cell = (x) => h('td', { style: { textAlign: 'right' } }, x == null ? '—' : yen(x));
      clear(out).append(h('div', null,
        h('h3', { class: 'small' }, `${s.label}（この条件）`),
        h('table', { class: 'mini-table' }, h('tbody', null,
          h('tr', null, h('th', null, '収入（現物収入を含む）'), cell(s.revenue)), h('tr', null, h('th', null, '必要経費'), cell(s.expense)),
          s.blue ? h('tr', null, h('th', null, '青色申告特別控除'), cell(s.blue)) : '',
          h('tr', null, h('th', null, '所得'), cell(s.income)), h('tr', null, h('th', null, `所得控除（基礎 ${yen(s.deductions.basic)}・障害者 ${yen(s.deductions.disability)}・社会保険料 ${yen(s.deductions.social)}・その他 ${yen(s.deductions.other)}）`), cell(s.deductions.basic + s.deductions.disability + s.deductions.social + s.deductions.other)),
          h('tr', null, h('th', null, '課税所得'), cell(s.taxable)), h('tr', null, h('th', null, '所得税＋復興特別所得税'), cell(s.nationalTotal)),
          h('tr', null, h('th', null, `住民税（翌年度）${s.resident.exempt ? '・非課税' : ''}`), cell(s.resident.total)),
          h('tr', null, h('th', null, '国民健康保険料（入力した料率）'), cell(s.nhi?.total)),
          s.pension ? h('tr', null, h('th', null, '障害基礎年金の所得制限'), h('td', null, s.pension.state)) : '')),
        h('h3', { class: 'small' }, 'Vine の額 × 経費の割合（ほかの条件は同じ）'),
        h('table', { class: 'mini-table' },
          h('thead', null, h('tr', null, h('th', null, 'Vineの額'), h('th', null, '経費'), h('th', null, '所得'), h('th', null, '所得税等'), h('th', null, '住民税'), h('th', null, '国保'))),
          h('tbody', null, r.scenarios.flatMap((g) => g.rows.map((x) => h('tr', null, h('td', null, yen(g.vineIncome)), h('td', null, x.label), cell(x.result.income), cell(x.result.nationalTotal), cell(x.result.resident?.total), cell(x.result.nhi?.total)))))),
        h('p', { class: 'small muted' }, ['目安です（確定申告の計算ではありません）。', ...s.notes, `未確認の値: ${s.unverified.join('・')}`, s.resident.note].filter(Boolean).join(' ')),
        h('p', { class: 'small muted' }, '出典: ', ...s.sources.map((x) => h('a', { href: x.url, target: '_blank', rel: 'noopener', style: { marginRight: '8px' } }, `${x.title}（${x.checked}確認）`)))));
    } catch (e) {
      showError(e);
    }
  };
  clear(body).append(h('div', null,
    h('p', { class: 'small muted' }, '入力した条件だけで計算する目安です。足りない設定（国保の料率・年金の所得制限の基準額）は空のままなら計算しません。入力はこの端末にだけ保存します。'),
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
      row('年分', sel('year', [[2025, '令和7年分'], [2026, '令和8年分'], [2027, '令和9年分']])),
      row('所得の区分', sel('kind', [['misc', '雑所得'], ['business', '事業所得']])),
      row('青色申告特別控除', sel('blue', [['none', 'なし（白色）'], ['blue10', '10万円'], ['blue55', '55万円'], ['blue65', '65万円']]))),
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
      row('Vineの現物収入として計上する額', num('vineIncome', '例: 1000000')), row('必要経費', num('expense', '例: 500000')), row('そのほかの収入（広告・アフィリエイト・売却益）', num('otherIncome', '0'))),
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
      row('障害者控除', sel('disability', [['none', 'なし'], ['general', '障害者'], ['special', '特別障害者'], ['cohabit_special', '同居特別障害者']])),
      row('社会保険料控除（払った額）', num('socialInsurance', '0')), row('そのほかの所得控除', num('otherDeductions', '0'))),
    h('details', null, h('summary', { class: 'small' }, '国民健康保険料・年金の所得制限（市町村・日本年金機構の値を入れたときだけ）'),
      h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
        row('国保 所得割の率（例 0.1）', num('rate', '', v.nhi)), row('均等割（人数分）', num('perCapita', '', v.nhi)), row('平等割', num('perHousehold', '', v.nhi)), row('上限', num('cap', '', v.nhi))),
      h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
        row('20歳前障害年金 2分の1停止の所得', num('half', '', v.pensionLimit)), row('全額停止の所得', num('full', '', v.pensionLimit)))),
    h('button', { class: 'btn primary', onclick: run }, '試算する'),
    out));
  run();
}

// ---------- 説明資料: 理念（主張）と事実を分けた年間資料・商品別資料 ----------
async function renderReport(body) {
  try {
    const { statement } = await api.get('/api/books/statement');
    const ta = h('textarea', { rows: 10, placeholder: '活動の理念（生活そのものを作品にする考え方など）。説明資料の第1部になります。' }, statement);
    clear(body).append(h('div', null,
      h('p', { class: 'small muted' }, '説明資料は印刷用のページで開きます（ブラウザの印刷から PDF に保存できます）。理念（あなたの主張）と、商品ごとの客観的な事実は分けて載せます。'),
      h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
        h('a', { class: 'btn small primary', href: `/api/books/report?year=${view.year}`, target: '_blank' }, `${view.year}年の説明資料を開く`),
        h('span', { class: 'small muted' }, '商品ごとの資料は、商品詳細の「🧾 帳簿」欄から開けます。')),
      h('label', { class: 'field', style: { marginTop: '12px' } }, h('span', { class: 'small muted' }, '活動の理念（利用者の主張）'), ta),
      h('button', { class: 'btn small', onclick: async () => { try { await api.put('/api/books/statement', { statement: ta.value }); toast('保存しました'); } catch (e) { showError(e); } } }, '理念を保存')));
  } catch (e) {
    showError(e);
  }
}
