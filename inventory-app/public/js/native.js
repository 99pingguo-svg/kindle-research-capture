// 純正カメラ連携: iPhone の「カメラ」アプリ（フォトグラフスタイル等がそのまま使える）で撮って取り込む。
// アプリで撮影対象を決める → ショートカット「台帳で撮る」がカメラを開く → 撮影 → 左上の「◀ ショートカット」で戻ると
// ショートカットが撮った写真を送る（戻るまで待機）→ 台帳に戻ると次の商品などを選べる。届かなかったときは「台帳に送る」か写真を選んで追加。
import { h, toast, showError, sheet, copyText } from './ui.js';
import { api } from './api.js';
import { state, on } from './state.js';

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

/** Shown when coming back from the Camera app: pick from the photos just taken, then 続けて撮る／次の商品／終える. */
export async function openImportSheet() {
  const s = session();
  if (!s) return;
  const nextId = s.ids[s.index + 1];
  await traySheet(s.productId, {
    afterShoot: () => sheet((close) => h('div', null,
      h('h2', null, '次はどうしますか'),
      h('div', { class: 'actions' },
        nextId && h('button', { class: 'btn primary', onclick: () => { close(); shootWithNativeCamera(nextId, { ids: s.ids, index: s.index + 1 }); } }, `→ 次の商品を撮る（#${nextId}）`),
        h('button', { class: 'btn', onclick: () => { close(); shootWithNativeCamera(s.productId, s); } }, '📸 この商品を続けて撮る'),
        h('button', { class: 'btn ghost', onclick: () => { close(); endShoot(); toast('純正カメラの撮影を終えました'); } }, '✓ 撮影を終える')))),
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
