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
  assert.equal(sayFor(p), '10月16日到着、Goti 犬猫用ブラシ 天然豚毛');
  assert.equal(sayFor(P('2', 'ヨガマット')), '到着日なし、ヨガマット');
});

test('スキャン: FNSKU 一致で決まり、ラベルの頭の商品名でも見つかる', () => {
  const list = [
    P('1', 'Goti 犬猫用ブラシ 天然豚毛 抜け毛取り 長毛 短毛 両用 ペット用品', { fnsku: 'X00ABCDEFG', arrivalDate: '2026-10-16' }),
    P('2', 'KENOH ラジオペンチ 先細 150mm 精密 電工', { arrivalDate: '2026-11-12' }),
    P('3', 'ヨガマット 10mm 厚手 滑り止め'),
  ];
  const a = scanLookup(list, { codes: ['X00ABCDEFG'], lines: [] });
  assert.equal(a.pick.id, '1');
  assert.equal(a.say, '10月16日到着、Goti 犬猫用ブラシ 天然豚毛');
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
  assert.match(scanLookup(list, { lines: ['ネックレス 留め具 10個'] }).say, /^候補2件/);
});
