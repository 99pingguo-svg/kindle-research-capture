// 商品詳細
import { h, clear, toast, showError, choose, sheet, fmtDate, yen, copyText, isAiActor, actorLabel } from './ui.js';
import { api } from './api.js';
import { state, on, applyProduct, emit } from './state.js';
import { openCamera } from './camera.js';
import { makeVariants, fetchBitmap, renderEdit, editToVariants, DEFAULT_EDIT } from './images.js';
import * as uploads from './uploads.js';

let pane;
let photoTab = 'actual';
let historyOpen = false;
let historyCache = null;

const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const fileUrl = (p, ph, v = 'thumb') => `/files/products/${p.id}/${ph.files[v] || ph.files.work}`;

export function mountDetail() {
  pane = document.getElementById('detail-pane');
  on('detail', () => renderDetail());
  on('uploaded', (ev) => {
    if (ev.productId === state.detailId) reload();
  });
  on('uploads', () => {
    if (state.detailId) renderDetail();
  });
}

export async function showDetail(id) {
  if (state.detailId !== id) {
    photoTab = 'actual';
    historyOpen = false;
    historyCache = null;
    pane.scrollTop = 0;
  }
  state.detailId = id;
  if (!id) {
    state.detail = null;
    renderDetail();
    return;
  }
  if (state.detail?.id !== id) {
    state.detail = null;
    renderDetail();
  }
  await reload();
}

export async function reload() {
  const id = state.detailId;
  if (!id) return;
  try {
    const p = await api.get(`/api/products/${id}`);
    if (state.detailId !== id) return;
    state.detail = p;
    if (historyOpen) historyCache = await api.get(`/api/products/${id}/history`);
    applyProduct(p);
  } catch (e) {
    if (e.status === 404) {
      state.detail = null;
      renderDetail(`商品 ${id} は見つかりません（削除済み）`);
    } else showError(e);
  }
}

async function act(promise, msg) {
  try {
    const r = await promise;
    const full = r?.product?.id ? r.product : r?.id ? r : null;
    if (full) applyProduct(full);
    else await reload();
    if (msg) toast(msg);
    return r;
  } catch (e) {
    showError(e);
  }
}

const P = () => state.detail;
const url = (suffix = '') => `/api/products/${P().id}${suffix}`;

// ---------- render ----------

export function renderDetail(message) {
  if (!pane) return;
  const p = state.detail;
  // Keep focus/caret and any unsaved typing across re-renders (SSE updates from the AI).
  const ae = document.activeElement;
  const keep = ae && pane.contains(ae) && ae.dataset?.path ? { path: ae.dataset.path, value: ae.value, s: ae.selectionStart, e: ae.selectionEnd } : null;
  const scroll = pane.scrollTop;
  clear(pane);
  if (!p) {
    pane.append(h('div', { class: 'detail-empty' }, message || (state.detailId ? '読み込み中…' : h('div', null, '📦', h('div', null, '左の一覧から商品を選択')))));
    if (state.detailId) pane.querySelector('.detail-empty').style.display = 'flex';
    return;
  }
  pane.append(h('div', { class: 'detail' },
    header(p), topControls(p), readinessCard(p), photosCard(p), aiCard(p), listingCard(p), qcCard(p), basicCard(p), linksCard(p), mercariCard(p), historyCard(p)));
  pane.scrollTop = scroll;
  if (keep) {
    const el = pane.querySelector(`[data-path="${CSS.escape(keep.path)}"]`);
    if (el) {
      el.value = keep.value;
      el.focus({ preventScroll: true });
      try {
        el.setSelectionRange(keep.s, keep.e);
      } catch {
        /* selects */
      }
    }
  }
}

function header(p) {
  return h('header', { class: 'topbar', style: { margin: '0 -12px' } },
    h('div', { class: 'detail-head' },
      h('button', { class: 'icon-btn only-mobile', onclick: () => (history.length > 1 ? history.back() : (location.hash = '#/')), 'aria-label': '戻る' }, '‹'),
      h('div', { class: 'name' }, h('span', { class: 'muted', style: { fontWeight: 500, marginRight: '6px' } }, p.id), p.name || '名称未設定'),
      h('button', { class: 'icon-btn', 'aria-label': 'その他', onclick: () => moreMenu(p) }, '⋯')));
}

function topControls(p) {
  const decisions = [['sell', '出品する'], ['hold', '保留'], ['no_sell', '出品しない']];
  return h('div', { class: 'card' },
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
      h('div', { class: 'seg wide', style: { flex: 1 } },
        decisions.map(([v, l]) => h('button', {
          class: `${v} ${p.decision === v ? 'on' : ''}`,
          onclick: () => act(api.post(url('/decision'), { decision: p.decision === v ? 'undecided' : v })),
        }, l))),
      h('button', { class: 'icon-btn cam', 'aria-label': '撮影', onclick: () => openCamera({ ids: [p.id] }) }, '📷')),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px', flexWrap: 'wrap' } },
      h('span', { class: 'badge accent' }, p.summary.status.label),
      p.summary.ai.label && h('span', { class: 'badge ai' }, p.summary.ai.label),
      h('span', { class: 'spacer' }),
      h('label', { class: 'small muted', style: { display: 'flex', alignItems: 'center', gap: '4px' } },
        'ステータス',
        h('select', {
          style: { border: '1px solid var(--border)', borderRadius: '8px', padding: '4px', background: 'var(--card)' },
          onchange: (e) => act(api.post(url('/stage'), { stage: e.target.value })),
        }, state.meta.stages.map((s) => h('option', { value: s.id, selected: p.stage === s.id }, s.label)))),
      h('label', { class: 'small', style: { display: 'flex', alignItems: 'center', gap: '4px' } },
        h('input', { type: 'checkbox', checked: p.shootPlan, onchange: (e) => act(api.post(url('/shoot-plan'), { on: e.target.checked })) }), '撮影予定')));
}

function readinessCard(p) {
  const rd = p.readiness;
  const reqs = p.photoRequests.filter((r) => !r.doneAt && !r.cancelledAt);
  const missing = rd.missing.filter((m) => m.code !== 'photo_requests');
  return h('div', { class: `card ready-box ${rd.ok ? 'ok' : 'ng'}` },
    h('h2', null, rd.ok ? '✅ 出品準備完了' : '出品準備に必要なこと'),
    reqs.length > 0 && h('div', { style: { marginBottom: '8px' } },
      h('h3', { style: { marginTop: 0 } }, '追加撮影の依頼'),
      reqs.map((r) => h('div', { class: 'req-row' },
        h('div', { class: 'label' }, r.label, h('span', { class: 'reason' }, [r.reason, isAiActor(r.by) && `${actorLabel(r.by)}より`].filter(Boolean).join(' — '))),
        h('button', { class: 'icon-btn cam', style: { width: '46px', height: '46px' }, onclick: () => openCamera({ ids: [p.id], tag: r.label, requestId: r.id }) }, '📷'),
        h('button', { class: 'btn small ghost', onclick: () => act(api.patch(url(`/photo-requests/${r.id}`), { cancel: true })) }, '不要')))),
    missing.length > 0 && h('ul', { class: 'missing' }, missing.map((m) => h('li', null, m.message,
      m.code.startsWith('unconfirmed:') && h('button', { class: 'btn small', onclick: () => act(api.patch(url(), { confirm: [m.field] }), '確定しました') }, 'この値で確定')))),
    rd.warnings.length > 0 && h('ul', { class: 'missing', style: { marginTop: '6px' } }, rd.warnings.map((w) => h('li', { class: 'w small muted' }, w.message))),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn small', onclick: () => {
        const label = prompt('撮影してほしい箇所（例: 背面、型番ラベル）');
        if (label) act(api.post(url('/photo-requests'), { label }));
      } }, '＋ 撮影依頼を追加')));
}

// ---------- photos ----------

function photosCard(p) {
  const live = p.photos.filter((x) => !x.deletedAt);
  const actual = live.filter((x) => x.kind === 'actual');
  const refs = live.filter((x) => x.kind === 'reference');
  const trash = p.photos.filter((x) => x.deletedAt);
  const byId = new Map(live.map((x) => [x.id, x]));
  const listing = p.listingPhotoIds.map((id) => byId.get(id)).filter(Boolean);
  const order = new Map(p.listingPhotoIds.map((id, i) => [id, i + 1]));
  const pending = uploads.pendingFor(p.id);

  const tile = (ph, extra) => h('button', { class: `ph ${ph.kind === 'reference' ? 'ref' : ''}`, onclick: () => photoSheet(p, ph) },
    h('img', { src: fileUrl(p, ph), loading: 'lazy', alt: ph.tag || '' }),
    order.get(ph.id) && h('span', { class: 'order' }, order.get(ph.id)),
    (ph.tag || ph.derivedFrom) && h('span', { class: 'tag' }, [ph.derivedFrom && '編集', ph.tag].filter(Boolean).join('・')),
    extra);
  const pendingTile = (x) => h('button', { class: 'ph', onclick: async () => {
    const v = await choose(x.error ? `送信失敗: ${x.error}` : 'アップロード待ち', [{ label: '再送', value: 'r' }, { label: '破棄', value: 'd', danger: true }]);
    if (v === 'r') uploads.retryFailed();
    if (v === 'd') uploads.discard(x.qid);
  } }, h('img', { src: x.url }), h('span', { class: 'pending' }, x.error ? '⚠ 失敗' : '↑ 送信中'));

  const tabs = [
    ['actual', `現物写真 ${actual.length}`],
    ['listing', `出品用 ${listing.length}`],
    ['reference', `参考資料 ${refs.length}`],
    ...(trash.length ? [['trash', `削除済み ${trash.length}`]] : []),
  ];
  let grid;
  if (photoTab === 'actual') grid = [...pending.filter((x) => x.kind === 'actual').map(pendingTile), ...actual.map((ph) => tile(ph))];
  else if (photoTab === 'listing') grid = listing.map((ph) => tile(ph));
  else if (photoTab === 'reference') grid = [...pending.filter((x) => x.kind === 'reference').map(pendingTile), ...refs.map((ph) => tile(ph))];
  else grid = trash.map((ph) => tile(ph, h('span', { class: 'pending' }, '削除済み')));

  const libInput = h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' }, onchange: (e) => addFiles(p.id, e.target.files, 'actual', 'library') });
  const refInput = h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' }, onchange: (e) => addFiles(p.id, e.target.files, 'reference', 'reference') });
  const hint = {
    actual: 'あなたが撮影した現物。番号付きが出品用（タップで出し入れ・編集）。',
    listing: 'メルカリにアップロードする写真と順番（1枚目がサムネイル）。現物写真からのみ選べます。',
    reference: '公式・購入ページ等の参考画像。AIの確認用で、メルカリには使いません。',
    trash: '削除した写真。タップで復元できます。',
  }[photoTab];
  return h('div', { class: 'card' },
    h('h2', null, '写真', h('span', { class: 'spacer' }), p.locks.listingPhotos && h('button', { class: 'lock on', title: '出品用写真の構成を確定済み（AIは提案のみ）', onclick: () => act(api.patch(url(), { unlock: ['listingPhotos'] }), 'AIが出品用写真を変更できるようにしました') }, '🔒 構成確定')),
    h('div', { class: 'tabs' }, tabs.map(([id, label]) => h('button', { class: `chip ${photoTab === id ? 'on' : ''}`, onclick: () => { photoTab = id; renderDetail(); } }, label))),
    h('p', { class: 'muted small', style: { margin: '0 0 8px' } }, hint),
    proposalBox(p, 'listingPhotos'),
    grid.length ? h('div', { class: 'photo-grid' }, grid) : h('div', { class: 'muted small', style: { padding: '12px 0' } }, 'まだありません'),
    h('div', { class: 'photo-actions' },
      photoTab === 'reference'
        ? [h('button', { class: 'btn small', onclick: () => refInput.click() }, '＋ 参考画像を追加')]
        : [h('button', { class: 'btn small primary', onclick: () => openCamera({ ids: [p.id] }) }, '📷 撮影'),
          h('button', { class: 'btn small', onclick: () => libInput.click() }, '🖼 写真を追加')]),
    libInput, refInput);
}

async function addFiles(productId, fileList, kind, source) {
  const files = [...(fileList || [])];
  for (const f of files) {
    try {
      const v = await makeVariants(f);
      await uploads.enqueue({ productId, kind, source, original: f, work: v.work, thumb: v.thumb, width: v.width, height: v.height, takenAt: new Date(f.lastModified || Date.now()).toISOString() });
    } catch (e) {
      showError(e);
    }
  }
  if (files.length) toast(`${files.length}枚を追加しました`);
}

function photoSheet(p, ph) {
  const inListing = p.listingPhotoIds.includes(ph.id);
  const idx = p.listingPhotoIds.indexOf(ph.id);
  const setListing = (ids) => act(api.put(url('/listing-photos'), { ids }));
  const src = p.photos.find((x) => x.id === ph.derivedFrom);
  sheet((close) => {
    const b = (label, fn, cls = '') => h('button', { class: `btn ${cls}`, onclick: async () => { close(); await fn(); } }, label);
    const actions = [];
    if (ph.deletedAt) actions.push(b('復元する', () => act(api.post(url(`/photos/${ph.id}/restore`)), '復元しました'), 'primary'));
    else if (ph.kind === 'actual') {
      if (inListing) {
        if (idx > 0) actions.push(b('出品用の1枚目（サムネイル）にする', () => setListing([ph.id, ...p.listingPhotoIds.filter((x) => x !== ph.id)])));
        if (idx > 0) actions.push(b('← 順番を前へ', () => { const ids = [...p.listingPhotoIds]; [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]]; return setListing(ids); }));
        if (idx < p.listingPhotoIds.length - 1) actions.push(b('順番を後ろへ →', () => { const ids = [...p.listingPhotoIds]; [ids[idx + 1], ids[idx]] = [ids[idx], ids[idx + 1]]; return setListing(ids); }));
        actions.push(b('出品用から外す', () => setListing(p.listingPhotoIds.filter((x) => x !== ph.id))));
      } else actions.push(b('出品用に追加', () => setListing([...p.listingPhotoIds, ph.id]), 'primary'));
      actions.push(b('✂️ 編集（元写真は残ります）', () => editor(p, ph)));
      actions.push(b('タグを変更', async () => {
        const t = await choose('タグ', [{ label: '（なし）', value: '' }, ...state.meta.photoTags.map((x) => ({ label: x, value: x }))]);
        if (t !== undefined) await act(api.patch(url(`/photos/${ph.id}`), { tag: t }));
      }));
      actions.push(b('参考資料画像に変更', () => act(api.patch(url(`/photos/${ph.id}`), { kind: 'reference' }))));
      actions.push(b('削除（ゴミ箱へ）', () => act(api.del(url(`/photos/${ph.id}`)), '削除しました（写真タブ「削除済み」から復元可）'), 'danger'));
    } else {
      actions.push(b('現物写真に変更（自分で撮った写真の場合のみ）', () => act(api.patch(url(`/photos/${ph.id}`), { kind: 'actual' }))));
      actions.push(b('削除（ゴミ箱へ）', () => act(api.del(url(`/photos/${ph.id}`))), 'danger'));
    }
    return h('div', null,
      h('img', { class: 'big-img', src: fileUrl(p, ph, 'work') }),
      h('p', { class: 'small muted' },
        `${ph.kind === 'actual' ? (ph.derivedFrom ? '編集版の現物写真' : '現物写真') : '参考資料画像（出品不可）'}`,
        ph.tag && ` ・ ${ph.tag}`, ` ・ ${actorLabel(ph.by)} ${fmtDate(ph.createdAt)}`,
        ph.sourceUrl && h('span', null, ' ・ ', h('a', { href: ph.sourceUrl, target: '_blank', rel: 'noopener' }, '出典')),
        ' ・ ', h('a', { href: fileUrl(p, ph, 'original'), target: '_blank' }, '元画像'),
        src && h('span', null, ' ・ ', h('a', { href: fileUrl(p, src, 'work'), target: '_blank' }, '編集前'))),
      h('div', { class: 'actions' }, actions, h('button', { class: 'btn ghost', onclick: () => close() }, '閉じる')));
  });
}

async function editor(p, ph) {
  let bmp;
  try {
    bmp = await fetchBitmap(fileUrl(p, ph, 'work'));
  } catch (e) {
    return showError(e);
  }
  const params = { ...DEFAULT_EDIT };
  const inListing = p.listingPhotoIds.includes(ph.id);
  sheet((close) => {
    const canvas = h('canvas');
    const preview = () => {
      const c = renderEdit(bmp, params, 900);
      canvas.width = c.width;
      canvas.height = c.height;
      canvas.getContext('2d').drawImage(c, 0, 0);
    };
    let raf;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(preview);
    };
    const slider = (key, label, min, max) => {
      const out = h('span', { class: 'small muted' }, params[key]);
      return h('label', { class: 'slider' }, label,
        h('input', { type: 'range', min, max, value: params[key], oninput: (e) => { params[key] = Number(e.target.value); out.textContent = params[key]; schedule(); } }), out);
    };
    const toggle = (key, label) => h('button', { class: `btn small ${params[key] ? 'primary' : ''}`, onclick: (e) => { params[key] = !params[key]; e.currentTarget.classList.toggle('primary', params[key]); schedule(); } }, label);
    const replace = h('input', { type: 'checkbox', checked: inListing });
    setTimeout(preview);
    return h('div', { class: 'editor' },
      h('h2', null, '写真を編集'),
      canvas,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn small', onclick: () => { params.rotate -= 90; schedule(); } }, '↺ 左回転'),
        h('button', { class: 'btn small', onclick: () => { params.rotate += 90; schedule(); } }, '↻ 右回転'),
        toggle('auto', '✨ 自動補正'),
        toggle('square', '□ 正方形')),
      slider('brightness', '明るさ', -80, 80),
      slider('contrast', 'コントラスト', -80, 80),
      slider('saturation', '彩度', -80, 80),
      inListing && h('label', { class: 'small', style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '10px' } }, replace, '出品用の元写真をこの編集版に差し替える'),
      h('p', { class: 'small muted' }, '保存すると新しい写真として追加されます。元写真はそのまま残ります。'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            const v = await editToVariants(bmp, params);
            await uploads.enqueue({ productId: p.id, kind: 'actual', source: 'edit', derivedFrom: ph.id, edit: { ...params }, replaceInListing: replace.checked, ...v });
            close();
            toast('編集版を保存しました');
          } catch (e) {
            showError(e);
          }
        } }, '編集版を保存'),
        h('button', { class: 'btn ghost', onclick: () => close() }, 'キャンセル')));
  });
}

// ---------- fields ----------

function proposalBox(p, path) {
  const pr = p.proposals[path];
  if (!pr) return null;
  const def = state.meta.fields.find((f) => f.path === path);
  const shown = path === 'listingPhotos' ? `${pr.value.length}枚の構成: ${pr.value.map((id) => (p.listingPhotoIds.includes(id) ? '' : '新') + (p.photos.find((x) => x.id === id)?.tag || '写真')).join(' / ')}` : def?.type === 'int' ? yen(pr.value) : String(pr.value);
  return h('div', { class: 'proposal', style: { marginBottom: '8px' } },
    h('div', null, `🤖 ${actorLabel(pr.by)}の提案`, pr.reason && `（${pr.reason}）`),
    h('div', { class: 'pv' }, shown),
    h('div', { style: { display: 'flex', gap: '6px' } },
      h('button', { class: 'btn small primary', onclick: () => act(api.post(url(`/proposals/${encodeURIComponent(path)}/accept`)), '採用しました') }, '採用'),
      h('button', { class: 'btn small', onclick: () => act(api.post(url(`/proposals/${encodeURIComponent(path)}/reject`))) }, '却下')));
}

function fieldEl(p, def, { copy = false } = {}) {
  const value = getPath(p, def.path);
  const locked = !!p.locks[def.path];
  const save = (raw) => {
    const v = def.type === 'int' ? (raw === '' ? null : raw) : raw;
    if (String(v ?? '') === String(value ?? '')) {
      if (def.confirm && !locked && v != null && v !== '') return act(api.patch(url(), { confirm: [def.path] }));
      return;
    }
    act(api.patch(url(), { set: { [def.path]: v } }));
  };
  let input;
  const common = { 'data-path': def.path, onchange: (e) => save(e.target.value) };
  if (def.type === 'textarea') input = h('textarea', { ...common, rows: def.path === 'listing.description' ? 10 : 3 }, value ?? '');
  else if (def.type === 'select') {
    input = h('select', common, h('option', { value: '' }, '—'), def.options.map((o) => h('option', { value: o, selected: value === o }, o)));
  } else input = h('input', { ...common, type: def.type === 'int' ? 'text' : 'text', inputmode: def.type === 'int' ? 'numeric' : undefined, value: value ?? '', placeholder: def.hint || '' });

  const counter = def.max ? h('span', { class: 'counter' }) : null;
  const updateCounter = () => {
    if (!counter) return;
    const n = (input.value || '').length;
    counter.textContent = `${n}/${def.max}`;
    counter.classList.toggle('over', n > def.max);
  };
  input.addEventListener('input', updateCounter);
  updateCounter();

  let lockBtn = null;
  if (def.confirm) {
    lockBtn = locked
      ? h('button', { class: 'lock on', onclick: () => act(api.patch(url(), { unlock: [def.path] })) }, '🔒 確定済み')
      : value != null && value !== ''
        ? h('button', { class: 'lock need', onclick: () => act(api.patch(url(), { confirm: [def.path] }), '確定しました') }, '未確認 → 確定する')
        : h('span', { class: 'lock need' }, '要入力・確定');
  } else if (locked) {
    lockBtn = h('button', { class: 'lock on', title: 'あなたが確定した値。AIは上書きせず提案します。タップで解除', onclick: () => act(api.patch(url(), { unlock: [def.path] })) }, '🔒');
  }
  return h('div', { class: `field ${locked ? 'locked' : ''}`, style: def.type === 'textarea' ? { gridColumn: '1 / -1' } : null },
    h('div', { class: 'field-label' },
      h('span', null, def.label), counter, h('span', { class: 'spacer' }), lockBtn,
      copy && value != null && value !== '' && h('button', { class: 'lock', onclick: () => copyText(String(value), `${def.label}をコピー`) }, 'コピー')),
    input,
    proposalBox(p, def.path));
}

// ---------- AI ----------

function aiCard(p) {
  const active = p.aiTasks.filter((t) => ['pending', 'processing'].includes(t.status));
  const last = p.aiTasks.filter((t) => !['pending', 'processing'].includes(t.status)).slice(-3).reverse();
  const req = (type) => act(api.post(url('/ai-tasks'), { type }), 'AIに依頼しました（MacのClaudeが処理します）');
  const conf = Object.fromEntries(state.meta.factConfidence.map((c) => [c.id, c.label]));
  return h('div', { class: 'card' },
    h('h2', null, '🤖 AI整理'),
    h('div', { class: 'row-actions', style: { marginTop: 0 } },
      h('button', { class: 'btn small primary', onclick: () => req('full') }, 'まとめて依頼'),
      h('button', { class: 'btn small', onclick: () => req('organize') }, '商品整理'),
      h('button', { class: 'btn small', onclick: () => req('draft') }, '原稿作成'),
      h('button', { class: 'btn small', onclick: () => req('qc') }, 'QC'),
      h('button', { class: 'btn small', onclick: () => req('price') }, '価格調査')),
    active.length > 0 && h('ul', { class: 'timeline', style: { marginTop: '8px' } }, active.map((t) => h('li', null,
      h('div', { class: 'meta' }, h('span', { class: 'badge ai' }, t.status === 'processing' ? '⏳ 処理中' : '待ち'), state.meta.aiTaskTypes.find((x) => x.id === t.type)?.label, fmtDate(t.requestedAt),
        h('span', { class: 'spacer' }), h('button', { class: 'btn small ghost', onclick: () => act(api.del(url(`/ai-tasks/${t.id}`))) }, '取消'))))),
    last.length > 0 && h('div', { class: 'small muted', style: { marginTop: '6px' } }, last.map((t) => h('div', null,
      `${t.status === 'error' ? '⚠' : '✓'} ${state.meta.aiTaskTypes.find((x) => x.id === t.type)?.label} ${fmtDate(t.finishedAt)}${t.message ? ` — ${t.message}` : ''}`))),
    h('h3', null, '整理された情報'),
    p.facts.length
      ? h('table', { class: 'facts' }, p.facts.map((f) => h('tr', null,
        h('td', { class: 'k' }, f.label),
        h('td', null,
          h('div', null, f.value || h('span', { class: 'muted' }, '—'), ' ', h('button', { class: `conf ${f.confidence}`, onclick: () => factSheet(p, f) }, conf[f.confidence] || f.confidence)),
          f.source && h('div', { class: 'small muted' }, `根拠: ${f.source}`),
          f.proposal && h('div', { class: 'proposal', style: { marginTop: '4px' } },
            `🤖 提案: ${f.proposal.value}（${conf[f.proposal.confidence]}）`,
            h('div', { style: { display: 'flex', gap: '6px', marginTop: '4px' } },
              h('button', { class: 'btn small primary', onclick: () => act(api.post(url(`/facts/${encodeURIComponent(f.key)}/accept`))) }, '採用'),
              h('button', { class: 'btn small', onclick: () => act(api.post(url(`/facts/${encodeURIComponent(f.key)}/reject`))) }, '却下')))))))
      : h('p', { class: 'muted small' }, 'AIが写真・URL・メモから型番や付属品などを整理すると、確度（確定／参考情報／要確認／不明）付きでここに表示されます。'),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn small', onclick: () => factSheet(p, null) }, '＋ 情報を追加')));
}

function factSheet(p, f) {
  sheet((close) => {
    const label = h('input', { type: 'text', value: f?.label || '', placeholder: '例: 付属品' });
    const value = h('input', { type: 'text', value: f?.value || '' });
    const conf = h('select', null, state.meta.factConfidence.map((c) => h('option', { value: c.id, selected: (f?.confidence || 'confirmed') === c.id }, c.label)));
    return h('div', null,
      h('h2', null, f ? `「${f.label}」を編集` : '情報を追加'),
      !f && h('label', { class: 'field' }, h('span', { class: 'field-label' }, '項目名'), label),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '値'), value),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '確度'), conf),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: async () => {
          const key = f?.key || label.value.trim();
          if (!key) return toast('項目名を入力してください');
          await act(api.put(url('/facts'), { facts: [{ key, label: f?.label || key, value: value.value, confidence: conf.value, source: 'ユーザー入力' }] }));
          close();
        } }, '保存'),
        f && h('button', { class: 'btn danger', onclick: async () => { await act(api.del(url(`/facts/${encodeURIComponent(f.key)}`))); close(); } }, '削除'),
        h('button', { class: 'btn ghost', onclick: () => close() }, 'キャンセル')));
  });
}

function listingCard(p) {
  const defs = state.meta.fields.filter((f) => f.group === 'listing');
  const main = defs.filter((f) => ['listing.title', 'listing.description', 'listing.price', 'listing.condition', 'listing.category', 'listing.brand'].includes(f.path));
  const ship = defs.filter((f) => f.path.startsWith('listing.shipping'));
  const notes = defs.find((f) => f.path === 'listing.aiNotes');
  const cands = p.listing.priceCandidates || [];
  const text = [`${p.listing.title}`, '', p.listing.description, '', `価格: ${p.listing.price ?? ''}`].join('\n');
  return h('div', { class: 'card' },
    h('h2', null, '🏷 出品原稿', h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: () => copyText(text, 'タイトル・説明・価格をコピー') }, '全部コピー')),
    main.map((d) => fieldEl(p, d, { copy: true })),
    cands.length > 0 && h('div', { class: 'field' },
      h('div', { class: 'field-label' }, '価格候補（AI調査）'),
      cands.map((c) => h('div', { class: 'req-row' },
        h('div', { class: 'label' }, yen(c.price), h('span', { class: 'reason' }, c.basis, c.source && h('span', null, ' ', /^https?:/.test(c.source) ? h('a', { href: c.source, target: '_blank', rel: 'noopener' }, '根拠') : c.source))),
        h('button', { class: 'btn small', onclick: () => act(api.patch(url(), { set: { 'listing.price': c.price } }), `${yen(c.price)} に確定`) }, 'この価格で確定')))),
    h('h3', null, '配送'),
    h('div', { class: 'grid2' }, ship.map((d) => fieldEl(p, d))),
    notes && (p.listing.aiNotes ? fieldEl(p, notes) : null),
    h('div', { class: 'row-actions' },
      h('a', { class: 'btn small', href: 'https://jp.mercari.com/sell/create', target: '_blank', rel: 'noopener' }, 'メルカリ出品画面を開く（手動入力用）')));
}

function qcCard(p) {
  const qc = p.qc;
  const lintWarn = p.lint.filter((x) => x.severity !== 'info');
  const icon = { pass: '✅', warn: '⚠️', fail: '❌', na: '—' };
  const checkList = (items) => h('ul', { class: 'checks' }, items.map((c) => h('li', null, h('span', null, icon[c.result] || '•'), h('span', null, c.label), c.note && h('span', { class: 'note' }, c.note))));
  return h('div', { class: 'card' },
    h('h2', null, '🔍 AI QC',
      qc && h('span', { class: `badge ${qc.result === 'pass' && qc.rev === p.rev ? 'ok' : 'warn'}` }, qc.rev !== p.rev ? '再QCが必要' : qc.result === 'pass' ? 'QC PASS' : qc.result === 'fail' ? 'NG' : '要確認')),
    qc
      ? h('div', null,
        h('p', { style: { margin: '0 0 6px' } }, qc.summary),
        h('div', { class: 'small muted' }, `${actorLabel(qc.by)}・モデル ${qc.model || '不明'}・${fmtDate(qc.at)}`),
        qc.issues.length > 0 && h('ul', { class: 'missing', style: { marginTop: '8px' } }, qc.issues.map((i) => h('li', { class: i.severity === 'info' ? 'w' : '' }, i.message))),
        qc.checks.some((c) => c.group === 'image') && [h('h3', null, '画像QC（画質・整合性・違和感）'), checkList(qc.checks.filter((c) => c.group === 'image'))],
        qc.checks.some((c) => c.group !== 'image') && [h('h3', null, '内容チェック'), checkList(qc.checks.filter((c) => c.group !== 'image'))])
      : h('p', { class: 'muted small' }, `QCはAI（${(state.meta.settings.imageQcModels || []).join(', ')}）が写真を実際に見て実施します。「AI整理」の「QC」で依頼できます。`),
    lintWarn.length > 0 && [h('h3', null, '機械チェック'), h('ul', { class: 'missing' }, lintWarn.map((w) => h('li', { class: w.severity === 'error' ? '' : 'w' }, w.message)))]);
}

function basicCard(p) {
  const defs = state.meta.fields.filter((f) => f.group === 'basic');
  return h('div', { class: 'card' }, h('h2', null, '基本情報'), h('div', { class: 'grid2' }, defs.map((d) => fieldEl(p, d))));
}

function linksCard(p) {
  const types = Object.fromEntries(state.meta.linkTypes.map((t) => [t.id, t.label]));
  const urlIn = h('input', { type: 'url', placeholder: 'https://…', style: { flex: 1, minWidth: 0, border: '1px solid var(--border)', borderRadius: '10px', padding: '8px 10px', background: 'var(--bg)' } });
  const typeSel = h('select', { style: { border: '1px solid var(--border)', borderRadius: '10px', background: 'var(--bg)' } }, h('option', { value: '' }, '自動'), state.meta.linkTypes.map((t) => h('option', { value: t.id }, t.label)));
  return h('div', { class: 'card' },
    h('h2', null, '🔗 参考URL・資料'),
    p.links.length ? h('ul', { class: 'timeline' }, p.links.map((l) => h('li', null,
      h('div', { class: 'meta' }, h('span', { class: 'badge' }, types[l.type] || l.type), isAiActor(l.by) && h('span', { class: 'who-ai' }, '🤖'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn small ghost', onclick: async () => {
          const t = await choose('種別', state.meta.linkTypes.map((x) => ({ label: x.label, value: x.id })));
          if (t) act(api.patch(url(`/links/${l.id}`), { type: t }));
        } }, '種別'),
        h('button', { class: 'btn small ghost danger', onclick: async () => { if (await choose('このURLを削除しますか？', [{ label: '削除', value: true, danger: true }])) act(api.del(url(`/links/${l.id}`))); } }, '削除')),
      h('a', { href: l.url, target: '_blank', rel: 'noopener', style: { wordBreak: 'break-all' } }, l.title || l.url),
      l.note && h('div', { class: 'small muted' }, l.note)))) : h('p', { class: 'muted small' }, '購入ページ・公式ページ・取扱説明書などを登録するとAIが参照します。'),
    h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } }, urlIn, typeSel,
      h('button', { class: 'btn small primary', onclick: () => urlIn.value.trim() && act(api.post(url('/links'), { url: urlIn.value.trim(), type: typeSel.value || undefined }), 'URLを追加しました') }, '追加')));
}

function mercariCard(p) {
  const m = p.channels.mercari || {};
  const st = {
    entered: 'メルカリ入力済み（転記QC待ち）', transfer_ok: '転記QC PASS', transfer_ng: '転記QC NG', listed: '出品中', sold: '売却済み', stopped: '出品停止',
  }[m.status] || '未連携';
  const mm = m.transferQc;
  const fieldsLabel = { title: '商品名', description: '説明', category: 'カテゴリー', brand: 'ブランド', condition: '状態', price: '価格', shippingPayer: '送料負担', shippingMethod: '配送方法', shippingFrom: '発送元', shippingDays: '発送日数', photoCount: '写真枚数', photoOrderOk: '写真順', photosMatchProduct: '写真の同一性', productMatches: '商品の同一性', rev: 'データ更新' };
  const outOfSync = m.enteredRev && m.enteredRev !== p.rev && ['mercari_entered', 'final_check', 'listed'].includes(p.stage);
  const btns = [];
  if (p.stage === 'ready') btns.push(h('button', { class: 'btn primary', onclick: () => act(api.post(url('/stage'), { stage: 'queued' }), '出品待ちにしました（AIがメルカリへ下書き入力します）') }, '🛒 メルカリ転記を依頼'));
  if (p.stage === 'queued') btns.push(h('button', { class: 'btn', onclick: () => act(api.post(url('/stage'), { stage: 'ready' })) }, '転記依頼を取り消す'));
  if (m.status === 'transfer_ok' && !m.publishApproved) btns.push(h('button', { class: 'btn primary', onclick: async () => {
    if (await choose('メルカリ下書きの内容を確認しましたか？承認するとAIが「出品する」を押せるようになります。', [{ label: '確認した・公開を承認', value: true, primary: true }])) act(api.post(url('/mercari/approve')), '公開を承認しました');
  } }, '✅ 公開を承認'));
  if (m.publishApproved && p.stage !== 'listed' && p.stage !== 'sold') btns.push(h('button', { class: 'btn', onclick: () => act(api.post(url('/mercari/approve'), { approved: false })) }, '公開承認を取り消す'));
  if (['mercari_entered', 'final_check', 'queued', 'ready'].includes(p.stage)) btns.push(h('button', { class: 'btn', onclick: () => {
    const itemUrl = prompt('メルカリ商品ページのURL（任意）', m.itemUrl || '');
    if (itemUrl !== null) act(api.post(url('/mercari/listed'), { itemUrl }), '出品中にしました');
  } }, '自分で公開した'));
  if (p.stage === 'listed') {
    btns.push(h('button', { class: 'btn primary', onclick: () => {
      const price = prompt('売却価格', m.listedPrice ?? p.listing.price ?? '');
      if (price !== null) act(api.post(url('/mercari/sold'), { price: price ? Number(price.replace(/[^\d]/g, '')) : null }), '売却済みにしました');
    } }, '売れた'));
    btns.push(h('button', { class: 'btn', onclick: () => act(api.post(url('/mercari/stopped'))) }, '出品停止した'));
  }
  return h('div', { class: 'card' },
    h('h2', null, '🛒 メルカリ', h('span', { class: `badge ${m.status === 'transfer_ng' ? 'danger' : m.status ? 'accent' : ''}` }, st)),
    outOfSync && h('div', { class: 'proposal', style: { borderColor: 'var(--warn)', background: 'var(--warn-weak)', marginBottom: '8px' } }, '⚠ メルカリ入力後に商品データが変更されています。メルカリ側の再入力が必要です。'),
    h('dl', { class: 'kv' },
      m.enteredAt && [h('dt', null, '入力'), h('dd', null, `${fmtDate(m.enteredAt)}（${m.savedAs === 'draft' ? '下書き' : m.savedAs || ''}）`)],
      m.draftUrl && [h('dt', null, '下書き'), h('dd', null, h('a', { href: m.draftUrl, target: '_blank', rel: 'noopener' }, m.draftUrl))],
      m.itemUrl && [h('dt', null, '商品ページ'), h('dd', null, h('a', { href: m.itemUrl, target: '_blank', rel: 'noopener' }, m.itemUrl))],
      m.listedAt && [h('dt', null, '出品日時'), h('dd', null, `${fmtDate(m.listedAt)} ${yen(m.listedPrice)}`)],
      m.soldAt && [h('dt', null, '売却'), h('dd', null, `${fmtDate(m.soldAt)} ${yen(m.soldPrice)}`)],
      m.publishApproved && [h('dt', null, '公開承認'), h('dd', null, fmtDate(m.publishApproved.at))]),
    mm && h('div', { style: { marginTop: '8px' } },
      h('div', { class: 'small' }, `転記QC: ${mm.result === 'pass' ? '✅ PASS' : '❌ NG'}（${actorLabel(mm.by)} ${fmtDate(mm.at)}）`),
      [...(mm.mismatches || []), ...(mm.unchecked || []).map((u) => ({ field: u, unchecked: true }))].length > 0 && h('ul', { class: 'missing', style: { marginTop: '4px' } },
        (mm.mismatches || []).map((x) => h('li', { class: 'small' }, `${fieldsLabel[x.field] || x.field}: 期待「${String(x.expected).slice(0, 40)}」/ 画面「${String(x.observed).slice(0, 40)}」`)),
        (mm.unchecked || []).map((u) => h('li', { class: 'small w' }, `${fieldsLabel[u] || u}: 未確認`)))),
    btns.length > 0 && h('div', { class: 'row-actions' }, btns),
    !m.status && p.stage !== 'ready' && p.stage !== 'queued' && h('p', { class: 'muted small' }, '出品準備完了になると、AIによるメルカリへの下書き入力を依頼できます。'));
}

function historyCard(p) {
  return h('div', { class: 'card' },
    h('h2', null, '🕘 変更履歴', h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: async () => {
        historyOpen = !historyOpen;
        if (historyOpen) historyCache = await api.get(url('/history')).catch(showError);
        renderDetail();
      } }, historyOpen ? '閉じる' : '表示')),
    historyOpen && historyCache && h('ul', { class: 'timeline' }, historyCache.map((e) => h('li', null,
      h('div', { class: 'meta' },
        h('span', { class: isAiActor(e.actor) ? 'who-ai' : 'who-user' }, isAiActor(e.actor) ? `🤖 ${actorLabel(e.actor)}` : `👤 ${actorLabel(e.actor)}`),
        h('span', null, fmtDate(e.at)), h('span', { class: 'spacer' }),
        e.revertible && h('button', { class: 'btn small ghost', onclick: async () => {
          if (await choose(`「${e.summary}」より前の状態に戻しますか？（それ以降の内容変更も戻ります。写真は消えません）`, [{ label: 'この変更の前に戻す', value: true, danger: true }])) {
            await act(api.post(url('/revert'), { historyId: e.id }), '復元しました');
            historyCache = await api.get(url('/history')).catch(() => historyCache);
            renderDetail();
          }
        } }, '戻す')),
      h('div', null, e.summary),
      e.changes?.length > 1 && h('div', { class: 'chg' }, e.changes.map((c) => `${c.label}: ${fmt(c.from)} → ${fmt(c.to)}`).join('\n'))))));
}

const fmt = (v) => (v == null || v === '' ? '（空）' : String(v).replace(/\s+/g, ' ').slice(0, 40));

async function moreMenu(p) {
  const opts = [
    { label: '🔎 重複チェック', value: 'dup' },
    { label: '📦 この商品を書き出し（ZIP）', value: 'export' },
    p.archived ? { label: 'アーカイブから戻す', value: 'unarchive' } : { label: 'アーカイブ', value: 'archive' },
  ];
  if (p.trashedAt) opts.push({ label: 'ゴミ箱から復元', value: 'restore' }, { label: '完全に削除…', value: 'purge', danger: true });
  else opts.push({ label: 'ゴミ箱へ移動', value: 'trash', danger: true });
  const v = await choose(`${p.id} ${p.name || ''}`, opts);
  if (v === 'dup') {
    const d = await api.get(url('/duplicates')).catch(showError);
    if (d) toast(d.length ? d.map((x) => `⚠ #${x.id} ${x.name}（${x.reasons.join('・')}）`).join('\n') : '重複の可能性がある商品はありません', { ms: 6000 });
  } else if (v === 'export') location.href = `/api/export.zip?ids=${p.id}`;
  else if (v === 'archive' || v === 'unarchive') act(api.post(url('/archive'), { archived: v === 'archive' }));
  else if (v === 'trash') act(api.post(url('/trash')), 'ゴミ箱へ移動しました（復元できます）');
  else if (v === 'restore') act(api.post(url('/restore')), '復元しました');
  else if (v === 'purge') {
    const typed = prompt(`完全に削除します。写真・履歴もすべて消え、元に戻せません。\n確認のため商品ID「${p.id}」を入力してください。`);
    if (typed === null) return;
    try {
      await api.del(`/api/products/${p.id}?confirm=${encodeURIComponent(typed)}`);
      state.products.delete(p.id);
      toast('完全に削除しました');
      emit('list');
      location.hash = '#/';
    } catch (e) {
      showError(e);
    }
  }
}
