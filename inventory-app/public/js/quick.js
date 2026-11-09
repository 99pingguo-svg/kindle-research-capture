// ワンタッチ操作: メモ（声でも入力）と、📷検索に使った写真をそのまま商品写真にする。
import { h, toast, showError, sheet } from './ui.js';
import { api } from './api.js';
import { state, applyProduct } from './state.js';
import * as uploads from './uploads.js';

// ---------- メモ ----------
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;

/** Memo sheet: the whole memo, caret at the end, 🎤 dictation where the browser has it. Saves only 「メモ」. */
export function quickMemo(id, current = '') {
  const p = state.products.get(id);
  const start = current ? `${current.replace(/\s+$/, '')}\n` : '';
  const ta = h('textarea', { class: 'memo-text', rows: 7, value: start, placeholder: 'メモ（キーボードのマイクでも音声入力できます）' });
  let rec = null;
  const status = h('span', { class: 'muted small' });
  const stopVoice = () => { rec?.stop(); rec = null; mic && (mic.textContent = '🎤 音声で入力'); status.textContent = ''; };
  const mic = Speech && h('button', {
    class: 'btn', type: 'button',
    onclick: () => {
      if (rec) return stopVoice();
      rec = new Speech();
      rec.lang = 'ja-JP';
      rec.interimResults = true;
      rec.continuous = true;
      // Final phrases are inserted at the caret; the phrase being spoken is shown beside the button.
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) ta.setRangeText(r[0].transcript, ta.selectionStart, ta.selectionEnd, 'end');
          else interim += r[0].transcript;
        }
        status.textContent = interim;
      };
      rec.onerror = (e) => { if (e.error !== 'aborted') toast(`音声入力: ${e.error === 'not-allowed' ? 'マイクが許可されていません' : e.error}`, { error: true }); stopVoice(); };
      rec.onend = () => rec && stopVoice();
      rec.start();
      mic.textContent = '⏹ 止める';
    },
  }, '🎤 音声で入力');
  const save = async (close) => {
    stopVoice();
    const notes = ta.value.replace(/\s+$/, '');
    if (notes === (current || '').replace(/\s+$/, '')) return close();
    try {
      const r = await api.patch(`/api/products/${id}`, { set: { notes } });
      applyProduct(r.product);
      close();
      toast('メモを保存しました');
    } catch (e) {
      showError(e);
    }
  };
  sheet((close) => h('div', { class: 'memo-sheet' },
    h('h2', null, '📝 メモ ', h('span', { class: 'muted small' }, `#${id} ${p?.name || ''}`)),
    ta,
    h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', marginTop: '8px' } }, mic, status),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => save(close) }, '保存'),
      h('button', { class: 'btn ghost', onclick: () => { stopVoice(); close(); } }, 'キャンセル'))), { onClose: stopVoice });
  // Still inside the tap, so iPhone shows the keyboard.
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

// ---------- 📷検索の写真 ----------
const KEEP_MS = 15 * 60_000;
let searchPhoto = null; // { file, work, thumb, thumbUrl, width, height, at, usedBy: Set }

export function rememberSearchPhoto(file, v) {
  if (searchPhoto) URL.revokeObjectURL(searchPhoto.thumbUrl);
  searchPhoto = { file, ...v, thumbUrl: URL.createObjectURL(v.thumb), at: Date.now(), usedBy: new Set() };
}

/** The last 📷 search photo, if recent and not yet added to this product. */
export function searchPhotoFor(id) {
  return searchPhoto && Date.now() - searchPhoto.at < KEEP_MS && !searchPhoto.usedBy.has(id) ? searchPhoto : null;
}

/** Add it as a real photo of the product; the Mac then finishes it (white background, colour, shadows) automatically. */
export async function addSearchPhoto(id) {
  const s = searchPhotoFor(id);
  if (!s) return false;
  s.usedBy.add(id);
  await uploads.enqueue({
    productId: id, kind: 'actual', source: 'search', original: s.file, work: s.work, thumb: s.thumb, width: s.width, height: s.height,
    takenAt: new Date(s.file.lastModified || Date.now()).toISOString(),
  });
  toast('検索に使った写真を商品写真に追加しました（Mac で自動仕上げします）');
  return true;
}

// ---------- あるかないか・レビュー・置き場 ----------
const PRESENCE_LABEL = { have: 'ある', gone: 'ない', unknown: '？' };

/** ある／ない／？ をタップ（同じものをもう一度で未チェックに戻す）。 */
export async function setPresence(id, current, state) {
  try {
    applyProduct(await api.post(`/api/products/${id}/presence`, { state: current === state ? null : state }));
  } catch (e) {
    showError(e);
  }
}

/** The three big buttons of the あるかないか row. */
export function presenceSeg(p) {
  const cur = p.presence || null;
  return h('div', { class: 'presence-seg', onclick: (e) => e.stopPropagation() },
    ['have', 'gone', 'unknown'].map((s) => h('button', {
      class: `${s} ${cur === s ? 'on' : ''}`, 'aria-pressed': cur === s ? 'true' : 'false',
      title: cur === s ? 'もう一度押すと未チェックに戻す' : '',
      onclick: () => setPresence(p.id, cur, s),
    }, PRESENCE_LABEL[s])));
}

/** レビュー・発信の予定（状態・形式・メモ・下書き・投稿先）。 */
export async function reviewSheet(id) {
  let full;
  try {
    full = await api.get(`/api/products/${id}`);
  } catch (e) {
    return showError(e);
  }
  const rp = { status: '', formats: [], note: '', draft: '', url: '', ...(full.reviewPlan || {}) };
  const statuses = state.meta.reviewStatuses || [];
  const formats = state.meta.reviewFormats || [];
  let status = rp.status;
  const picked = new Set(rp.formats);
  const note = h('textarea', { class: 'memo-text', rows: 3, placeholder: '何を伝えるか・切り口・撮りたいカットなど（AI への指示にもなります）' }, rp.note);
  const draft = h('textarea', { class: 'memo-text', rows: 6, placeholder: '下書き（AI が書くとここに入ります）' }, rp.draft);
  const url = h('input', { type: 'url', class: 'memo-text', placeholder: '投稿したページの URL', value: rp.url });
  const stSeg = h('div', { class: 'seg wide review-status' });
  const fmSeg = h('div', { class: 'seg wide' });
  const paint = () => {
    stSeg.replaceChildren(...statuses.map((s) => h('button', { class: status === s.id ? 'on' : '', onclick: () => { status = s.id; paint(); } }, s.label)));
    fmSeg.replaceChildren(...formats.map((f) => h('button', { class: picked.has(f.id) ? 'on' : '', onclick: () => { picked.has(f.id) ? picked.delete(f.id) : picked.add(f.id); paint(); } }, f.label)));
  };
  paint();
  sheet((close) => h('div', { class: 'memo-sheet' },
    h('h2', null, '✍ レビュー・発信 ', h('span', { class: 'muted small' }, `#${id} ${full.name || ''}`)),
    h('div', { class: 'small muted' }, 'するか'), stSeg,
    h('div', { class: 'small muted', style: { marginTop: '8px' } }, '形式（いくつでも）'), fmSeg,
    h('div', { class: 'small muted', style: { marginTop: '8px' } }, '内容のメモ'), note,
    h('div', { class: 'small muted', style: { marginTop: '8px' } }, '下書き'), draft,
    h('div', { class: 'small muted', style: { marginTop: '8px' } }, '投稿先'), url,
    h('p', { class: 'muted small' }, '「する」にすると AI エージェントの「やること」に載り、下書きが届きます。「投稿OK」にしたものだけ AI が投稿できます。'),
    h('div', { class: 'actions' },
      h('a', { class: 'btn', href: `/api/materials.zip?ids=${id}`, download: '' }, '📦 素材Zip'),
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          applyProduct((await api.put(`/api/products/${id}/review-plan`, { status, formats: [...picked], note: note.value, draft: draft.value, url: url.value.trim() })));
          close();
          toast('レビュー・発信の予定を保存しました');
        } catch (e) { showError(e); }
      } }, '保存'),
      h('button', { class: 'btn ghost', onclick: () => close() }, 'キャンセル'))));
}

/** 種類ごとの置き場を決める（全端末共通の設定）。 */
export async function placeSheet(category) {
  const places = { ...(state.meta.settings.categoryPlaces || {}) };
  const input = h('input', { type: 'text', class: 'memo-text', value: places[category] || '', placeholder: '例: 押し入れ上段・青い箱' });
  sheet((close) => h('div', { class: 'memo-sheet' },
    h('h2', null, '📍 置き場 ', h('span', { class: 'muted small' }, category)),
    input,
    h('p', { class: 'muted small' }, 'この種類の商品の置き場として表示します。商品ごとの「保管場所」が入っている商品はそちらが優先です。'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          places[category] = input.value.trim();
          state.meta.settings = await api.put('/api/settings', { categoryPlaces: places });
          close();
          toast('置き場を保存しました');
          await (await import('./state.js')).loadAll();
        } catch (e) { showError(e); }
      } }, '保存'),
      h('button', { class: 'btn ghost', onclick: () => close() }, 'キャンセル'))));
  input.focus();
}
