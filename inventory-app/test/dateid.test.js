import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { DateIds, reiwaDate, formatDateId, parseOrderList, rowsFromJson, daysFromList } from '../server/dateid.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-dateid-'));
const line = (name, asin, date) => `${name}\t${asin ? `https://www.amazon.co.jp/dp/${asin}` : 'https://www.amazon.co.jp/gp/your-account/order-details?orderID=250-0000000-0000000'}\t${date}\t\t`;
const asin = (n) => `B0TEST${String(n).padStart(4, '0')}`;

test('日付IDの形: 令和の年月日6桁＋注文順＋その日の数（締まっていなければ ?）', () => {
  assert.equal(reiwaDate('2026-10-10'), '081010');
  assert.equal(reiwaDate('2019-05-01'), '010501');
  assert.equal(reiwaDate('2019-04-30'), null);
  assert.equal(formatDateId('2026-10-10', 8, 8), '08101088');
  assert.equal(formatDateId('2026-11-15', 1, null), '0811151?');
  assert.equal(formatDateId('2026-11-15', 3, 2), '');
});

test('一覧の読み取り: 注文番号のリンクは覚えず、ASIN だけ', () => {
  const { rows, skipped } = parseOrderList(`﻿${line('商品A', asin(1), '2026-11-15')}\n${line('商品B', '', '2026-11-15')}\n商品C\t\t\t\t\n`);
  assert.equal(skipped, 1);
  assert.deepEqual(rows, [{ title: '商品A', asin: asin(1), date: '2026-11-15' }, { title: '商品B', asin: '', date: '2026-11-15' }]);
  assert.ok(!JSON.stringify(rows).includes('orderID'));
});

test('新しい順の一覧: 同じ日の中も新しい順なので、下の行ほど先の注文', () => {
  const { rows } = parseOrderList([line('c', asin(3), '2026-11-14'), line('b', asin(2), '2026-11-14'), line('a', asin(1), '2026-11-14'), line('z', asin(9), '2026-11-13')].join('\n'));
  const { days } = daysFromList(rows);
  assert.deepEqual(days.get('2026-11-14').map((r) => r.title), ['a', 'b', 'c']);
});

test('古い順の一覧も向きを日付から読む', () => {
  const { rows } = parseOrderList([line('z', asin(9), '2026-11-13'), line('a', asin(1), '2026-11-14'), line('b', asin(2), '2026-11-14')].join('\n'));
  assert.deepEqual(daysFromList(rows).days.get('2026-11-14').map((r) => r.title), ['a', 'b']);
});

test('アプリが後から足した区切り（firstSeen が10分以上あく）は、前の区切りより後の注文', () => {
  const t0 = 816400000; // seconds since 2001 (the app's firstSeen)
  const { rows } = rowsFromJson([
    { asin: asin(2), title: 'b', ordered: '2026-11-15', firstSeen: t0 }, { asin: asin(1), title: 'a', ordered: '2026-11-15', firstSeen: t0 + 0.01 },
    { asin: asin(9), title: 'z', ordered: '2026-11-14', firstSeen: t0 + 0.02 },
    { asin: asin(4), title: 'd', ordered: '2026-11-15', firstSeen: t0 + 3600 }, { asin: asin(3), title: 'c', ordered: '2026-11-15', firstSeen: t0 + 3600.01 },
  ]);
  assert.deepEqual(daysFromList(rows).days.get('2026-11-15').map((r) => r.title), ['a', 'b', 'c', 'd']);
});

test('いちばん新しい日は8件未満なら ?、次の一覧でより新しい日が来たら締まる。知っている注文の番号は変わらない', () => {
  const store = new Store(tmp());
  const ids = [1, 2, 3, 9].map((n) => store.create({ name: `テスト商品${n}` }, 'user', { links: [{ url: `https://www.amazon.co.jp/dp/${asin(n)}` }] }).product.id);
  const d = new DateIds(store.dataDir);
  const first = [line('商品2', asin(2), '2026-11-15'), line('商品1', asin(1), '2026-11-15'), line('商品9', asin(9), '2026-11-14')].join('\n');
  const dry = d.importList(store, 'user', { text: first });
  assert.equal(dry.dryRun, true);
  assert.equal(store.get(ids[0]).dateId, undefined, '試しでは書かない');
  const r1 = d.importList(store, 'user', { text: first, dryRun: false });
  assert.equal(r1.applied, 3);
  assert.equal(store.get(ids[0]).dateId, '0811151?');
  assert.equal(store.get(ids[1]).dateId, '0811152?');
  assert.equal(store.get(ids[3]).dateId, '08111411', '古い日は締まっている');
  assert.deepEqual(r1.open, [{ date: '2026-11-15', count: 2 }]);

  // Next day's list: 11/15 gained one more order (商品3, newest of that day) and 11/16 has one.
  const second = [line('商品X', '', '2026-11-16'), line('商品3', asin(3), '2026-11-15'), line('商品2', asin(2), '2026-11-15'), line('商品1', asin(1), '2026-11-15')].join('\n');
  const r2 = d.importList(store, 'import', { text: second, dryRun: false, from: '観察ブラウザ連携' });
  assert.equal(store.get(ids[0]).dateId, '08111513');
  assert.equal(store.get(ids[1]).dateId, '08111523');
  assert.equal(store.get(ids[2]).dateId, '08111533');
  assert.equal(store.get(ids[3]).dateId, '08111411', '一覧にない日は覚えたまま');
  assert.deepEqual(r2.open, [{ date: '2026-11-16', count: 1 }]);
  assert.equal(r2.unmatched, 1, 'リンクのない台帳にない注文も数と順番には入る');
  assert.ok(store.history(ids[0]).some((h) => h.action === 'date_id'));
});

test('8件そろった日は、その日が一番新しくても締まる', () => {
  const store = new Store(tmp());
  const text = Array.from({ length: 8 }, (_, i) => line(`商品${8 - i}`, asin(8 - i), '2026-11-15')).join('\n');
  const id = store.create({ name: '八番目の商品' }, 'user', { links: [{ url: `https://www.amazon.co.jp/dp/${asin(8)}` }] }).product.id;
  new DateIds(store.dataDir).importList(store, 'user', { text, dryRun: false });
  assert.equal(store.get(id).dateId, '08111588');
});

test('リンクのない注文は商品名（先頭30字）で結ぶ。2つの商品に当たる名前は結ばない', () => {
  const store = new Store(tmp());
  // 観察ブラウザ連携が登録する名前（「 | 」より前）
  const one = store.create({ name: 'ホログラムテープ キラキラテープ 8色セット 15m×1.5cm 粘着付き' }).product.id;
  store.create({ name: 'よくある名前の商品ですが同じものが二つ' });
  store.create({ name: 'よくある名前の商品ですが同じものが二つ' }, 'user', { allowDuplicate: true });
  const text = [line('ホログラムテープ キラキラテープ 8色セット 15m×1.5cm 粘着付き | カラーテープ', '', '2026-11-14'),
    line('よくある名前の商品ですが同じものが二つ', '', '2026-11-14')].join('\n');
  const r = new DateIds(store.dataDir).importList(store, 'user', { text, dryRun: false });
  assert.equal(store.get(one).dateId, '0811142?', '一覧でいちばん新しい日・8件未満なので ?');
  assert.equal(r.applied, 1);
});

test('日付IDの形が違う値は書けない', () => {
  const store = new Store(tmp());
  const id = store.create({ name: 'x' }).product.id;
  assert.throws(() => store.setDateId(id, 'user', '0811'), /形が違います/);
});

test('同じ日に同じ名前の注文が2行あれば2件（色違いなど）。次の一覧でも1件ずつ対応して増えない', () => {
  const store = new Store(tmp());
  const d = new DateIds(store.dataDir);
  const name = 'Heptour カラビナ スマホ ストラップ リング 丸型 ナスカン キーホルダー O型 金属 パーツ';
  const text = [line(name, '', '2026-11-09'), line(name, '', '2026-11-09'), line('別の日', asin(5), '2026-11-08')].join('\n');
  d.importList(store, 'user', { text, dryRun: false });
  assert.equal(d.book.days['2026-11-09'].rows.length, 2);
  const again = d.importList(store, 'user', { text: `${line('新しい日', asin(6), '2026-11-10')}\n${text}`, dryRun: false });
  assert.equal(again.added, 1);
  assert.equal(d.book.days['2026-11-09'].rows.length, 2);
  assert.equal(d.book.days['2026-11-09'].closed, true);
});

test('名前で結ぶのは、片方の名前がもう片方の頭と同じときだけ（同じブランドの別タイプは結ばない）。結べなくなった番号は外す', () => {
  const store = new Store(tmp());
  const other = store.create({ name: '[Rimerakea] サングラス クリップ メガネの上からかける 跳ね上げ' }).product.id;
  const d = new DateIds(store.dataDir);
  store.setDateId(other, 'claude', '08100511'); // e.g. given by the looser rule before
  const r = d.importList(store, 'user', { text: line('[Rimerakea] サングラス クリップ メガネの上からかける 偏光 PC', '', '2026-10-05'), dryRun: false });
  assert.equal(r.matched, 0);
  assert.equal(store.get(other).dateId, '', '外した');
});

test('あとから台帳に入った商品にも、付け直しで番号がつく', () => {
  const store = new Store(tmp());
  const d = new DateIds(store.dataDir);
  d.importList(store, 'user', { text: [line('新しい日', asin(7), '2026-11-16'), line('あとで入る商品', asin(8), '2026-11-15')].join('\n'), dryRun: false });
  const id = store.create({ name: 'あとで入る商品' }, 'import', { links: [{ url: `https://www.amazon.co.jp/dp/${asin(8)}` }] }).product.id;
  assert.equal(d.refresh(store), 1);
  assert.equal(store.get(id).dateId, '08111511');
  assert.equal(d.refresh(store), 0, '2回目は何もしない');
});

import { encodeDateId, decodeDateId, encodeA } from '../public/js/datecode.js';

test('商品ID（令和日付・注文商品識別コード）: 仕様書の動作確認例', () => {
  assert.deepEqual([1, 4, 5, 6, 10, 11, 23, 31].map(encodeA), ['1', '4', '0', '01', '00', '001', '00003', '0000001']);
  const cases = [['2026-10-10', 7, 8, '0300Q00b'], ['2026-10-10', 1, 8, '0300Y00b'], ['2026-05-15', 4, 8, '030F000b'], ['2026-03-07', 3, 5, '033S02w'],
    ['2026-01-01', 1, 1, '031Y1y'], ['2027-12-31', 6, 8, '04002L0000001b'], ['2028-02-04', 5, 8, '002W4b']];
  for (const [d, i, t, code] of cases) assert.equal(encodeDateId(d, i, t), code, d);
  assert.deepEqual(decodeDateId('0300Q00b'), [{ year: 8, month: 10, day: 10, index: 7, total: 8 }]);
  assert.equal(decodeDateId('002W4b').length, 2, '令和10年2月4日 と 令和5年7月4日 の両方');
  assert.deepEqual(decodeDateId('0300Q00s'), [], '3個中7番目は無効');
  assert.equal(encodeDateId('2026-11-15', 1, null), '03001Y000?');
  assert.equal(encodeDateId('2026-11-15', 9, 9), '', '9以上は作らない');
});

test('注文の一覧から日付IDと商品IDを両方つける', () => {
  const store = new Store(tmp());
  const id = store.create({ name: '七番目' }, 'user', { links: [{ url: `https://www.amazon.co.jp/dp/${asin(7)}` }] }).product.id;
  const text = Array.from({ length: 8 }, (_, i) => line(`商品${8 - i}`, asin(8 - i), '2026-10-10')).join('\n');
  new DateIds(store.dataDir).importList(store, 'user', { text, dryRun: false });
  assert.equal(store.get(id).dateId, '08101078');
  assert.equal(store.get(id).productCode, '0300Q00b');
});

test('出品の原稿（channel_package）と素材の info.json の説明に商品IDが入る', async () => {
  const { channelPackage, withProductCode } = await import('../server/rules.js');
  const store = new Store(tmp());
  const id = store.create({ name: 'x' }).product.id;
  store.updateFields(id, 'user', { 'listing.description': '良い商品です。' });
  store.setDateId(id, 'claude', '08101078', '0300Q00b');
  const pkg = channelPackage(store.get(id), 'mercari');
  assert.equal(pkg.productCode, '0300Q00b');
  assert.equal(pkg.description, '良い商品です。\n\n商品ID: 0300Q00b');
  assert.equal(withProductCode(pkg.description, '0300Q00b'), pkg.description, '二重に足さない');
});
