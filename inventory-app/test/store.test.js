import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { readiness, lint } from '../server/rules.js';
import * as mercari from '../server/adapters/mercari.js';
import * as channels from '../server/channels.js';
import { IMAGE_QC_CHECK_IDS } from '../server/schema.js';

const MODEL = 'claude-opus-5-5';
const imageChecks = () => IMAGE_QC_CHECK_IDS.map((id) => ({ id, result: 'pass' }));
const passQc = (store, id) => store.saveQc(id, 'claude', { result: 'pass', summary: 'OK', model: MODEL, checks: imageChecks() });

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-'));
const photo = (store, id, actor = 'user', meta = {}) => store.addPhoto(id, actor, { kind: 'actual', ...meta }, { original: { buffer: JPEG, mime: 'image/jpeg' } }).photo;

/** A product with everything needed for 出品準備完了 except QC. */
function preparedProduct(store) {
  const { product } = store.create({ name: 'Anker PowerCore 10000', brand: 'Anker', model: 'A1263', decision: 'sell' });
  const id = product.id;
  for (const tag of ['正面', '背面', '型番ラベル']) photo(store, id, 'user', { tag });
  store.updateFields(id, 'claude', {
    'listing.title': 'Anker PowerCore 10000 モバイルバッテリー A1263',
    'listing.description': 'Anker PowerCore 10000（A1263）です。\n動作確認済み。',
    'listing.category': '家電・スマホ・カメラ > スマホアクセサリー > モバイルバッテリー',
    'listing.shippingMethod': 'らくらくメルカリ便',
    'listing.shippingFrom': '東京都',
  });
  store.updateFields(id, 'user', { 'listing.price': 2800, 'listing.condition': '目立った傷や汚れなし' });
  return id;
}

test('create assigns sequential ids and persists a readable folder', () => {
  const dir = tmp();
  const store = new Store(dir);
  const a = store.create({ name: 'A' }).product;
  const b = store.create({ name: 'B' }).product;
  assert.equal(a.id, '0001');
  assert.equal(b.id, '0002');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'products/0001/product.json'), 'utf8'));
  assert.equal(onDisk.name, 'A');
  assert.ok(fs.existsSync(path.join(dir, 'products/0001/listing.txt')));
  // reload from disk
  const again = new Store(dir);
  assert.equal(again.get('0002').name, 'B');
  assert.equal(again.create({ name: 'C' }).product.id, '0003');
});

test('user edits lock fields; AI writes to locked fields become proposals', () => {
  const store = new Store(tmp());
  const id = store.create({ name: 'rough name' }).product.id;
  // initial value is not locked, AI may refine it
  let r = store.updateFields(id, 'claude', { name: 'Anker PowerCore 10000' });
  assert.deepEqual(r.set, ['name']);
  store.updateFields(id, 'user', { 'listing.title': 'ユーザーのタイトル' });
  r = store.updateFields(id, 'claude', { 'listing.title': 'AIのタイトル' }, { reason: 'SEO' });
  assert.deepEqual(r.proposed, ['listing.title']);
  assert.equal(store.get(id).listing.title, 'ユーザーのタイトル');
  assert.equal(store.get(id).proposals['listing.title'].value, 'AIのタイトル');
  store.resolveProposal(id, 'user', 'listing.title', true);
  assert.equal(store.get(id).listing.title, 'AIのタイトル');
  assert.equal(store.get(id).proposals['listing.title'], undefined);
});

test('AI cannot take user-only actions', () => {
  const store = new Store(tmp());
  const id = store.create({ name: 'x' }).product.id;
  assert.throws(() => store.setDecision(id, 'claude', 'sell'), /ユーザーのみ/);
  assert.throws(() => store.trash(id, 'claude'), /ユーザーのみ/);
  assert.throws(() => store.setStage(id, 'claude', 'queued'), /ユーザーのみ/);
  assert.throws(() => store.deletePhoto(id, 'claude', 'nope'), /ユーザーのみ/);
});

test('reference images can never be listing photos', () => {
  const store = new Store(tmp());
  const id = store.create({ name: 'x' }).product.id;
  const ref = store.addPhoto(id, 'claude', { kind: 'reference' }, { original: { buffer: JPEG, mime: 'image/jpeg' } }).photo;
  assert.equal(store.get(id).listingPhotoIds.length, 0, 'reference not auto-selected');
  assert.throws(() => store.setListingPhotos(id, 'user', [ref.id]), /参考資料画像/);
  assert.throws(() => store.updatePhoto(id, 'claude', ref.id, { kind: 'actual' }), /ユーザーのみ/);
});

test('photos: auto-select for listing, idempotent clientId, request fulfilment by tag', () => {
  const store = new Store(tmp());
  const id = store.create({ name: 'x', decision: 'sell' }).product.id;
  assert.equal(store.get(id).stage, 'unsorted');
  store.addPhotoRequests(id, 'claude', [{ label: '背面', reason: '状態確認' }]);
  const a = photo(store, id, 'user', { clientId: 'c1' });
  const again = store.addPhoto(id, 'user', { kind: 'actual', clientId: 'c1' }, { original: { buffer: JPEG, mime: 'image/jpeg' } });
  assert.equal(again.duplicate, true);
  assert.equal(again.photo.id, a.id);
  photo(store, id, 'user', { tag: '背面' });
  const p = store.get(id);
  assert.equal(p.photos.length, 2);
  assert.equal(p.listingPhotoIds.length, 2);
  assert.ok(p.photoRequests[0].doneAt, 'request fulfilled by tagged photo');
  assert.equal(p.stage, 'shooting');
});

test('full flow: ready requires confirmed price/condition and fresh QC; edits invalidate QC', () => {
  const store = new Store(tmp());
  const id = preparedProduct(store);
  let rd = readiness(store.get(id), store.settings);
  assert.deepEqual(rd.missing.map((m) => m.code), ['qc']);
  passQc(store, id);
  assert.equal(store.get(id).stage, 'ready');
  // a later content edit makes QC stale and demotes the product
  store.updateFields(id, 'user', { 'listing.description': 'Anker PowerCore 10000（A1263）です。\n動作確認済み。付属品なし。' });
  rd = readiness(store.get(id), store.settings);
  assert.ok(rd.missing.some((m) => m.code === 'qc_stale'));
  assert.equal(store.get(id).stage, 'needs_review');
});

test('AI-set price is not enough: user must confirm', () => {
  const store = new Store(tmp());
  const id = store.create({ name: 'x' }).product.id;
  store.updateFields(id, 'claude', { 'listing.price': 1200 });
  const rd = readiness(store.get(id), store.settings);
  assert.ok(rd.missing.some((m) => m.code === 'unconfirmed:listing.price'));
  store.confirmFields(id, 'user', ['listing.price']);
  assert.ok(!readiness(store.get(id), store.settings).missing.some((m) => m.code.endsWith('listing.price')));
});

test('QC cannot pass while deterministic lint errors exist', () => {
  const store = new Store(tmp());
  const id = preparedProduct(store);
  store.updateFields(id, 'claude', { 'listing.description': '付属品: 要確認' });
  assert.throws(() => passQc(store, id), /PASS にできません/);
});

test('revert restores previous content but keeps photos added since', () => {
  const store = new Store(tmp());
  const id = store.create({ name: 'orig' }).product.id;
  store.updateFields(id, 'claude', { name: 'bad AI rename', 'listing.title': 'bad' });
  photo(store, id);
  const h = store.history(id).find((x) => x.action === 'update');
  store.revert(id, 'user', h.id);
  const p = store.get(id);
  assert.equal(p.name, 'orig');
  assert.equal(p.listing.title, '');
  assert.equal(p.photos.length, 1);
});

test('revertActorSince undoes an AI batch across products', () => {
  const store = new Store(tmp());
  const a = store.create({ name: 'A' }).product.id;
  const b = store.create({ name: 'B' }).product.id;
  const since = new Date().toISOString();
  store.updateFields(a, 'claude', { name: 'A!!' });
  store.updateFields(b, 'claude', { name: 'B!!' });
  store.updateFields(b, 'claude', { brand: 'X' });
  const res = store.revertActorSince('user', 'claude', since);
  assert.equal(res.length, 2);
  assert.equal(store.get(a).name, 'A');
  assert.equal(store.get(b).name, 'B');
  assert.equal(store.get(b).brand, '');
});

test('trash and purge require explicit steps', () => {
  const dir = tmp();
  const store = new Store(dir);
  const id = store.create({ name: 'x' }).product.id;
  assert.throws(() => store.purge(id, 'user', id), /ゴミ箱内/);
  store.trash(id, 'user');
  assert.throws(() => store.purge(id, 'user', 'wrong'), /商品ID/);
  store.purge(id, 'user', id);
  assert.ok(!fs.existsSync(path.join(dir, 'products', id)));
});

test('duplicates detected by model, JAN, URL, similar name', () => {
  const store = new Store(tmp());
  store.create({ name: 'Anker PowerCore 10000', model: 'A1263', jan: '0848061063815' }, 'user', { links: ['https://www.amazon.co.jp/dp/B019GJLER8?tag=x'] });
  const d1 = store.duplicatesFor({ name: 'anker powercore 10000' });
  assert.equal(d1.length, 1);
  const d2 = store.duplicatesFor({ name: '別物', links: ['https://amazon.co.jp/dp/B019GJLER8'] });
  assert.match(d2[0].reasons.join(), /URL/);
  assert.throws(() => store.create({ name: 'x', model: 'a-1263' }, 'user', { allowDuplicate: false }), /重複/);
});

test('AI task lifecycle and shoot-done', () => {
  const store = new Store(tmp());
  const id = store.create({ name: 'x', decision: 'sell' }).product.id;
  photo(store, id);
  store.shootDone(id, 'user');
  let p = store.get(id);
  assert.equal(p.stage, 'ai_pending');
  const t = p.aiTasks[0];
  assert.equal(t.type, 'full');
  store.startAiTask(id, 'claude', t.id);
  assert.equal(store.get(id).stage, 'ai_processing');
  store.finishAiTask(id, 'claude', t.id, { message: 'ok' });
  p = store.get(id);
  assert.equal(p.stage, 'needs_review');
  assert.equal(p.aiTasks[0].status, 'done');
});

test('mercari adapter: package, record, verify, approval gate', () => {
  const store = new Store(tmp());
  const id = preparedProduct(store);
  assert.throws(() => mercari.buildPackage(store, id), /出品準備が完了していません/);
  passQc(store, id);
  store.setStage(id, 'user', 'queued');
  const pkg = mercari.buildPackage(store, id);
  assert.equal(pkg.photos.length, 3);
  assert.ok(fs.existsSync(pkg.photos[0].path));
  assert.ok(pkg.photos[0].path.endsWith('01.jpg'));
  mercari.recordEntry(store, id, 'claude', { savedAs: 'draft' });
  assert.equal(store.get(id).stage, 'mercari_entered');
  const L = store.get(id).listing;
  const bad = mercari.recordVerification(store, id, 'claude', { ...L, price: 280, photoCount: 3, photoOrderOk: true, photosMatchProduct: true, productMatches: true });
  assert.equal(bad.result, 'fail');
  assert.deepEqual(bad.mismatches.map((m) => m.field), ['price']);
  const good = mercari.recordVerification(store, id, 'claude', {
    ...L, description: L.description.replace('\n', '\r\n  '), category: 'モバイルバッテリー', photoCount: 3, photoOrderOk: true, photosMatchProduct: true, productMatches: true,
  });
  assert.equal(good.result, 'pass');
  assert.equal(store.get(id).stage, 'final_check');
  assert.throws(() => mercari.markListed(store, id, 'claude', {}), /公開承認/);
  assert.throws(() => mercari.approvePublish(store, id, 'claude'), /ユーザーのみ/);
  mercari.approvePublish(store, id, 'user');
  mercari.markListed(store, id, 'claude', { itemUrl: 'https://jp.mercari.com/item/m123' });
  assert.equal(store.get(id).stage, 'listed');
  mercari.markSold(store, id, 'claude', { price: 2800 });
  assert.equal(store.get(id).stage, 'sold');
  assert.equal(store.get(id).soldPrice, 2800);
});

test('facts: AI cannot overwrite user facts, proposes instead', () => {
  const store = new Store(tmp());
  const id = store.create({ name: 'x' }).product.id;
  store.setFacts(id, 'user', [{ key: 'color', label: '色', value: '黒', confidence: 'confirmed' }]);
  store.setFacts(id, 'claude', [
    { key: 'color', label: '色', value: 'ブラック', confidence: 'confirmed' },
    { key: 'year', label: '発売年', value: '2024', confidence: 'reference' },
  ]);
  const p = store.get(id);
  assert.equal(p.facts.find((f) => f.key === 'color').value, '黒');
  assert.equal(p.facts.find((f) => f.key === 'color').proposal.value, 'ブラック');
  assert.equal(p.facts.find((f) => f.key === 'year').confidence, 'reference');
});

test('QC (incl. image QC) only accepted from the configured model, with all image checks', () => {
  const store = new Store(tmp());
  const id = preparedProduct(store);
  assert.throws(() => store.saveQc(id, 'claude', { result: 'pass', model: 'claude-haiku-4-5-20251001', checks: imageChecks() }), /claude-opus-5-5/);
  assert.throws(() => store.saveQc(id, 'claude', { result: 'pass', checks: imageChecks() }), /未指定/);
  assert.throws(() => store.saveQc(id, 'claude', { result: 'pass', model: MODEL, checks: [] }), /画像QCの未評価項目/);
  const withFail = imageChecks().map((c) => (c.id === 'image_anomaly' ? { ...c, result: 'fail' } : c));
  assert.throws(() => store.saveQc(id, 'claude', { result: 'pass', model: MODEL, checks: withFail }), /fail のチェック項目/);
  store.saveQc(id, 'claude', { result: 'needs_review', model: MODEL, summary: '背面に別商品が写り込み', checks: withFail, photoRequests: ['背面'] });
  assert.equal(store.get(id).qc.model, MODEL);
  passQc(store, id);
  assert.equal(store.get(id).qc.result, 'pass');
  // a QC made by a model that is later removed from the allow-list no longer counts
  store.updateSettings({ imageQcModels: ['some-other-model'] });
  assert.ok(readiness(store.get(id), store.settings).missing.some((m) => m.code === 'qc_model'));
});

test('decision 下書き: prepares like 出品 but can never be approved or published', () => {
  const store = new Store(tmp());
  const id = preparedProduct(store);
  store.setDecision(id, 'user', 'draft');
  assert.throws(() => store.setDecision(id, 'claude', 'sell'), /ユーザーのみ/);
  passQc(store, id);
  assert.equal(readiness(store.get(id), store.settings).ok, true);
  store.setStage(id, 'user', 'queued');
  mercari.recordEntry(store, id, 'claude', { savedAs: 'draft' });
  assert.throws(() => mercari.recordEntry(store, id, 'claude', { savedAs: 'listed' }), /公開承認/);
  const L = store.get(id).listing;
  mercari.recordVerification(store, id, 'claude', { ...L, category: 'モバイルバッテリー', photoCount: 3, photoOrderOk: true, photosMatchProduct: true, productMatches: true });
  assert.throws(() => mercari.approvePublish(store, id, 'user'), /下書き/);
  assert.throws(() => mercari.markListed(store, id, 'claude', {}), /下書き/);
  store.setDecision(id, 'user', 'sell');
  mercari.approvePublish(store, id, 'user');
});

test('generated images: listable with a warning, never confused with own photos', () => {
  const store = new Store(tmp());
  const { product } = store.create({ name: '生成画像だけの商品' });
  const id = product.id;
  const gen = store.addPhoto(id, 'import', { kind: 'generated' }, { original: { buffer: JPEG, mime: 'image/jpeg' } }).photo;
  const ref = store.addPhoto(id, 'import', { kind: 'reference' }, { original: { buffer: JPEG, mime: 'image/jpeg' } }).photo;
  assert.equal(gen.source, 'generated');
  assert.throws(() => store.setListingPhotos(id, 'user', [gen.id, ref.id]), /参考資料画像/);
  store.setListingPhotos(id, 'user', [gen.id]);
  const rd = readiness(store.get(id), store.settings);
  assert.ok(!rd.missing.some((m) => m.code === 'no_photos'));
  assert.ok(rd.warnings.some((w) => w.code === 'generated_only'));
  assert.throws(() => store.updatePhoto(id, 'claude', gen.id, { kind: 'actual' }), /ユーザーのみ/);
  store.updatePhoto(id, 'claude', gen.id, { kind: 'reference' });
  assert.deepEqual(store.get(id).listingPhotoIds, []);
});

test('update ledger basis: photos carry sha256; Mercari snapshot flags later image/text changes', () => {
  const store = new Store(tmp());
  const id = preparedProduct(store);
  const first = store.get(id).photos[0];
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  passQc(store, id);
  store.setStage(id, 'user', 'queued');
  mercari.recordEntry(store, id, 'claude', { savedAs: 'draft' });
  const codes = () => lint(store.get(id), store.settings).map((x) => x.code);
  assert.ok(!codes().includes('mercari_photos_changed'));
  // An updated image replaces the first listing photo (different bytes → different fingerprint).
  const newer = store.addPhoto(id, 'user', { kind: 'actual' }, { original: { buffer: Buffer.concat([JPEG, Buffer.from([1])]), mime: 'image/jpeg' } }).photo;
  store.setListingPhotos(id, 'user', [newer.id, ...store.get(id).listingPhotoIds.slice(1)]);
  assert.ok(codes().includes('mercari_photos_changed'));
  store.updateFields(id, 'user', { 'listing.description': '説明を更新しました。' });
  assert.ok(codes().includes('mercari_text_changed'));
});

test('status check: platform lists sync into the app; cross-platform conflict is flagged', () => {
  const store = new Store(tmp());
  const id = preparedProduct(store);
  passQc(store, id);
  store.setStage(id, 'user', 'queued');
  mercari.recordEntry(store, id, 'claude', { savedAs: 'draft' });
  const title = store.get(id).listing.title;
  // The user published it on Mercari by hand; the checker sees it in the 出品中 list (matched by title).
  let r = channels.syncObserved(store, 'claude', 'mercari', [{ status: 'listed', title, itemUrl: 'https://jp.mercari.com/item/m11112222333', price: 2800 }]);
  assert.deepEqual(r.updated.map((u) => u.to), ['listed']);
  assert.equal(store.get(id).stage, 'listed');
  assert.equal(store.get(id).channels.mercari.itemId, 'm11112222333');
  // Same state again: nothing written, but the check time is kept.
  r = channels.syncObserved(store, 'claude', 'mercari', [{ status: 'listed', itemUrl: 'https://jp.mercari.com/item/m11112222333' }]);
  assert.equal(r.unchanged, 1);
  assert.ok(store.get(id).channels.mercari.lastCheckedAt);
  // An order comes in (取引中), matched by item id; an unknown item is reported, not guessed.
  r = channels.syncObserved(store, 'claude', 'mercari', [{ status: 'trading', itemId: 'm11112222333' }, { status: 'listed', title: '知らない商品' }]);
  assert.equal(store.get(id).stage, 'trading');
  assert.equal(r.unmatched.length, 1);
  // Also offered on ジモティー → must be withdrawn there.
  store.updateChannel(id, 'user', 'jmty', { status: 'listed' });
  assert.ok(lint(store.get(id), store.settings).some((x) => x.code === 'offered_elsewhere' && x.severity === 'error'));
  channels.syncObserved(store, 'claude', 'mercari', [{ status: 'sold', itemId: 'm11112222333', price: 2800 }]);
  assert.equal(store.get(id).stage, 'sold');
  assert.equal(store.get(id).soldPrice, 2800);
  assert.equal(store.meta.channelChecks.mercari.seen, 1);
});

test('mercari queue: 出品待ち by default; ready 出品/下書き only when explicitly included', () => {
  const store = new Store(tmp());
  const id = preparedProduct(store);
  store.setDecision(id, 'user', 'draft');
  passQc(store, id);
  assert.equal(store.get(id).stage, 'ready');
  assert.deepEqual(mercari.queue(store).map((p) => p.id), []);
  assert.deepEqual(mercari.queue(store, { includeReady: true }).map((p) => p.id), [id]);
  store.setDecision(id, 'user', 'hold');
  assert.deepEqual(mercari.queue(store, { includeReady: true }).map((p) => p.id), []);
});
