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
