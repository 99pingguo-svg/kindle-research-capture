import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-scan-'));
const T1 = '2026-11-20T09:00:00.000Z';
const T2 = '2026-11-21T09:00:00.000Z';

test('recordScan: 空の FNSKU を入れ、ある の印を読んだ時刻で付ける（在庫なし→未定）', () => {
  const store = new Store(tmp());
  const { product } = store.create({ name: 'ヨガマット', decision: 'no_stock' });
  store.setStockUnknown(product.id, 'user', true);
  // ある is user-only here too: an AI cannot mark it through a scan record.
  assert.throws(() => store.recordScan(product.id, 'claude', { fnsku: 'X00ABCDEFG', scannedAt: T1 }), (e) => e.status === 403);
  assert.equal(store.get(product.id).fnsku, '');
  const r = store.recordScan(product.id, 'user', { fnsku: 'X00ABCDEFG', scannedAt: T1 });
  assert.equal(r.conflict, undefined);
  assert.equal(r.product.fnsku, 'X00ABCDEFG');
  assert.equal(r.product.stockCheckedAt, T1);
  assert.equal(r.product.stockUnknownAt, null);
  assert.equal(r.product.decision, 'undecided');
  assert.equal(r.product.lastScanAt, T1);
  const h = store.history(product.id)[0];
  assert.equal(h.action, 'scan');
  assert.match(h.summary, /スキャンで在庫確認/);
  // setPresence keeps refusing AI actors: recordScan did not go through it.
  assert.throws(() => store.setPresence(product.id, 'claude', 'have'), /ユーザーのみ/);
});

test('recordScan: 別の FNSKU は上書きせず conflict、lastScanAt は新しい方', () => {
  const store = new Store(tmp());
  const { product } = store.create({ name: 'ラジオペンチ', fnsku: 'X00AAAAAAA' });
  store.recordScan(product.id, 'user', { fnsku: 'X00AAAAAAA', scannedAt: T2 });
  const r = store.recordScan(product.id, 'user', { fnsku: 'X00BBBBBBB', scannedAt: T1 });
  assert.match(r.conflict, /X00AAAAAAA/);
  assert.equal(r.product.fnsku, 'X00AAAAAAA');
  assert.equal(r.product.lastScanAt, T2);
  assert.equal(r.product.stockCheckedAt, T2, 'an older scan does not move the last-seen date back');
  assert.throws(() => store.recordScan(product.id, 'user', { fnsku: 'ABC', scannedAt: T1 }), /形が違います/);
  assert.throws(() => store.recordScan(product.id, 'user', { scannedAt: 'きのう' }), /日時ではありません/);
});

test('undoScan: 前の状態へそのまま戻り、記録は取り消し済みとして残る', () => {
  const store = new Store(tmp());
  const { product } = store.create({ name: 'ブラシ', decision: 'no_stock' });
  const prior = store.get(product.id);
  store.recordScan(product.id, 'user', { fnsku: 'X00ABCDEFG', scannedAt: T1 });
  const { product: p, kept } = store.undoScan(product.id, 'user');
  assert.deepEqual(kept, []);
  for (const k of ['fnsku', 'stockCheckedAt', 'stockUnknownAt', 'decision', 'lastScanAt']) assert.deepEqual(p[k], prior[k], k);
  assert.equal(p.locks.fnsku, undefined);
  assert.equal(p.scanEvents.length, 1);
  assert.ok(p.scanEvents[0].undoneAt);
  assert.equal(p.scanEvents[0].undoneBy, 'user');
  assert.equal(store.history(product.id)[0].action, 'scan-undo');
  assert.match(store.history(product.id)[0].summary, /スキャン取り消し/);
  // Nothing left to undo: a clean error, not a crash.
  assert.throws(() => store.undoScan(product.id, 'user'), (e) => e.status === 404 && /取り消せるスキャンがありません/.test(e.message));
});

test('undoScan: 2回のうち新しい方を取り消すと前のスキャンが残る・元からの FNSKU は残る', () => {
  const store = new Store(tmp());
  const { product } = store.create({ name: 'マット', fnsku: 'X00KEEPKEE' });
  store.recordScan(product.id, 'user', { fnsku: 'X00KEEPKEE', scannedAt: T1 });
  store.recordScan(product.id, 'user', { fnsku: 'X00KEEPKEE', scannedAt: T2 });
  let p = store.undoScan(product.id, 'user').product;
  assert.equal(p.lastScanAt, T1);
  assert.equal(p.stockCheckedAt, T1);
  assert.equal(p.fnsku, 'X00KEEPKEE');
  p = store.undoScan(product.id, 'user').product;
  assert.equal(p.lastScanAt, null);
  assert.equal(p.stockCheckedAt, null);
  assert.equal(p.fnsku, 'X00KEEPKEE');
  assert.deepEqual(p.scanEvents.map((e) => !!e.undoneAt), [true, true]);
});

test('undoScan: AI はほかの人のスキャンを取り消せない', () => {
  const store = new Store(tmp());
  const { product } = store.create({ name: 'ペンチ' });
  store.recordScan(product.id, 'user', { scannedAt: T1 });
  assert.throws(() => store.undoScan(product.id, 'claude'), (e) => e.status === 403);
  store.recordScan(product.id, 'claude', { scannedAt: T2, presence: false });
  assert.equal(store.undoScan(product.id, 'claude').product.lastScanAt, T1);
});

// ---------- HTTP ----------
let server;
let base;
before(async () => {
  const { handler } = createApp({ dataDir: tmp() });
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); });
const api = async (method, url, body, actor = 'user') => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-actor': actor }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test('HTTP: /api/scan/import（dryRun・FNSKU/ASIN 一致・未一致・形違い・食い違い）と /api/scan/undo', async () => {
  const a = (await api('POST', '/api/products', { name: 'FNSKU の商品', fnsku: 'X00AAAAAAA' })).body.product.id;
  const b = (await api('POST', '/api/products', { name: 'ASIN の商品' }, 'user')).body.product.id;
  await api('PUT', `/api/products/${b}/browser`, { browser: { asin: 'B0TESTASIN', lists: {} } });
  const c = (await api('POST', '/api/products', { name: '別の番号の商品', fnsku: 'X00CCCCCCC' })).body.product.id;
  const records = [
    { fnsku: 'X00AAAAAAA', scannedAt: T1 },
    { fnsku: 'X00BBBBBBB', scannedAt: T2, asin: 'B0TESTASIN' },
    { fnsku: 'X00DDDDDDD', scannedAt: T1, productId: c },
    { fnsku: 'X00ZZZZZZZ', scannedAt: T1 },
    { fnsku: 'nope', scannedAt: T1 },
    { fnsku: 'X00EEEEEEE', scannedAt: 'yesterday' },
  ];
  const dry = await api('POST', '/api/scan/import', { records });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.total, 6);
  assert.equal(dry.body.applied, 0);
  assert.deepEqual(dry.body.unmatched.map((u) => u.fnsku), ['X00ZZZZZZZ']);
  assert.deepEqual(dry.body.invalid.map((u) => u.index), [4, 5]);
  assert.deepEqual(dry.body.conflicts.map((x) => [x.productId, x.fnsku]), [[c, 'X00DDDDDDD']]);
  assert.equal((await api('GET', `/api/products/${a}`)).body.lastScanAt ?? null, null, 'dryRun changes nothing');
  assert.equal((await api('GET', `/api/products/${b}`)).body.fnsku, '');

  // An AI import records the scans but leaves the ある marks alone.
  const ai = await api('POST', '/api/scan/import', { records: [records[0]], dryRun: false }, 'claude');
  assert.equal(ai.body.presence, false);
  assert.equal(ai.body.applied, 1);
  const pai = (await api('GET', `/api/products/${a}`)).body;
  assert.equal(pai.lastScanAt, T1);
  assert.equal(pai.summary.presence, null);
  assert.equal(pai.stockCheckedAt, null);
  assert.equal((await api('POST', '/api/scan/undo', { productId: a }, 'claude')).status, 200);

  const run = await api('POST', '/api/scan/import', { records, dryRun: false });
  assert.equal(run.body.presence, true);
  assert.equal(run.body.applied, 3);
  const pa = (await api('GET', `/api/products/${a}`)).body;
  assert.equal(pa.lastScanAt, T1);
  assert.equal(pa.summary.lastScanAt, T1);
  assert.equal(pa.summary.presence, 'have');
  const pb = (await api('GET', `/api/products/${b}`)).body;
  assert.equal(pb.fnsku, 'X00BBBBBBB');
  assert.equal((await api('GET', `/api/products/${c}`)).body.fnsku, 'X00CCCCCCC');
  // The same records again are not counted twice.
  const again = await api('POST', '/api/scan/import', { records, dryRun: false });
  assert.equal(again.body.applied, 0);
  assert.equal(again.body.duplicates.length, 3);

  // confirm stamps lastScanAt and shows the scans; undo puts the earlier state back.
  const conf = await api('POST', '/api/scan/confirm', { id: b, fnsku: 'X00BBBBBBB', presence: true });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  assert.ok(conf.body.lastScanAt > T2);
  assert.equal(conf.body.noted, '');
  assert.equal(conf.body.scans.length, 2);
  const undo = await api('POST', '/api/scan/undo', { productId: b });
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.equal(undo.body.lastScanAt, T2);
  assert.deepEqual(undo.body.scans.map((s) => s.undone), [true, false]);
  assert.equal(undo.body.fnsku, 'X00BBBBBBB');
  const none = await api('POST', '/api/scan/undo', { productId: (await api('POST', '/api/products', { name: '未スキャン' })).body.product.id });
  assert.equal(none.status, 404);
  // AI still cannot mark ある through confirm.
  assert.equal((await api('POST', '/api/scan/confirm', { id: a, presence: true }, 'claude')).status, 403);
});

test('HTTP フェーズ2: 重複チェック・新規登録フロー・FNSKU二重登録防止・スキャン場面写真の1枚差し替え', async () => {
  const existing = (await api('POST', '/api/products', {
    name: '高機能 ワイヤレス マウス 静音',
    brand: 'Logicool',
    fnsku: 'X00EXIST01',
    orderDate: '2026-10-05',
  })).body.product.id;
  await api('POST', `/api/products/${existing}/links`, { url: 'https://www.amazon.co.jp/dp/B0MOUSE001', type: 'purchase' });

  // /api/scan returns full detail fields for existing item
  const lookA = await api('POST', '/api/scan', { codes: ['X00EXIST01'], lines: [] });
  assert.equal(lookA.status, 200);
  assert.equal(lookA.body.status, 'registered');
  assert.equal(lookA.body.pick.orderDate, '2026-10-05');
  assert.equal(lookA.body.pick.sourceUrl, 'https://www.amazon.co.jp/dp/B0MOUSE001');

  // Cannot bind an already-registered FNSKU onto another product via /api/scan/confirm
  const other = (await api('POST', '/api/products', { name: '別商品' })).body.product.id;
  const dupConfirm = await api('POST', '/api/scan/confirm', { id: other, fnsku: 'X00EXIST01', presence: true });
  assert.equal(dupConfirm.status, 409);
  assert.equal(dupConfirm.body.code, 'FNSKU_OWNED_BY_OTHER');
  assert.equal(dupConfirm.body.fnskuOwner.id, existing);

  // /api/scan/check-duplicates detects FNSKU conflict & similar existing products
  const chk1 = await api('POST', '/api/scan/check-duplicates', { fnsku: 'X00EXIST01', name: '別の名前' });
  assert.equal(chk1.status, 200);
  assert.equal(chk1.body.hasConflict, true);
  assert.equal(chk1.body.fnskuOwner.id, existing);

  const chk2 = await api('POST', '/api/scan/check-duplicates', { fnsku: 'X00NEWREG1', name: 'ワイヤレス マウス 静音型' });
  assert.equal(chk2.status, 200);
  assert.equal(chk2.body.hasConflict, false);
  assert.ok(chk2.body.similar.some((s) => s.id === existing), 'similar existing product surfaced');

  // Cannot register a new product with an existing FNSKU
  const regDupFnsku = await api('POST', '/api/scan/register', { name: '新製品', fnsku: 'X00EXIST01' });
  assert.equal(regDupFnsku.status, 409);
  assert.equal(regDupFnsku.body.code, 'FNSKU_OWNED_BY_OTHER');

  // AI cannot mark presence=true via /api/scan/register
  const regAi = await api('POST', '/api/scan/register', { name: '新製品AI', fnsku: 'X00NEWREG1', presence: true }, 'claude');
  assert.equal(regAi.status, 403);

  // User registers new product from state C with FNSKU + scan confirmation
  const regOk = await api('POST', '/api/scan/register', {
    name: 'まったく新しい USBハブ 7ポート',
    brand: 'UGREEN',
    fnsku: 'X00NEWREG1',
    url: 'https://www.amazon.co.jp/dp/B0HUB00007',
  });
  assert.equal(regOk.status, 200, JSON.stringify(regOk.body));
  assert.equal(regOk.body.created, true);
  assert.equal(regOk.body.fnsku, 'X00NEWREG1');
  assert.equal(regOk.body.presence, 'have');
  assert.equal(regOk.body.sourceUrl, 'https://www.amazon.co.jp/dp/B0HUB00007');
  assert.ok(regOk.body.lastScanAt);
  const newId = regOk.body.id;

  // Scan scene photo: stored as reference (not listing photo), strictly 1 per product (replaced on next scan)
  const uploadScan = async (bytes, clientId) => {
    const fd = new FormData();
    fd.append('kind', 'actual'); // even if client sends actual, source=scan stores as reference scan scene
    fd.append('source', 'scan');
    fd.append('clientId', clientId);
    fd.append('original', new Blob([bytes], { type: 'image/jpeg' }), 'scan.jpg');
    const res = await fetch(`${base}/api/products/${newId}/photos`, { method: 'POST', headers: { 'x-actor': 'user' }, body: fd });
    return { status: res.status, body: await res.json() };
  };
  const jpg1 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
  const jpg2 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x02, 0xff, 0xd9]);

  const up1 = await uploadScan(jpg1, 'scan:first');
  assert.equal(up1.status, 200, JSON.stringify(up1.body));
  assert.equal(up1.body.photo.kind, 'reference');
  assert.equal(up1.body.photo.source, 'scan');
  assert.equal(up1.body.product.counts.actual, 0);
  assert.ok(up1.body.product.scanScene);

  // Same clientId is idempotent
  const up1Dup = await uploadScan(jpg1, 'scan:first');
  assert.equal(up1Dup.body.duplicate, true);

  // Second scan scene replaces the first one: still strictly 1 scan photo, never in listingPhotoIds
  const up2 = await uploadScan(jpg2, 'scan:second');
  assert.equal(up2.status, 200);
  assert.notEqual(up2.body.photo.id, up1.body.photo.id);
  const fullProd = (await api('GET', `/api/products/${newId}`)).body;
  assert.equal(fullProd.photos.filter((x) => x.source === 'scan').length, 1);
  assert.equal(fullProd.photos[0].id, up2.body.photo.id);
  assert.deepEqual(fullProd.listingPhotoIds, []);
});

test('HTTP T-010: aiInstruction フィールド・メモ2欄の追記(append)/編集(set)・売らない(no_sell)と元に戻す', async () => {
  const meta = await api('GET', '/api/meta');
  assert.equal(meta.status, 200);
  assert.ok(meta.body.fields.some((f) => f.path === 'aiInstruction'));
  assert.ok(meta.body.fields.some((f) => f.path === 'conditionNote'));

  const created = await api('POST', '/api/products', { name: 'テスト用イヤホン', fnsku: 'X00MEMO001' });
  const id = created.body.product.id;
  assert.equal(created.body.product.aiInstruction, '');
  assert.equal(created.body.product.conditionNote, '');
  assert.equal(created.body.product.decision, 'undecided');

  // Append onto empty fields sets directly without leading newline
  const app1 = await api('PATCH', `/api/products/${id}`, {
    append: { conditionNote: '外箱にスレあり', aiInstruction: '付属品の写真を強調して' },
  });
  assert.equal(app1.status, 200);
  assert.equal(app1.body.product.conditionNote, '外箱にスレあり');
  assert.equal(app1.body.product.aiInstruction, '付属品の写真を強調して');
  assert.equal(app1.body.product.notes, '');

  // Append onto existing fields joins with newline
  const app2 = await api('PATCH', `/api/products/${id}`, {
    append: { conditionNote: '動作確認済み', aiInstruction: '相場より少し高めに出す' },
  });
  assert.equal(app2.status, 200);
  assert.equal(app2.body.product.conditionNote, '外箱にスレあり\n動作確認済み');
  assert.equal(app2.body.product.aiInstruction, '付属品の写真を強調して\n相場より少し高めに出す');

  // Full edit overwrites
  const edit = await api('PATCH', `/api/products/${id}`, {
    set: { conditionNote: '美品・箱なし', aiInstruction: '本体のみと明記' },
  });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.product.conditionNote, '美品・箱なし');
  assert.equal(edit.body.product.aiInstruction, '本体のみと明記');

  // /api/scan returns conditionNote and aiInstruction on scanCard
  const scanRes = await api('POST', '/api/scan', { codes: ['X00MEMO001'], lines: [] });
  assert.equal(scanRes.status, 200);
  assert.equal(scanRes.body.pick.conditionNote, '美品・箱なし');
  assert.equal(scanRes.body.pick.aiInstruction, '本体のみと明記');

  // 「売らない（在庫あり）」: confirm scan (stockCheckedAt) + decision='no_sell', then undo decision back to 'undecided'
  const prevDecision = scanRes.body.pick.decision;
  assert.equal(prevDecision, 'undecided');
  const conf = await api('POST', '/api/scan/confirm', { id, fnsku: 'X00MEMO001', presence: true });
  assert.equal(conf.status, 200);
  assert.equal(conf.body.presence, 'have');
  const decNoSell = await api('POST', `/api/products/${id}/decision`, { decision: 'no_sell' });
  assert.equal(decNoSell.status, 200);
  assert.equal(decNoSell.body.decision, 'no_sell');
  assert.ok(decNoSell.body.stockCheckedAt);
  const decUndo = await api('POST', `/api/products/${id}/decision`, { decision: prevDecision });
  assert.equal(decUndo.status, 200);
  assert.equal(decUndo.body.decision, 'undecided');
});

test('HTTP 第1部（T-013/T-011/写真冪等性/不整合監査）: FNSKU強制・operationId・訂正・expectedRev・AI保護・写真不変条件', async () => {
  const p1 = (await api('POST', '/api/products', { name: '商品A', fnsku: ' x00guard01 ' })).body.product;
  assert.equal(p1.fnsku, 'X00GUARD01', 'normalized on save');
  assert.equal(p1.listing.titleSource, 'unknown');
  assert.equal(p1.listing.descriptionSource, 'unknown');
  const p2 = (await api('POST', '/api/products', { name: '商品B' })).body.product;

  // Invalid FNSKU format rejected with 400 INVALID_FNSKU_FORMAT
  const badFmt = await api('PATCH', `/api/products/${p2.id}`, { set: { fnsku: 'BAD123' } });
  assert.equal(badFmt.status, 400);
  assert.equal(badFmt.body.code, 'INVALID_FNSKU_FORMAT');

  // FNSKU uniqueness enforced across PATCH and parallel requests
  const patchDup = await api('PATCH', `/api/products/${p2.id}`, { set: { fnsku: 'X00GUARD01' } });
  assert.equal(patchDup.status, 409);
  assert.equal(patchDup.body.code, 'FNSKU_OWNED_BY_OTHER');
  assert.equal(patchDup.body.owner.productId, p1.id);

  const p3 = (await api('POST', '/api/products', { name: '商品C' })).body.product;
  const [par1, par2] = await Promise.all([
    api('POST', '/api/scan/confirm', { id: p2.id, fnsku: 'X00RACE001', presence: true, operationId: 'op-race-1' }),
    api('POST', '/api/scan/confirm', { id: p3.id, fnsku: 'X00RACE001', presence: true, operationId: 'op-race-2' }),
  ]);
  assert.deepEqual([par1.status, par2.status].sort(), [200, 409], 'parallel bind of same FNSKU lets only one succeed');

  // Different FNSKU on already-assigned product rejected on /api/scan/confirm
  const diffConfirm = await api('POST', '/api/scan/confirm', { id: p1.id, fnsku: 'X00DIFF999', presence: true });
  assert.equal(diffConfirm.status, 409);
  assert.equal(diffConfirm.body.code, 'PRODUCT_HAS_DIFFERENT_FNSKU');
  assert.equal(diffConfirm.body.currentFnsku, 'X00GUARD01');

  // operationId idempotency (same product -> no double apply; different product -> 409 OPERATION_ID_CONFLICT)
  const opFirst = await api('POST', '/api/scan/confirm', { id: p1.id, fnsku: 'X00GUARD01', presence: true, operationId: 'op-idem-1' });
  assert.equal(opFirst.status, 200);
  const countAfterFirst = opFirst.body.scans.length;
  const opReplay = await api('POST', '/api/scan/confirm', { id: p1.id, fnsku: 'X00GUARD01', presence: true, operationId: 'op-idem-1' });
  assert.equal(opReplay.status, 200);
  assert.equal(opReplay.body.idempotent, true);
  assert.equal(opReplay.body.scans.length, countAfterFirst);
  const opCross = await api('POST', '/api/scan/confirm', { id: p3.id, fnsku: '', presence: true, operationId: 'op-idem-1' });
  assert.equal(opCross.status, 409);
  assert.equal(opCross.body.code, 'OPERATION_ID_CONFLICT');

  // FNSKU correction API: history records old/new/reason/operationId, scanEvents untouched, conflict blocked
  const corrConflict = await api('POST', `/api/products/${p1.id}/fnsku/correct`, { newFnsku: 'X00RACE001', reason: '誤登録', operationId: 'op-corr-bad' });
  assert.equal(corrConflict.status, 409);
  assert.equal(corrConflict.body.code, 'FNSKU_OWNED_BY_OTHER');

  const corrOk = await api('POST', `/api/products/${p1.id}/fnsku/correct`, { newFnsku: 'X00FIXED01', reason: 'ラベル見間違い', operationId: 'op-corr-1' });
  assert.equal(corrOk.status, 200);
  assert.equal(corrOk.body.product.fnsku, 'X00FIXED01');
  assert.equal(corrOk.body.product.scanEvents[0].fnsku, 'X00GUARD01', 'past scanEvents are NOT overwritten');
  const hist = (await api('GET', `/api/products/${p1.id}/history`)).body;
  const corrHist = hist.find((h) => h.action === 'fnsku_correct');
  assert.equal(corrHist.oldFnsku, 'X00GUARD01');
  assert.equal(corrHist.newFnsku, 'X00FIXED01');
  assert.equal(corrHist.reason, 'ラベル見間違い');
  assert.equal(corrHist.operationId, 'op-corr-1');

  // Audit classifies explained correction as explainable (not anomaly), and catches prior unexplained mismatch
  const audit1 = (await api('GET', '/api/audit/fnsku')).body;
  assert.ok(!audit1.anomalies.some((x) => x.productId === p1.id));
  assert.ok(audit1.explainable.some((x) => x.type === 'explained_by_correction' && x.productId === p1.id));
  if (audit1.anomalies.length > 0) {
    const anom = audit1.anomalies[0];
    const inv = await api('POST', `/api/products/${anom.productId}/scan-events/${anom.eventId}/invalidate`, { reason: 'テスト誤スキャン無効化' });
    assert.equal(inv.status, 200);
    assert.ok(inv.body.event.invalidatedAt);
    assert.equal(inv.body.event.invalidationReason, 'テスト誤スキャン無効化');
    const audit2 = (await api('GET', '/api/audit/fnsku')).body;
    assert.equal(audit2.summary.anomalyCount, 0);
  }

  // T-011: expectedRev conflict, stock confirm does not bump rev, human_edited protection, UTF-16 length validation, hasJmtyOverride
  const det0 = (await api('GET', `/api/products/${p1.id}`)).body;
  const revBeforeScan = det0.rev;
  await api('POST', '/api/scan/confirm', { id: p1.id, fnsku: 'X00FIXED01', presence: true });
  const editTitle = await api('PATCH', `/api/products/${p1.id}`, { set: { 'listing.title': '人が編集したタイトル' }, expectedRev: revBeforeScan });
  assert.equal(editTitle.status, 200, 'stock confirm did not conflict with expectedRev');
  assert.equal(editTitle.body.product.listing.titleSource, 'human_edited');
  const newRev = editTitle.body.product.rev;
  assert.ok(newRev > revBeforeScan);

  // Stale expectedRev -> 409 REVISION_CONFLICT with current server values
  const stale = await api('PATCH', `/api/products/${p1.id}`, { set: { 'listing.title': '古い編集' }, expectedRev: revBeforeScan });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'REVISION_CONFLICT');
  assert.equal(stale.body.currentRev, newRev);
  assert.equal(stale.body.currentTitle, '人が編集したタイトル');

  // AI cannot silently overwrite human_edited title (stored as proposal even if unlocked)
  await api('PATCH', `/api/products/${p1.id}`, { unlock: ['listing.title'] });
  const aiEdit = await api('PATCH', `/api/products/${p1.id}`, { set: { 'listing.title': 'AIによる上書き案' } }, 'claude');
  assert.equal(aiEdit.status, 200);
  assert.equal(aiEdit.body.product.listing.title, '人が編集したタイトル');
  assert.ok(aiEdit.body.proposed.includes('listing.title'));

  // UTF-16 length validation (title > 40, description > 1000 -> 400)
  const tooLongTitle = await api('PATCH', `/api/products/${p1.id}`, { set: { 'listing.title': 'あ'.repeat(41) } });
  assert.equal(tooLongTitle.status, 400);
  const tooLongDesc = await api('PATCH', `/api/products/${p1.id}`, { set: { 'listing.description': 'い'.repeat(1001) } });
  assert.equal(tooLongDesc.status, 400);

  // hasJmtyOverride flag on detail API
  assert.equal((await api('GET', `/api/products/${p1.id}`)).body.hasJmtyOverride, false);
  await api('PATCH', `/api/products/${p1.id}`, { set: { 'override.jmty.title': 'ジモティー専用タイトル' } });
  assert.equal((await api('GET', `/api/products/${p1.id}`)).body.hasJmtyOverride, true);

  // Photo clientPhotoId idempotency, cross-product error, manual_camera/manual_library non-auto-adopt, and side-effect invariant
  const beforePhoto = (await api('GET', `/api/products/${p1.id}`)).body;
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
  const uploadManual = async (targetId, source, clientPhotoId) => {
    const fd = new FormData();
    fd.append('kind', 'actual');
    fd.append('source', source);
    fd.append('clientPhotoId', clientPhotoId);
    fd.append('original', new Blob([jpg], { type: 'image/jpeg' }), 'manual.jpg');
    const res = await fetch(`${base}/api/products/${targetId}/photos`, { method: 'POST', headers: { 'x-actor': 'user' }, body: fd });
    return { status: res.status, body: await res.json() };
  };
  const m1 = await uploadManual(p1.id, 'manual_camera', 'cpid-uuid-1');
  assert.equal(m1.status, 200);
  assert.equal(m1.body.duplicate, false);
  const afterPhoto = (await api('GET', `/api/products/${p1.id}`)).body;
  assert.deepEqual(afterPhoto.listingPhotoIds, [], 'manual_camera defaults to not adopted');
  assert.equal(afterPhoto.stockCheckedAt, beforePhoto.stockCheckedAt, 'photo upload must not alter stockCheckedAt');
  assert.equal(afterPhoto.fnsku, beforePhoto.fnsku);
  assert.equal(afterPhoto.conditionNote, beforePhoto.conditionNote);
  assert.equal(afterPhoto.aiInstruction, beforePhoto.aiInstruction);
  assert.equal(afterPhoto.name, beforePhoto.name);

  // Adopt photo per-item, then replay same clientPhotoId -> idempotent without resetting adoption
  const adopted = await api('PATCH', `/api/products/${p1.id}/photos/${m1.body.photo.id}`, { adopted: true });
  assert.equal(adopted.status, 200);
  assert.deepEqual(adopted.body.listingPhotoIds, [m1.body.photo.id]);
  const m1Replay = await uploadManual(p1.id, 'manual_camera', 'cpid-uuid-1');
  assert.equal(m1Replay.status, 200);
  assert.equal(m1Replay.body.duplicate, true);
  assert.deepEqual((await api('GET', `/api/products/${p1.id}`)).body.listingPhotoIds, [m1.body.photo.id]);

  // Same clientPhotoId on a different product -> 409 CLIENT_PHOTO_ID_CONFLICT
  const m1Cross = await uploadManual(p3.id, 'manual_library', 'cpid-uuid-1');
  assert.equal(m1Cross.status, 409);
  assert.equal(m1Cross.body.code, 'CLIENT_PHOTO_ID_CONFLICT');
});
