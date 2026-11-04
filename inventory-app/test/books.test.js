import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Books } from '../server/books.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-'));
  const store = new Store(dir);
  const vine = store.create({ name: 'Vineの食品' }).product.id;
  const bought = store.create({ name: '買った物' }).product.id;
  store.setBrowserInfo(vine, 'import', { asin: 'B0VINE0001', lists: { reviewed: { ordered: '2026-10-01', delivered: '2026-10-03' } } });
  store.setBrowserInfo(bought, 'import', { asin: 'B0BUY00001', lists: { orders: { ordered: '2026-10-02' } } });
  store.products.get(vine).amazon = { price: 1500, fetchedAt: '2026-10-27T10:00:00.000Z' };
  return { dir, store, vine, bought, books: new Books(dir) };
}

test('帳簿: 連携で Vine受領とレビュー投稿を1回だけ記録し、経費は自動で作らない', () => {
  const { store, vine, books } = setup();
  const r = books.syncFromProducts(store.list());
  assert.deepEqual(r, { created: 2, updated: 0 });
  const [receipt] = books.list({ kind: 'vine_receipt' });
  assert.equal(receipt.productId, vine);
  assert.equal(receipt.date, '2026-10-03', '受領日は到着日');
  assert.equal(receipt.facts.listPrice, 1500);
  assert.equal(receipt.facts.listPriceAt, '2026-10-27');
  assert.equal(receipt.status, 'review');
  assert.equal(receipt.valuation.value, null, '税務上の評価額は決めない');
  assert.deepEqual(receipt.journal.map((l) => [l.side, l.amount]), [['debit', 1500], ['credit', 1500]]);
  assert.equal(books.list({ kind: 'expense' }).length, 0);
  assert.deepEqual(books.syncFromProducts(store.list()), { created: 0, updated: 0 }, '二重に記録しない');
});

test('帳簿: 承認・対象外はユーザーのみ。承認後は連携でも書き換えず、変更は取り消してから', () => {
  const { store, vine, books, dir } = setup();
  books.syncFromProducts(store.list());
  const id = books.list({ kind: 'vine_receipt' })[0].id;
  assert.throws(() => books.setStatus(id, 'approved', 'claude'), /ユーザーのみ/);
  books.setStatus(id, 'approved', 'user');
  store.products.get(vine).amazon = { price: 1200, fetchedAt: '2026-11-01T00:00:00.000Z' };
  books.syncFromProducts(store.list());
  assert.equal(books.get(id).facts.listPrice, 1500, '承認済みは変えない');
  assert.throws(() => books.update(id, { facts: { listPrice: 1 } }, 'user'), /承認を取り消す/);
  books.setStatus(id, 'review', 'user');
  books.update(id, { valuation: { value: 1300, basis: '実売価格の中央値' }, tax: { claim: '動画制作で使用' } }, 'user');
  assert.equal(new Books(dir).get(id).valuation.value, 1300, 'ディスクに保存される');
  assert.ok(books.history(id).length >= 4, '変更の記録が残る');
});

test('帳簿: 手で記録・年の集計・CSV', () => {
  const { store, books } = setup();
  books.syncFromProducts(store.list());
  const e = books.create({ kind: 'expense', date: '2026/11/04', title: 'マイク', amount: 5000, journal: [{ side: 'debit', account: '消耗品費', amount: 5000 }, { side: 'credit', account: '現金', amount: 5000 }] }, 'user');
  books.setStatus(e.id, 'approved', 'user');
  const s = books.summary(2026);
  assert.equal(s.vine.shownPriceTotal, 1500);
  assert.deepEqual(s.approvedAccounts['消耗品費'], { debit: 5000, credit: 0 });
  const csv = books.csv(2026);
  assert.ok(csv.startsWith('﻿"取引ID"'));
  assert.match(csv, /マイク/);
  assert.throws(() => books.create({ kind: 'nope', date: '2026-11-04' }, 'user'), /種類/);
});
