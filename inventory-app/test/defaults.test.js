import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { createDefaults } from '../server/defaults.js';

const tick = () => new Promise((r) => setTimeout(r, 20));

test('安い商品は出品先にフリマが1回だけ入り、ユーザーが外したらそのまま', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-')));
  const cheap = store.create({ name: '安い' }).product.id;
  const dear = store.create({ name: '高い' }).product.id;
  const touched = store.create({ name: '前に手で外した' }).product.id;
  store.setResearch(cheap, 'claude', { amazonPrice: 980 });
  store.setResearch(dear, 'claude', { amazonPrice: 5000 });
  store.setTargets(touched, 'user', ['flea']);
  store.setTargets(touched, 'user', []);
  store.setResearch(touched, 'claude', { amazonPrice: 500 });
  // the rule must not see the marker the user set (simulate a product edited before the rule existed)
  const t = store.products.get(touched); delete t.targetsManual;
  const defaults = createDefaults(store);
  await tick();
  assert.deepEqual(store.get(cheap).targets, ['flea']);
  assert.deepEqual(store.get(dear).targets, []);
  assert.deepEqual(store.get(touched).targets, [], '以前の履歴で手で外した商品には入れない');
  assert.equal(store.history(cheap)[0].actor, 'system');

  store.setTargets(cheap, 'user', ['mercari']); // the user takes フリマ off
  defaults.sweep();
  await tick();
  assert.deepEqual(store.get(cheap).targets, ['mercari']);

  store.setTargets(dear, 'user', ['mercari']);
  store.setResearch(dear, 'claude', { amazonPrice: 900 }); // becomes cheap later
  await tick();
  assert.deepEqual(store.get(dear).targets, ['mercari', 'flea'], 'あとから基準に入った商品にも足す（ユーザーの選択は残す）');
  assert.throws(() => store.setTargets(dear, 'claude', []), /ユーザーのみ/);
});

test('手取りのおすすめ: よいサイトを緑で入れ、相場が変われば入れ替え、手で触ったサイトはそのまま', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-')));
  store.settings.fleaDefault = { on: false };
  const id = store.create({ name: 'ケース' }).product.id;
  const p = store.products.get(id);
  const rec = (median) => ({ matchType: 'same', median, count: 3, examples: [] });
  Object.assign(p, { amazon: { package: { dims: [20, 12, 2], kg: 0.1 } }, market: rec(2000), marketPaypay: rec(2600), marketRakuma: rec(1200) });
  const defaults = createDefaults(store);
  await tick();
  assert.deepEqual(store.get(id).targets, ['paypay'], 'ヤフーフリマが一番（手数料5%）');
  assert.equal(store.get(id).targetDefaults.paypay.rule, 'net');

  // the market moves: Mercari now pays best, Yahoo!フリマ falls behind → swapped
  Object.assign(store.products.get(id), { market: rec(4000) });
  defaults.sweep();
  await tick();
  assert.deepEqual(store.get(id).targets, ['mercari']);

  // the user adds ラクマ and removes メルカリ by hand: both stay as the user left them
  store.setTargets(id, 'user', ['rakuma']);
  defaults.sweep();
  await tick();
  assert.deepEqual(store.get(id).targets, ['rakuma']);
});

test('依頼で緑にした出品先: ユーザーが入れた分はAIが取り消せない、手で外した分はAIが戻せない', () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-')));
  const a = store.create({ name: 'a' }).product.id;
  store.setTargets(a, 'user', ['flea']); // ticked by hand
  assert.equal(store.markDefaultTarget(a, 'claude', 'flea', 'test'), true); // turns green only
  assert.equal(store.unmarkDefaultTarget(a, 'claude', 'flea'), false);
  assert.deepEqual(store.get(a).targets, ['flea']);
  const b = store.create({ name: 'b' }).product.id;
  store.setTargets(b, 'user', ['flea']);
  store.setTargets(b, 'user', []); // cleared by hand
  assert.equal(store.markDefaultTarget(b, 'claude', 'flea', 'test'), false);
  assert.deepEqual(store.get(b).targets, []);
  const c = store.create({ name: 'c' }).product.id;
  assert.equal(store.markDefaultTarget(c, 'claude', 'jmty', 'test'), true); // added by the request → can be undone
  assert.equal(store.unmarkDefaultTarget(c, 'claude', 'jmty'), true);
  assert.deepEqual(store.get(c).targets, []);
});

test('飲食料品: フリマは手で入れたものも1回外し、既定で入れず、確認つきで入れたものは残す', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-')));
  const honey = store.create({ name: '国産アカシアはちみつ（300g）' }).product.id;
  const sup = store.create({ name: 'プラセンタ サプリ 60粒' }).product.id;
  const pet = store.create({ name: '犬用発酵ドリンク' }).product.id;
  const towel = store.create({ name: 'タオル' }).product.id;
  store.setResearch(sup, 'claude', { amazonPrice: 500 }); // cheap, but no default フリマ for food
  store.products.get(honey).targets = ['mercari', 'flea'];
  store.products.get(honey).targetsManual = { flea: 'by hand' };
  store.products.get(pet).targets = ['flea'];
  store.setTargets(towel, 'user', ['flea']);
  const defaults = createDefaults(store);
  await tick();
  assert.deepEqual(store.get(honey).targets, ['mercari'], '手で入れたフリマも外す');
  assert.deepEqual(store.get(pet).targets, []);
  assert.deepEqual(store.get(sup).targets, []);
  assert.deepEqual(store.get(towel).targets, ['flea'], '飲食料品以外はそのまま');

  // Without the dialog's confirmation the server refuses; with it the choice stays, through later sweeps too.
  assert.throws(() => store.setTargets(honey, 'user', ['mercari', 'flea']), /確認してチェック/);
  store.setTargets(honey, 'user', ['mercari', 'flea'], { confirmFoodFlea: true });
  defaults.sweep();
  await tick();
  assert.deepEqual(store.get(honey).targets, ['mercari', 'flea']);
  assert.equal(store.markDefaultTarget(sup, 'user', 'flea', 'x'), false, '一括の既定でも入らない');
  store.setTargets(honey, 'user', ['mercari']); // taking it off needs no confirmation
  assert.deepEqual(store.get(honey).targets, ['mercari']);
});
