// Small DOM helpers: h() element builder, toasts, bottom sheets.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'indeterminate') el[k] = v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

export function toast(message, { error = false, ms = 2600 } = {}) {
  const root = document.getElementById('toast-root');
  const t = h('div', { class: 'toast' + (error ? ' error' : '') }, message);
  root.append(t);
  setTimeout(() => t.remove(), error ? Math.max(ms, 5000) : ms);
}

export function showError(e) {
  console.error(e);
  toast(e?.message || String(e), { error: true });
}

/** Bottom sheet. `build(close)` returns the sheet content. Resolves when closed. */
export function sheet(build, { onClose } = {}) {
  const root = document.getElementById('overlay-root');
  let resolveFn;
  const done = new Promise((r) => (resolveFn = r));
  const close = (value) => {
    backdrop.remove();
    onClose?.(value);
    resolveFn(value);
  };
  const box = h('div', { class: 'sheet', role: 'dialog', onclick: (e) => e.stopPropagation() });
  const backdrop = h('div', { class: 'backdrop', onclick: () => close() }, box);
  box.append(build(close));
  root.append(backdrop);
  return done;
}

/** Action sheet: [{label, value, danger?, primary?}] → value */
export function choose(title, options) {
  return sheet((close) =>
    h('div', null,
      title && h('h2', null, title),
      h('div', { class: 'actions' },
        options.map((o) => h('button', { class: `btn ${o.danger ? 'danger' : ''} ${o.primary ? 'primary' : ''}`, onclick: () => close(o.value) }, o.label)),
        h('button', { class: 'btn ghost', onclick: () => close() }, 'キャンセル'))));
}

export const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

export const yen = (n) => (n == null || n === '' ? '—' : `¥${Number(n).toLocaleString('ja-JP')}`);

export function isToday(iso) {
  return !!iso && new Date(iso).toDateString() === new Date().toDateString();
}

export async function copyText(text, label = 'コピーしました') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(label);
}

export const isAiActor = (actor) => actor && actor !== 'user';
export const actorLabel = (actor) => (actor === 'user' ? 'あなた' : actor === 'api' ? 'API' : actor[0].toUpperCase() + actor.slice(1));
