// 商品台帳 server: REST API for the PWA, MCP endpoint for AI agents, static files.
// Zero dependencies — run with `node server/index.js` (Node 20+).
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, isUser } from './store.js';
import { AppError, nowIso } from './util.js';
import { readBody, parseMultipart } from './multipart.js';
import { summary, readiness, lint } from './rules.js';
import { writeZip } from './zip.js';
import { exportEntries, productsCsv } from './export.js';
import { createMcpHandler, matchesFilter } from './mcp.js';
import * as mercari from './adapters/mercari.js';
import * as schema from './schema.js';
import { parseLine, importDates } from './dates.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.heic': 'image/heic',
  '.heif': 'image/heif', '.gif': 'image/gif', '.txt': 'text/plain; charset=utf-8',
};

export function createApp({ dataDir, token = '' } = {}) {
  const store = new Store(dataDir);
  const mcp = createMcpHandler(store);
  const sseClients = new Set();
  store.on('change', (ev) => {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of sseClients) res.write(line);
  });

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler });
  };

  const full = (p) => ({ ...p, summary: summary(p, store.settings), readiness: readiness(p, store.settings), lint: lint(p, store.settings) });
  const sm = (p) => summary(p, store.settings);

  // ---- meta / settings ----
  route('GET', '/api/meta', () => ({
    stages: schema.STAGES, decisions: schema.DECISIONS, fields: schema.FIELDS, conditions: schema.MERCARI_CONDITIONS,
    linkTypes: schema.LINK_TYPES, photoTags: schema.PHOTO_TAGS, factConfidence: schema.FACT_CONFIDENCE,
    aiTaskTypes: schema.AI_TASK_TYPES, qcChecks: schema.QC_CHECKS, limits: schema.MERCARI_LIMITS,
    shipping: { payers: schema.SHIPPING_PAYERS, methods: schema.SHIPPING_METHODS, days: schema.SHIPPING_DAYS, prefectures: schema.PREFECTURES },
    settings: store.settings, dataDir: store.dataDir, mcpPath: '/mcp',
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
      if (it.itemDate) fields.itemDate = it.itemDate;
      if (body?.decision) fields.decision = body.decision;
      if (body?.shootPlan) fields.shootPlan = true;
      created.push(store.create(fields, actor, { links: it.links }).product.id);
    });
    return { created };
  });
  // 日付の一括反映 (existing products only; unmatched rows are ignored)
  route('POST', '/api/dates/import', ({ body, actor }) =>
    importDates(store, actor, { text: body?.text || '', dryRun: body?.dryRun !== false, include: body?.include || [] }));
  route('GET', '/api/products/:id', ({ params }) => full(store.get(params.id)));
  route('PATCH', '/api/products/:id', ({ params, body, actor }) => {
    const { set, confirm, unlock } = body || {};
    let r = { proposed: [] };
    if (set && Object.keys(set).length) r = store.updateFields(params.id, actor, set);
    if (confirm?.length) store.confirmFields(params.id, actor, confirm);
    if (unlock?.length) store.unlockFields(params.id, actor, unlock);
    return { product: full(store.get(params.id)), proposed: r.proposed };
  });
  route('POST', '/api/products/:id/decision', ({ params, body, actor }) => full(store.setDecision(params.id, actor, body.decision)));
  route('POST', '/api/products/:id/stage', ({ params, body, actor }) => full(store.setStage(params.id, actor, body.stage, { note: body.note })));
  route('POST', '/api/products/:id/archive', ({ params, body, actor }) => full(store.setArchived(params.id, actor, body.archived !== false)));
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
    return { photo, duplicate, product: sm(store.get(params.id)) };
  });
  route('PATCH', '/api/products/:id/photos/:pid', ({ params, body, actor }) => full(store.updatePhoto(params.id, actor, params.pid, body)));
  route('DELETE', '/api/products/:id/photos/:pid', ({ params, actor }) => full(store.deletePhoto(params.id, actor, params.pid)));
  route('POST', '/api/products/:id/photos/:pid/restore', ({ params, actor }) => full(store.restorePhoto(params.id, actor, params.pid)));
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
  route('POST', '/api/revert-actor', ({ body, actor }) => store.revertActorSince(actor, body.actor, body.since));

  // bulk — one item failing never fails the others
  route('POST', '/api/bulk', ({ body, actor }) => {
    const { ids = [], op, value } = body || {};
    const results = [];
    for (const id of ids) {
      try {
        switch (op) {
          case 'decision': store.setDecision(id, actor, value); break;
          case 'ai': store.requestAiTask(id, actor, value); break;
          case 'shootPlan': store.setShootPlan(id, actor, !!value); break;
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
        results.push({ id, ok: false, error: e.message });
      }
    }
    return { results, products: ids.filter((id) => store.products.has(id)).map((id) => sm(store.get(id))) };
  });

  // export
  route('GET', '/api/export.csv', ({ res, query }) => {
    let list = store.list({ includeTrash: false });
    if (query.ids) list = list.filter((p) => query.ids.split(',').includes(p.id));
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="products-${stamp()}.csv"` });
    res.end(productsCsv(list));
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

  function authorized(req, url) {
    if (!token) return true;
    const cookie = /(?:^|;\s*)inv_token=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
    return cookie === token || bearer === token || url.searchParams.get('token') === token;
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://local');
    try {
      if (!authorized(req, url)) {
        if (url.pathname.startsWith('/api') || url.pathname === '/mcp') return sendJson(res, 401, { error: '認証が必要です（?token=… を付けて一度開いてください）' });
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<meta name=viewport content="width=device-width"><p style="font:16px system-ui;padding:24px">商品台帳: アクセスにはトークン付きURL（…/?token=XXXX）で一度開いてください。</p>');
      }
      if (token && url.searchParams.get('token') === token) {
        res.setHeader('set-cookie', `inv_token=${token}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
      }
      if (url.pathname === '/mcp') return await handleMcp(req, res, url);
      if (url.pathname.startsWith('/api/')) {
        const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
        if (!r) throw new AppError(404, `Not found: ${req.method} ${url.pathname}`);
        const m = r.re.exec(url.pathname);
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        let body;
        const isMultipart = (req.headers['content-type'] || '').startsWith('multipart/');
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !isMultipart) {
          const raw = await readBody(req, 2 * 1024 * 1024);
          body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        }
        const actor = String(req.headers['x-actor'] || 'api');
        const out = await r.handler({ req, res, params, query: Object.fromEntries(url.searchParams), body, actor });
        if (!res.headersSent) sendJson(res, 200, out ?? { ok: true });
        return;
      }
      if (url.pathname.startsWith('/files/')) return serveDataFile(req, res, store.dataDir, url.pathname.slice(7));
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      if (res.headersSent) return res.end();
      const status = e instanceof AppError ? e.status : e instanceof SyntaxError ? 400 : 500;
      if (status >= 500) console.error(e);
      sendJson(res, status, { error: e.message, code: e.code, duplicates: e.duplicates });
    }
  }

  return { store, handler, sseClients };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function serveDataFile(req, res, dataDir, rel) {
  const safe = path.normalize(decodeURIComponent(rel)).replace(/^(\.\.[/\\])+/, '');
  if (!/^(products[/\\][^/\\]+[/\\]photos|outbox)[/\\]/.test(safe)) throw new AppError(404, 'not found');
  const file = path.join(dataDir, safe);
  if (!file.startsWith(dataDir + path.sep) || !fs.existsSync(file)) throw new AppError(404, 'not found');
  pipeFile(res, file, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': safe.startsWith('outbox') ? 'no-store' : 'private, max-age=31536000, immutable' });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  if (!fs.existsSync(file)) throw new AppError(404, 'not found');
  pipeFile(res, file, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
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
    const { name, urls, date } = parseLine(raw);
    items.push(date ? { name, links: urls, itemDate: date } : { name, links: urls });
  }
  return items;
}

/** Keep small, frequent backups of everything except photo binaries (photos are append-only). */
export function backupMetadata(dataDir, { keep = 30 } = {}) {
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `metadata-${stamp()}.tar.gz`);
  return new Promise((resolve) => {
    const tar = spawn('tar', ['-czf', out, '--exclude=./backups', '--exclude=./outbox', '--exclude=*/photos', '--exclude=*/versions', '-C', dataDir, '.'], { stdio: 'ignore' });
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
  const token = process.env.INVENTORY_TOKEN || '';
  const { handler } = createApp({ dataDir, token });
  const tls = process.env.TLS_CERT && process.env.TLS_KEY ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) } : null;
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.listen(port, host, () => {
    const proto = tls ? 'https' : 'http';
    console.log(`商品台帳 起動: ${proto}://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(`  データ: ${dataDir}`);
    console.log(`  MCP:   ${proto}://localhost:${port}/mcp   （claude mcp add --transport http shohin-daicho ${proto}://localhost:${port}/mcp）`);
    if (host === '0.0.0.0') for (const a of lanAddresses()) console.log(`  LAN:   ${proto}://${a}:${port}${token ? '/?token=…' : ''}`);
    else console.log('  iPhoneから使うには: tailscale serve --bg ' + port + '  （HTTPSになりカメラも使えます。docs/SETUP.md 参照）');
  });
  backupMetadata(dataDir);
  setInterval(() => backupMetadata(dataDir), 24 * 3600 * 1000).unref();
}
