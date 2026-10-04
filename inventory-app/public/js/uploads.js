// Persistent upload queue (IndexedDB). A photo is stored locally the instant it is
// taken and uploaded in the background with retries, so a flaky connection or an app
// reload never loses a shot. The server de-duplicates by clientId, so retries are safe.
import { emit } from './state.js';

const DB = 'daicho';
const STORE = 'uploads';
let dbp;
const memory = new Map(); // fallback when IndexedDB is unavailable
const urls = new Map(); // qid -> object URL for local thumbnails

function db() {
  if (!dbp) {
    dbp = new Promise((resolve) => {
      if (!('indexedDB' in window)) return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'qid' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  if (!d) return fn(null);
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

async function all() {
  const d = await db();
  if (!d) return [...memory.values()];
  return new Promise((resolve) => {
    const req = d.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.createdAt - b.createdAt));
    req.onerror = () => resolve([]);
  });
}

async function put(item) {
  const d = await db();
  if (!d) return memory.set(item.qid, item);
  await tx('readwrite', (s) => s.put(item));
}

async function remove(qid) {
  const d = await db();
  if (!d) return memory.delete(qid);
  await tx('readwrite', (s) => s.delete(qid));
}

let cache = [];
async function refresh() {
  cache = await all();
  emit('uploads', status());
}

export function status() {
  return { pending: cache.length, failed: cache.filter((x) => x.error).length };
}

/** Local items for a product, to show thumbnails before the upload finishes. */
export function pendingFor(productId) {
  return cache
    .filter((x) => x.productId === productId)
    .map((x) => {
      if (!urls.has(x.qid)) urls.set(x.qid, URL.createObjectURL(x.thumb || x.work || x.original));
      return { qid: x.qid, url: urls.get(x.qid), error: x.error, tag: x.tag, kind: x.kind };
    });
}

export async function enqueue(item) {
  const qid = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).toString();
  const rec = { ...item, qid, clientId: qid, createdAt: Date.now(), attempts: 0, error: null };
  await put(rec);
  await refresh();
  kick();
  return qid;
}

export async function retryFailed() {
  for (const x of cache.filter((c) => c.error)) await put({ ...x, error: null, attempts: 0 });
  await refresh();
  kick();
}

export async function discard(qid) {
  await remove(qid);
  if (urls.has(qid)) URL.revokeObjectURL(urls.get(qid));
  urls.delete(qid);
  await refresh();
}

let running = false;
let timer = null;

export async function kick() {
  clearTimeout(timer);
  if (running) return;
  running = true;
  try {
    await refresh();
    for (const item of cache) {
      if (item.error) continue;
      const fd = new FormData();
      for (const k of ['kind', 'tag', 'note', 'requestId', 'clientId', 'source', 'derivedFrom', 'width', 'height', 'takenAt']) {
        if (item[k] != null && item[k] !== '') fd.append(k, String(item[k]));
      }
      if (item.edit) fd.append('edit', JSON.stringify(item.edit));
      if (item.replaceInListing) fd.append('replaceInListing', 'true');
      fd.append('original', item.original, 'original' + (item.original.type === 'image/png' ? '.png' : '.jpg'));
      if (item.work && item.work !== item.original) fd.append('work', item.work, 'work.jpg');
      if (item.thumb) fd.append('thumb', item.thumb, 'thumb.jpg');
      try {
        const res = await fetch(`/api/products/${item.productId}/photos`, { method: 'POST', body: fd, headers: { 'x-actor': 'user' }, credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          // 4xx (except timeouts/rate limits) will not fix itself: park it and tell the user.
          if (res.status >= 400 && res.status < 500 && ![408, 429].includes(res.status)) {
            await put({ ...item, error: data.error || `HTTP ${res.status}` });
            continue;
          }
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        await remove(item.qid);
        emit('uploaded', { productId: item.productId, photo: data.photo, summary: data.product, qid: item.qid });
        setTimeout(() => {
          if (urls.has(item.qid)) URL.revokeObjectURL(urls.get(item.qid));
          urls.delete(item.qid);
        }, 30000);
      } catch {
        // network problem: back off and try again later
        const attempts = (item.attempts || 0) + 1;
        await put({ ...item, attempts });
        await refresh();
        timer = setTimeout(kick, Math.min(60000, 2000 * 2 ** Math.min(attempts, 5)));
        return;
      }
    }
  } finally {
    running = false;
    await refresh();
  }
}

window.addEventListener('online', () => kick());
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && kick());
