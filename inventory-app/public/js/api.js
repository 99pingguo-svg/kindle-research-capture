// REST client. Requests from the UI are made as the human user (X-Actor: user), except in a tab opened with ?as=<name>
// (e.g. ?as=muse): an AI agent working the screen (Muse over remote desktop). That tab's changes are recorded under its name
// (history, 一括取り消し) and the server refuses the user-only operations. Per tab (sessionStorage); ?as=user goes back.
const AS_KEY = 'daicho.actor';
function initActor() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('as')) {
      const v = (q.get('as') || '').trim().toLowerCase();
      if (/^[a-z][a-z0-9_-]{1,30}$/.test(v) && !['user', 'system', 'api'].includes(v)) sessionStorage.setItem(AS_KEY, v);
      else sessionStorage.removeItem(AS_KEY);
    }
    return sessionStorage.getItem(AS_KEY) || 'user';
  } catch {
    return 'user';
  }
}
export const actor = initActor();

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'x-actor': actor, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const e = new Error(data?.error || `HTTP ${res.status}`);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body = {}) => request('PUT', url, body),
  patch: (url, body = {}) => request('PATCH', url, body),
  del: (url) => request('DELETE', url),
};

/** Server-sent events with automatic reconnect (EventSource handles retries). */
export function connectEvents(onEvent, onStatus) {
  let es;
  const open = () => {
    es = new EventSource('/api/events');
    es.onopen = () => onStatus?.(true);
    es.onerror = () => onStatus?.(false);
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {
        /* ignore */
      }
    };
  };
  open();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && es.readyState === EventSource.CLOSED) open();
  });
}
