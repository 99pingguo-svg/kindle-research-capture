// 検索: 部分一致・表記ゆれに強い商品検索と、写真の文字（OCR）から商品を探す。
// 比べる前に両方を同じ形にそろえる: 全角/半角・大文字/小文字・カタカナ/ひらがな・空白・記号・長音「ー」を無視。
// 語ごとに「含まれる」なら一致、含まれなくても1〜2文字の違い（打ち間違い・表記ゆれ）で並んでいれば「近い候補」。
// 写真の文字（OCR）は日本語と英語が混ざるので、どちらも同じ形にそろえて比べる。

const SMALL = /[\s\p{P}\p{S}ー〜～]/gu;
const kataToHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
// Common spelling variants: イヤフォン/イヤホン, ヴァ/バ.
const VARIANTS = [[/ゔぁ/g, 'ば'], [/ゔぃ/g, 'び'], [/ゔぇ/g, 'べ'], [/ゔぉ/g, 'ぼ'], [/ゔ/g, 'ぶ'], [/ふぉ/g, 'ほ']];
export const norm = (s) => VARIANTS.reduce((t, [re, to]) => t.replace(re, to), kataToHira(String(s ?? '').normalize('NFKC').toLowerCase()).replace(SMALL, ''));

const grams = (s) => {
  const g = new Set();
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  return g;
};
const asinOf = (url) => /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i.exec(url || '')?.[1] || '';

// Summaries are replaced on every update, so caching by object never goes stale.
const cache = new WeakMap();
function prepared(p) {
  let c = cache.get(p);
  if (!c) {
    const hay = norm([p.id, p.name, p.brand, p.model, p.jan, p.notes, p.location, p.title, p.category, asinOf(p.sourceUrl)].join(' '));
    const name = norm([p.name, p.title].join(' '));
    c = { hay, name, nameGrams: grams(name) };
    cache.set(p, c);
  }
  return c;
}

/** Search terms (normalised, empties dropped). */
export const termsOf = (q) => String(q || '').split(/[\s　]+/).map(norm).filter(Boolean);

// Fuzzy only for terms long enough to mean something; numbers (ID・JAN・型番の数字) must match as typed.
const FUZZY_MIN = 5;
const allowedErrors = (len) => Math.floor((len - 1) / 4); // 5〜8文字は1文字、9〜12文字は2文字まで
// A long term (a pasted name, a line read from a photo) also counts when a big enough piece of it appears.
const PIECE_MIN_TERM = 8;
const PIECE_MIN = 5;
const PIECE_RATIO = 0.4;

/** Fewest edits that turn `t` into some stretch of `s` (Sellers' approximate substring match). */
function nearestEdit(t, s, limit) {
  const m = t.length;
  let prev = Array.from({ length: m + 1 }, (_, i) => i);
  let best = m;
  for (const c of s) {
    const cur = [0];
    for (let i = 1; i <= m; i++) cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (t[i - 1] === c ? 0 : 1));
    if (cur[m] < best && (best = cur[m]) === 0) break;
    prev = cur;
  }
  return best <= limit ? best : Infinity;
}

/** Length of the longest stretch shared by `t` and `s`. */
function longestShared(t, s) {
  let prev = new Uint16Array(t.length + 1);
  let best = 0;
  for (const c of s) {
    const cur = new Uint16Array(t.length + 1);
    for (let i = 1; i <= t.length; i++) if (t[i - 1] === c && (cur[i] = prev[i - 1] + 1) > best) best = cur[i];
    prev = cur;
  }
  return best;
}

/** How well one term matches: 1 = contained, below 1 = close, 0 = not at all. */
function termScore(t, hay) {
  if (hay.includes(t)) return 1;
  if (t.length < FUZZY_MIN || /^[0-9a-z]+$/.test(t) && /\d/.test(t)) return 0;
  const d = nearestEdit(t, hay, allowedErrors(t.length));
  if (d !== Infinity) return 1 - d / t.length;
  if (t.length < PIECE_MIN_TERM) return 0;
  const piece = longestShared(t, hay);
  return piece >= PIECE_MIN && piece / t.length >= PIECE_RATIO ? 0.9 * piece / t.length : 0;
}

/** 1 = every term is contained; below 1 = close (some terms are 1–2 characters off); 0 = no match. */
export function searchScore(p, terms) {
  const { hay } = prepared(p);
  let sum = 0;
  let misses = 0;
  for (const t of terms) {
    const s = termScore(t, hay);
    if (!s) misses++;
    sum += s;
  }
  if (sum === terms.length) return 1;
  // With three or more words one may be missing (an extra word like 「2枚入り」 that the record does not have).
  if (misses > (terms.length >= 3 ? 1 : 0)) return 0;
  const score = sum / terms.length;
  // Never let a close match tie with a real one.
  return score >= 0.5 ? Math.min(0.99, score) : 0;
}

/**
 * Products that the photo text points to, best first: [{ p, score, why }].
 * A barcode equal to the JAN wins outright; otherwise how much of the product name appears in the photo,
 * plus the brand / model when they are printed.
 */
export function ocrCandidates(products, { lines = [], barcodes = [] }, limit = 8) {
  const all = norm(lines.map((l) => l.text).join(' '));
  const allGrams = grams(all);
  const codes = new Set(barcodes.map((b) => String(b).replace(/\D/g, '')).filter((b) => b.length >= 8));
  const out = [];
  for (const p of products) {
    const jan = String(p.jan || '').replace(/\D/g, '');
    if (jan && codes.has(jan)) { out.push({ p, score: 2, why: 'バーコード一致' }); continue; }
    const { nameGrams } = prepared(p);
    if (nameGrams.size < 2) continue;
    let hit = 0;
    for (const g of nameGrams) if (allGrams.has(g)) hit++;
    let score = hit / nameGrams.size;
    const extras = [p.brand, p.model].map(norm).filter((s) => s.length >= 3 && all.includes(s));
    score += extras.length * 0.15;
    if (score >= 0.25) out.push({ p, score, why: extras.length ? '商品名・ブランド/型番' : '商品名' });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
