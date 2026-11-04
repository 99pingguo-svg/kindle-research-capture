// 観察ブラウザ連携（Mac の amazon-research-browser/sync/）の読み取り口。
// 台帳からは読むだけ: 画像取得の状況（sync/out/images-status.json）と、取れた商品画像（sync/images/<ASIN>.jpg）。
// どの一覧（Vine注文・レビュー待ち・レビュー済み・注文履歴）に入っているかは、sync 側が PUT /api/products/:id/browser で書く。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError, nowIso } from './util.js';
import { normalizeDate } from './schema.js';

export const BROWSER_LISTS = [
  { id: 'vineOrders', label: 'Vine注文' },
  { id: 'reviewPending', label: 'レビュー待ち' },
  { id: 'reviewed', label: 'レビュー済み' },
  { id: 'orders', label: '注文履歴' },
];
const LIST_IDS = BROWSER_LISTS.map((l) => l.id);
const VINE_LISTS = ['vineOrders', 'reviewPending', 'reviewed'];
export const IMAGE_STATES = { ok: '取得済み', later: '次回に取得', gave_up: 'あきらめ', none: '未取得' };

const DIR = process.env.BROWSER_SYNC_DIR || path.join(os.homedir(), 'AI-Workspace/projects/amazon-research-browser/sync');
const STATUS_FILE = path.join(DIR, 'out', 'images-status.json');
const ASIN = /^[A-Z0-9]{10}$/;

let cache = { mtime: -1, data: null };
/** The image run's latest status, re-read only when the file changes. Missing file = no runs yet. */
export function imageStatus() {
  let mtime = 0;
  try { mtime = fs.statSync(STATUS_FILE).mtimeMs; } catch {}
  if (mtime !== cache.mtime) {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch {}
    cache = { mtime, data };
  }
  return cache.data;
}

export function imageFor(asin) {
  if (!asin) return null;
  const it = imageStatus()?.items?.[asin];
  return it ? { status: IMAGE_STATES[it.status] ? it.status : 'none', url: it.status === 'ok' ? `/api/browser-images/${asin}` : null } : null;
}

export function imageFile(asin) {
  if (!ASIN.test(asin || '')) throw new AppError(404, 'not found');
  const file = path.join(DIR, 'images', `${asin}.jpg`);
  if (!fs.existsSync(file)) throw new AppError(404, 'not found');
  return file;
}

/** Clean what the sync sends: { asin, lists: { vineOrders: { ordered, delivered }, … } }. */
export function normalizeBrowserInfo(info) {
  const asin = String(info?.asin || '').toUpperCase();
  if (!ASIN.test(asin)) throw new AppError(400, 'ASIN が不正です');
  const lists = {};
  for (const [id, v] of Object.entries(info?.lists || {})) {
    if (!LIST_IDS.includes(id)) throw new AppError(400, `不明な一覧: ${id}`);
    lists[id] = { ordered: normalizeDate(v?.ordered || '') || '', delivered: normalizeDate(v?.delivered || '') || '' };
  }
  // Vine注文日: the order date any Vine list knows (Vine注文 first).
  const vineOrderDate = VINE_LISTS.map((id) => lists[id]?.ordered).find(Boolean) || '';
  return { asin, lists, vineOrderDate, syncedAt: nowIso() };
}

/** Same content, ignoring when it was synced. */
export const sameBrowserInfo = (a, b) => !!a && !!b && a.asin === b.asin && a.vineOrderDate === b.vineOrderDate &&
  JSON.stringify(a.lists) === JSON.stringify(b.lists);

/** What the list needs per product. */
export function browserBrief(p) {
  if (!p.browser) return null;
  return { asin: p.browser.asin, lists: Object.keys(p.browser.lists || {}), vineOrderDate: p.browser.vineOrderDate || null, image: imageFor(p.browser.asin) };
}

/** The 画像取得 page: when it last ran, whether it is paused, and per list how many have a picture. */
export function browserSyncOverview(products) {
  const st = imageStatus();
  const perList = Object.fromEntries(BROWSER_LISTS.map((l) => [l.id, { label: l.label, total: 0, ok: 0, later: 0, gave_up: 0, none: 0 }]));
  const missing = [];
  for (const p of products) {
    if (!p.browser || p.trashedAt) continue;
    const img = imageFor(p.browser.asin)?.status || 'none';
    for (const id of Object.keys(p.browser.lists || {})) {
      const c = perList[id];
      if (!c) continue;
      c.total++;
      c[img]++;
    }
    if (img !== 'ok' && Object.keys(p.browser.lists || {}).some((id) => VINE_LISTS.includes(id))) {
      missing.push({ id: p.id, name: p.name, asin: p.browser.asin, status: img });
    }
  }
  return {
    available: !!st,
    updatedAt: st?.updatedAt || null,
    lastRun: st?.lastRun || null,
    pausedUntil: st?.pausedUntil || null,
    robot: st?.robot || null,
    perList: Object.values(perList),
    missing: missing.slice(0, 200),
  };
}
