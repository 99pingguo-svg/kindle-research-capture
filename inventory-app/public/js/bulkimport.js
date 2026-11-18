// 純正カメラの写真をまとめて取り込む: iPhone の「カメラ」で好きなモード・スタイルで撮りっぱなしにして、あとで選ぶだけ。
// 撮影時刻（写真の EXIF）で間があいたところを区切りに「商品ごとの組」に分け、組の写真の文字・ラベル（Amazon管理番号・JAN・商品名）を
// Mac で読んで（POST /api/ocr）どの商品か候補を出す。確かめて「取り込む」で各商品の現物写真になり、Mac が自動で仕上げる。
// ショートカットは要らない（入れてあれば今まで通り使える）。
import { h, toast, showError, sheet } from './ui.js';
import { state } from './state.js';
import { actor, api } from './api.js';
import { makeVariants } from './images.js';
import * as uploads from './uploads.js';
import { ocrCandidates, termsOf, searchScore, fnskusIn } from './search.js';
import { takenAt, groupByGap } from './photo-time.js';

async function suggest(group) {
  // Read a few frames (the last ones are often the label) and pool the text.
  const picks = [...new Set([group.items.at(-1), group.items[0], group.items[Math.floor(group.items.length / 2)]])].slice(0, 3);
  const lines = [];
  const barcodes = [];
  for (const it of picks) {
    try {
      const r = await fetch('/api/ocr', { method: 'POST', headers: { 'x-actor': actor, 'content-type': 'image/jpeg' }, body: it.v.work, credentials: 'same-origin' });
      const j = await r.json();
      if (r.ok) { lines.push(...(j.lines || [])); barcodes.push(...(j.barcodes || [])); }
    } catch { /* offline: no suggestion */ }
  }
  group.fnsku = fnskusIn([...barcodes, ...lines.map((l) => l.text)].join(' '))[0] || '';
  group.ocrName = lines.map((l) => l.text).sort((a, b) => b.length - a.length)[0] || '';
  const c = ocrCandidates([...state.products.values()].filter((p) => !p.trashedAt), { lines, barcodes }, 4);
  // Orders in the order list that are not in the 台帳 yet (most photos are of new items): matched by name only.
  const o = ocrCandidates(orderPool, { lines, barcodes: [] }, 3).filter((x) => x.score >= 0.35);
  group.candidates = c.map((x) => ({ id: x.p.id, why: x.why, score: x.score }));
  group.orders = o.map((x) => ({ ...x.p.order, why: x.why, score: x.score }));
  // Decide by itself only when it is clear: a code match, or a strong name match well ahead of the next one.
  const [a, b] = [...c, ...o].sort((x, y) => y.score - x.score);
  const clear = a && (a.why.includes('一致') || (a.score >= 0.45 && (!b || b.score < a.score * 0.8)));
  if (clear && a.p.order) { group.newOrder = a.p.order; group.why = '注文の一覧の商品名'; }
  else if (clear) { group.productId = a.p.id; group.why = a.why; }
}

// Unregistered orders from ⋯→🔢 (the date-ID order list), as search targets with the order's title.
let orderPool = [];
async function loadOrders() {
  try {
    const v = await api.get('/api/date-ids');
    orderPool = v.days.flatMap((d) => d.orders.filter((x) => !x.productId).map((x) => ({ id: `order:${d.date}:${x.seq}`, name: x.title, order: { date: d.date, title: x.title, dateId: x.dateId, code: x.code } })));
  } catch { orderPool = []; }
}

/** The picture to compare with: the Amazon official image when there is one. */
const officialOf = (p) => p.official || (p.thumbIsReference ? p.thumb : null) || p.browser?.image?.url || p.thumb || null;

export function bulkImportNativePhotos() {
  const picker = h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' } });
  picker.onchange = async () => {
    const files = [...(picker.files || [])];
    picker.remove();
    if (!files.length) return;
    const t = toast(`${files.length}枚を読み込んでいます…`, { ms: 120000 });
    const items = [];
    for (const f of files) {
      try {
        const v = await makeVariants(f);
        items.push({ file: f, v, at: await takenAt(f), url: URL.createObjectURL(v.thumb) });
      } catch (e) {
        showError(e);
      }
    }
    t?.remove?.();
    if (!items.length) return;
    items.sort((a, b) => a.at - b.at);
    openGrouping(items);
  };
  document.body.append(picker);
  picker.click();
}

export function openGrouping(items) {
  let gap = 45;
  let groups = groupByGap(items, gap);
  const body = h('div', { class: 'bulk-groups' });
  const status = h('p', { class: 'muted small' });
  const fmt = (ms) => new Date(ms).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  const name = (id) => (id && state.products.get(id)?.name) || '';

  async function suggestAll() {
    status.textContent = '写真の文字・ラベルから商品を探しています…（Mac で読み取り）';
    let n = 0;
    for (const g of groups) {
      if (g.productId || g.candidates || g.newOrder || g.newName) continue;
      await suggest(g);
      n++;
      paint();
    }
    status.textContent = `${groups.length}組・${items.length}枚。候補を確かめて、違う組は「選ぶ」で直してください。`;
  }

  function choose(g) {
    const input = h('input', { type: 'search', class: 'memo-text', placeholder: '商品名・型番・ID で探す', autofocus: true });
    const list = h('div', { class: 'agent-tasks' });
    const show = () => {
      const terms = termsOf(input.value);
      const pool = [...state.products.values()].filter((p) => !p.trashedAt);
      const hits = terms.length ? pool.map((p) => [searchScore(p, terms), p]).filter(([s]) => s).sort((a, b) => b[0] - a[0]).slice(0, 30).map(([, p]) => p)
        : (g.candidates || []).map((c) => state.products.get(c.id)).filter(Boolean);
      list.replaceChildren(...hits.map((p) => h('button', { class: 'agent-task', onclick: () => { g.productId = p.id; g.why = '選んだ'; g.skip = false; close(); paint(); } }, `#${p.id} ${p.name || ''}`)));
    };
    input.oninput = show;
    let close = () => {};
    sheet((c) => { close = c; return h('div', { class: 'memo-sheet' }, h('h2', null, 'どの商品の写真？'), input, list, h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => c() }, '戻る'))); });
    show();
    input.focus();
  }

  function paint() {
    body.replaceChildren(...groups.map((g, i) => h('div', { class: `bulk-group ${g.skip ? 'skip' : ''}` },
      h('div', { class: 'bulk-head' }, h('b', null, `${i + 1}`), ` ${fmt(g.at[0])}〜 ${g.items.length}枚`),
      h('div', { class: 'bulk-thumbs' }, g.items.slice(0, 8).map((it) => h('img', { src: it.url, alt: '' })), g.items.length > 8 && h('span', { class: 'muted small' }, `+${g.items.length - 8}`)),
      h('div', { class: 'bulk-pick' },
        g.skip ? h('span', { class: 'muted' }, '取り込まない')
          : g.productId ? h('span', null, h('b', null, `#${g.productId} `), name(g.productId), g.why && h('span', { class: 'muted small' }, `（${g.why}）`))
            : h('span', { class: 'muted' }, g.candidates ? ((g.candidates.length || g.orders?.length) ? '下の候補を見比べて選ぶ（大抵は「＋新規」）' : '候補なし') : '探しています…'),
        g.newOrder && h('span', null, h('b', null, '＋新しい商品 '), g.newOrder.title.slice(0, 40), h('span', { class: 'muted small' }, `（注文 ${g.newOrder.date}）`)),
        g.newName && h('span', null, h('b', null, '＋新しい商品 '), g.newName),
        h('button', { class: 'btn small', onclick: () => choose(g) }, '選ぶ'),
        (g.productId || g.newOrder || g.newName) && (g.candidates?.length || g.orders?.length) > 0 && h('button', { class: 'btn small ghost', onclick: () => { Object.assign(g, { productId: null, newOrder: null, newName: null, why: '' }); paint(); } }, '見比べる'),
        h('button', { class: 'btn small', onclick: () => { const n = prompt('新しい商品の名前', g.ocrName || ''); if (n?.trim()) { Object.assign(g, { productId: null, newOrder: null, newName: n.trim(), skip: false, why: '' }); paint(); } } }, '＋新規'),
        h('button', { class: 'btn small ghost', onclick: () => { g.skip = !g.skip; paint(); } }, g.skip ? '戻す' : '使わない')),
      g.fnsku && h('div', { class: 'small muted' }, `Amazon管理番号 ${g.fnsku}${g.productId && state.products.get(g.productId)?.fnsku ? '' : '（取り込むと商品に入ります）'}`),
      !g.skip && !g.productId && !g.newOrder && !g.newName && (g.candidates?.length || g.orders?.length) ? compare(g) : null)));
  }

  /** Candidates side by side: the Amazon image, whether the product already has own photos, and the order-list items not in the 台帳. */
  function compare(g) {
    const tile = (img, title, sub, badge, pick) => h('button', { class: 'bulk-cand', onclick: pick },
      img ? h('img', { src: img, alt: '' }) : h('div', { class: 'bulk-cand-noimg' }, '画像なし'),
      badge, h('div', { class: 'small bulk-cand-name' }, title), h('div', { class: 'muted small' }, sub));
    return h('div', { class: 'bulk-cands' },
      ...(g.candidates || []).map((c) => {
        const p = state.products.get(c.id);
        if (!p) return null;
        const n = p.counts?.actual || 0;
        return tile(officialOf(p), `#${p.id} ${p.name || ''}`, [c.why, p.dateId].filter(Boolean).join('・'),
          h('span', { class: `badge ${n ? 'ok' : 'warn'}` }, n ? `📷 撮影あり ${n}枚` : '撮影なし'),
          () => { Object.assign(g, { productId: p.id, why: '見比べて選んだ', skip: false }); paint(); });
      }),
      ...(g.orders || []).map((o) => tile(null, o.title, `注文 ${o.date}・${o.why}`, h('span', { class: 'badge info' }, '🧾 台帳にない注文'),
        () => { Object.assign(g, { newOrder: o, why: '', skip: false }); paint(); })));
  }

  const gapInput = h('input', { type: 'range', min: 10, max: 300, step: 5, value: gap, oninput: (e) => { gap = Number(e.target.value); gapLabel.textContent = `${gap}秒`; } , onchange: () => { groups = groupByGap(items, gap); paint(); suggestAll(); } });
  const gapLabel = h('span', { class: 'small' }, `${gap}秒`);
  sheet((close) => h('div', { class: 'memo-sheet bulk-sheet' },
    h('h2', null, `📸 純正カメラの写真を取り込む（${items.length}枚）`),
    h('div', { class: 'small', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, '撮影の間があいたら別の商品とみなす:', gapInput, gapLabel),
    status, body,
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: async () => {
        for (const g of groups.filter((x) => !x.skip && !x.productId && (x.newOrder || x.newName))) {
          try {
            const body = g.newOrder ? { name: g.newOrder.title.split(' | ')[0].slice(0, 120), orderDate: g.newOrder.date, notes: `Amazonの商品名: ${g.newOrder.title}\n登録: 純正カメラの写真の取り込み` } : { name: g.newName };
            g.productId = (await api.post('/api/products', body)).product.id;
          } catch (e) { showError(e); }
        }
        const todo = groups.filter((g) => !g.skip && g.productId);
        if (!todo.length) return toast('取り込む組がありません（商品を選んでください）', { error: true });
        let n = 0;
        for (const g of todo) {
          for (const it of g.items) {
            await uploads.enqueue({ productId: g.productId, kind: 'actual', source: 'native-pick', original: it.file, work: it.v.work, thumb: it.v.thumb, width: it.v.width, height: it.v.height, takenAt: new Date(it.at).toISOString() });
            n++;
          }
        }
        const left = groups.filter((g) => !g.skip && !g.productId).length;
        close();
        toast(`${todo.length}商品に${n}枚を取り込みます（送信は自動で続き、Mac が仕上げます）${left ? `。商品を選んでいない ${left}組は取り込んでいません` : ''}`);
      } }, '取り込む'),
      h('button', { class: 'btn ghost', onclick: () => close() }, 'やめる'))), { onClose: () => items.forEach((it) => URL.revokeObjectURL(it.url)) });
  paint();
  loadOrders().then(suggestAll);
}
