// 令和日付・注文商品識別コード（ユーザー仕様 2026-11-15）。サーバー（server/dateid.js）と画面の両方で使う。
// [令和の年:A][月:A][何番目:B大文字][日:A][その日の注文総数:B小文字]。例 0300Q00b = 令和8年10月10日・8個中7番目。
// 体系A: "0"=5 を q 個＋余り1〜4を1文字（6→01, 10→00）。体系B: YRSFWLQB = 1〜8。
// 台帳独自: その日の注文数がまだ決まっていない（最新の日で8件未満）間は、末尾の小文字の代わりに「?」。
const UPPER = 'YRSFWLQB';
const LOWER = 'yrsfwlqb';

export const encodeA = (n) => '0'.repeat(Math.floor(n / 5)) + (n % 5 ? String(n % 5) : '');
/** Canonical 体系A only ("0"* then at most one 1–4); otherwise null. */
export function decodeA(s) {
  if (!s || !/^0*[1-4]?$/.test(s)) return null;
  const r = /[1-4]$/.test(s) ? Number(s.slice(-1)) : 0;
  return (s.length - (r ? 1 : 0)) * 5 + r;
}

const realDate = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

/** "2026-10-10", 7, 8 → "0300Q00b". total null → "?" at the end. '' when outside the spec (before 令和, 9 or more). */
export function encodeDateId(date, index, total) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return '';
  const [y, mo, d] = [Number(m[1]) - 2018, Number(m[2]), Number(m[3])];
  if (y < 1 || (y === 1 && mo < 5) || !realDate(y + 2018, mo, d)) return '';
  if (!(index >= 1 && index <= 8) || (total != null && !(total >= index && total <= 8))) return '';
  return encodeA(y) + encodeA(mo) + UPPER[index - 1] + encodeA(d) + (total == null ? '?' : LOWER[total - 1]);
}

/** Every reading of a code: [{ year, month, day, index, total }] (total null for "?"). Empty = invalid; 2+ = ambiguous. */
export function decodeDateId(code) {
  const m = /^([0-4]+)([YRSFWLQB])([0-4]+)([yrsfwlqb?])$/.exec(String(code || ''));
  if (!m) return [];
  const index = UPPER.indexOf(m[2]) + 1;
  const total = m[4] === '?' ? null : LOWER.indexOf(m[4]) + 1;
  const day = decodeA(m[3]);
  if (!day || (total != null && index > total)) return [];
  const out = [];
  for (let i = 1; i < m[1].length; i++) {
    const year = decodeA(m[1].slice(0, i));
    const month = decodeA(m[1].slice(i));
    if (!year || !month || month > 12 || (year === 1 && month < 5) || !realDate(year + 2018, month, day)) continue;
    out.push({ year, month, day, index, total });
  }
  return out;
}

/** 0300Q00b → 令和8年10月10日・8個中7番目（読み方が2つ以上なら全部、区切りつきで）. */
export function describeDateId(code) {
  const c = decodeDateId(code);
  const one = (r) => `令和${r.year}年${r.month}月${r.day}日・${r.total == null ? '注文数はまだ決まっていない日の' : `${r.total}個中`}${r.index}番目`;
  if (!c.length) return '';
  if (c.length === 1) return one(c[0]);
  return `読み方が${c.length}つ: ${c.map((r) => `${one(r)}（${encodeA(r.year)}|${encodeA(r.month)}|…）`).join(' ／ ')}`;
}
