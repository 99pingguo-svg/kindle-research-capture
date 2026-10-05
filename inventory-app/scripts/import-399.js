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
const CODEX = process.env.CODEX_399_ROOT || path.join(os.homedir(), 'Documents/Codex');
const R = path.join(CODEX, '2026-10-04/task/recovery_audit_20261004');
const SRC = {
  assignment: path.join(R, 'iphone_work_handoff_20261004/399_assignment.csv'),
  audit: path.join(R, 'audit_399_current_copy.json'),
  manuscripts: path.join(R, 'iphone_work_handoff_20261004/master_manuscripts/products'),
  ledger: path.join(CODEX, '2026-10-02/task/promotion_completion_ledger.json'),
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
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const readJsonIf = (f) => (fs.existsSync(f) ? readJson(f) : null);
const truthy = (v) => v === true || v === 'True' || v === 'true';
const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
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

function adoptedImages(rec) {
  if (!rec) return [];
  const imgs = rec.images || [];
  const picked = rec.completion_state === 'complete' ? imgs
    : rec.completion_state === 'partial_images_adopted_not_complete' ? imgs.filter((im) => truthy(im.formal_parent_scoped_adoption))
    : [];
  // `file` is normally the exact path; tolerate a folder path by appending the image name.
  const resolve = (im) => {
    if (!im.file) return null;
    try {
      if (fs.statSync(im.file).isDirectory()) return path.join(im.file, im.name);
    } catch {
      return null;
    }
    return im.file;
  };
  return picked
    .map((im) => ({ name: im.name, file: resolve(im) }))
    .filter((im) => im.file && fs.existsSync(im.file) && fs.statSync(im.file).isFile())
    .sort((a, b) => a.name.localeCompare(b.name));
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
  fd.append('original', new Blob([fs.readFileSync(file)], { type: mime }), path.basename(file));
  // Work copy only when the original is large (generated PNGs); a thumbnail for every image keeps the list light on the iPhone.
  if (mime === 'image/png' || fs.statSync(file).size > 600_000) fd.append('work', new Blob([await resized(file, 1600, 'w')], { type: 'image/jpeg' }), 'work.jpg');
  fd.append('thumb', new Blob([await resized(file, 400, 't')], { type: 'image/jpeg' }), 'thumb.jpg');
  return api('POST', `/api/products/${productId}/photos`, fd);
}

/** The parts of the source that the app mirrors; compared run-to-run to find updates. */
function sourceOf(item) {
  const { asin } = item;
  const ms = readJsonIf(path.join(SRC.manuscripts, asin, 'manuscript.json')) || {};
  const refs = (readJsonIf(path.join(SRC.manuscripts, asin, 'reference_inventory.json')) || []).filter((r) => r.original_path && fs.existsSync(r.original_path));
  const gens = adoptedImages(item.ledger).map((g) => ({ ...g, sha256: sha256File(g.file) }));
  return {
    name: (ms.product || item.product || asin).trim(),
    description: ms.description || '',
    purchaseReason: ms.purchase_reason || '',
    hasGenerated: gens.length > 0,
    url: item.sourceUrl || `https://www.amazon.co.jp/dp/${asin}`,
    refs,
    gens,
  };
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
  const mercariIds = new Set([...(p.channels?.mercari?.listed?.photos || p.channels?.mercari?.entered?.photos || [])].map((x) => x.id));
  let order = [...p.listingPhotoIds];
  const changes = [];
  const currentIds = [];
  for (const g of src.gens) {
    const same = live.find((ph) => nameOf(ph) === g.name && ph.sha256 === g.sha256);
    if (same) { currentIds.push(same.id); continue; }
    const olds = live.filter((ph) => nameOf(ph) === g.name);
    const clientId = olds.length ? `${asin}:gen:${g.name}:${g.sha256.slice(0, 12)}` : `${asin}:gen:${g.name}`;
    const { photo } = await uploadPhoto(id, g.file, { kind: 'generated', source: 'generated', note: `紹介画像 ${g.name}`, clientId });
    currentIds.push(photo.id);
    if (created && !olds.length) continue;
    const old = olds.find((ph) => order.includes(ph.id)) || olds[0];
    if (old && order.includes(old.id)) order = order.map((x) => (x === old.id ? photo.id : x));
    else if (!order.includes(photo.id)) order.push(photo.id);
    for (const o of olds) await api('PATCH', `/api/products/${id}/photos/${o.id}`, { note: `旧版（${today()} の更新で差し替え）紹介画像 ${g.name}` });
    changes.push({ kind: '画像', item: g.name, change: old ? '差し替え' : '追加', oldSha: old?.sha256, newSha: g.sha256, oldPhotoId: old?.id, newPhotoId: photo.id, inMercari: !!old && mercariIds.has(old.id) });
  }
  const adoptedNames = new Set(src.gens.map((g) => g.name));
  for (const ph of live.filter((x) => !adoptedNames.has(nameOf(x)) && order.includes(x.id))) {
    order = order.filter((x) => x !== ph.id);
    changes.push({ kind: '画像', item: nameOf(ph), change: '採用から外れた', oldSha: ph.sha256, oldPhotoId: ph.id, inMercari: mercariIds.has(ph.id) });
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
  if (!DRY) acquireLock();
  console.log(`[${new Date().toLocaleString('ja-JP')}] 同期開始`);
  const rows = parseCsv(fs.readFileSync(SRC.assignment, 'utf8'));
  const audit = new Map(readJson(SRC.audit).map((a) => [a.asin, a]));
  const ledger = new Map(readJson(SRC.ledger).records.map((r) => [r.asin, r]));
  let items = rows.map((r) => ({
    asin: r.asin,
    product: r.product,
    audit: r.final_fulltext_audit_state,
    sourceUrl: audit.get(r.asin)?.source_url,
    ledger: ledger.get(r.asin),
  }));
  if (ONLY) items = items.filter((it) => ONLY.has(it.asin));
  items = items.slice(0, LIMIT);
  const state = fs.existsSync(STATE_FILE) ? readJson(STATE_FILE) : {};
  console.log(`対象 ${items.length} 商品${DRY ? '（試算のみ）' : ''}`);

  const results = [];
  const failures = [];
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
        failures.push({ asin: it.asin, error: e.message });
        console.log(`  失敗 ${it.asin}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  fs.rmSync(TMP, { recursive: true, force: true });
  if (!DRY) writeLedger(updates);

  const sum = (k) => results.reduce((a, r) => a + (r[k] || 0), 0);
  console.log(`完了: ${results.length} 商品 / 生成画像 ${sum('gens')} 枚 / 参考画像 ${sum('refs')} 枚 / 更新 ${updates.length} 件（台帳: ${LEDGER_CSV}）/ 失敗 ${failures.length}`);
  if (DRY) console.log('例:', results.slice(0, 3));
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
