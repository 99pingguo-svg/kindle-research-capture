import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortName, sayFor, scanCandidates, clearPick, scanLookup } from '../server/scan.js';
import { arrivalIdOf } from '../public/js/datecode.js';
import { photoTakenAt } from '../server/store.js';

// A tiny JPEG start with EXIF DateTimeOriginal (little-endian TIFF).
function jpegWithExif(when) {
  const t = Buffer.alloc(8 + 2 + 12 + 4 + 2 + 12 + 4 + 20);
  t.write('II', 0); t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4);
  t.writeUInt16LE(1, 8); // IFD0: one entry, ExifIFD pointer
  t.writeUInt16LE(0x8769, 10); t.writeUInt16LE(4, 12); t.writeUInt32LE(1, 14); t.writeUInt32LE(26, 18);
  t.writeUInt16LE(1, 26); // Exif IFD: DateTimeOriginal
  t.writeUInt16LE(0x9003, 28); t.writeUInt16LE(2, 30); t.writeUInt32LE(20, 32); t.writeUInt32LE(44, 36);
  t.write(`${when}\0`, 44, 'latin1');
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(app1.length + 2, 4);
  return Buffer.concat([head, app1, Buffer.from([0xff, 0xd9])]);
}

test('到着ID: 到着日を8桁に', () => {
  assert.equal(arrivalIdOf('2026-10-16'), '20261016');
  assert.equal(arrivalIdOf(''), '');
  assert.equal(arrivalIdOf('2026/10/16'), '');
});

test('撮影時刻: ライブラリの写真も EXIF の撮影時刻を使う', () => {
  const buf = jpegWithExif('2026:10:16 09:30:00');
  const got = photoTakenAt(buf, '2026-11-18T12:00:00Z');
  assert.equal(new Date(got).getTime(), new Date(2026, 9, 16, 9, 30, 0).getTime());
  assert.equal(photoTakenAt(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), '2026-11-18T12:00:00Z'), '2026-11-18T12:00:00.000Z');
  assert.equal(photoTakenAt(Buffer.from([1, 2, 3]), 'garbage'), null);
});

const P = (id, name, extra = {}) => ({ id, name, title: '', arrivalDate: '', counts: { actual: 0 }, ...extra });

test('読み上げ: 到着日と短い名前', () => {
  const p = P('1', '【2026年最新】Goti 犬猫用ブラシ 天然豚毛 抜け毛取り 長毛 短毛 両用', { arrivalDate: '2026-10-16' });
  assert.equal(shortName(p), 'Goti 犬猫用ブラシ 天然豚毛');
  assert.equal(sayFor(p), '10月到着、Goti 犬猫用ブラシ 天然豚毛');
  assert.equal(sayFor(P('2', 'ヨガマット')), '到着日なし、ヨガマット');
});

test('読み上げ: 日付の決まり（11/1 から日まで・到着日がなければ購入日）', () => {
  assert.equal(sayFor(P('1', 'ヨガマット', { arrivalDate: '2026-11-01' })), '11月1日到着、ヨガマット');
  assert.equal(sayFor(P('1', 'ヨガマット', { arrivalDate: '2026-10-31', orderDate: '2026-11-20' })), '10月到着、ヨガマット');
  assert.equal(sayFor(P('1', 'ヨガマット', { orderDate: '2026-11-15' })), '11月15日購入、ヨガマット');
  assert.equal(sayFor(P('1', 'ヨガマット', { orderDate: '2026-09-03' })), '9月購入、ヨガマット');
  assert.equal(sayFor(P('1', 'ヨガマット', { orderDate: '', arrivalDate: '' })), '到着日なし、ヨガマット');
});

test('スキャン: FNSKU 一致で決まり、ラベルの頭の商品名でも見つかる', () => {
  const list = [
    P('1', 'Goti 犬猫用ブラシ 天然豚毛 抜け毛取り 長毛 短毛 両用 ペット用品', { fnsku: 'X00ABCDEFG', arrivalDate: '2026-10-16' }),
    P('2', 'KENOH ラジオペンチ 先細 150mm 精密 電工', { arrivalDate: '2026-11-12' }),
    P('3', 'ヨガマット 10mm 厚手 滑り止め'),
  ];
  const a = scanLookup(list, { codes: ['X00ABCDEFG'], lines: [] });
  assert.equal(a.pick.id, '1');
  assert.equal(a.say, '10月到着、Goti 犬猫用ブラシ 天然豚毛');
  assert.equal(a.pick.arrivalId, '20261016');
  // An unregistered label: the code is new, the printed name points to the product.
  const b = scanLookup(list, { codes: ['X00ZZZZZZZ'], lines: ['X00ZZZZZZZ', 'KENOH ラジオペンチ 先細 150mm...', 'New'] });
  assert.equal(b.fnsku, 'X00ZZZZZZZ');
  assert.equal(b.pick?.id, '2');
  assert.match(b.say, /^11月12日到着/);
  const c = scanLookup(list, { codes: ['X00YYYYYYY'], lines: [] });
  assert.equal(c.pick, null);
  assert.equal(c.say, '台帳にない番号です');
});

test('スキャン: 似た2つは決めずに候補を出す', () => {
  const list = [P('1', 'ネックレス 留め具 ゴールド 10個'), P('2', 'ネックレス 留め具 シルバー 10個')];
  const c = scanCandidates(list, { codes: [], lines: ['ネックレス 留め具 10個'] });
  assert.equal(c.length, 2);
  assert.equal(clearPick(c), null);
  const r = scanLookup(list, { lines: ['ネックレス 留め具 10個'] });
  assert.match(r.say, /^候補2件/);
  assert.equal(r.status, 'candidates');
  assert.equal(r.voiceSay, '候補が複数あります。確認してください');
});

test('スキャン フェーズ2: 照合3状態（登録済み・候補あり・未登録下書き）と詳細項目', () => {
  const list = [
    P('1', 'Anker 充電器 USB-C 20W', {
      brand: 'Anker', orderDate: '2026-10-10', arrivalDate: '2026-11-05',
      fnsku: 'X00REG1111', presence: 'have', sourceUrl: 'https://www.amazon.co.jp/dp/B0ANKER001',
      scanScene: '/files/products/1/photos/ph1.work.jpg',
    }),
    P('2', '別製品 すでに別FNSKUあり', {
      brand: 'BrandX', orderDate: '2026-11-01', fnsku: 'X00OTHER99',
    }),
  ];
  // 状態A: 登録済み
  const a = scanLookup(list, { codes: ['X00REG1111'], lines: [] });
  assert.equal(a.status, 'registered');
  assert.equal(a.registered, true);
  assert.equal(a.fnskuOwner.id, '1');
  assert.equal(a.pick.orderDate, '2026-10-10');
  assert.equal(a.pick.sourceUrl, 'https://www.amazon.co.jp/dp/B0ANKER001');
  assert.equal(a.pick.scanScene, '/files/products/1/photos/ph1.work.jpg');
  assert.match(a.voiceSay, /^登録済みの商品です。11月5日到着/);

  // 状態B: ブランド一致・別FNSKUがついている商品は自動確定せず候補に留める
  const b = scanLookup(list, { codes: ['X00NEW2222'], lines: ['X00NEW2222', '別製品 すでに別FNSKUあり'] });
  assert.equal(b.status, 'candidates');
  assert.equal(b.registered, false);
  assert.equal(b.pick, null);
  assert.equal(b.candidates[0].id, '2');

  // 状態C: 未登録・候補なし → 新規登録用の下書きを生成
  const c = scanLookup(list, { codes: ['X00NEW3333', '4901234567890'], lines: ['X00NEW3333', 'まったく新しい LEDライト 小型', 'New', 'Made in China'] });
  assert.equal(c.status, 'unregistered');
  assert.equal(c.registered, false);
  assert.equal(c.candidates.length, 0);
  assert.match(c.voiceSay, /新規登録できます/);
  assert.equal(c.draft.fnsku, 'X00NEW3333');
  assert.equal(c.draft.jan, '4901234567890');
  assert.equal(c.draft.name, 'まったく新しい LEDライト 小型');
  assert.deepEqual(c.draft.lines, ['まったく新しい LEDライト 小型']);
});
