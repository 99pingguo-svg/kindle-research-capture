import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class AppError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

export const nowIso = () => new Date().toISOString();

export function newId(prefix = '') {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

export const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function getPath(obj, p) {
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, p, value) {
  const keys = p.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[keys.at(-1)] = value;
}

export function same(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Write atomically so a crash mid-write never leaves a truncated product.json. */
export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function writeJson(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
}

export function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}

export function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a torn last line */
    }
  }
  return out;
}

/** Normalise text for fuzzy comparison: NFKC, lower-case, drop spaces and punctuation. */
export function norm(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_/・,.、。()（）［］[\]「」【】"'`~!！?？:：;；|｜]+/g, '');
}

export function normUrl(u) {
  try {
    const url = new URL(String(u).trim());
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|ref|tag|_encoding|psc|th|smid|spm)/i.test(k)) url.searchParams.delete(k);
    }
    return (url.host.replace(/^www\./, '') + url.pathname.replace(/\/+$/, '') + url.search).toLowerCase();
  } catch {
    return String(u ?? '').trim().toLowerCase();
  }
}

/** Sørensen–Dice coefficient over character bigrams. */
export function similarity(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g);
    if (n) {
      hit++;
      grams.set(g, n - 1);
    }
  }
  return (2 * hit) / (x.length - 1 + y.length - 1);
}

export const pad4 = (n) => String(n).padStart(4, '0');

export function yen(n) {
  return n == null || n === '' ? '' : `${Number(n).toLocaleString('ja-JP')}円`;
}

export function truncate(s, n) {
  if (typeof s !== 'string' || s.length <= n) return s;
  return s.slice(0, n) + '…';
}

export function safeSegment(s) {
  return String(s ?? '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 40);
}
