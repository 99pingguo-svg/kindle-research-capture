import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp, parseImport } from '../server/index.js';
import { crc32 } from '../server/zip.js';

let server;
let base;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);

before(async () => {
  const { handler } = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-http-')) });
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const api = async (method, url, body, actor = 'user') => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-actor': actor }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const rpc = async (method, params, id = 1) => {
  const res = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  return res.json();
};

test('parseImport extracts names and urls', () => {
  const items = parseImport('- Anker PowerCore https://a.example/1 https://b.example/2\n\n# comment\nSony WH-1000XM4\thttps://c.example');
  assert.deepEqual(items, [
    { name: 'Anker PowerCore', links: ['https://a.example/1', 'https://b.example/2'] },
    { name: 'Sony WH-1000XM4', links: ['https://c.example'] },
  ]);
});

test('REST: create, upload photo (multipart), list summary, bulk', async () => {
  const c = await api('POST', '/api/products', { name: 'テスト商品', decision: 'sell' });
  assert.equal(c.status, 200);
  const id = c.body.product.id;
  const fd = new FormData();
  fd.append('kind', 'actual');
  fd.append('tag', '正面');
  fd.append('clientId', 'abc');
  fd.append('original', new Blob([JPEG], { type: 'image/jpeg' }), 'o.jpg');
  fd.append('thumb', new Blob([JPEG], { type: 'image/jpeg' }), 't.jpg');
  const up = await fetch(`${base}/api/products/${id}/photos`, { method: 'POST', headers: { 'x-actor': 'user' }, body: fd });
  const upBody = await up.json();
  assert.equal(up.status, 200, JSON.stringify(upBody));
  assert.equal(upBody.product.counts.actual, 1);
  const img = await fetch(base + upBody.product.thumb);
  assert.equal(img.status, 200);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), JPEG);

  const list = await api('GET', '/api/products');
  assert.equal(list.body[0].status.label, '撮影中');

  const bulk = await api('POST', '/api/bulk', { ids: [id, '9999'], op: 'ai', value: 'full' });
  assert.equal(bulk.body.results[0].ok, true);
  assert.equal(bulk.body.results[1].ok, false, 'one failure does not fail the batch');

  const forbidden = await api('POST', `/api/products/${id}/decision`, { decision: 'no_sell' }, 'claude');
  assert.equal(forbidden.status, 403);
});

test('path traversal on /files is rejected', async () => {
  const raw = (p) => new Promise((resolve) => http.get(base + p, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }));
  for (const p of ['/files/../meta.json', '/files/%2e%2e/meta.json', '/files/products/0001/../../meta.json', '/files/products/0001/product.json']) {
    const r = await raw(p);
    assert.ok(!r.body.includes('nextId') && !r.body.includes('"schemaVersion"'), `${p} leaked data`);
  }
  assert.equal((await raw('/files/products/0001/product.json')).status, 404);
});

test('MCP: initialize, list tools, call tools', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'shohin-daicho');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const notif = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(notif.status, 202);
  const tools = await rpc('tools/list', {});
  const names = tools.result.tools.map((t) => t.name);
  for (const n of ['list_products', 'get_product', 'get_photos', 'save_listing_draft', 'save_qc_result', 'mercari_prepare', 'mercari_verify_entry']) assert.ok(names.includes(n), n);

  const created = await rpc('tools/call', { name: 'create_products', arguments: { products: [{ name: 'MCP商品', model: 'XYZ-1', links: ['https://example.com/p'] }] } });
  const res = JSON.parse(created.result.content[0].text);
  assert.equal(res[0].ok, true);
  const dup = await rpc('tools/call', { name: 'create_products', arguments: { products: [{ name: '別名', model: 'xyz1' }] } });
  assert.equal(JSON.parse(dup.result.content[0].text)[0].ok, false);

  const pid = res[0].id;
  const draft = await rpc('tools/call', { name: 'save_listing_draft', arguments: { id: pid, title: 'タイトル', price: 1500, price_candidates: [{ price: 1500, basis: '相場' }] } });
  const d = JSON.parse(draft.result.content[0].text);
  assert.deepEqual(d.set.sort(), ['listing.price', 'listing.title']);
  assert.ok(d.readiness.missing.some((m) => m.code === 'unconfirmed:listing.price'));

  const bad = await rpc('tools/call', { name: 'set_stage', arguments: { id: pid, stage: 'listed' } });
  assert.equal(bad.result.isError, true);

  const photos = await rpc('tools/call', { name: 'get_photos', arguments: { id: '0001', size: 'thumb' } });
  assert.equal(photos.result.content.find((c) => c.type === 'image').mimeType, 'image/jpeg');

  // QC PASS requires the model to have actually looked at every listing photo
  const checks = (await rpc('tools/call', { name: 'get_reference_data', arguments: {} })).result.content[0].text;
  const imageIds = JSON.parse(checks).qcChecks.filter((c) => c.group === 'image').map((c) => ({ id: c.id, result: 'pass' }));
  const qcArgs = { id: '0001', model: 'claude-opus-5-5', result: 'pass', summary: 'ok', checks: imageIds };
  const notSeen = await rpc('tools/call', { name: 'save_qc_result', arguments: qcArgs });
  assert.match(notSeen.result.content[0].text, /未確認の写真/);
  await rpc('tools/call', { name: 'get_photos', arguments: { id: '0001', kind: 'listing', size: 'work' } });
  const wrongModel = await rpc('tools/call', { name: 'save_qc_result', arguments: { ...qcArgs, model: 'claude-sonnet-5-5' } });
  assert.match(wrongModel.result.content[0].text, /claude-opus-5-5/);
  const seen = await rpc('tools/call', { name: 'save_qc_result', arguments: qcArgs });
  assert.notEqual(seen.result.isError, true, seen.result.content[0].text);

  const hist = await rpc('tools/call', { name: 'get_history', arguments: { id: pid } });
  assert.ok(JSON.parse(hist.result.content[0].text).some((h) => h.actor === 'claude'));
});

test('export zip is well-formed', async () => {
  const res = await fetch(base + '/api/export.zip', { headers: { 'x-actor': 'user' } });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  assert.ok(count >= 4);
  // first entry CRC matches its data
  const nameLen = buf.readUInt16LE(26);
  const size = buf.readUInt32LE(18);
  const data = buf.slice(30 + nameLen, 30 + nameLen + size);
  assert.equal(buf.readUInt32LE(14), crc32(data));
  assert.equal(buf.slice(30, 30 + nameLen).toString(), 'Products/products.csv');
});

test('token: LAN door requires it, Mac-only trusted door does not', async () => {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-token-')), token: 'secret-123' });
  const lan = http.createServer(app.handler);
  const local = http.createServer(app.trustedHandler);
  await Promise.all([lan, local].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  const at = (s, p, init) => fetch(`http://127.0.0.1:${s.address().port}${p}`, init);
  try {
    assert.equal((await at(lan, '/api/meta')).status, 401);
    assert.equal((await at(lan, '/api/meta', { headers: { authorization: 'Bearer secret-123' } })).status, 200);
    assert.equal((await at(lan, '/api/meta?token=wrong')).status, 401);
    assert.equal((await at(local, '/api/meta')).status, 200);
    const mcp = await at(local, '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(mcp.status, 200);
    assert.equal((await at(lan, '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    // Opening the page with ?token sets the cookie and redirects so the token leaves the address bar.
    const open = await at(lan, '/?token=secret-123&x=1', { redirect: 'manual' });
    assert.equal(open.status, 303);
    assert.equal(open.headers.get('location'), '/?x=1');
    assert.match(open.headers.get('set-cookie'), /inv_token=secret-123;.*HttpOnly/);
    assert.match(open.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await at(lan, '/api/meta', { headers: { cookie: 'inv_token=secret-123' } })).status, 200);
    assert.equal((await at(lan, '/api/meta', { headers: { cookie: 'inv_token=secret-12' } })).status, 401);
  } finally {
    for (const s of [lan, local]) { s.closeAllConnections(); s.close(); }
  }
});

/** A noisy 80×60 PNG (big enough to look like a photo to the server). */
async function noisePng() {
  const { deflateSync } = await import('node:zlib');
  const w = 80;
  const hgt = 60;
  const raw = Buffer.alloc((w * 3 + 1) * hgt);
  for (let i = 0; i < raw.length; i++) raw[i] = i % (w * 3 + 1) === 0 ? 0 : (i * 2654435761) >>> 24;
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('native camera: the shortcut key can only read the target and send photos to it', async () => {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-native-')), token: 'secret-123' });
  const lan = http.createServer(app.handler);
  const local = http.createServer(app.trustedHandler);
  await Promise.all([lan, local].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  const at = (s, p, init = {}) => fetch(`http://127.0.0.1:${s.address().port}${p}`, init);
  const user = { 'content-type': 'application/json', 'x-actor': 'user' };
  try {
    const { product } = app.store.create({ name: 'テスト商品' }, 'user');
    // Only the user can start a shoot; the AI cannot.
    assert.equal((await at(local, '/api/native-shoot', { method: 'PUT', headers: { ...user, 'x-actor': 'claude' }, body: JSON.stringify({ productId: product.id }) })).status, 403);
    assert.equal((await (await at(local, '/api/native-shoot', { method: 'PUT', headers: user, body: JSON.stringify({ productId: product.id }) })).json()).productId, product.id);
    const { key } = await (await at(local, '/api/native-shoot/key', { headers: user })).json();
    assert.ok(key.length > 20);
    const k = { 'x-upload-key': key };
    assert.equal((await (await at(lan, '/api/native-shoot', { headers: k })).json()).name, 'テスト商品');
    assert.equal((await at(lan, '/api/native-shoot', { headers: { 'x-upload-key': 'wrong' } })).status, 401);
    assert.equal((await at(lan, '/api/products', { headers: k })).status, 401); // nothing else
    const png = await noisePng();
    const r = await (await at(lan, '/api/native-shoot/photos', { method: 'POST', headers: { ...k, 'content-type': 'image/png' }, body: png })).json();
    assert.equal(r.productId, product.id);
    const again = await (await at(lan, '/api/native-shoot/photos', { method: 'POST', headers: { ...k, 'content-type': 'image/png' }, body: png })).json();
    assert.equal(again.duplicate, true);
    const ph = app.store.get(product.id).photos.filter((x) => !x.deletedAt);
    assert.equal(ph.length, 1);
    assert.equal(ph[0].source, 'native');
    assert.match(ph[0].files.work, /\.work\.jpg$/);
    assert.match(ph[0].files.thumb, /\.thumb\.jpg$/);
    // After the shoot ends, photos are refused.
    await at(local, '/api/native-shoot', { method: 'DELETE', headers: user });
    assert.equal((await at(lan, '/api/native-shoot/photos', { method: 'POST', headers: k, body: png })).status, 409);
  } finally {
    for (const s of [lan, local]) { s.closeAllConnections(); s.close(); }
  }
});

test('native camera: the key-bearing shortcut needs a one-time ticket from the user', async () => {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-ticket-')), token: 'secret-123' });
  const local = http.createServer(app.trustedHandler);
  await new Promise((r) => local.listen(0, '127.0.0.1', r));
  const at = (p, init = {}) => fetch(`http://127.0.0.1:${local.address().port}${p}`, init);
  try {
    assert.equal((await at('/api/native-shoot/shortcut/send')).status, 403);
    assert.equal((await at('/api/native-shoot/key', { headers: { 'x-actor': 'claude' } })).status, 403);
    const { ticket } = await (await at('/api/native-shoot/key', { headers: { 'x-actor': 'user' } })).json();
    assert.ok(ticket);
    assert.equal((await at(`/api/native-shoot/shortcut/send?ticket=wrong`)).status, 403);
  } finally {
    local.closeAllConnections();
    local.close();
  }
});
