#!/usr/bin/env node
// 399商品（Codex の素材・原稿・採用画像）を商品台帳に取り込む。元フォルダは読むだけで変更しない。
//
// - 商品名・タイトル下書き・説明文下書き（紹介原稿の本文）・Amazon リンクを登録（actor=import なので「ユーザー確定」にはならない）
// - 正式採用の紹介画像 → 生成画像（出品用に選べる）。完成商品は台帳の全画像、部分採用は formal_parent_scoped_adoption の画像だけ
// - Amazon 商品ページ画像（reference_inventory.json）→ 参考資料画像（出品には使わない）
// - 再実行しても重複しない（ASIN→商品ID と取り込み時点の原稿を data/imports/codex-399.json に保存、写真は clientId で重複排除）。
// - 再実行は「更新の同期」も兼ねる。元フォルダ側で変わったものだけを反映し、data/imports/update-ledger.{jsonl,csv} に記録する:
//   ・採用画像が差し替わった（指紋 sha256 が違う）→ 新版を生成画像として追加し、出品用の並びで旧版と置き換え（旧版は消さず「旧版」メモ）
//   ・採用画像が増えた／外れた → 出品用に追加／出品用から外す
//   ・原稿（商品名・説明文・購入理由）が変わった → アプリ側が取り込み時のままなら更新。ユーザー確定（🔒）なら提案として届く。
//     ユーザー以外が書き換え済みなら上書きせず「要確認」として台帳に残す
//   ・それぞれ、メルカリに入れた画像・文章だったか（下書き／出品中）も記録。アプリ側でも商品に「メルカリ側の更新が必要」と出る
//
// 使い方: node scripts/import-399.js [--limit N] [--asin B0XXXX,...] [--dry-run]
// 前提: サーバーが起動中（Mac 内の入口 http://127.0.0.1:8787）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.INVENTORY_URL || 'http://127.0.0.1:8787';
const ACTOR = 'import';
// 取り込み元の正本は外付けSSD（2026-11-20〜、写すのは scripts/collect-399-sources.py）。iCloud の ~/Documents/Codex は控え。
const ORIG_CODEX = path.join(os.homedir(), 'Documents/Codex');
const CODEX = process.env.CODEX_399_ROOT || ORIG_CODEX;
/** 台帳類に書かれた ~/Documents/Codex/… の絶対パスを、取り込み元（SSD）の同じ場所へ読み替える。 */
export const relocate = (p, root = CODEX) => (p && root !== ORIG_CODEX && String(p).startsWith(ORIG_CODEX + '/') ? path.join(root, String(p).slice(ORIG_CODEX.length + 1)) : p);
const R = path.join(CODEX, '2026-10-04/task/recovery_audit_20261004');
const SRC = {
  assignment: path.join(R, 'iphone_work_handoff_20261004/399_assignment.csv'),
  audit: path.join(R, 'audit_399_current_copy.json'),
  manuscripts: path.join(R, 'iphone_work_handoff_20261004/master_manuscripts/products'),
  ledger: path.join(CODEX, '2026-10-02/task/promotion_completion_ledger.json'),
  // 販売用（在庫の実物向け）原稿。ある商品はこちらを正本にする。
  resale: path.join(R, 'iphone_work_handoff_20261004/master_manuscripts/products_resale'),
  // 現行の採用台帳（status=formally_adopted）。10/5 の台帳より優先する。
  adoption: path.join(CODEX, '399商品_Claude画像制作共有/handoff_to_dot/COORDINATOR_CLAUDE/ADOPTION_LEDGER.json'),
};
const IMPORT_DIR = path.join(process.env.INVENTORY_DATA || path.join(ROOT, 'data'), 'imports');
const STATE_FILE = path.join(IMPORT_DIR, 'codex-399.json');
const LEDGER_JSONL = path.join(IMPORT_DIR, 'update-ledger.jsonl');
const LEDGER_CSV = path.join(IMPORT_DIR, 'update-ledger.csv');
const TITLE_MAX = 40;
const DESC_MAX = 1000;
const AI_IMAGE_NOTE = '※商品画像の一部はAIによる生成イメージです。実物と異なる場合があります。';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const LIMIT = Number(opt('--limit')) || Infinity;
const ONLY = opt('--asin') ? new Set(opt('--asin').split(',')) : null;
const DRY = args.includes('--dry-run');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.replace(/^﻿/, ''), r[i] ?? ''])));
}
/** A source file is in iCloud only (optimized storage); a background job cannot read it. Not a failure: retried next run. */
class Pending extends Error {}
function readSafe(file) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if (['EAGAIN', 'EDEADLK', 'ETIMEDOUT'].includes(e.code) || e.errno === -11 || /error -11/.test(e.message)) {
      execFile('brctl', ['download', file], () => {}); // ask iCloud to bring it back for the next run
      throw new Pending(`iCloud に未ダウンロード: ${path.basename(file)}`);
    }
    throw e;
  }
}
const readJson = (f) => JSON.parse(readSafe(f).toString('utf8'));
const readJsonIf = (f) => (fs.existsSync(f) ? readJson(f) : null);
const truthy = (v) => v === true || v === 'True' || v === 'true';
/** Fingerprints are cached by size+mtime, so unchanged (possibly iCloud-only) files are never read again. */
const SHA_CACHE_FILE = path.join(IMPORT_DIR, 'sha-cache.json');
let shaCache = null;
function sha256File(f) {
  shaCache ??= fs.existsSync(SHA_CACHE_FILE) ? JSON.parse(fs.readFileSync(SHA_CACHE_FILE, 'utf8')) : {};
  const st = fs.statSync(f);
  const hit = shaCache[f];
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sha;
  const sha = crypto.createHash('sha256').update(readSafe(f)).digest('hex');
  shaCache[f] = { size: st.size, mtimeMs: st.mtimeMs, sha };
  return sha;
}
function saveShaCache() {
  if (!shaCache) return;
  fs.mkdirSync(IMPORT_DIR, { recursive: true });
  fs.writeFileSync(SHA_CACHE_FILE, JSON.stringify(shaCache));
}
const descriptionFrom = (src) => [src.description, src.hasGenerated ? AI_IMAGE_NOTE : ''].filter(Boolean).join('\n\n').slice(0, DESC_MAX);
const aiNotesFrom = (src) => (src.purchaseReason ? `紹介原稿の購入理由: ${src.purchaseReason}` : '');

/** Mercari titles are at most 40 chars: drop the last ・-separated details inside a trailing （…） until it fits, then cut. */
function toTitle(name) {
  if (name.length <= TITLE_MAX) return name;
  const m = /^(.*?)[（(]([^（()）]*)[)）]\s*$/.exec(name);
  if (m) {
    const parts = m[2].split('・');
    while (parts.length && `${m[1]}（${parts.join('・')}）`.length > TITLE_MAX) parts.pop();
    const t = parts.length ? `${m[1]}（${parts.join('・')}）` : m[1];
    if (t.length <= TITLE_MAX) return t;
  }
  return name.slice(0, TITLE_MAX);
}

const AUDIT_LABEL = { pass: '全文監査 合格', pass_root_not_independent: '全文監査 合格（独立監査は未実施）', pending: '全文監査 待ち' };
const COMPLETION_LABEL = { complete: '正式完成', partial_images_adopted_not_complete: '一部採用（未完成）' };

/** Images adopted in the 10/5 ledger (complete: all; partial: formally adopted ones). */
function oldLedgerImages(rec) {
  if (!rec) return [];
  const imgs = rec.images || [];
  const picked = rec.completion_state === 'complete' ? imgs
    : rec.completion_state === 'partial_images_adopted_not_complete' ? imgs.filter((im) => truthy(im.formal_parent_scoped_adoption))
    : [];
  // `file` is normally the exact path; tolerate a folder path by appending the image name.
  const resolve = (im) => {
    if (!im.file) return null;
    im = { ...im, file: relocate(im.file) };
    try {
      if (fs.statSync(im.file).isDirectory()) return path.join(im.file, im.name);
    } catch {
      return null;
    }
    return im.file;
  };
  return picked.map((im) => ({ role: String(im.name).slice(0, 2), name: im.name, file: resolve(im), sha256: im.sha256 || null }));
}

/** One adopted image per role (01…05): the current adoption ledger wins per role; the 10/5 ledger fills the rest. */
function adoptedImages(item) {
  const byRole = new Map();
  for (const g of oldLedgerImages(item.ledger)) byRole.set(g.role, g);
  for (const r of item.adoptions || []) byRole.set(r.role, { role: r.role, name: path.basename(r.png), file: relocate(r.png), sha256: r.sha256 || null, adoptedAt: r.adopted_at_utc });
  return [...byRole.values()].filter((g) => g.file && fs.existsSync(g.file)).sort((a, b) => a.role.localeCompare(b.role));
}

/** Newest price/classification database (…/outputs/399商品_価格確認データ_YYYYMMDD.json) anywhere under Codex. */
function latestPriceDb() {
  const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  const hits = [];
  for (const d of ls(CODEX)) for (const t of ls(path.join(CODEX, d))) {
    const out = path.join(CODEX, d, t, 'outputs');
    for (const f of ls(out)) {
      const m = /^399商品_価格確認データ_(\d{8})\.json$/.exec(f);
      if (m) hits.push({ file: path.join(out, f), date: m[1], mtime: fs.statSync(path.join(out, f)).mtimeMs });
    }
  }
  hits.sort((a, b) => b.date.localeCompare(a.date) || b.mtime - a.mtime);
  return hits[0]?.file || null;
}
function loadResearch() {
  const file = latestPriceDb();
  if (!file) return { map: new Map(), file: null };
  const db = readJson(file);
  // ジモティ候補の見立て（寸法・重さ・理由）は同じスレッドの work/classification.json にある。
  const cls = readJsonIf(path.join(path.dirname(file), '..', 'work', 'classification.json'));
  const extra = new Map((cls?.group1 || []).map((g) => [`${g.asin}#${g.number}`, g]));
  const list = (v) => { try { return Array.isArray(v) ? v : JSON.parse(v || '[]'); } catch { return []; } };
  const map = new Map();
  for (const r of db.rows || []) {
    const g = extra.get(`${r.asin}#${r.number}`);
    map.set(r.asin, {
      source: path.basename(file),
      checkedDate: r.checked_date || '',
      number: Number(r.number) || r.number,
      group: r.classification || '',
      amazonPrice: r.current_price_jpy ? Number(r.current_price_jpy) : null,
      priceKind: r.price_kind || '',
      priceStatus: r.price_status || '',
      liveTitle: r.live_title || '',
      liveVariant: r.live_variant || '',
      reviewNote: r.review_note || '',
      discounts: list(r.conditional_discounts),
      url: r.url || '',
      ...(g ? { jimoty: { priority: g.priority || '', dimensions: g.dimensions || '', weightNote: g.weight_note || '', weightKg: g.weight_kg && g.weight_kg !== 'None' ? Number(g.weight_kg) : null, reason: g.reason || '', checks: g.checks || '' } } : {}),
    });
  }
  return { map, file };
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'x-actor': ACTOR, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${json.error || ''}`);
  return json;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-import-'));
async function resized(file, maxPx, tag) {
  const out = path.join(TMP, `${tag}-${process.hrtime.bigint()}.jpg`);
  await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', String(maxPx), file, '--out', out]);
  const buf = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  return buf;
}
async function uploadPhoto(productId, file, meta) {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const fd = new FormData();
  for (const [k, v] of Object.entries(meta)) if (v != null && v !== '') fd.append(k, String(v));
  fd.append('original', new Blob([readSafe(file)], { type: mime }), path.basename(file));
  // Work copy only when the original is large (generated PNGs); a thumbnail for every image keeps the list light on the iPhone.
  if (mime === 'image/png' || fs.statSync(file).size > 600_000) fd.append('work', new Blob([await resized(file, 1600, 'w')], { type: 'image/jpeg' }), 'work.jpg');
  fd.append('thumb', new Blob([await resized(file, 400, 't')], { type: 'image/jpeg' }), 'thumb.jpg');
  return api('POST', `/api/products/${productId}/photos`, fd);
}

/** The parts of the source that the app mirrors; compared run-to-run to find updates. */
function sourceOf(item) {
  const { asin } = item;
  const ms = readJsonIf(path.join(SRC.manuscripts, asin, 'manuscript.json')) || {};
  const rs = readJsonIf(path.join(SRC.resale, asin, 'manuscript.json'));
  const refs = (readJsonIf(path.join(SRC.manuscripts, asin, 'reference_inventory.json')) || []).map((r) => ({ ...r, original_path: relocate(r.original_path) })).filter((r) => r.original_path && fs.existsSync(r.original_path));
  const gens = adoptedImages(item).map((g) => ({ ...g, sha256: g.sha256 || sha256File(g.file) }));
  // 販売用原稿（在庫の実物向け）があればそれを正本にする。通常原稿は候補として残す。
  const text = rs?.description ? rs : ms;
  return {
    name: (text.product || ms.product || item.product || asin).trim(),
    description: text.description || '',
    purchaseReason: text.purchase_reason || '',
    resale: !!rs?.description,
    main: { product: ms.product || '', description: ms.description || '', purchaseReason: ms.purchase_reason || '' },
    resaleText: rs?.description ? { product: rs.product || '', description: rs.description || '', purchaseReason: rs.purchase_reason || '' } : null,
    hasGenerated: gens.length > 0,
    url: item.sourceUrl || `https://www.amazon.co.jp/dp/${asin}`,
    refs,
    gens,
  };
}
/** Texts the user can pick from in the app (the server keeps earlier versions as 旧版). */
function candidatesOf(src) {
  const out = [];
  const add = (key, field, label, text) => text && out.push({ key, field, label, text, source: '399商品 原稿' });
  const desc = (d) => d && descriptionFrom({ description: d, hasGenerated: src.hasGenerated });
  if (src.resaleText) {
    add('resale:title', 'title', '販売用原稿の商品名（在庫向け）', toTitle(src.resaleText.product));
    add('resale:description', 'description', '販売用原稿の説明（在庫向け）', desc(src.resaleText.description));
    add('resale:reason', 'description', '販売用原稿の購入理由', src.resaleText.purchaseReason);
  }
  add('main:title', 'title', '通常原稿の商品名', src.main.product && toTitle(src.main.product));
  add('main:description', 'description', '通常原稿の説明', desc(src.main.description));
  add('main:reason', 'description', '通常原稿の購入理由', src.main.purchaseReason);
  return out;
}

const baselineOf = (src) => ({ name: src.name, description: src.description, purchaseReason: src.purchaseReason, hasGenerated: src.hasGenerated, images: Object.fromEntries(src.gens.map((g) => [g.name, g.sha256])) });

async function getProduct(id) {
  const r = await api('GET', `/api/products/${id}`);
  return r.product || r;
}

async function importOne(item, state, ledger) {
  const { asin } = item;
  const src = sourceOf(item);
  if (DRY) return { asin, name: src.name, refs: src.refs.length, gens: src.gens.length, existing: !!state[asin] };

  let id = state[asin]?.id;
  if (id) {
    try { await getProduct(id); } catch { id = null; }
  }
  const created = !id;
  if (created) {
    const desc = descriptionFrom(src);
    const notes = [
      `ASIN: ${asin}`,
      `原稿: ${AUDIT_LABEL[item.audit] || item.audit || '不明'}`,
      `紹介画像: ${COMPLETION_LABEL[item.ledger?.completion_state] || '未採用'}（取り込み${src.gens.length}枚）`,
      '取り込み元: 399商品 素材・原稿・採用画像（2026-10-05）',
    ].join('\n');
    const { product } = await api('POST', '/api/products', {
      name: src.name,
      notes,
      'listing.title': toTitle(src.name),
      ...(desc ? { 'listing.description': desc } : {}),
      ...(aiNotesFrom(src) ? { 'listing.aiNotes': aiNotesFrom(src) } : {}),
      links: [{ url: src.url, type: 'purchase', label: 'Amazon' }],
    });
    id = product.id;
    state[asin] = { id };
    saveState(state);
  }

  // Reference images never change the listing; just make sure they are all present (skip ones already uploaded).
  const have = new Set((await getProduct(id)).photos.map((ph) => ph.clientId).filter(Boolean));
  for (const ref of src.refs) {
    const base = path.basename(ref.original_path);
    if (have.has(`${asin}:ref:${base}`)) continue;
    await uploadPhoto(id, ref.original_path, { kind: 'reference', source: 'reference', note: `Amazon商品ページ画像 ${base}`, sourceUrl: src.url, clientId: `${asin}:ref:${base}` });
  }

  const changes = await syncGenerated(asin, id, src, created, ledger);
  if (!created && state[asin].source) changes.push(...(await syncText(asin, id, src, state[asin].source, ledger)));
  await api('POST', `/api/products/${id}/text-candidates`, { items: candidatesOf(src) });
  if (item.research) await api('PUT', `/api/products/${id}/research`, { research: { ...item.research, importedAt: new Date().toISOString() } });
  state[asin] = { id, source: baselineOf(src) };
  saveState(state);
  return { asin, id, name: src.name, refs: src.refs.length, gens: src.gens.length, changes: changes.length };
}

/** Adopted generated images: add new versions, swap them into the listing order, drop images no longer adopted. */
async function syncGenerated(asin, id, src, created, ledger) {
  let p = await getProduct(id);
  const live = p.photos.filter((ph) => !ph.deletedAt && ph.kind === 'generated' && ph.clientId?.startsWith(`${asin}:gen:`));
  // Without fingerprints every image would look "changed" (an older server that predates sha256). Stop instead of guessing.
  if (live.some((ph) => !ph.sha256)) throw new Error('写真に指紋(sha256)がありません。サーバーを最新版で再起動してから実行してください（誤った差し替えを防ぐため中止）');
  const nameOf = (ph) => ph.clientId.slice(`${asin}:gen:`.length).replace(/:[0-9a-f]{12}$/, '');
  const roleOf = (ph) => nameOf(ph).slice(0, 2);
  const swapped = new Map();
  const mercariIds = new Set([...(p.channels?.mercari?.listed?.photos || p.channels?.mercari?.entered?.photos || [])].map((x) => x.id));
  let order = [...p.listingPhotoIds];
  const changes = [];
  const currentIds = [];
  for (const g of src.gens) {
    const same = live.find((ph) => roleOf(ph) === g.role && ph.sha256 === g.sha256);
    if (same) { currentIds.push(same.id); continue; }
    const olds = live.filter((ph) => roleOf(ph) === g.role);
    const clientId = `${asin}:gen:${g.role}:${g.sha256.slice(0, 12)}`;
    const { photo } = await uploadPhoto(id, g.file, { kind: 'generated', source: 'generated', note: `紹介画像 ${g.name}`, clientId });
    currentIds.push(photo.id);
    if (created && !olds.length) continue;
    const old = olds.find((ph) => order.includes(ph.id)) || olds[0];
    if (old) swapped.set(old.id, photo.id);
    if (old && order.includes(old.id)) order = order.map((x) => (x === old.id ? photo.id : x));
    else if (!order.includes(photo.id)) order.push(photo.id);
    for (const o of olds) await api('PATCH', `/api/products/${id}/photos/${o.id}`, { note: `旧版（${today()} の更新で差し替え）紹介画像 ${g.name}` });
    changes.push({ kind: '画像', item: g.name, change: old ? '差し替え' : '追加', oldSha: old?.sha256, newSha: g.sha256, oldPhotoId: old?.id, newPhotoId: photo.id, inMercari: !!old && mercariIds.has(old.id) });
  }
  const adoptedRoles = new Set(src.gens.map((g) => g.role));
  for (const ph of live.filter((x) => !adoptedRoles.has(roleOf(x)) && order.includes(x.id))) {
    order = order.filter((x) => x !== ph.id);
    changes.push({ kind: '画像', item: nameOf(ph), change: '採用から外れた', oldSha: ph.sha256, oldPhotoId: ph.id, inMercari: mercariIds.has(ph.id) });
  }
  // Per-destination photo lists keep the user's choice of roles; swap old versions for the new ones there too.
  for (const [ch, ids] of Object.entries(p.channelPhotos || {})) {
    const next = ids.map((x) => swapped.get(x) || x);
    if (next.join(',') !== ids.join(',')) await api('PUT', `/api/products/${id}/channel-photos/${ch}`, { ids: next });
  }
  if (created && currentIds.length && !p.listingPhotoIds.length) order = currentIds.slice(0, 20);
  let applied = '反映';
  if (order.join(',') !== p.listingPhotoIds.join(',')) {
    p = await api('PUT', `/api/products/${id}/listing-photos`, { ids: order.slice(0, 20) }).then((r) => r.product || r);
    if (p.proposals?.listingPhotos) applied = '提案（出品用写真はユーザー確定済み）';
  }
  for (const c of changes) ledger.push(entry(asin, p, { ...c, applied }));
  return changes;
}

/** Manuscript text: update only what the app still holds as imported; otherwise let the user decide. */
async function syncText(asin, id, src, base, ledger) {
  const p = await getProduct(id);
  const fields = [
    ['name', '商品名', base.name, src.name],
    ['listing.title', 'タイトル', toTitle(base.name), toTitle(src.name)],
    ['listing.description', '説明文', descriptionFrom(base), descriptionFrom(src)],
    ['listing.aiNotes', 'AIメモ（購入理由）', aiNotesFrom(base), aiNotesFrom(src)],
  ];
  const changes = [];
  for (const [field, label, before, after] of fields) {
    if (before === after) continue;
    const current = field.split('.').reduce((o, k) => o?.[k], p) ?? '';
    const locked = !!p.locks?.[field];
    let applied;
    if (!locked && current !== before) applied = '要確認（アプリ側で編集済みのため自動更新せず）';
    else {
      await api('PATCH', `/api/products/${id}`, { set: { [field]: after } });
      applied = locked ? '提案（ユーザー確定済みの項目）' : '反映';
    }
    const c = { kind: '文章', item: label, change: '更新', before, after, applied, inMercari: mercariHas(p, field, current) };
    changes.push(c);
    ledger.push(entry(asin, p, c));
  }
  return changes;
}
const mercariHas = (p, field, value) => {
  const snap = p.channels?.mercari?.listed || p.channels?.mercari?.entered;
  const key = { 'listing.title': 'title', 'listing.description': 'description' }[field];
  return !!snap && !!key && snap[key] === value;
};
const today = () => new Date().toISOString().slice(0, 10);
function entry(asin, p, c) {
  const m = p.channels?.mercari;
  return {
    at: new Date().toISOString(),
    asin,
    productId: p.id,
    productName: p.name,
    ...c,
    mercariStatus: m?.status || '',
  };
}

function writeLedger(newEntries) {
  if (!newEntries.length && fs.existsSync(LEDGER_CSV)) return;
  fs.mkdirSync(IMPORT_DIR, { recursive: true });
  for (const e of newEntries) fs.appendFileSync(LEDGER_JSONL, JSON.stringify(e) + '\n');
  const all = fs.existsSync(LEDGER_JSONL) ? fs.readFileSync(LEDGER_JSONL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const MERCARI = { entered: 'メルカリ下書き', transfer_ok: 'メルカリ下書き（転記QC済）', transfer_ng: 'メルカリ下書き（転記QC要修正）', listed: 'メルカリ出品中', sold: '売却済み', stopped: '出品停止' };
  const cols = [
    ['日時', (e) => e.at.replace('T', ' ').slice(0, 19)], ['ASIN', (e) => e.asin], ['商品ID', (e) => e.productId], ['商品名', (e) => e.productName],
    ['種類', (e) => e.kind], ['項目', (e) => e.item], ['変化', (e) => e.change], ['アプリへの反映', (e) => e.applied],
    ['メルカリの状態', (e) => MERCARI[e.mercariStatus] || '未入力'], ['メルカリに入れた版か', (e) => (e.inMercari ? 'はい（メルカリ側の更新が必要）' : '')],
    ['旧指紋', (e) => e.oldSha?.slice(0, 12) || ''], ['新指紋', (e) => e.newSha?.slice(0, 12) || ''], ['旧写真ID', (e) => e.oldPhotoId || ''], ['新写真ID', (e) => e.newPhotoId || ''],
    ['変更前', (e) => e.before ?? ''], ['変更後', (e) => e.after ?? ''],
  ];
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [cols.map(([h]) => q(h)).join(','), ...all.map((e) => cols.map(([, f]) => q(f(e))).join(','))].join('\r\n');
  fs.writeFileSync(LEDGER_CSV, '﻿' + csv + '\r\n');
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
}

/** One run at a time (a manual run and the scheduled morning/evening run may overlap). */
function acquireLock() {
  const lock = path.join(IMPORT_DIR, '.sync.lock');
  fs.mkdirSync(IMPORT_DIR, { recursive: true });
  try {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        console.log(`別の同期（pid ${pid}）が実行中のため終了します`);
        process.exit(0);
      } catch {
        /* stale lock from a crashed run */
      }
    }
  } catch {
    /* no lock */
  }
  fs.writeFileSync(lock, String(process.pid));
  process.on('exit', () => fs.rmSync(lock, { force: true }));
}

async function main() {
  // SSD を外しているとき（利用者は時々 iPhone に使う）は失敗にせず休む。次の回に続ける。
  if (!fs.existsSync(SRC.assignment)) {
    console.log(`[${new Date().toLocaleString('ja-JP')}] 取り込み元が見つからないので休み: ${CODEX}`);
    return;
  }
  if (!DRY) acquireLock();
  console.log(`[${new Date().toLocaleString('ja-JP')}] 同期開始`);
  const rows = parseCsv(fs.readFileSync(SRC.assignment, 'utf8'));
  const audit = new Map(readJson(SRC.audit).map((a) => [a.asin, a]));
  const ledger = new Map(readJson(SRC.ledger).records.map((r) => [r.asin, r]));
  // Current adoption ledger: latest formally adopted image per (asin, role).
  const adoptions = new Map();
  for (const r of readJsonIf(SRC.adoption)?.records || []) {
    if (r.status !== 'formally_adopted') continue;
    const m = adoptions.get(r.asin) || new Map();
    const cur = m.get(r.role);
    if (!cur || String(r.adopted_at_utc) > String(cur.adopted_at_utc)) m.set(r.role, r);
    adoptions.set(r.asin, m);
  }
  const research = loadResearch();
  console.log(`価格・分類: ${research.file ? path.basename(research.file) : '見つからず'}`);
  let items = rows.map((r) => ({
    asin: r.asin,
    product: r.product,
    audit: r.final_fulltext_audit_state,
    sourceUrl: audit.get(r.asin)?.source_url,
    ledger: ledger.get(r.asin),
    adoptions: [...(adoptions.get(r.asin)?.values() || [])],
    research: research.map.get(r.asin) || null,
  }));
  if (ONLY) items = items.filter((it) => ONLY.has(it.asin));
  items = items.slice(0, LIMIT);
  const state = fs.existsSync(STATE_FILE) ? readJson(STATE_FILE) : {};
  console.log(`対象 ${items.length} 商品${DRY ? '（試算のみ）' : ''}`);

  const results = [];
  const failures = [];
  const pending = [];
  const updates = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const it = items[next++];
      try {
        const r = await importOne(it, state, updates);
        results.push(r);
        if (results.length % 20 === 0 || results.length === items.length) console.log(`  ${results.length}/${items.length} 件完了`);
      } catch (e) {
        if (e instanceof Pending) {
          pending.push({ asin: it.asin, reason: e.message });
          continue;
        }
        failures.push({ asin: it.asin, error: e.message });
        console.log(`  失敗 ${it.asin}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  fs.rmSync(TMP, { recursive: true, force: true });
  saveShaCache();
  if (!DRY) writeLedger(updates);

  const sum = (k) => results.reduce((a, r) => a + (r[k] || 0), 0);
  console.log(`完了: ${results.length} 商品 / 生成画像 ${sum('gens')} 枚 / 参考画像 ${sum('refs')} 枚 / 更新 ${updates.length} 件（台帳: ${LEDGER_CSV}）/ 保留 ${pending.length}（iCloud 未ダウンロード。次回再試行）/ 失敗 ${failures.length}`);
  if (DRY) console.log('例:', results.slice(0, 3));
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
