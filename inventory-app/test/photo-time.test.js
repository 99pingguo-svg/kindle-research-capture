import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { takenAt, groupByGap } from '../public/js/photo-time.js';

const file = (name) => new File([fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url))], name, { lastModified: 0 });

test('撮影時刻: 写真の EXIF（DateTimeOriginal）を読み、なければファイルの日時', async () => {
  const a = await takenAt(file('exif-a.jpg'));
  assert.equal(new Date(a).getHours(), 10);
  assert.equal(new Date(a).getMinutes(), 0);
  const b = await takenAt(file('exif-b.jpg'));
  assert.equal((b - a) / 1000, 20);
  assert.equal(await takenAt(new File([Buffer.from('not a jpeg')], 'x.txt', { lastModified: 1234 })), 1234);
});

test('組分け: 撮影の間があいたら別の商品', async () => {
  const items = await Promise.all(['exif-a.jpg', 'exif-b.jpg', 'exif-c.jpg'].map(async (n) => ({ name: n, at: await takenAt(file(n)) })));
  assert.deepEqual(groupByGap(items, 45).map((g) => g.items.map((i) => i.name)), [['exif-a.jpg', 'exif-b.jpg'], ['exif-c.jpg']]);
  assert.equal(groupByGap(items, 300).length, 1);
});
