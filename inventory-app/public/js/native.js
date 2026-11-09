// 純正カメラ連携: iPhone の「カメラ」アプリ（フォトグラフスタイル等がそのまま使える）で撮って取り込む。
// アプリで撮影対象を決める → ショートカット「台帳で撮る」がカメラを開く → 撮影 → 左上の「◀ ショートカット」で戻ると
// ショートカットが撮った写真を送る（戻るまで待機）→ 台帳に戻ると次の商品などを選べる。届かなかったときは「台帳に送る」か写真を選んで追加。
import { h, toast, showError, sheet, copyText } from './ui.js';
import { api } from './api.js';
import { state } from './state.js';
import { makeVariants } from './images.js';
import * as uploads from './uploads.js';

const KEY = 'daicho.native';
const NAMES_KEY = 'daicho.nativeNames';
const DEFAULT_NAMES = { camera: '台帳で撮る', send: '台帳に送る' };
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
// (the old two-step 「台帳カメラ」 only opened the Camera; 「台帳で撮る」 now shoots and sends in one go)
export const shortcutNames = () => { const n = { ...DEFAULT_NAMES, ...read(NAMES_KEY, {}) }; if (n.camera === '台帳カメラ') n.camera = DEFAULT_NAMES.camera; return n; };
const runShortcut = (name, back) => {
  const q = `name=${encodeURIComponent(name)}`;
  location.href = back ? `shortcuts://x-callback-url/run-shortcut?${q}&x-success=${encodeURIComponent(back)}` : `shortcuts://run-shortcut?${q}`;
};
const session = () => {
  const s = read(KEY, null);
  return s && Date.now() - s.at < 3 * 3600_000 ? s : null;
};

/** The last contacts from the iPhone shortcut (did it reach the Mac, and why not). */
export function contactsBox() {
  const box = h('div', { class: 'contacts small' }, h('span', { class: 'muted' }, 'ショートカットからの連絡を確認中…'));
  api.get('/api/native-shoot/contacts').then(({ contacts }) => {
    const fmt = (iso) => new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    box.replaceChildren(
      h('b', null, 'ショートカットからの連絡（新しい順）'),
      contacts.length ? h('ul', null, contacts.slice(0, 5).map((c) => h('li', { class: c.ok ? '' : 'ng' }, `${fmt(c.at)} ${c.what}: ${c.result}`)))
        : h('p', { class: 'muted', style: { margin: '2px 0' } }, 'まだ一度も届いていません（このMacの再起動後）。iPhone の Tailscale がオンか、ショートカットを今のアドレスで入れ直したかを確かめてください。'));
  }).catch(() => box.replaceChildren(h('span', { class: 'muted' }, '確認できませんでした')));
  return box;
}

/** Start (or move) a shoot: this product receives the photos, then the Camera app opens. ids/index = the list being shot, for 次の商品. */
export async function shootWithNativeCamera(productId, { ids = [productId], index } = {}) {
  try {
    await api.put('/api/native-shoot', { productId });
  } catch (e) {
    return showError(e);
  }
  write(KEY, { productId, ids, index: index ?? Math.max(0, ids.indexOf(productId)), at: Date.now(), hiddenAt: 0 });
  runShortcut(shortcutNames().camera);
}

async function endShoot() {
  write(KEY, null);
  await api.del('/api/native-shoot').catch(() => {});
}

async function addPicked(productId, fileList) {
  const files = [...(fileList || [])];
  let n = 0;
  for (const f of files) {
    try {
      const v = await makeVariants(f);
      await uploads.enqueue({ productId, kind: 'actual', source: 'native-pick', original: f, work: v.work, thumb: v.thumb, width: v.width, height: v.height, takenAt: new Date(f.lastModified || Date.now()).toISOString() });
      n++;
    } catch (e) {
      showError(e);
    }
  }
  if (n) toast(`${n}枚を追加しました（送信は自動で続きます）`);
}

/** Shown when coming back from the Camera app (or the send shortcut). */
export async function openImportSheet() {
  const s = session();
  if (!s) return;
  let info = null;
  try {
    info = await api.get('/api/native-shoot');
  } catch {
    /* offline: the sheet still offers picking photos */
  }
  const p = state.products.get(s.productId);
  const picker = h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' } });
  const names = shortcutNames();
  sheet((close) => {
    picker.onchange = (e) => { addPicked(s.productId, e.target.files); close(); };
    const nextId = s.ids[s.index + 1];
    return h('div', null,
      h('h2', null, '📸 純正カメラの写真を取り込む'),
      h('p', { class: 'small', style: { margin: '0 0 4px' } }, h('b', null, `#${s.productId} `), p?.name || ''),
      info?.active && h('p', { class: 'muted small', style: { margin: '0 0 8px' } }, `この撮影で届いた写真: ${info.photos}枚`),
      contactsBox(),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => { close(); runShortcut(names.send, `${location.origin}/#/p/${s.productId}`); } }, `⚡ 写真が届いていなければ送り直す`),
        h('button', { class: 'btn', onclick: () => picker.click() }, '🖼 写真を選んで取り込む'),
        h('button', { class: 'btn', onclick: async () => { close(); (await import('./bulkimport.js')).bulkImportNativePhotos(); } }, '📸 いくつもの商品をまとめて取り込む（自動で仕分け）'),
        h('button', { class: 'btn primary', onclick: () => { close(); shootWithNativeCamera(s.productId, s); } }, '📸 続けて撮る'),
        nextId && h('button', { class: 'btn', onclick: () => { close(); shootWithNativeCamera(nextId, { ids: s.ids, index: s.index + 1 }); } }, `→ 次の商品を撮る（#${nextId}）`),
        h('button', { class: 'btn ghost', onclick: () => { close(); endShoot(); toast('純正カメラの撮影を終えました'); } }, '✓ 撮影を終える'),
        h('button', { class: 'btn ghost small', onclick: () => { close(); openNativeSetup(); } }, 'ショートカットの設定方法')),
      picker);
  });
}

/** After the app comes back to the front during a shoot, offer the import sheet once. */
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

/** One-time setup: two iPhone shortcuts (open Camera / send the photos taken since the shoot started). */
export async function openNativeSetup() {
  let key = '';
  let ticket = '';
  try {
    ({ key, ticket } = await api.get('/api/native-shoot/key'));
  } catch (e) {
    return showError(e);
  }
  const base = location.origin;
  const names = shortcutNames();
  const copyRow = (label, value, hidden = false) => h('div', { class: 'row', style: { gap: '6px', alignItems: 'center', margin: '4px 0' } },
    h('span', { class: 'small', style: { minWidth: '7em' } }, label),
    h('code', { class: 'code', style: { flex: 1 } }, hidden ? '••••••••（コピーで取得）' : value),
    h('button', { class: 'btn small', onclick: () => copyText(value, `${label}をコピーしました`) }, 'コピー'));
  const nameInputs = {};
  sheet((close) => h('div', { class: 'native-setup' },
    h('h2', null, '📸 純正カメラ連携の設定（最初に1回）'),
    h('p', { class: 'small' }, 'iPhone の「カメラ」アプリで撮るので、フォトグラフスタイルや撮影モードなど、カメラの機能がそのまま使えます。iPhone でこの画面を開き、下の①を押すと「ショートカット」に追加されます（自動設定）。'),
    h('ol', { class: 'small' },
      h('li', null, '商品の「📸 純正カメラで撮る」を押す → 「カメラ」が開く'),
      h('li', null, '好きなだけ撮る'),
      h('li', null, '左上の「◀ ショートカット」を押して戻る → 撮った写真がその商品に届く（Mac が自動で仕上げ）'),
      h('li', null, '台帳に戻ると「次の商品を撮る」などが出る')),
    h('p', { class: 'small', style: { background: 'var(--bg)', padding: '8px', borderRadius: '8px' } }, h('b', null, 'いちばん簡単なのは: '), 'ショートカットなしで「カメラ」で撮りっぱなし → 一覧の下の「📸 カメラの写真を取り込む」で写真を選ぶだけ（撮影時刻と写真の文字で商品ごとに自動で分けます）。'),
    h('p', { class: 'small' }, `ショートカット②はこのアドレスに送ります: `, h('code', null, base), `（前に別のアドレスで入れたショートカットは届きません。①②を押し直して入れ替えてください）`),
    contactsBox(),
    h('div', { class: 'actions' },
      h('a', { class: 'btn primary', href: `/api/native-shoot/shortcut/camera?ticket=${encodeURIComponent(ticket)}` }, `① 「${names.camera}」を追加（これだけで使えます）`),
      h('a', { class: 'btn', href: `/api/native-shoot/shortcut/send?ticket=${encodeURIComponent(ticket)}` }, `② 「${names.send}」を追加（送り直し用・任意）`)),
    h('p', { class: 'muted small' }, '「台帳に送る」は最新の写真（スクリーンショット以外・最大20枚）を送ります。撮影を始める前の写真はMacが撮影日時を見て取り込みません。同じ写真が二重に入ることもありません。'),
    h('details', null, h('summary', { class: 'small' }, '手で作る場合の手順'),
    h('h3', null, '① 台帳で撮る（カメラを開き、戻ったら送る）'),
    h('ol', { class: 'small' },
      h('li', null, '新規ショートカット → 名前「', names.camera, '」'),
      h('li', null, 'アクション「アプリを開く」→ アプリに「カメラ」を選ぶ'),
      h('li', null, 'アクション「戻るまで待機」'),
      h('li', null, '「最新の写真を取得」（10枚・スクリーンショットを含めない）→「各項目を繰り返す」の中に下の②と同じ「URLの内容を取得」（POST・ヘッダ x-upload-key・本文ファイル＝繰り返し項目）')),
    h('h3', null, '② 台帳に送る（送り直し用）'),
    copyRow('対象URL', `${base}/api/native-shoot`),
    copyRow('送信URL', `${base}/api/native-shoot/photos`),
    copyRow('合言葉', key, true),
    h('ol', { class: 'small' },
      h('li', null, '新規ショートカット → 名前「', names.send, '」'),
      h('li', null, '「URLの内容を取得」: URL＝対象URL。詳細を開き、ヘッダに キー「x-upload-key」・値＝合言葉'),
      h('li', null, '「辞書の値を取得」: キー「sinceLocal」（辞書＝URLの内容）'),
      h('li', null, '「入力から日付を取得」: 入力＝辞書の値'),
      h('li', null, '「写真を検索」: フィルタ「撮影日」「が次より後」→ 日付（前の手順の結果）。並び順は撮影日（古い順）'),
      h('li', null, '「各項目を繰り返す」（写真）の中に「URLの内容を取得」: URL＝送信URL、方法「POST」、ヘッダ「x-upload-key」＝合言葉、本文を要求「ファイル」→「繰り返し項目」'),
      h('li', null, '（任意）最後に「通知を表示」で「送信しました」')),
    ),
    h('p', { class: 'muted small' }, '合言葉で使えるのは「撮影中の商品を調べる」「その商品に写真を送る」の2つだけです（一覧やほかの操作はできません）。アプリで「撮影を終える」と写真は受け付けません。②のファイルには合言葉が入っているので、人には渡さないでください。'),
    h('h3', null, 'ショートカット名（変えた場合）'),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'カメラを開く'), (nameInputs.camera = h('input', { type: 'text', value: names.camera }))),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '写真を送る'), (nameInputs.send = h('input', { type: 'text', value: names.send })))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => { write(NAMES_KEY, { camera: nameInputs.camera.value.trim() || DEFAULT_NAMES.camera, send: nameInputs.send.value.trim() || DEFAULT_NAMES.send }); close(); toast('保存しました'); } }, '保存して閉じる'),
      h('button', { class: 'btn ghost small', onclick: async () => {
        try {
          await api.get('/api/native-shoot/key?rotate=1');
          close();
          toast('合言葉を作り直しました。ショートカット②の合言葉も入れ直してください');
        } catch (e) { showError(e); }
      } }, '合言葉を作り直す'))));
}
