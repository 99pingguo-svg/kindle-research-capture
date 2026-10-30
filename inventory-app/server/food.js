// 飲食料品（食べたり飲んだりするもの）の判定。フリマは飲料・食品の出店禁止が多いので、これらはフリマを既定で入れず、
// 手でチェックするときは確認を求める（ユーザー指定 2026-10-30）。
// 種類が「食品・飲料」のもの（未設定なら商品名から推定）に加え、別の種類に入るサプリやペット用の飲食品を商品名で拾う。
import { guessCategory } from './category.js';

const EDIBLE = /サプリ|プラセンタ|健康食品|栄養補助|青汁|プロテイン|発酵ドリンク|ドッグフード|キャットフード|ペットフード/;

export function isFood(p) {
  if ((p.category || guessCategory(p.name || '')) === '食品・飲料') return true;
  return EDIBLE.test(`${p.name || ''} ${p.amazon?.title || ''}`);
}
