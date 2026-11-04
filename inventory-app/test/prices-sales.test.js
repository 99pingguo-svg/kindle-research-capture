import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Books } from '../server/books.js';
import { Prices } from '../server/prices.js';
import { parseMercariSales } from '../server/adapters/mercari-sales.js';
import { ruleSuggest, matchProduct } from '../server/classify.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-'));
  const store = new Store(dir);
  const vine = store.create({ name: 'ステンレス 水筒 500ml 保温' }).product.id;
  const mine = store.create({ name: 'ワイヤレスイヤホン Bluetooth 5.3 ノイズキャンセリング' }).product.id;
  store.setBrowserInfo(vine, 'import', { asin: 'B0VINE0001', lists: { vineOrders: { ordered: '2026-10-01', delivered: '2026-10-03' } } });
  return { dir, store, vine, mine, books: new Books(dir), prices: new Prices(dir) };
}

const SALES = `ワイヤレスイヤホン Bluetooth 5.3 ノイズキャンセリング
m12345678901
販売価格
¥3,000
販売手数料
-¥300
配送料
-¥210
販売利益
¥2,490
購入日時 2026年10月20日 12:34

ステンレス 水筒 500ml
販売価格 ¥1,200
販売手数料 -¥120
配送料 -¥230
販売利益 ¥850
2026/10/22`;

test('価格の履歴: 受領日に近い確認の値を帳簿の表示価格に使い、前後30日の幅を残す', () => {
  const { store, vine, books, prices } = setup();
  prices.add({ asin: 'B0VINE0001', price: 1980, at: '2026-10-02T03:00:00Z', source: 'amazon_product_page_logged_out' }, 'import');
  prices.add({ asin: 'B0VINE0001', price: 1480, basisPrice: 1980, at: '2026-10-20T03:00:00Z', source: 'amazon_product_page_logged_out' }, 'import');
  assert.throws(() => prices.add({ asin: 'bad', price: 1 }, 'import'), /ASIN/);
  assert.equal(new Prices(store.dataDir).history('B0VINE0001').length, 2, 'ファイルから読み直せる');
  books.syncFromProducts(store.list(), 'import', prices);
  const [r] = books.list({ kind: 'vine_receipt' });
  assert.equal(r.productId, vine);
  assert.equal(r.facts.listPrice, 1980, '受領日（10/03）の前の確認');
  assert.equal(r.facts.listPriceAt, '2026-10-02');
  assert.match(r.facts.note, /1480〜1980円/);
});

test('価格の履歴: 確かめる順番は 未確認 → 受領60日以内は週1 → 以後90日ごと', () => {
  const { store, prices } = setup();
  const now = Date.parse('2026-10-10T00:00:00Z');
  assert.deepEqual(prices.dueAsins(store.list(), 20, now).map((d) => d.asin), ['B0VINE0001'], 'Vine提供品だけ・未確認は今');
  prices.add({ asin: 'B0VINE0001', price: 1000, at: '2026-10-08T00:00:00Z' }, 'import');
  assert.equal(prices.dueAsins(store.list(), 20, now).length, 0, '2日前に確認済み');
  assert.equal(prices.dueAsins(store.list(), 20, Date.parse('2026-10-16T00:00:00Z')).length, 1, '8日たてばまた');
  assert.equal(prices.dueAsins(store.list(), 20, Date.parse('2027-01-01T00:00:00Z')).length, 0, '受領から60日すぎは90日ごと');
});

test('メルカリの売上: 取引画面の文字・CSV を読み、二重に取り込まず、台帳の売却記録に追記する', () => {
  const { store, mine, vine, books } = setup();
  const p = parseMercariSales(SALES);
  assert.deepEqual(p.rows.map((r) => [r.date, r.title.slice(0, 8), r.price, r.fee, r.shipping, r.proceeds]),
    [['2026-10-20', 'ワイヤレスイヤホ', 3000, 300, 210, 2490], ['2026-10-22', 'ステンレス 水筒', 1200, 120, 230, 850]]);
  const csv = parseMercariSales('日付,商品名,販売価格,販売手数料,配送料\n2026/10/01,"バッテリー, 10000mAh",2500,250,210');
  assert.equal(csv.rows[0].title, 'バッテリー, 10000mAh');
  assert.equal(csv.rows[0].proceeds, 2040, '手取りは 価格−手数料−送料');

  // 台帳でメルカリ売却済みの商品 → 連携で売却の記録ができ、取り込みはそこへ追記する
  store.products.get(mine).channels = { mercari: { status: 'sold', soldAt: '2026-10-20T05:00:00Z', soldPrice: 3000 } };
  books.syncFromProducts(store.list());
  const auto = books.list({ kind: 'sold' })[0];
  assert.equal(auto.productId, mine);
  const dry = books.importSales(p.rows, store.list(), 'user', { dryRun: true });
  assert.deepEqual(dry.rows.map((r) => r.action), ['update', 'new']);
  assert.equal(books.list({ kind: 'sold' }).length, 1, 'dryRun は書かない');
  assert.equal(dry.rows[1].match.productId, vine, '名前の近い Vine の水筒が見つかる');
  assert.deepEqual([dry.rows[1].link, dry.rows[1].vine], ['', true], 'Vine提供品には自動で結び付けず、印を付ける');
  books.importSales(p.rows, store.list(), 'user');
  const after = books.get(auto.id);
  assert.deepEqual([after.facts.fee, after.facts.shipping, after.facts.proceeds], [300, 210, 2490]);
  assert.equal(books.list({ kind: 'sold' }).length, 2);
  assert.deepEqual(books.importSales(p.rows, store.list(), 'user').counts.duplicate, 2, '同じ取引は二重に入らない');
});

test('分類の候補: 売却は仮の仕訳と Vine の印、経費は語から科目、割合は決めない。使うのはユーザーだけ', () => {
  const { store, vine, books } = setup();
  const sold = books.create({ kind: 'sold', date: '2026-10-22', title: 'ステンレス 水筒 500ml 保温', productId: vine, amount: 1200, fee: 120, shipping: 230, proceeds: 850 }, 'user');
  const s = ruleSuggest(sold, store.list());
  assert.deepEqual(s.journal.map((l) => [l.side, l.account, l.amount]),
    [['debit', '支払手数料', 120], ['debit', '荷造運賃', 230], ['debit', '売上金（メルカリ）', 850], ['credit', '売上（フリマ）', 1200]]);
  assert.ok(s.flags.includes('vine_sold'));
  const phone = books.create({ kind: 'expense', date: '2026-10-05', title: 'スマホ回線の通信料', amount: 3000 }, 'user');
  const t = ruleSuggest(phone, store.list());
  assert.equal(t.journal[0].account, '通信費');
  assert.ok(t.flags.includes('mixed_use'), '私用と兼ねるかもしれない印だけ');
  assert.equal(ruleSuggest(books.create({ kind: 'expense', date: '2026-10-05', title: 'カメラ', amount: 80000 }, 'user'), store.list()).journal[0].account, '消耗品費', '10万円未満');
  assert.equal(ruleSuggest(books.create({ kind: 'expense', date: '2026-10-05', title: '謎の支払い', amount: 500 }, 'user'), store.list()), null, '分からないものはローカルAIへ');
  books.setSuggestion(phone.id, t, 'system');
  assert.equal(books.get(phone.id).journal.length, 0, '候補を付けても記録は変わらない');
  assert.throws(() => books.applySuggestion(phone.id, 'claude'), /ユーザーのみ/);
  const used = books.applySuggestion(phone.id, 'user');
  assert.equal(used.journal[0].account, '通信費');
  assert.equal(used.status, 'review', '使っても要確認のまま');
});

test('照合: 名前の近さに、メルカリで売却済み・同じ価格を足して確かなものだけ結び付ける', () => {
  const { store, mine } = setup();
  assert.equal(matchProduct(store.list(), 'ワイヤレスイヤホン Bluetooth5.3 ノイズキャンセリング').productId, mine);
  assert.equal(matchProduct(store.list(), '全然ちがう商品').productId, '');
});
