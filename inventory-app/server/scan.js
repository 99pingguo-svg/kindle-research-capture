// iPhone の「台帳スキャン」用: カメラが読んだバーコード（FNSKU・JAN）とラベルの文字から商品を探し、
// 「◯月◯日到着、◯◯」と読み上げる文を返す。決まった商品には「ある」と FNSKU を記録する（写真は photos の口で source 'scan'）。
import { ocrCandidates, fnskusIn, norm } from '../public/js/search.js';
import { arrivalIdOf } from '../public/js/datecode.js';

const grams = (s) => {
  const g = new Set();
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  return g;
};

/** A short name that is quick to hear: brackets and their contents dropped, cut near 20 characters at a space. */
export function shortName(p) {
  const s = String(p.name || p.title || '').replace(/[【［\[〔（(<＜][^】］\]〕）)>＞]*[】］\]〕）)>＞]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length <= 20) return s;
  const cut = s.lastIndexOf(' ', 20);
  return s.slice(0, cut >= 8 ? cut : 20);
}

/** What the phone says for one product. */
export function sayFor(p) {
  const m = /^\d{4}-(\d\d)-(\d\d)$/.exec(p.arrivalDate || '');
  return `${m ? `${Number(m[1])}月${Number(m[2])}日到着` : '到着日なし'}、${shortName(p)}`;
}

/**
 * Products for what the camera read, best first. A label prints only the start of the Amazon name,
 * so besides "how much of the name is in the photo" each text line is also scored by how much of it is in the name.
 */
export function scanCandidates(products, { codes = [], lines = [] }, limit = 4) {
  const live = products.filter((p) => !p.trashedAt);
  const base = ocrCandidates(live, { lines: lines.map((text) => ({ text })), barcodes: codes }, 20);
  const byId = new Map(base.map((x) => [x.p.id, x]));
  const fnskus = new Set(fnskusIn([...codes, ...lines].join(' ')));
  const labelLines = lines.map(norm).filter((l) => l.length >= 6 && ![...fnskus].some((f) => l.includes(norm(f))));
  if (labelLines.length) {
    const lg = labelLines.map(grams);
    for (const p of live) {
      const name = norm([p.name, p.title].join(' '));
      if (name.length < 4) continue;
      let best = 0;
      for (const g of lg) {
        let hit = 0;
        for (const x of g) if (name.includes(x)) hit++;
        best = Math.max(best, (hit / g.size) * Math.min(1, g.size / 12)); // a 4-letter line proves little
      }
      if (best < 0.3) continue;
      const cur = byId.get(p.id);
      if (!cur) byId.set(p.id, { p, score: best * 0.9, why: 'ラベルの商品名' });
      else if (cur.score < 2 && best * 0.9 > cur.score) cur.score = best * 0.9;
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Exactly one product, clearly ahead (a code match, or a strong name well ahead of the next). */
export function clearPick(c) {
  const [a, b] = c;
  if (!a) return null;
  if (a.score >= 2) return c.filter((x) => x.score >= 2).length === 1 ? a : null;
  return a.score >= 0.6 && (!b || b.score < a.score * 0.8) ? a : null;
}

export function scanCard(p, why = '', score = 0) {
  return {
    id: p.id, name: p.name || p.title || '', short: shortName(p), say: sayFor(p),
    arrivalDate: p.arrivalDate || '', arrivalId: arrivalIdOf(p.arrivalDate), dateId: p.dateId || '', productCode: p.productCode || '',
    fnsku: p.fnsku || '', thumb: p.thumb || null, official: p.official || null,
    shotDate: p.shotDate || '', presence: p.presence || null, hasOwnPhoto: (p.counts?.actual || 0) > 0, why, score: Math.round(score * 100) / 100,
  };
}

/** The answer for one reading: { fnsku, pick, candidates, say }. */
export function scanLookup(products, input) {
  const c = scanCandidates(products, input);
  const pick = clearPick(c);
  const fnsku = fnskusIn([...(input.codes || []), ...(input.lines || [])].join(' '))[0] || '';
  const say = pick ? sayFor(pick.p) : c.length ? `候補${c.length}件。画面で選んでください` : fnsku ? '台帳にない番号です' : '見つかりません';
  return { fnsku, pick: pick ? scanCard(pick.p, pick.why, pick.score) : null, candidates: c.map((x) => scanCard(x.p, x.why, x.score)), say };
}
