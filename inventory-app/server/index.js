// 商品台帳 server: REST API for the PWA, MCP endpoint for AI agents, static files.
// Zero dependencies — run with `node server/index.js` (Node 20+).
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import zlib from 'node:zlib';
import { X509Certificate, timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, isUser } from './store.js';
import { shippingMeta } from './shipping.js';
import { CATEGORIES } from './category.js';
import { AppError, nowIso } from './util.js';
import { readBody, parseMultipart } from './multipart.js';
import { summary, readiness, lint, channelPackage, suggestedTargets, bulkPrice } from './rules.js';
import { writeZip } from './zip.js';
import { createStudio } from './studio.js';
import { createCodeReader } from './codes.js';
import { createCategorizer } from './categorize.js';
import { createOfficialFetcher } from './official.js';
import { agentQueue } from './hub.js';
import { createTray } from './tray.js';
import { createDefaults } from './defaults.js';
import { exportEntries, productsCsv, officialEntries, officialStats, materialsEntries } from './export.js';
import { createMcpHandler, matchesFilter } from './mcp.js';
import * as mercari from './adapters/mercari.js';
import * as channels from './channels.js';
import * as schema from './schema.js';
import { parseLine, importDates } from './dates.js';
import { Books, BOOK_KINDS, BOOK_STATUSES } from './books.js';
import { Prices } from './prices.js';
import { DateIds } from './dateid.js';
import { parseMercariSales } from './adapters/mercari-sales.js';
import { FLAGS as BOOK_FLAGS } from './classify.js';
import { productReport, yearReport } from './book-report.js';
import { simulate, scenarios, TAX_YEARS } from './tax.js';
import { scanLookup, scanCard, recentScans, importScans, checkScanDuplicates, registerFromScan } from './scan.js';
import { browserBrief, browserSyncOverview, imageFile, isVineProvided, BROWSER_LISTS, IMAGE_STATES } from './browser-sync.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.heic': 'image/heic',
  '.heif': 'image/heif', '.gif': 'image/gif', '.txt': 'text/plain; charset=utf-8',
};

export function createApp({ dataDir, token = '', background = !process.env.NODE_TEST_CONTEXT } = {}) {
  const store = new Store(dataDir);
  const mcp = createMcpHandler(store);
  const sseClients = new Set();
  store.on('change', (ev) => {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of sseClients) res.write(line);
  });

  // Auto-finishing of newly shot photos (white background / crop / colour), one at a time in the background.
  const studio = createStudio(store);
  const codes = createCodeReader(store);
  // 撮影トレイ: 純正カメラの写真はまずここへ。ユーザーが登録したら商品の写真になり、自動仕上げ・番号読み取りへ。
  const tray = createTray(store, { onRegistered: (id, photo) => { studio.enqueue(id, photo); codes.enqueue(id, photo); } });
  createDefaults(store);
  // 種類の自動分類と公式画像の自動取得（テストでは動かさない: 外へ取りに行くため）
  const categorizer = background ? createCategorizer(store) : null;
  const official = background ? createOfficialFetcher(store, { port: Number(process.env.PORT || 8787) }) : null;
  const books = new Books(store.dataDir);
  const prices = new Prices(store.dataDir);
  const dateIds = new DateIds(store.dataDir);
  if (background) dateIds.watch(store);
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler });
  };

  // 観察ブラウザ連携（どの一覧か・画像取得の状況）は台帳の外のファイルも見るので、summary の外で足す。
  const sm = (p) => ({ ...summary(p, store.settings), browser: browserBrief(p), vineOrderDate: p.browser?.vineOrderDate || null, vineProvided: isVineProvided(p) });
  const full = (p) => ({
    ...p,
    hasJmtyOverride: !!(p.override?.jmty?.title || p.override?.jmty?.description),
    summary: sm(p),
    readiness: readiness(p, store.settings),
    lint: lint(p, store.settings),
  });

  // ---- meta / settings ----
  route('GET', '/api/meta', () => ({
    delivery: shippingMeta(), categories: CATEGORIES, stages: schema.STAGES, decisions: schema.DECISIONS, fields: schema.FIELDS, conditions: schema.MERCARI_CONDITIONS,
    linkTypes: schema.LINK_TYPES, photoTags: schema.PHOTO_TAGS, factConfidence: schema.FACT_CONFIDENCE,
    aiTaskTypes: schema.AI_TASK_TYPES, qcChecks: schema.QC_CHECKS, limits: schema.MERCARI_LIMITS,
    presence: schema.PRESENCE, reviewStatuses: schema.REVIEW_STATUSES, reviewFormats: schema.REVIEW_FORMATS,
    shipping: { payers: schema.SHIPPING_PAYERS, methods: schema.SHIPPING_METHODS, days: schema.SHIPPING_DAYS, prefectures: schema.PREFECTURES },
    settings: store.settings, dataDir: store.dataDir, mcpPath: '/mcp',
    channels: schema.CHANNELS, observedStatuses: schema.OBSERVED_STATUSES, photoKinds: schema.PHOTO_KINDS, channelChecks: store.meta.channelChecks || {},
    browserLists: BROWSER_LISTS, imageStates: IMAGE_STATES,
  }));
  route('PUT', '/api/settings', ({ body, actor }) => {
    if (!isUser(actor)) throw new AppError(403, '設定変更はユーザーのみ');
    return store.updateSettings(body);
  });

  // ---- products ----
  route('GET', '/api/products', ({ query }) => {
    let list = store.list();
    if (query.ids) {
      const ids = new Set(query.ids.split(','));
      list = list.filter((p) => ids.has(p.id));
    }
    return list.map(sm);
  });
  route('POST', '/api/products', ({ body, actor }) => {
    const { links = [], allowDuplicate = true, ...fields } = body || {};
    const { product, duplicates } = store.create(fields, actor, { links, allowDuplicate });
    return { product: full(product), duplicates };
  });
  route('POST', '/api/import', ({ body, actor }) => {
    const items = parseImport(body?.text || '');
    const existing = store.list();
    const seen = [];
    const preview = items.map((it) => {
      const dups = [...store.duplicatesFor(it), ...seen.filter((x) => x.name && it.name && x.name === it.name).map((x) => ({ id: '(同じ入力内)', name: x.name, reasons: ['同名'] }))];
      seen.push(it);
      return { ...it, duplicates: dups };
    });
    if (body?.dryRun) return { items: preview, existing: existing.length };
    const skip = new Set(body?.skip || []);
    const created = [];
    preview.forEach((it, i) => {
      if (skip.has(i)) return;
      const fields = { name: it.name };
      for (const k of ['itemDate', 'orderDate', 'arrivalDate']) if (it[k]) fields[k] = it[k];
      if (body?.decision) fields.decision = body.decision;
      if (body?.shootPlan) fields.shootPlan = true;
      created.push(store.create(fields, actor, { links: it.links }).product.id);
    });
    return { created };
  });
  // 日付の一括反映 (existing products only; unmatched rows are ignored)
  route('POST', '/api/dates/import', ({ body, actor }) =>
    importDates(store, actor, { text: body?.text || '', dryRun: body?.dryRun !== false, include: body?.include || [], field: body?.field || 'itemDate' }));
  route('GET', '/api/products/:id', ({ params }) => full(store.get(params.id)));
  route('PATCH', '/api/products/:id', ({ params, body, actor }) => {
    const { set, append, confirm, unlock, expectedRev } = body || {};
    let r = { proposed: [] };
    if ((set && Object.keys(set).length) || (append && Object.keys(append).length)) {
      r = store.updateFields(params.id, actor, set, { append, expectedRev });
    }
    if (confirm?.length) store.confirmFields(params.id, actor, confirm);
    if (unlock?.length) store.unlockFields(params.id, actor, unlock);
    return { product: full(store.get(params.id)), proposed: r.proposed };
  });
  route('POST', '/api/products/:id/decision', ({ params, body, actor }) => full(store.setDecision(params.id, actor, body.decision)));
  route('POST', '/api/products/:id/stage', ({ params, body, actor }) => full(store.setStage(params.id, actor, body.stage, { note: body.note })));
  route('POST', '/api/products/:id/archive', ({ params, body, actor }) => full(store.setArchived(params.id, actor, body.archived !== false)));
  const notifyAozoraShelf = (req, id, onShelf) => {
    if (req?.headers?.['x-from-aozora'] === '1') return;
    fetch('http://127.0.0.1:8790/api/daicho-webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8790', 'x-daicho-sync': '1' },
      body: JSON.stringify({ ids: [id], onShelf: !!onShelf }),
    }).catch(() => {});
  };
  route('POST', '/api/products/:id/aside', ({ params, body, actor }) => full(store.setAside(params.id, actor, body?.on !== false)));
  // 観察ブラウザ連携（Mac の sync.py）が書く: どの一覧に入っているか。null で外す。
  route('PUT', '/api/products/:id/browser', ({ params, body, actor }) => sm(store.setBrowserInfo(params.id, actor, body?.browser ?? null)));
  // 日付ID: 注文の一覧（文字・観察ブラウザの JSON）を取り込み、日ごとの注文順から番号をつける（server/dateid.js）。
  route('GET', '/api/date-ids', () => dateIds.view(store.list()));
  // ---- iPhone「台帳スキャン」: 読んだバーコード・ラベルの文字 → 候補と読み上げ文。決めた商品は「ある」＋FNSKU を記録 ----
  route('POST', '/api/scan', ({ body }) => scanLookup(store.list().map(sm), {
    codes: (Array.isArray(body?.codes) ? body.codes : []).map(String).slice(0, 20),
    lines: (Array.isArray(body?.lines) ? body.lines : []).map(String).slice(0, 80),
  }));
  route('POST', '/api/scan/confirm', ({ body, actor }) => {
    const id = String(body?.id || '');
    store.get(id);
    const rawFnsku = String(body?.fnsku ?? '').trim();
    const presence = body?.presence !== false;
    // 「ある」を付けるのは今までどおりユーザーだけ（setPresence と同じ境界）。
    if (presence && !isUser(actor)) throw new AppError(403, 'あるかないかのチェックはユーザーのみ実行できます（AIの権限外）', 'forbidden');
    const scannedAt = body?.scannedAt ? String(body.scannedAt) : new Date().toISOString();
    const operationId = body?.operationId ? String(body.operationId).trim() : '';
    const { product, conflict, idempotent } = store.recordScan(id, actor, {
      fnsku: rawFnsku,
      scannedAt,
      presence,
      via: 'confirm',
      operationId,
      strictFnsku: true,
    });
    return { ...scanCard(sm(product), '', 0, recentScans(product)), noted: conflict || '', ...(idempotent ? { idempotent: true } : {}) };
  });
  // FNSKU の専用訂正操作（履歴に旧番号・新番号・理由・操作IDを残す。scanEvents は書き換えない）。
  route('POST', '/api/products/:id/fnsku/correct', ({ params, body, actor }) => {
    const { product, correction, idempotent } = store.correctFnsku(params.id, actor, {
      newFnsku: body?.newFnsku ?? '',
      reason: body?.reason ?? '',
      operationId: body?.operationId ?? '',
    });
    return { product: full(product), correction, ...(idempotent ? { idempotent: true } : {}) };
  });
  // 読み取り専用の FNSKU 整合性チェック（確実な異常・説明可能な差異・判定不能の3分類）。
  route('GET', '/api/audit/fnsku', () => store.auditFnskuIntegrity());
  // 誤スキャンイベントの無効化（物理削除せずマークし、有効記録から在庫確認状態を再計算）。
  route('POST', '/api/products/:id/scan-events/:eventId/invalidate', ({ params, body, actor }) => {
    const { product, event } = store.invalidateScanEvent(params.id, actor, params.eventId, body?.reason ?? '');
    return { product: full(product), event };
  });
  // 新規登録前の重複・類似チェック（同じ FNSKU や似た既存商品を返す）。
  route('POST', '/api/scan/check-duplicates', ({ body }) => checkScanDuplicates(store, {
    fnsku: body?.fnsku, name: body?.name, brand: body?.brand, model: body?.model, jan: body?.jan, url: body?.url,
    lines: Array.isArray(body?.lines) ? body.lines.map(String).slice(0, 40) : [],
  }));
  // 状態C等から新規商品を登録し、FNSKU＋スキャン記録までまとめて確定する。
  route('POST', '/api/scan/register', ({ body, actor }) => registerFromScan(store, actor, body || {}));
  // 台帳スキャンの記録をまとめて取り込む（既定 dryRun）。{ records: [{ fnsku, scannedAt, productId?, asin? }] }
  route('POST', '/api/scan/import', ({ body, actor }) => importScans(store, actor, { records: body?.records, dryRun: body?.dryRun !== false }));
  // 一番新しいスキャンを取り消す（前の値へ戻す。記録は「取り消し済み」として残る）。
  route('POST', '/api/scan/undo', ({ body, actor }) => {
    const id = String(body?.productId || body?.id || '');
    const { product, undone, kept } = store.undoScan(id, actor);
    return { ...scanCard(sm(product), '', 0, recentScans(product)), undone, kept };
  });
  route('POST', '/api/date-ids/refresh', ({ actor }) => ({ applied: dateIds.refresh(store, actor) }));
  route('POST', '/api/date-ids/import', ({ body, actor }) => dateIds.importList(store, actor, {
    text: body?.text, rows: body?.rows, from: String(body?.from || '').slice(0, 80), dryRun: body?.dryRun !== false,
  }));
  route('GET', '/api/browser-sync', () => browserSyncOverview(store.list()));
  route('GET', '/api/browser-images/:asin', ({ res, params }) => {
    // Small JPEGs (one per product): sent in one go so the route has answered before it returns.
    const buf = fs.readFileSync(imageFile(params.asin));
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=300', 'content-length': buf.length });
    res.end(buf);
  });
  route('POST', '/api/products/:id/open-check', ({ params, body, actor }) => full(store.setOpenChecked(params.id, actor, body?.on !== false)));
  route('POST', '/api/products/:id/stock-check', ({ req, params, body, actor }) => {
    const on = body?.checked !== undefined ? !!body.checked : body?.on !== false;
    const p = store.setStockChecked(params.id, actor, on);
    notifyAozoraShelf(req, params.id, on);
    return full(p);
  });
  // あるかないか（ユーザーのみ）: have / gone / unknown / null。あおぞら市の棚の印も合わせる。
  route('POST', '/api/products/:id/presence', ({ req, params, body, actor }) => {
    const state = body?.state ?? null;
    const p = store.setPresence(params.id, actor, state);
    notifyAozoraShelf(req, params.id, state === 'have');
    return full(p);
  });
  // レビュー・発信の予定（ユーザーは全部、AI は下書きと投稿済みの報告だけ）
  route('PUT', '/api/products/:id/review-plan', ({ params, body, actor }) => full(store.setReviewPlan(params.id, actor, body || {})));
  // AI エージェントの「やること」一覧（レビューの下書き・投稿OKの投稿・出品）
  route('GET', '/api/agent/queue', () => agentQueue(store, store.settings));
  // 素材Zip: ?ids=0001,0002（無ければ ?presence=have のように絞った全部）。公式画像・写真・仕上げ・紹介画像・情報・下書き。
  route('GET', '/api/materials.zip', async ({ res, query }) => {
    let list = store.list({ includeTrash: false });
    if (query.ids) { const ids = new Set(String(query.ids).split(',')); list = list.filter((p) => ids.has(p.id)); }
    if (query.presence) list = list.filter((p) => (sm(p).presence || 'none') === query.presence);
    if (list.length > 600) throw new AppError(400, '一度に600件までです（絞ってください）');
    const browserImage = (asin) => { try { return imageFile(asin); } catch { return null; } };
    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="materials-${stamp()}.zip"` });
    await writeZip(res, materialsEntries(store, list, { browserImage, settings: store.settings }));
    res.end();
  });
  route('GET', '/api/auto-jobs', () => ({ official: official?.status() || null }));
  route('POST', '/api/categorize/run', async () => ({ classified: categorizer ? await categorizer.sweep() : 0 }));
  route('POST', '/api/official/run', () => ({ started: official ? official.run() : false }));
  route('POST', '/api/products/:id/stock-unknown', ({ req, params, body, actor }) => {
    const on = body?.on !== false;
    const p = store.setStockUnknown(params.id, actor, on);
    if (on) notifyAozoraShelf(req, params.id, false);
    return full(p);
  });
  route('POST', '/api/products/:id/shoot-plan', ({ params, body, actor }) => full(store.setShootPlan(params.id, actor, body.on !== false)));
  route('POST', '/api/products/:id/shoot-done', ({ params, body, actor }) => full(store.shootDone(params.id, actor, { requestAi: body?.requestAi !== false })));
  route('POST', '/api/products/:id/trash', ({ params, actor }) => full(store.trash(params.id, actor)));
  route('POST', '/api/products/:id/restore', ({ params, actor }) => full(store.restore(params.id, actor)));
  route('DELETE', '/api/products/:id', ({ params, query, actor }) => {
    store.purge(params.id, actor, query.confirm);
    return { ok: true };
  });
  route('GET', '/api/products/:id/duplicates', ({ params }) => {
    const p = store.get(params.id);
    return store.duplicatesFor(p, p.id);
  });
  route('POST', '/api/duplicates', ({ body }) => store.duplicatesFor(body || {}));

  // proposals
  route('POST', '/api/products/:id/proposals/:field/:verb', ({ params, actor }) =>
    full(store.resolveProposal(params.id, actor, decodeURIComponent(params.field), params.verb === 'accept')));
  route('POST', '/api/products/:id/facts/:key/:verb', ({ params, actor }) =>
    full(store.resolveFactProposal(params.id, actor, decodeURIComponent(params.key), params.verb === 'accept')));
  route('PUT', '/api/products/:id/facts', ({ params, body, actor }) => full(store.setFacts(params.id, actor, body.facts || [], { replace: !!body.replace })));
  route('DELETE', '/api/products/:id/facts/:key', ({ params, actor }) => full(store.removeFact(params.id, actor, decodeURIComponent(params.key))));

  // links
  route('POST', '/api/products/:id/links', ({ params, body, actor }) => full(store.addLink(params.id, actor, body)));
  route('PATCH', '/api/products/:id/links/:lid', ({ params, body, actor }) => full(store.updateLink(params.id, actor, params.lid, body)));
  route('DELETE', '/api/products/:id/links/:lid', ({ params, actor }) => full(store.removeLink(params.id, actor, params.lid)));

  // photos
  route('POST', '/api/products/:id/photos', async ({ params, req, actor }) => {
    store.get(params.id);
    const { fields, files } = parseMultipart(await readBody(req), req.headers['content-type']);
    let edit = null;
    try {
      edit = fields.edit ? JSON.parse(fields.edit) : null;
    } catch {
      edit = null;
    }
    const { photo, duplicate } = store.addPhoto(params.id, actor, { ...fields, edit, replaceInListing: fields.replaceInListing === 'true' }, files);
    // A scan photo only proves the item was here that day; manual_camera / manual_library must never mutate FNSKU.
    if (!duplicate) {
      if (photo.source !== 'scan') studio.enqueue(params.id, photo);
      if (!['scan', 'manual_camera', 'manual_library'].includes(photo.source)) codes.enqueue(params.id, photo);
    }
    return { photo, duplicate, product: sm(store.get(params.id)) };
  });
  // ---- 純正カメラ連携: アプリで撮影対象を決め → iPhone の「カメラ」で撮影 → ショートカットが撮った写真を送る ----
  const shootInfo = () => {
    const ns = store.nativeShoot;
    if (!ns) return { active: false };
    const p = store.get(ns.productId);
    // sinceLocal: the Mac's local time as "2026/10/29 18:30:05", which the Shortcuts app reads reliably as a date.
    const d = new Date(ns.since);
    const pad = (n) => String(n).padStart(2, '0');
    const sinceLocal = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return { active: true, productId: p.id, name: p.name, since: ns.since, sinceLocal, photos: tray.list({ productId: p.id }).filter((x) => x.status === 'new' && x.receivedAt >= ns.at).length };
  };
  // ショートカットからの連絡の記録（最新20件、メモリだけ）: つながっているか・何で失敗したかをアプリで見せる。
  const shortcutContacts = [];
  const contact = (what, result, ok = true) => {
    shortcutContacts.unshift({ at: nowIso(), what, result, ok });
    shortcutContacts.length = Math.min(shortcutContacts.length, 20);
  };
  route('GET', '/api/native-shoot', ({ req }) => {
    const info = shootInfo();
    if (req.headers['x-upload-key']) contact('撮影中の商品を確認', info.active ? `#${info.productId} を受け付け中` : '撮影中の商品なし（アプリで撮影を始めていない）', info.active);
    return info;
  });
  route('GET', '/api/native-shoot/contacts', () => ({ contacts: shortcutContacts }));
  // 撮影トレイ（候補の写真）: 一覧・画像・登録／保留／破棄（ユーザーのみ）
  route('GET', '/api/tray', ({ query }) => ({ items: tray.list({ productId: query.productId || null }) }));
  route('GET', '/api/tray/:id/:variant', ({ res, params }) => {
    const buf = fs.readFileSync(tray.file(params.id, params.variant));
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600', 'content-length': buf.length });
    res.end(buf);
  });
  route('POST', '/api/tray/decide', ({ body, actor }) => tray.decide(actor, Array.isArray(body?.decisions) ? body.decisions : []));
  // 自動仕上げ: 状況と、まだ仕上げていない写真の処理（商品を指定できる）
  // 写真の文字・バーコードを読む（検索用。tools/bin/ocr＝macOS Vision、外部送信なし）。本文 = 画像そのもの。写真は保存しない。
  route('POST', '/api/ocr', async ({ req }) => {
    const tool = path.join(ROOT, 'tools', 'bin', 'ocr');
    if (!fs.existsSync(tool)) throw new AppError(503, '文字認識の道具がありません（npm run build:ocr）');
    const buf = await readBody(req, 20 * 1024 * 1024);
    if (buf.length < 1000) throw new AppError(400, '画像データがありません');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-ocr-'));
    const file = path.join(dir, 'in.jpg');
    try {
      fs.writeFileSync(file, buf);
      const out = await new Promise((resolve, reject) => execFile(tool, [file], { timeout: 30000 }, (e, so) => (e && !so ? reject(e) : resolve(String(so)))));
      const r = JSON.parse(out);
      if (!r.ok) throw new AppError(422, r.error || '文字を読み取れませんでした');
      return { lines: r.lines, barcodes: r.barcodes };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  route('GET', '/api/studio', () => ({ available: studio.available(), pending: studio.pending(), on: store.settings.autoStudio !== false }));
  route('POST', '/api/studio/run', ({ body }) => ({ queued: studio.backfill(Array.isArray(body?.productIds) ? body.productIds.map(String) : null) }));
  // 指定の商品に出品先を既定（緑）として入れる。手で外した出品先を上書きできるのはユーザー本人の操作だけ（AIは空いている所に足すだけ）。
  route('POST', '/api/default-targets', ({ body, actor }) => {
    const ids = [...new Set(Array.isArray(body?.ids) ? body.ids.map(String) : [])];
    if (ids.length > 1000) throw new AppError(400, '一度に1000件まで');
    const reason = String(body?.reason || '依頼').replace(/\s+/g, ' ').slice(0, 80);
    let changed = 0;
    const ch = String(body?.channel || '');
    for (const id of ids) if (body?.remove ? store.unmarkDefaultTarget(id, actor, ch) : store.markDefaultTarget(id, actor, ch, reason)) changed++;
    return { ok: true, count: ids.length, changed };
  });
  // 写真から Amazon 管理番号（FNSKU）を読む: 今ある写真をまとめて（新しい写真は届くたびに自動）。
  route('POST', '/api/codes/backfill', () => ({ queued: codes.backfill() }));
  route('GET', '/api/codes', () => ({ pending: codes.pending() }));
  route('POST', '/api/studio/redo', ({ body }) => ({ queued: studio.redo(Array.isArray(body?.productIds) ? body.productIds.map(String) : null) }));
  route('PUT', '/api/native-shoot', ({ body, actor }) => {
    store.setNativeShoot(actor, String(body?.productId || ''));
    return shootInfo();
  });
  route('DELETE', '/api/native-shoot', ({ actor }) => store.clearNativeShoot(actor) ?? { active: false });
  // The two iPhone shortcuts as signed files (the send one carries the upload key). Opened from the app on the iPhone.
  // A browser link cannot carry x-actor, so the key-bearing file needs a one-time ticket that only the user's key request hands out.
  const shortcutTickets = new Map(); // ticket -> expiry
  route('GET', '/api/native-shoot/shortcut/:which', async ({ params, req, res, query }) => {
    const name = { camera: '台帳カメラ', send: '台帳に送る' }[params.which];
    if (!name) throw new AppError(404, 'not found');
    // 台帳カメラ only opens the Camera (no passphrase inside); 台帳に送る carries it, so it needs the one-time ticket.
    if (params.which === 'send') {
      const exp = shortcutTickets.get(String(query.ticket || ''));
      shortcutTickets.delete(String(query.ticket || ''));
      if (!exp || exp < Date.now()) throw new AppError(403, '設定画面を開き直してから押してください（引換券の期限切れ）');
    }
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
    if (!/^[a-z0-9.:-]+$/i.test(host)) throw new AppError(400, 'ホスト名が不正です');
    // A shortcut made for a Mac-only address can never reach the Mac from the iPhone (it failed silently before).
    if (/^(127\.|localhost|\[::1\])/i.test(host)) throw new AppError(400, 'このアドレス（Mac の中だけ）ではショートカットが iPhone から届きません。iPhone で Tailscale のアドレス（…ts.net）を開いてから押してください');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-shortcut-'));
    try {
      await new Promise((resolve, reject) => execFile('python3', [path.join(ROOT, 'tools', 'make_shortcuts.py'), dir, `https://${host}`, store.uploadKey()], { timeout: 120000 }, (e) => (e ? reject(e) : resolve())));
      const file = path.join(dir, `${name}.shortcut`);
      if (!fs.existsSync(file)) throw new AppError(500, 'ショートカットの署名に失敗しました');
      const buf = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.shortcut`, 'cache-control': 'no-store' });
      res.end(buf);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  route('GET', '/api/native-shoot/key', ({ actor, query }) => {
    if (!isUser(actor)) throw new AppError(403, 'ユーザーのみ');
    const ticket = randomBytes(16).toString('base64url');
    for (const [t, exp] of shortcutTickets) if (exp < Date.now()) shortcutTickets.delete(t);
    shortcutTickets.set(ticket, Date.now() + 5 * 60_000);
    return { key: store.uploadKey({ rotate: query.rotate === '1' }), ticket };
  });
  // Body = the photo itself (JPEG / HEIC / PNG). Display and list sizes are made here with sips.
  route('POST', '/api/native-shoot/photos', async ({ req }) => {
    const ns = store.nativeShoot;
    if (!ns) { contact('写真を受け取る', '撮影中の商品がないので受け取らなかった', false); throw new AppError(409, '撮影中の商品がありません（アプリで「純正カメラで撮る」を押してから送ってください）'); }
    const buf = await readBody(req, 60 * 1024 * 1024);
    if (buf.length < 1000) { contact('写真を受け取る', '画像が空だった（ショートカットの「本文」の設定を確認）', false); throw new AppError(400, '画像データがありません'); }
    const digest = createHash('sha256').update(buf).digest('hex').slice(0, 32);
    const files = await nativeVariants(buf);
    // The shortcut sends the latest photos; only those taken after the shoot started belong to this product.
    if (files.takenAt && files.takenAt < new Date(Date.parse(ns.since) - 60_000)) { contact('写真を受け取る', '撮影開始より前の写真なので入れなかった'); return { ok: true, skipped: '撮影開始より前の写真' }; }
    // Not into the product yet: the photo waits in the tray until the user picks 登録／保留／破棄 in the web app.
    const { item, duplicate } = tray.add({ productId: ns.productId, digest, files });
    contact('写真を受け取る', duplicate ? '同じ写真が既にトレイにある' : `#${ns.productId} の候補としてトレイに入れた`);
    return { ok: true, productId: ns.productId, trayId: item.id, duplicate };
  });
  route('PATCH', '/api/products/:id/photos/:pid', ({ params, body, actor }) => full(store.updatePhoto(params.id, actor, params.pid, body)));
  route('DELETE', '/api/products/:id/photos/:pid', ({ params, actor }) => full(store.deletePhoto(params.id, actor, params.pid)));
  route('POST', '/api/products/:id/photos/:pid/restore', ({ params, actor }) => full(store.restorePhoto(params.id, actor, params.pid)));
  // ---- destinations (メルカリ／ジモティー／フリマ) ----
  route('PUT', '/api/products/:id/targets', ({ params, body, actor }) => full(store.setTargets(params.id, actor, body?.targets || [], { confirmFoodFlea: body?.confirmFoodFlea === true })));
  route('PUT', '/api/products/:id/channel-photos/:channel', ({ params, body, actor }) => full(store.setChannelPhotos(params.id, actor, params.channel, body?.ids ?? null)));
  route('PUT', '/api/products/:id/channels/:channel', ({ req, params, body, actor }) => {
    const status = body?.status || 'listed';
    channels.applyObserved(store, params.id, actor, params.channel, { status, ...body });
    if (status === 'sold' || status === 'trading') notifyAozoraShelf(req, params.id, false);
    return full(store.get(params.id));
  });
  route('POST', '/api/channels/sync', ({ req, body, actor }) => {
    const res = channels.syncObserved(store, actor, body?.channel || 'mercari', body?.observations || []);
    for (const u of res.updated || []) {
      if (u.to === 'sold' || u.to === 'trading') notifyAozoraShelf(req, u.id, false);
    }
    return res;
  });
  route('GET', '/api/products/:id/package/:channel', ({ params }) => {
    const pkg = channelPackage(store.get(params.id), params.channel);
    return { ...pkg, photos: pkg.photos.map((ph) => ({ ...ph, url: `/files/products/${params.id}/${ph.work}` })) };
  });
  route('PUT', '/api/products/:id/size-estimate', ({ params, body, actor }) => full(store.setSizeEstimate(params.id, actor, body?.estimate ?? null)));
  route('PUT', '/api/products/:id/market', ({ params, body, actor }) => full(store.setMarket(params.id, actor, body?.market ?? null, body?.site || 'mercari')));
  route('PUT', '/api/products/:id/amazon', ({ params, body, actor }) => {
    const a = body?.amazon;
    if (a?.asin && a.price != null) prices.add({ asin: a.asin, productId: params.id, price: a.price, at: a.fetchedAt, source: 'amazon-info' }, actor);
    return full(store.setAmazonInfo(params.id, actor, a ?? null));
  });
  route('PUT', '/api/products/:id/research', ({ params, body, actor }) => full(store.setResearch(params.id, actor, body?.research ?? null)));
  route('POST', '/api/products/:id/text-candidates', ({ params, body, actor }) => full(store.upsertTextCandidates(params.id, actor, body?.items || [])));
  route('PUT', '/api/products/:id/listing-photos', ({ params, body, actor }) => {
    store.setListingPhotos(params.id, actor, body.ids || []);
    return full(store.get(params.id));
  });

  // photo requests
  route('POST', '/api/products/:id/photo-requests', ({ params, body, actor }) => full(store.addPhotoRequests(params.id, actor, body.requests || [body.label])));
  route('PATCH', '/api/products/:id/photo-requests/:rid', ({ params, body, actor }) => full(store.updatePhotoRequest(params.id, actor, params.rid, body)));

  // AI tasks
  route('POST', '/api/products/:id/ai-tasks', ({ params, body, actor }) => {
    store.requestAiTask(params.id, actor, body.type, body.note);
    return full(store.get(params.id));
  });
  route('DELETE', '/api/products/:id/ai-tasks/:tid', ({ params, actor }) => full(store.cancelAiTask(params.id, actor, params.tid)));

  // Mercari
  route('POST', '/api/products/:id/mercari/:op', ({ params, body = {}, actor }) => {
    const id = params.id;
    switch (params.op) {
      case 'approve': return full(mercari.approvePublish(store, id, actor, body.approved !== false));
      case 'listed': return full(mercari.markListed(store, id, actor, { itemUrl: body.itemUrl, price: body.price }));
      case 'sold': return full(mercari.markSold(store, id, actor, { price: body.price }));
      case 'stopped': return full(mercari.markStopped(store, id, actor));
      case 'package': return mercari.buildPackage(store, id, { force: !!body.force });
      case 'update': {
        if (!isUser(actor)) throw new AppError(403, 'ユーザーのみ');
        const allowed = {};
        for (const k of ['itemUrl', 'draftUrl', 'note']) if (body[k] !== undefined) allowed[k] = body[k];
        return full(store.updateChannel(id, actor, 'mercari', allowed, { summary: 'メルカリ情報を手動更新' }));
      }
      default: throw new AppError(404, '不明な操作');
    }
  });

  // history / undo
  route('GET', '/api/products/:id/history', ({ params, query }) => store.history(params.id, { limit: Number(query.limit) || 200 }));
  route('POST', '/api/products/:id/revert', ({ params, body, actor }) => {
    if (!isUser(actor)) throw new AppError(403, '復元はユーザーのみ');
    return full(store.revert(params.id, actor, body.historyId));
  });
  route('GET', '/api/activity', ({ query }) => store.activity({ limit: Number(query.limit) || 300, since: query.since }));
  // Update ledger written by scripts/import-399.js (source material re-synced), newest first.
  route('GET', '/api/update-ledger', ({ query }) => {
    const file = path.join(store.dataDir, 'imports/update-ledger.jsonl');
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    const entries = lines.map((l) => JSON.parse(l)).reverse().slice(0, Number(query.limit) || 500);
    return { entries, total: lines.length, channelChecks: store.meta.channelChecks || {} };
  });
  route('POST', '/api/revert-actor', ({ body, actor }) => store.revertActorSince(actor, body.actor, body.since));

  // bulk — one item failing never fails the others
  // ---- whole-app snapshots (状態の保存) and rollback ----
  route('GET', '/api/snapshots', () => ({ snapshots: store.listSnapshots() }));
  route('POST', '/api/snapshots', ({ body, actor }) => store.saveSnapshot(actor, { label: body?.label || '' }));
  route('POST', '/api/snapshots/:id/rollback', ({ params, actor }) => store.rollbackTo(actor, params.id));
  route('DELETE', '/api/snapshots/:id', ({ params, actor }) => {
    store.deleteSnapshot(actor, params.id);
    return { ok: true };
  });

  const BULK_LABEL = { decision: '出品判断', price: '価格の一括設定', addTarget: '出品先の追加', removeTarget: '出品先の解除', suggestedTargets: 'おすすめの出品先', ai: 'AI依頼', shootPlan: '撮影予定', stockCheck: '最新在庫チェック', stockUnknown: '在庫不明チェック', aside: '別枠', archive: 'アーカイブ', trash: 'ゴミ箱へ移動', restore: '復元', queue: '出品待ち', unqueue: '出品待ち解除', stage: 'ステータス変更' };
  route('POST', '/api/bulk', ({ body, actor }) => {
    const { ids = [], op, value } = body || {};
    const results = [];
    // Large bulk edits are easy to regret: save the whole state first so they can be rolled back.
    const snapshot = ids.length >= 10 ? store.saveSnapshot(actor, { label: `${BULK_LABEL[op] || op}（${ids.length}件）の前（自動）`, kind: 'before' }).id : null;
    for (const id of ids) {
      try {
        switch (op) {
          case 'decision': store.setDecision(id, actor, value); break;
          case 'ai': store.requestAiTask(id, actor, value); break;
          case 'shootPlan': store.setShootPlan(id, actor, !!value); break;
          case 'stockCheck': store.setStockChecked(id, actor, !!value); break;
          case 'stockUnknown': store.setStockUnknown(id, actor, !!value); break;
          case 'aside': store.setAside(id, actor, !!value); break;
          case 'addTarget': store.setTargets(id, actor, [...(store.get(id).targets || []), value]); break;
          case 'removeTarget': store.setTargets(id, actor, (store.get(id).targets || []).filter((t) => t !== value)); break;
          case 'price': {
            let r;
            try {
              r = bulkPrice(store.get(id), value || {});
            } catch (e) {
              throw new AppError(400, e.message);
            }
            if (r.skip) throw new AppError(409, r.skip, 'skipped');
            store.updateFields(id, actor, { [value.field]: r.price });
            break;
          }
          case 'suggestedTargets': store.setTargets(id, actor, [...new Set([...(store.get(id).targets || []), ...suggestedTargets(store.get(id))])]); break;
          case 'archive': store.setArchived(id, actor, !!value); break;
          case 'trash': store.trash(id, actor); break;
          case 'restore': store.restore(id, actor); break;
          case 'queue': {
            const p = store.get(id);
            if (p.stage !== 'ready') throw new AppError(409, `「${summary(p, store.settings).status.label}」のため出品待ちにできません（出品準備完了のみ）`);
            store.setStage(id, actor, 'queued', { note: 'メルカリ転記を依頼' });
            break;
          }
          case 'unqueue': {
            if (store.get(id).stage === 'queued') store.setStage(id, actor, 'ready');
            break;
          }
          case 'stage': store.setStage(id, actor, value); break;
          default: throw new AppError(400, `不明な一括操作: ${op}`);
        }
        results.push({ id, ok: true });
      } catch (e) {
        // "Skipped" (e.g. already priced and not overwriting) is not a failure.
        results.push(e.code === 'skipped' ? { id, ok: true, skipped: e.message } : { id, ok: false, error: e.message });
      }
    }
    const changed = results.some((r) => r.ok && !r.skipped);
    if (snapshot && !changed) store.discardAutoSnapshot(snapshot);
    return { results, snapshot: changed ? snapshot : null, products: ids.filter((id) => store.products.has(id)).map((id) => sm(store.get(id))) };
  });

  // export
  // ---- 帳簿（server/books.js）: 承認・対象外はユーザーのみ。観察ブラウザ連携が POST /api/books/sync で Vine受領などを記録する ----
  const thisYear = () => String(new Date().getFullYear());
  route('GET', '/api/books', ({ query }) => ({ entries: books.list(query), kinds: BOOK_KINDS, statuses: BOOK_STATUSES, flags: BOOK_FLAGS }));
  route('GET', '/api/books/summary', ({ query }) => books.summary(query.year || thisYear()));
  route('GET', '/api/books/export.csv', ({ res, query }) => {
    const year = /^\d{4}$/.test(query.year || '') ? query.year : thisYear();
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="books-${year}.csv"` });
    res.end(books.csv(year));
  });
  route('POST', '/api/books', ({ body, actor }) => books.create(body || {}, actor));
  route('POST', '/api/books/sync', async ({ actor }) => {
    const r = books.syncFromProducts(store.list({ includeTrash: false }), actor, prices);
    return { ...r, suggested: (await books.classify(store.list(), { actor: 'system' })).rules };
  });
  // メルカリの売上: 貼り付けた文字・CSV を読む（dryRun=true で読めた結果だけ）→ 売却の記録（要確認）。分類の候補も付ける。
  route('POST', '/api/books/import/mercari', async ({ body, actor }) => {
    const parsed = parseMercariSales(String(body?.text || '').slice(0, 1_000_000));
    const r = books.importSales(parsed.rows, store.list(), actor, { dryRun: body?.dryRun !== false });
    if (body?.dryRun === false) r.suggested = (await books.classify(store.list(), { actor: 'system' })).rules;
    return { format: parsed.format, ...r };
  });
  route('POST', '/api/books/classify', ({ body }) => books.classify(store.list(), { useAi: !!body?.useAi, actor: 'system' }));
  route('POST', '/api/books/:id/apply-suggestion', ({ params, actor }) => books.applySuggestion(params.id, actor));
  route('PATCH', '/api/books/:id', ({ params, body, actor }) => books.update(params.id, body || {}, actor));
  route('POST', '/api/books/:id/status', ({ params, body, actor }) => books.setStatus(params.id, body?.status, actor, body?.reason));
  route('GET', '/api/books/:id/history', ({ params }) => books.history(params.id));
  // 作品（YouTube・ブログなど）と商品の多対多
  route('GET', '/api/works', ({ query }) => books.listWorks(query));
  // ---- Amazon の価格の履歴（server/prices.js）: Mac の観察ブラウザ連携がログアウト状態の商品ページで確かめた値を送る ----
  route('GET', '/api/prices/due', ({ query }) => ({ due: prices.dueAsins(store.list(), Math.min(50, Number(query.limit) || 20)) }));
  route('POST', '/api/prices', ({ body, actor }) => ({ added: (Array.isArray(body?.observations) ? body.observations : [body]).slice(0, 100).map((o) => prices.add(o, actor)).length }));
  route('GET', '/api/products/:id/prices', ({ params }) => {
    const p = store.get(params.id);
    const asin = p.browser?.asin || p.amazon?.asin || '';
    return { asin, history: asin ? prices.history(asin) : [] };
  });
  route('POST', '/api/works', ({ body, actor }) => books.createWork(body, actor));
  route('PATCH', '/api/works/:id', ({ params, body, actor }) => books.updateWork(params.id, body, actor));
  // 活動の理念（利用者の主張）と説明資料（印刷用 HTML）
  route('GET', '/api/books/statement', () => ({ statement: books.db.statement || '' }));
  route('PUT', '/api/books/statement', ({ body, actor }) => books.setStatement(body?.statement, actor));
  const sendHtml = (res, html) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); };
  route('GET', '/api/books/report', ({ res, query }) => {
    const year = /^\d{4}$/.test(query.year || '') ? query.year : thisYear();
    sendHtml(res, yearReport({ year, entries: books.list({ year }), works: books.listWorks().filter((w) => (w.publishedAt || w.plannedAt || w.createdAt).startsWith(year)),
      summary: books.summary(year), products: store.products, statement: books.db.statement || '' }));
  });
  route('GET', '/api/books/report/product/:id', ({ res, params }) => {
    const p = store.get(params.id);
    sendHtml(res, productReport({ p, entries: books.list({ productId: p.id }).reverse(), works: books.listWorks({ productId: p.id }), statement: books.db.statement || '' }));
  });
  // 税額の試算（目安）: 1件の条件と、Vine 100/200/300万円 × 経費 なし/半分/全額 の表
  route('POST', '/api/tax/simulate', ({ body }) => ({ years: Object.keys(TAX_YEARS), single: simulate(body || {}), scenarios: scenarios(body || {}) }));
  route('GET', '/api/export.csv', ({ res, query }) => {
    let list = store.list({ includeTrash: false });
    if (query.ids) list = list.filter((p) => query.ids.split(',').includes(p.id));
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="products-${stamp()}.csv"` });
    res.end(productsCsv(list));
  });
  // Official images of products that have nothing but official images (参考用). ?ids= limits it to those products.
  const officialList = (query) => {
    const list = store.list({ includeTrash: false });
    return query.ids ? list.filter((p) => query.ids.split(',').includes(p.id)) : list;
  };
  route('GET', '/api/export/official-stats', ({ query }) => officialStats(store, officialList(query)));
  route('GET', '/api/export/official.zip', async ({ res, query }) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="official-images-${stamp()}.zip"` });
    await writeZip(res, officialEntries(store, officialList(query)));
    res.end();
  });
  route('GET', '/api/export.zip', async ({ res, query }) => {
    let list = store.list({ includeTrash: false });
    if (query.ids) list = list.filter((p) => query.ids.split(',').includes(p.id));
    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="products-${stamp()}.zip"` });
    await writeZip(res, exportEntries(store, list, { photos: query.photos !== '0' }));
    res.end();
  });

  // live updates
  route('GET', '/api/events', ({ req, res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`data: ${JSON.stringify({ type: 'hello', at: nowIso() })}\n\n`);
    sseClients.add(res);
    const ka = setInterval(() => res.write(': ka\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ka);
      sseClients.delete(res);
    });
  });

  async function handleMcp(req, res, url) {
    if (req.method === 'GET') {
      res.writeHead(405, { allow: 'POST' });
      return res.end();
    }
    if (req.method === 'DELETE') {
      res.writeHead(200);
      return res.end();
    }
    let msg;
    try {
      msg = JSON.parse((await readBody(req, 5 * 1024 * 1024)).toString('utf8'));
    } catch {
      return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const actor = (url.searchParams.get('actor') || req.headers['x-actor'] || store.settings.aiActorName || 'claude').toString();
    if (isUser(actor)) return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'MCP actor に user は使えません' } });
    const out = await mcp(msg, { actor });
    if (!out) {
      res.writeHead(202);
      return res.end();
    }
    return sendJson(res, 200, out);
  }

  // Requests that arrived through trustedHandler (the Mac-only 127.0.0.1 listener). A server-side mark, not a header, so clients cannot set it.
  const trustedRequests = new WeakSet();

  const tokenBuf = Buffer.from(token);
  const isToken = (v) => {
    if (!token || v == null) return false;
    const b = Buffer.from(String(v));
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };

  // The iPhone shortcut's key opens only these two doors (read the target, send photos to it).
  const isUploadKeyRequest = (req, url) => {
    if (!(url.pathname === '/api/native-shoot' && req.method === 'GET') && !(url.pathname === '/api/native-shoot/photos' && req.method === 'POST')) return false;
    const k = String(req.headers['x-upload-key'] || '');
    const want = store.meta.uploadKey;
    return !!want && k.length === want.length && timingSafeEqual(Buffer.from(k), Buffer.from(want));
  };

  function authorized(req, url) {
    if (!token || trustedRequests.has(req)) return true;
    if (isUploadKeyRequest(req, url)) return true;
    if (req.headers['x-upload-key'] && url.pathname.startsWith('/api/native-shoot')) contact('合言葉の確認', '合言葉が違う（ショートカット②を入れ直す）', false);
    const cookie = /(?:^|;\s*)inv_token=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
    return isToken(cookie) || isToken(bearer) || isToken(url.searchParams.get('token'));
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://local');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      if (!authorized(req, url)) {
        if (url.pathname.startsWith('/api') || url.pathname === '/mcp') return sendJson(res, 401, { error: '認証が必要です（?token=… を付けて一度開いてください）' });
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<meta name=viewport content="width=device-width"><p style="font:16px system-ui;padding:24px">商品台帳: アクセスにはトークン付きURL（…/?token=XXXX）で一度開いてください。</p>');
      }
      if (isToken(url.searchParams.get('token'))) {
        res.setHeader('set-cookie', `inv_token=${token}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${req.socket.encrypted ? '; Secure' : ''}`);
        // Pages: drop the token from the address bar / history once the cookie is set.
        if (req.method === 'GET' && !url.pathname.startsWith('/api') && url.pathname !== '/mcp') {
          url.searchParams.delete('token');
          res.writeHead(303, { location: url.pathname + url.search, 'cache-control': 'no-store' });
          return res.end();
        }
      }
      if (url.pathname === '/mcp') return await handleMcp(req, res, url);
      if (url.pathname.startsWith('/api/')) {
        const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
        if (!r) throw new AppError(404, `Not found: ${req.method} ${url.pathname}`);
        const m = r.re.exec(url.pathname);
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        let body;
        const isMultipart = (req.headers['content-type'] || '').startsWith('multipart/');
        // Raw photos (the iPhone shortcut, 📷 search) are read by their route, not as JSON.
        const isRaw = url.pathname === '/api/native-shoot/photos' || url.pathname === '/api/ocr';
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !isMultipart && !isRaw) {
          const raw = await readBody(req, 2 * 1024 * 1024);
          body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        }
        const actor = String(req.headers['x-actor'] || 'api');
        const readOnlyPost = ['/api/scan', '/api/scan/check-duplicates', '/api/duplicates', '/api/tax/simulate', '/api/ocr'].includes(url.pathname);
        const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !readOnlyPost;
        const exec = () => r.handler({ req, res, params, query: Object.fromEntries(url.searchParams), body, actor });
        const out = isWrite ? await store.withWriteLock(exec) : await exec();
        if (!res.headersSent) sendJson(res, 200, out ?? { ok: true });
        return;
      }
      if (url.pathname.startsWith('/files/')) return serveDataFile(req, res, store.dataDir, url.pathname.slice(7));
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      if (res.headersSent) return res.end();
      const status = e instanceof AppError ? e.status : e instanceof SyntaxError ? 400 : 500;
      if (status >= 500) console.error(e);
      sendJson(res, status, {
        error: e.message,
        code: e.code,
        duplicates: e.duplicates,
        ...(e.owner ? { owner: e.owner } : {}),
        ...(e.fnskuOwner ? { fnskuOwner: e.fnskuOwner } : {}),
        ...(e.similar ? { similar: e.similar } : {}),
        ...(e.currentFnsku !== undefined ? { currentFnsku: e.currentFnsku } : {}),
        ...(e.scannedFnsku !== undefined ? { scannedFnsku: e.scannedFnsku } : {}),
        ...(e.productId !== undefined ? { productId: e.productId } : {}),
        ...(e.currentRev !== undefined ? { currentRev: e.currentRev } : {}),
        ...(e.currentTitle !== undefined ? { currentTitle: e.currentTitle } : {}),
        ...(e.currentDescription !== undefined ? { currentDescription: e.currentDescription } : {}),
      });
    }
  }

  // The token-free Mac listener must not be usable by other web pages open on this Mac:
  // a foreign Host name (DNS rebinding) is refused, and so is a change sent from another site (CSRF).
  const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
  // (Tailscale reaches the app through the token-protected HTTPS listener, so this one needs only the Mac's own names.)
  const okHost = (h) => LOCAL_HOST.test(h);
  function crossSite(req) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site') return true;
    const origin = req.headers.origin;
    if (!origin || origin === 'null') return !!origin;
    try {
      return new URL(origin).host.toLowerCase() !== String(req.headers.host || '').toLowerCase();
    } catch {
      return true;
    }
  }
  function trustedHandler(req, res) {
    if (!okHost(String(req.headers.host || '')) || crossSite(req)) {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
      return sendJson(res, 403, { error: 'このMacの画面以外からの操作は受け付けません' });
    }
    trustedRequests.add(req);
    return handler(req, res);
  }

  return { store, handler, trustedHandler, sseClients };
}

// Same-origin only: photos are served by this app (blob: for photos still uploading), external sites are only linked.
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

const acceptsGzip = (res) => /\bgzip\b/.test(res.req?.headers['accept-encoding'] || '');

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  // The product list is ~1.5MB of JSON; gzip makes it about a tenth for the phone.
  if (body.length > 2048 && acceptsGzip(res)) {
    const gz = zlib.gzipSync(body, { level: 5 });
    res.writeHead(status, { ...headers, 'content-encoding': 'gzip', vary: 'Accept-Encoding', 'content-length': gz.length });
    return res.end(gz);
  }
  res.writeHead(status, headers);
  res.end(body);
}

function serveDataFile(req, res, dataDir, rel) {
  const safe = path.normalize(decodeURIComponent(rel)).replace(/^(\.\.[/\\])+/, '');
  if (!/^(products[/\\][^/\\]+[/\\]photos|outbox)[/\\]/.test(safe)) throw new AppError(404, 'not found');
  const file = path.join(dataDir, safe);
  if (!file.startsWith(dataDir + path.sep)) throw new AppError(404, 'not found');
  const headers = { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': safe.startsWith('outbox') ? 'no-store' : 'private, max-age=31536000, immutable' };
  // List-size thumbnails (x.mini.jpg) are made from x.thumb.jpg the first time they are asked for.
  if (!fs.existsSync(file) && /\.mini\.jpg$/.test(file)) {
    const thumb = file.replace(/\.mini\.jpg$/, '.thumb.jpg');
    if (!fs.existsSync(thumb)) throw new AppError(404, 'not found');
    return makeMini(thumb, file).then((ok) => pipeFile(res, ok ? file : thumb, headers));
  }
  if (!fs.existsSync(file)) throw new AppError(404, 'not found');
  pipeFile(res, file, headers);
}

/** A photo sent as-is from the iPhone: keep the original, make the 2048px work copy and the 400px thumb (JPEG) with sips. */
async function nativeVariants(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-native-'));
  const run = (args) => new Promise((resolve, reject) => execFile('sips', args, { timeout: 60000 }, (e, out) => (e ? reject(e) : resolve(String(out)))));
  try {
    const src = path.join(dir, 'in');
    fs.writeFileSync(src, buf);
    const info = await run(['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', '-g', 'creation', src]).catch(() => '');
    const num = (k) => Number(new RegExp(`${k}: (\\d+)`).exec(info)?.[1]) || null;
    const fmt = /format: (\w+)/.exec(info)?.[1] || '';
    if (!/jpeg|heic|heif|png|tiff/i.test(fmt)) throw new AppError(400, `画像として読めません（${fmt || '不明な形式'}）`);
    const mk = async (edge, name, q) => {
      const out = path.join(dir, name);
      await run(['-s', 'format', 'jpeg', '-s', 'formatOptions', String(q), '-Z', String(edge), src, '--out', out]);
      return fs.readFileSync(out);
    };
    const mime = /heic|heif/i.test(fmt) ? 'image/heic' : /png/i.test(fmt) ? 'image/png' : 'image/jpeg';
    return {
      original: { buffer: buf, mime },
      work: { buffer: await mk(2048, 'work.jpg', 86), mime: 'image/jpeg' },
      thumb: { buffer: await mk(400, 'thumb.jpg', 82), mime: 'image/jpeg' },
      width: num('pixelWidth'),
      height: num('pixelHeight'),
      // EXIF date taken ("2026:10:29 18:49:44", the phone's local time) → Date, or null.
      takenAt: (() => {
        const m = /creation: (\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(info);
        return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
      })(),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 256px on the long side: sharp at 3x for the 72px list thumbnail, about a third of the 400px thumb.
const MINI_PX = 256;
const miniJobs = new Map();
let miniRunning = 0;
const miniWaiting = [];
function makeMini(src, dest) {
  if (miniJobs.has(dest)) return miniJobs.get(dest);
  const job = new Promise((resolve) => {
    const run = () => {
      miniRunning++;
      const tmp = `${dest}.${process.pid}.tmp.jpg`;
      execFile('sips', ['-Z', String(MINI_PX), '-s', 'format', 'jpeg', '-s', 'formatOptions', '78', src, '--out', tmp], { timeout: 15000 }, (err) => {
        let ok = false;
        try {
          if (!err && fs.statSync(tmp).size > 0) {
            fs.renameSync(tmp, dest);
            ok = true;
          }
        } catch {
          /* fall back to the thumb */
        }
        if (!ok) fs.rmSync(tmp, { force: true });
        miniRunning--;
        miniJobs.delete(dest);
        resolve(ok);
        miniWaiting.shift()?.();
      });
    };
    // A few at a time so the first list view does not start dozens of sips at once.
    if (miniRunning < 3) run();
    else miniWaiting.push(run);
  });
  miniJobs.set(dest, job);
  return job;
}

// App files: always revalidated (so a new version shows up at once) but answered with 304 when
// unchanged, and gzipped once per version.
const staticCache = new Map(); // file -> { tag, raw, gz }
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg']);
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  if (!fs.existsSync(file)) throw new AppError(404, 'not found');
  const st = fs.statSync(file);
  const tag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const headers = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', etag: tag, vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === tag) {
    res.writeHead(304, headers);
    return res.end();
  }
  if (!COMPRESSIBLE.has(path.extname(file))) return pipeFile(res, file, headers);
  let c = staticCache.get(file);
  if (!c || c.tag !== tag) {
    const raw = fs.readFileSync(file);
    c = { tag, raw, gz: zlib.gzipSync(raw, { level: 9 }) };
    staticCache.set(file, c);
  }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = gz ? c.gz : c.raw;
  res.writeHead(200, { ...headers, ...(gz ? { 'content-encoding': 'gzip' } : {}), 'content-length': body.length });
  res.end(body);
}

function pipeFile(res, file, headers) {
  const stream = fs.createReadStream(file);
  stream.on('open', () => {
    res.writeHead(200, headers);
    stream.pipe(res);
  });
  stream.on('error', () => {
    if (!res.headersSent) sendJson(res, 404, { error: 'not found' });
    else res.destroy();
  });
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
}

/** "商品名  https://…  https://…" per line. Lines can also be tab/comma/| separated. */
export function parseImport(text) {
  const items = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const { name, urls, date, positional, ordered, delivered } = parseLine(raw);
    const item = { name, links: urls };
    // Browser exports keep 注文日 and 到着日 in their own columns; other lines give one undistinguished date.
    if (positional) {
      if (ordered) item.orderDate = ordered;
      if (delivered) item.arrivalDate = delivered;
      if (!ordered && !delivered && date) item.itemDate = date;
    } else if (date) item.itemDate = date;
    items.push(item);
  }
  return items;
}

/** Keep small, frequent backups of everything except photo binaries (photos are append-only) and the re-downloadable market-scan thumbnails. */
export function backupMetadata(dataDir, { keep = 30 } = {}) {
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `metadata-${stamp()}.tar.gz`);
  return new Promise((resolve) => {
    const tar = spawn('tar', ['-czf', out, '--exclude=./backups', '--exclude=./outbox', '--exclude=*/photos', '--exclude=*/versions', '--exclude=./imports/*-scan/img', '-C', dataDir, '.'], { stdio: 'ignore' });
    tar.on('error', () => resolve(null));
    tar.on('close', (code) => {
      const files = fs.readdirSync(dir).filter((f) => f.startsWith('metadata-')).sort();
      for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
      resolve(code === 0 ? out : null);
    });
  });
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = path.resolve(process.env.INVENTORY_DATA || path.join(ROOT, 'data'));
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const anyHost = host === '0.0.0.0' || host === '::'; // '::' listens on IPv6 and IPv4 at once
  const token = process.env.INVENTORY_TOKEN || '';
  const { handler, trustedHandler, store } = createApp({ dataDir, token });
  const tls = process.env.TLS_CERT && process.env.TLS_KEY ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) } : null;
  if (tls) {
    // Two doors on one store: HTTPS for the iPhone (token required when exposed beyond this Mac),
    // and plain HTTP on 127.0.0.1 for Claude / MCP on this Mac, so .mcp.json and ai-worker.sh keep working unchanged.
    if (host !== '127.0.0.1' && !token) throw new Error('HTTPS を LAN に公開するときは INVENTORY_TOKEN が必要です');
    const tlsPort = Number(process.env.TLS_PORT || 8443);
    // ACCESS_LOG=1 prints each LAN request's start and end (token masked), to see what a phone actually asked for.
    const lanHandler = process.env.ACCESS_LOG ? (req, res) => {
      const t0 = Date.now();
      const what = `${req.socket.remoteAddress} ${req.method} ${req.url.replace(/token=[^&]+/, 'token=…')}`;
      console.log(`→ ${what}`);
      res.on('close', () => console.log(`← ${what} ${res.writableFinished ? res.statusCode : '中断'} ${Date.now() - t0}ms`));
      return handler(req, res);
    } : handler;
    const lanServer = https.createServer(tls, lanHandler);
    lanServer.on('tlsClientError', (err, socket) => console.log(`TLS エラー ${socket.remoteAddress || '?'}: ${err.code || ''} ${err.message}`));
    lanServer.listen(tlsPort, host, () => {
      console.log(`商品台帳 起動（HTTPS・iPhone用）: https://${anyHost ? 'localhost' : host}:${tlsPort}`);
      // Show the names the certificate is valid for; opening by IP would fail the iPhone's certificate check.
      const names = (new X509Certificate(tls.cert).subjectAltName || '').split(', ').filter((s) => s.startsWith('DNS:')).map((s) => s.slice(4));
      if (anyHost) for (const n of names.length ? names : lanAddresses()) console.log(`  LAN:   https://${n}:${tlsPort}${token ? '/?token=…' : ''}`);
    });
    http.createServer(trustedHandler).listen(port, '127.0.0.1', () => {
      console.log(`  Mac内:  http://127.0.0.1:${port}（このMacからのみ・トークン不要）`);
      console.log(`  データ: ${dataDir}`);
      console.log(`  MCP:   http://localhost:${port}/mcp`);
    });
  } else {
    http.createServer(handler).listen(port, host, () => {
      console.log(`商品台帳 起動: http://${anyHost ? 'localhost' : host}:${port}`);
      console.log(`  データ: ${dataDir}`);
      console.log(`  MCP:   http://localhost:${port}/mcp   （claude mcp add --transport http shohin-daicho http://localhost:${port}/mcp）`);
      if (anyHost) for (const a of lanAddresses()) console.log(`  LAN:   http://${a}:${port}${token ? '/?token=…' : ''}`);
      else console.log('  iPhoneから使うには: tailscale serve --bg ' + port + '  （HTTPSになりカメラも使えます。docs/SETUP.md 参照）');
    });
  }
  backupMetadata(dataDir);
  // 自動保存: at start and every AUTOSAVE_MINUTES (default 30), only if something changed since the last snapshot.
  store.autoSaveIfChanged();
  setInterval(() => {
    try {
      store.autoSaveIfChanged();
    } catch (e) {
      console.error('自動保存に失敗', e.message);
    }
  }, Number(process.env.AUTOSAVE_MINUTES || 30) * 60_000).unref();
  setInterval(() => backupMetadata(dataDir), 24 * 3600 * 1000).unref();
}
