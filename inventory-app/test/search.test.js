import { test } from 'node:test';
import assert from 'node:assert/strict';
import { norm, termsOf, searchScore, ocrCandidates } from '../public/js/search.js';

const p = (o) => ({ id: '0001', name: '', ...o });
const score = (prod, q) => searchScore(prod, termsOf(q));

test('norm: width, case, kana, spaces and long vowels do not matter', () => {
  assert.equal(norm('ＵＳＢ ケーブル'), norm('usbけぶる'));
  assert.equal(norm('コンピューター'), norm('こんぴゅーた'));
});

test('search: contained terms in any order match exactly; hiragana finds katakana', () => {
  const tw = p({ name: 'セームタオル パープル PVA素材' });
  assert.equal(score(tw, 'たおる'), 1);
  assert.equal(score(tw, 'パープル セーム'), 1);
  assert.equal(score(tw, 'セームタオル'), 1);
  assert.equal(score(p({ name: 'ワイヤレス イヤホン' }), 'ワイヤレスイヤホン'), 1);
});

test('search: a near miss is a close candidate, below every real match', () => {
  const ear = p({ name: 'ワイヤレスイヤホン Bluetooth' });
  assert.equal(score(ear, 'ワイヤレスイヤフォン'), 1); // フォ/ホ are the same
  const s = score(ear, 'ワイヤレスイヤポン');
  assert.ok(s >= 0.6 && s < 1, String(s));
  assert.ok(score(ear, 'bluetoth') > 0.6); // English typo
  assert.equal(score(p({ name: 'iPhoneケース' }), 'イヤフォン'), 0); // short words must not drift (アイフォン)
  assert.equal(score(p({ name: 'セームタオル' }), 'まな板'), 0);
});

test('search: numbers (ID, JAN) and very short terms must match as typed', () => {
  const x = p({ id: '0327', jan: '4901234567894', name: 'タオル' });
  assert.equal(score(x, '0327'), 1);
  assert.equal(score(x, '0328'), 0);
  assert.equal(score(x, '4901234567890'), 0);
  assert.equal(score(x, 'タナ'), 0);
});

test('search: with three or more words one extra word may be missing', () => {
  const g = p({ name: 'iPhone 17 Pro用ガラスフィルム（2枚）' });
  const s = score(g, 'ガラスフィルム iPhone17 2枚入り');
  assert.ok(s > 0 && s < 1, String(s));
  assert.equal(score(g, 'ガラスフィルム 2枚入り'), 0);
});

test('ocr: Japanese and English mixed on the package', () => {
  const a = p({ id: 'a', name: 'AULUMU G09 MagSafeスタンド（ブラック）', brand: 'AULUMU' });
  const b = p({ id: 'b', name: 'スマホケース（シルバー）' });
  const lines = [{ text: 'AULUMU' }, { text: 'MagSafe対応 折りたたみスタンド' }, { text: 'Model G09' }];
  assert.equal(ocrCandidates([a, b], { lines })[0].p.id, 'a');
});

test('ocr: barcode equal to the JAN wins; otherwise the product whose name is printed', () => {
  const a = p({ id: 'a', name: '水で戻して使うセームタオル パープル' });
  const b = p({ id: 'b', name: 'ステンレス まな板', jan: '4901234567894' });
  const c = p({ id: 'c', name: 'USB充電ケーブル' });
  const lines = [{ text: '水で戻して使うセームタオル' }, { text: 'パープル、約43✕32cmのPVA素材' }];
  assert.deepEqual(ocrCandidates([a, b, c], { lines }).map((r) => r.p.id), ['a']);
  assert.equal(ocrCandidates([a, b, c], { lines, barcodes: ['4901234567894'] })[0].p.id, 'b');
});

test('FNSKU: 写真の文字・バーコードの X00… を拾い、検索と📷候補で使う', async () => {
  const { fnskusIn } = await import('../public/js/search.js');
  assert.deepEqual(fnskusIn('X001EKB04P (GP-131) Made in China'), ['X001EKB04P']);
  assert.deepEqual(fnskusIn('XO01EKB04P'), ['X001EKB04P']); // O read for 0
  assert.deepEqual(fnskusIn('ASIN B0HFCZGB9C'), []);
  const a = p({ id: 'a', name: '箱', fnsku: 'X001EKB04P' });
  const b = p({ id: 'b', name: '別の箱' });
  assert.equal(score(a, 'x001ekb04p'), 1);
  assert.equal(ocrCandidates([b, a], { lines: [{ text: 'X001EKB04P' }], barcodes: [] })[0].p.id, 'a');
  assert.equal(ocrCandidates([b, a], { lines: [], barcodes: ['X001EKB04P'] })[0].why, 'Amazon管理番号（FNSKU）一致');
});
