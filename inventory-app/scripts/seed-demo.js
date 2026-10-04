// Fill a data directory with demo products (synthetic images) to try the app.
//   INVENTORY_DATA=./demo-data node scripts/seed-demo.js && INVENTORY_DATA=./demo-data npm start
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.js';
import { crc32 } from '../server/zip.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = new Store(path.resolve(process.env.INVENTORY_DATA || path.join(root, 'demo-data')));

function solidPng(rgb, size = 64) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw.set(rgb.map((c) => Math.max(0, c - ((x + y) % 16))), y * (size * 3 + 1) + 1 + x * 3);
  const chunk = (t, d) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(td));
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const demo = [
  { name: 'Anker PowerCore 10000', brand: 'Anker', model: 'A1263', decision: 'sell', photos: ['正面', '背面', '型番ラベル'], color: [40, 40, 48], link: 'https://www.anker.com/' },
  { name: 'Sony WH-1000XM4 ワイヤレスヘッドホン', brand: 'Sony', model: 'WH-1000XM4', decision: 'sell', photos: ['全体'], color: [30, 30, 30] },
  { name: '無印良品 ポリプロピレン収納ケース', brand: '無印良品', decision: 'no_sell', photos: [], color: [230, 230, 230] },
  { name: 'Nintendo Switch Proコントローラー', brand: 'Nintendo', model: 'HAC-013', decision: 'sell', photos: [], color: [60, 60, 70], shootPlan: true },
  { name: 'LEGO 42115 ランボルギーニ', brand: 'LEGO', model: '42115', decision: 'hold', photos: ['箱・パッケージ'], color: [200, 120, 20] },
  { name: '', decision: 'undecided', photos: ['全体'], color: [120, 160, 200] },
];

for (const d of demo) {
  const { product } = store.create({ name: d.name, brand: d.brand || '', model: d.model || '', shootPlan: !!d.shootPlan, decision: d.decision }, 'user', { links: d.link ? [d.link] : [] });
  for (const tag of d.photos) store.addPhoto(product.id, 'user', { kind: 'actual', tag }, { original: { buffer: solidPng(d.color), mime: 'image/png' } });
}
store.addPhotoRequests('0002', 'claude', [{ label: '背面', reason: 'イヤーパッドの状態を確認するため' }, { label: '付属品', reason: 'ケース・ケーブルの有無' }]);
store.setFacts('0001', 'claude', [
  { key: 'model', label: '型番', value: 'A1263', confidence: 'confirmed', source: '型番ラベル写真' },
  { key: 'capacity', label: '容量', value: '10000mAh', confidence: 'confirmed', source: '本体印字' },
  { key: 'release', label: '発売年', value: '2016年', confidence: 'reference', source: '公式サイト' },
  { key: 'cable', label: '付属ケーブル', value: 'Micro USBケーブル', confidence: 'unverified', source: '写真で確認できず' },
]);
store.updateFields('0001', 'claude', {
  'listing.title': 'Anker PowerCore 10000 モバイルバッテリー A1263 ブラック',
  'listing.description': 'Anker PowerCore 10000（A1263）です。\n\n・容量: 10000mAh\n・動作確認済み\n・目立った傷や汚れはありません\n\n付属品は本体のみです。',
  'listing.category': '家電・スマホ・カメラ > スマホアクセサリー > モバイルバッテリー',
  'listing.condition': '目立った傷や汚れなし',
  'listing.price': 2400,
  'listing.shippingMethod': 'らくらくメルカリ便',
  'listing.shippingFrom': '東京都',
}, { reason: '相場 2,200〜2,800円' });
console.log(`demo data: ${store.dataDir} (${store.list().length} products)`);
