// REST client. Every request from the UI is made as the human user (X-Actor: user).

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'x-actor': 'user', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
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
