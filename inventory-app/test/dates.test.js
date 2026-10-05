import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { parseDateRows, planDates, importDates, asinOf } from '../server/dates.js';
import { normalizeDate } from '../server/schema.js';
import { parseImport } from '../server/index.js';

// Real lines from the user's list (tab separated; the date sits in column 3 or 4).
const T = '\t';
const LINES = [
  ['フォームローラー Anjeri 筋膜リリースローラー ヨガストラップ', 'https://www.amazon.co.jp/dp/B0HF6WWQ51', '', '', ''],
  ['LCDお絵描きボード 電子メモパッド 2枚セット 子供用', 'https://www.amazon.co.jp/dp/B0HB31SVLH', '', '2026-10-04', ''],
  ['COOLHILL パナソニック シェーバー ES9013 替刃、外刃ES9087+内刃ES9068 互換品 1セット ブラック', 'https://www.amazon.co.jp/dp/B0HK8THP6Z', '', '2026-10-02', ''],
  ['COOLHILL パナソニック シェーバー ES9013 替刃、外刃ES9087+内刃ES9068 互換品 1セット ブラック', 'https://www.amazon.co.jp/dp/B0H3TX4H1F', '', '2026-06-16', ''],
  ['（商品名なし）', 'https://www.amazon.co.jp/dp/B0HHHLNJF2', '', '2026-09-23', ''],
  ['高校入試 5科の完全復習： 15日で一気に合格する!', 'https://www.amazon.co.jp/dp/4424638669', '', '2026-08-11', ''],
  ['BJBT Tesla Model Y（2025-20…', 'https://www.amazon.co.jp/dp/B0HB3LW14C', '', '2026-08-23', ''],
  ['【RSC51 】【4個入】浄水シャワー カートリッジ', 'https://www.amazon.co.jp/dp/B0H2LQRQ83', '2026-06-06', '', ''],
  ['Nintendo Switch 2(日本語・国内専用)', 'https://www.amazon.co.jp/dp/B0DX1BC3R8', '2026-04-22', '', ''],
  ['リストにだけある商品（未登録）', 'https://www.amazon.co.jp/dp/B0ZZZZZZZZ', '', '2026-09-01', ''],
].map((c) => c.join(T)).join('\n');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-dates-'));

test('normalizeDate accepts common formats and rejects impossible dates', () => {
  assert.equal(normalizeDate('2026-9-3'), '2026-09-03');
  assert.equal(normalizeDate('2026/09/23'), '2026-09-23');
  assert.equal(normalizeDate('2026年9月23日'), '2026-09-23');
  assert.equal(normalizeDate('2026-02-30'), null);
  assert.equal(normalizeDate('9/23'), null);
});

test('parseDateRows: date from column 3 or 4, name without dates, ASIN incl. ISBN', () => {
  const rows = parseDateRows(LINES);
  assert.equal(rows.length, 10);
  assert.equal(rows[0].date, null);
  assert.equal(rows[1].date, '2026-10-04');
  assert.equal(rows[7].date, '2026-06-06');
  assert.equal(rows[1].name, 'LCDお絵描きボード 電子メモパッド 2枚セット 子供用');
  assert.deepEqual(rows[5].asins, ['4424638669']);
  assert.equal(asinOf('https://www.amazon.co.jp/gp/product/B0HF6WWQ51?th=1'), 'B0HF6WWQ51');
});

test('dates apply only to existing products; unmatched rows ignored; same name different ASIN kept apart', () => {
  const store = new Store(tmp());
  // Existing products as registered earlier from the same list (name + URL, no date)
  for (const line of LINES.split('\n').slice(0, 9)) {
    const [name, url] = line.split(T);
    store.create({ name }, 'user', { links: [url] });
  }
  store.create({ name: '手動で登録した別商品' });
  const before = store.list().length;

  const dry = importDates(store, 'user', { text: LINES });
  assert.equal(dry.counts.set, 8);
  assert.equal(dry.counts.nomatch, 1);
  assert.equal(dry.counts.nodate, 1);
  assert.ok(store.list().every((p) => !p.itemDate), 'dry run changes nothing');

  const r = importDates(store, 'user', { text: LINES, dryRun: false });
  assert.equal(r.applied.length, 8);
  assert.equal(store.list().length, before, 'no products created');
  const byName = (n) => store.list().filter((p) => p.name.startsWith(n));
  const shavers = byName('COOLHILL').map((p) => p.itemDate).sort();
  assert.deepEqual(shavers, ['2026-06-16', '2026-10-02'], 'two identical names matched by ASIN, not mixed up');
  assert.equal(byName('Nintendo Switch 2')[0].itemDate, '2026-04-22');
  assert.equal(byName('（商品名なし）')[0].itemDate, '2026-09-23');
  assert.equal(byName('フォームローラー')[0].itemDate, '', 'row without date leaves product untouched');

  // Re-running is idempotent
  const again = importDates(store, 'user', { text: LINES });
  assert.equal(again.counts.same, 8);
});

test('name fallback only when unique; ambiguous rows need explicit opt-in', () => {
  const store = new Store(tmp());
  const a = store.create({ name: 'リッチェル スプラウトファーム 24型N アイボリー' }).product.id;
  store.create({ name: '同名商品' });
  store.create({ name: '同名商品' });
  const text = ['リッチェル スプラウトファーム 24型N アイボリー\thttps://example.com/x\t\t2026-07-31', '同名商品\t\t\t2026-07-01'].join('\n');
  const plan = planDates(store.list(), parseDateRows(text));
  assert.equal(plan[0].status, 'set');
  assert.equal(plan[0].matchedBy, '商品名');
  assert.equal(plan[1].status, 'nomatch', 'non-unique name is never guessed');
  importDates(store, 'user', { text, dryRun: false });
  assert.equal(store.get(a).itemDate, '2026-07-31');
});

test('product list import also picks up the date and keeps it out of the name', () => {
  const items = parseImport('Nintendo Switch 2(日本語・国内専用)\thttps://www.amazon.co.jp/dp/B0DX1BC3R8\t2026-04-22\t\t');
  assert.deepEqual(items, [{ name: 'Nintendo Switch 2(日本語・国内専用)', links: ['https://www.amazon.co.jp/dp/B0DX1BC3R8'], itemDate: '2026-04-22' }]);
});
