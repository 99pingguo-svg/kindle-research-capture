// 純正カメラ連携（いちばん簡単な形）: Webアプリから iPhone の「カメラ」アプリを開き（ショートカット「台帳カメラ」はカメラを開くだけ）、
// 好きなモード・スタイルで撮って台帳に戻ったら、「撮った写真から登録」で iPhone の写真選択から選んだ写真をその商品の写真にする。
// ショートカットは写真を送らない・消さない・合言葉も持たない（以前の自動送信は iPhone で動かなかったため）。
import { h, toast, showError, sheet } from './ui.js';
import { api } from './api.js';
import { state, on } from './state.js';
import { makeVariants } from './images.js';
import * as uploads from './uploads.js';
import { takenAt } from './photo-time.js';

const KEY = 'daicho.native';
const NAMES_KEY = 'daicho.nativeNames';
const DEFAULT_NAMES = { camera: '台帳カメラ' };
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
// (「台帳で撮る」 was the short-lived auto-send version: fall back to the camera-only shortcut)
export const shortcutNames = () => { const n = { ...DEFAULT_NAMES, ...read(NAMES_KEY, {}) }; if (!n.camera || n.camera === '台帳で撮る') n.camera = DEFAULT_NAMES.camera; return n; };
const session = () => {
  const s = read(KEY, null);
  return s && Date.now() - s.at < 3 * 3600_000 ? s : null;
};

/** Open the iPhone Camera app for this product (ids/index = the list being shot, for 次の商品). */
export function shootWithNativeCamera(productId, { ids = [productId], index } = {}) {
  write(KEY, { productId, ids, index: index ?? Math.max(0, ids.indexOf(productId)), at: Date.now(), hiddenAt: 0 });
  location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(shortcutNames().camera)}`;
}

function endShoot() {
  write(KEY, null);
}

/** iPhone の写真選択から選んだ写真を、この商品の現物写真として登録（送信は自動で続き、Mac が仕上げる）。 */
export function pickPhotosFor(productId, { after } = {}) {
  const picker = h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' } });
  picker.onchange = async () => {
    const files = [...(picker.files || [])];
    picker.remove();
    if (!files.length) return;
    const t = toast(`${files.length}枚を準備しています…`, { ms: 60000 });
    let n = 0;
    for (const f of files) {
      try {
        const v = await makeVariants(f);
        await uploads.enqueue({ productId, kind: 'actual', source: 'native-pick', original: f, work: v.work, thumb: v.thumb, width: v.width, height: v.height, takenAt: new Date(await takenAt(f)).toISOString() });
        n++;
      } catch (e) {
        showError(e);
      }
    }
    t?.remove?.();
    if (n) toast(`#${productId} に${n}枚を登録します（送信は自動で続き、Mac が仕上げます）`);
    after?.(n);
  };
  document.body.append(picker);
  picker.click();
}

/** Shown when coming back from the Camera app: choose the photos to register, then 続けて撮る／次の商品／終える. */
export function openImportSheet() {
  const s = session();
  if (!s) return;
  const p = state.products.get(s.productId);
  const nextId = s.ids[s.index + 1];
  sheet((close) => h('div', null,
    h('h2', null, '📸 撮った写真を登録 ', h('span', { class: 'muted small' }, `#${s.productId} ${p?.name || ''}`)),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary big', onclick: () => pickPhotosFor(s.productId) }, '🖼 撮った写真から選んで登録'),
      h('button', { class: 'btn', onclick: () => { close(); shootWithNativeCamera(s.productId, s); } }, '📸 この商品を続けて撮る'),
      nextId && h('button', { class: 'btn', onclick: () => { close(); shootWithNativeCamera(nextId, { ids: s.ids, index: s.index + 1 }); } }, `→ 次の商品を撮る（#${nextId}）`),
      h('button', { class: 'btn ghost', onclick: () => { close(); endShoot(); } }, '✓ 終える')),
    h('p', { class: 'muted small' }, '写真の選択画面で、この商品の写真だけをタップして「追加」。別の商品の写真は、その商品で選べば大丈夫です。')));
}

/** After the app comes back to the front during a shoot, offer the register sheet once. */
export function watchNativeReturn() {
  document.addEventListener('visibilitychange', () => {
    const s = session();
    if (!s) return;
    if (document.visibilityState === 'hidden') return write(KEY, { ...s, hiddenAt: Date.now() });
    if (s.hiddenAt && Date.now() - s.hiddenAt > 2500) {
      write(KEY, { ...s, hiddenAt: 0 });
      openImportSheet();
    }
  });
}

/** One-time setup: one shortcut that only opens the Camera app. */
export function openNativeSetup() {
  const names = shortcutNames();
  let nameInput;
  sheet((close) => h('div', { class: 'native-setup' },
    h('h2', null, '📸 純正カメラ連携の設定（最初に1回）'),
    h('p', { class: 'small' }, 'iPhone でこの画面を開いて下のボタンを押すと、「カメラ」を開くだけのショートカット「台帳カメラ」が追加されます。'),
    h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '/api/native-shoot/shortcut/camera' }, `「${names.camera}」を追加`)),
    h('ol', { class: 'small' },
      h('li', null, '商品の「📸 純正カメラで撮る」→「カメラ」が開く（モード・スタイルはそのまま）'),
      h('li', null, '撮ったら台帳に戻る（左上の「◀ ショートカット」か、アプリの切り替えで）'),
      h('li', null, '「🖼 撮った写真から選んで登録」でその商品の写真を選ぶ')),
    h('details', null, h('summary', { class: 'small' }, 'ボタンで追加できないとき（手で作る）'),
      h('ol', { class: 'small' },
        h('li', null, '「ショートカット」→ ＋ → 名前「', names.camera, '」'),
        h('li', null, 'アクション「アプリを開く」を追加し、アプリに「カメラ」を選ぶ（これだけ）'))),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'ショートカット名（変えた場合）'), (nameInput = h('input', { type: 'text', value: names.camera }))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => { write(NAMES_KEY, { camera: nameInput.value.trim() || DEFAULT_NAMES.camera }); close(); toast('保存しました'); } }, '保存して閉じる'))));
}

// ---- 撮影トレイ（以前の自動送信で Mac に届いた写真が残っているときだけ使う）----
const ACTION = { register: '登録', hold: '保留', discard: '破棄' };
const NEXT = { register: 'hold', hold: 'discard', discard: 'register' };

/**
 * 撮影トレイから選ぶ: この商品のために撮った写真（既定は「登録」）と、保留中・前の撮影の未整理の写真（既定は「保留」）を並べる。
 * タップで 登録→保留→破棄 を切り替え、「決める」で登録した分だけこの商品の写真になる（Mac が自動で仕上げ）。
 * 別の商品も続けて撮ったときは、その写真を「保留」のまま残せば、次の商品でここに出てくる。
 */
export async function traySheet(productId, { afterShoot = null } = {}) {
  const p = state.products.get(productId);
  const choice = new Map();
  let items = [];
  const grid = h('div', { class: 'tray-grid' });
  const status = h('p', { class: 'muted small', style: { margin: '4px 0' } });
  const decideBtn = h('button', { class: 'btn primary' }, '決める');
  const mine = (it) => it.status === 'new' && it.productId === productId;
  const count = () => [...choice.values()].reduce((m, a) => ((m[a] = (m[a] || 0) + 1), m), {});
  function paint() {
    grid.replaceChildren(...items.map((it) => {
      const a = choice.get(it.id);
      return h('button', { class: `tray-tile ${a}`, onclick: () => { choice.set(it.id, NEXT[a]); paint(); } },
        h('img', { src: it.thumb, alt: '', loading: 'lazy' }),
        h('span', { class: 'tray-label' }, ACTION[a]),
        !mine(it) && h('span', { class: 'tray-from' }, it.status === 'held' ? '保留中' : `#${it.productId}の撮影`));
    }));
    const c = count();
    decideBtn.textContent = `決める（登録 ${c.register || 0}・保留 ${c.hold || 0}・破棄 ${c.discard || 0}）`;
    status.textContent = items.length ? 'タップで 登録 → 保留 → 破棄。別の商品の写真は「保留」にしておくと、次の商品で選べます。'
      : afterShoot ? '写真を受け取り中…（ショートカットが送り終えるまで少し待ってください）' : 'トレイに写真はありません。';
  }
  async function refresh() {
    try {
      items = (await api.get('/api/tray')).items;
    } catch {
      return;
    }
    items.sort((a, b) => (mine(b) - mine(a)) || (b.takenAt || b.receivedAt).localeCompare(a.takenAt || a.receivedAt));
    for (const it of items) if (!choice.has(it.id)) choice.set(it.id, mine(it) ? 'register' : 'hold');
    for (const id of [...choice.keys()]) if (!items.some((it) => it.id === id)) choice.delete(id);
    paint();
  }
  const off = on('tray', refresh);
  // Photos keep arriving for a while after coming back (the shortcut sends them one by one).
  const poll = afterShoot ? setInterval(refresh, 3000) : null;
  const stopPoll = setTimeout(() => poll && clearInterval(poll), 120_000);
  const cleanup = () => { off(); if (poll) clearInterval(poll); clearTimeout(stopPoll); };
  const setAll = (a, pred = () => true) => { for (const it of items) if (pred(it)) choice.set(it.id, a); paint(); };
  sheet((close) => {
    decideBtn.onclick = async () => {
      const decisions = items.map((it) => ({ id: it.id, action: choice.get(it.id), productId }));
      if (!decisions.length) return close();
      try {
        const r = await api.post('/api/tray/decide', { decisions });
        toast(`登録 ${r.registered}枚・保留 ${r.held}枚・破棄 ${r.discarded}枚（登録した写真は Mac が自動で仕上げます）`);
        close();
        afterShoot?.();
      } catch (e) {
        showError(e);
      }
    };
    return h('div', { class: 'memo-sheet tray-sheet' },
      h('h2', null, '📥 撮った写真から選ぶ ', h('span', { class: 'muted small' }, `#${productId} ${p?.name || ''}`)),
      status,
      h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', margin: '4px 0' } },
        h('button', { class: 'btn small', onclick: () => setAll('register', mine) }, 'この商品の分を全部登録'),
        h('button', { class: 'btn small', onclick: () => setAll('hold', (it) => choice.get(it.id) !== 'register') }, '登録以外は保留'),
        h('button', { class: 'btn small ghost', onclick: refresh }, '↻ 受け取りを確認')),
      grid,
      h('div', { class: 'actions' }, decideBtn, h('button', { class: 'btn ghost', onclick: () => close() }, 'あとで')));
  }, { onClose: cleanup });
  await refresh();
}

