import test from 'node:test';
import assert from 'node:assert/strict';
import { mercariNet, marketBrief } from '../server/market.js';

const ship = { cheapest: { price: 210, label: 'ネコポス' } };
const rec = (matchType, median, examples = []) => ({ matchType, median, count: median == null ? 0 : 3, examples });

test('参考手取り: 同じ商品の相場が最優先、無ければ似た商品（メルカリ→ラクマ→ヤフオク）', () => {
  const p = { market: rec('none', null), marketRakuma: rec('similar', 2000), marketYahoo: rec('same', 3000) };
  const a = mercariNet(p, ship);
  assert.equal(a.site, 'yahoo');
  assert.equal(a.reference, false);
  assert.equal(a.net, 3000 - 300 - 210);
  const b = mercariNet({ ...p, marketYahoo: rec('none', null) }, ship);
  assert.equal(b.site, 'rakuma');
  assert.equal(b.reference, true);
  assert.equal(b.net, 2000 - 200 - 210);
  assert.equal(mercariNet({ market: rec('none', null), listing: { price: 1500 } }, ship).basis, 'listing');
  assert.equal(mercariNet({ market: rec('none', null) }, ship), null);
});

test('一覧から開く参考商品は中央値にいちばん近い売れた商品', () => {
  const ex = [
    { url: 'https://jp.mercari.com/item/m1', price: 900, match: 'similar' },
    { url: 'https://jp.mercari.com/item/m2', price: 1480, match: 'similar' },
    { url: '', price: 1500, match: 'similar' },
  ];
  const m = marketBrief({ name: 'x', market: rec('similar', 1500, ex) });
  assert.equal(m.ref.url, 'https://jp.mercari.com/item/m2');
  assert.equal(marketBrief({ name: 'x' }).ref, null);
});
