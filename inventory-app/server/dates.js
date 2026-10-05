// Bulk date import: "商品名 <TAB> URL <TAB> 日付…" lines → itemDate on EXISTING products.
// 注文日・購入日・到着日 are treated as one date (the first valid date on the line).
// Matching is deliberately strict so items never get mixed up: Amazon ASIN, then exact
// URL, then exact (normalised) name only when it is unique on both sides. Rows that do
// not match an existing product are reported and ignored — nothing is created.
import { normalizeDate } from './schema.js';
import { norm, normUrl } from './util.js';

const URL_RE = /https?:\/\/[^\s,|\t]+/g;
const DATE_RE = /\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}日?/g;

export function asinOf(url) {
  const m = /\/(?:dp|gp\/product|gp\/aw\/d|o\/ASIN|product)\/([A-Z0-9]{10})(?=[/?#]|$)/i.exec(String(url || ''));
  return m ? m[1].toUpperCase() : null;
}

/** One line → { name, urls, asins, date, dates }. Shared with the product list import. */
export function parseLine(raw) {
  const line = String(raw).replace(/^\s*(?:[-*・]|\d+[.)])\s+/, '').trim();
  const urls = line.match(URL_RE) || [];
  const dates = [...line.matchAll(DATE_RE)].map((m) => normalizeDate(m[0])).filter(Boolean);
  const name = line
    .replace(URL_RE, ' ')
    .replace(DATE_RE, ' ')
    .replace(/[\t|,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { name, urls, asins: [...new Set(urls.map(asinOf).filter(Boolean))], date: dates[0] || null, dates };
}

export function parseDateRows(text) {
  const rows = [];
  String(text)
    .split(/\r?\n/)
    .forEach((raw, i) => {
      if (!raw.trim() || raw.trim().startsWith('#')) return;
      rows.push({ line: i + 1, ...parseLine(raw) });
    });
  return rows;
}

const pushTo = (map, key, p) => {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  if (!map.get(key).includes(p)) map.get(key).push(p);
};

/**
 * Decide what each row would do. status:
 *  set (no date yet) / change (different date) / same / nomatch (ignored) /
 *  nodate (row has no date) / ambiguous (several products) / conflict (another row
 *  already gives this product a different date).
 */
export function planDates(products, rows) {
  const byAsin = new Map();
  const byUrl = new Map();
  const byName = new Map();
  for (const p of products) {
    if (p.trashedAt) continue;
    for (const l of p.links || []) {
      pushTo(byAsin, asinOf(l.url), p);
      pushTo(byUrl, normUrl(l.url), p);
    }
    pushTo(byName, norm(p.name), p);
  }
  const rowNames = new Map();
  for (const r of rows) rowNames.set(norm(r.name), (rowNames.get(norm(r.name)) || 0) + 1);

  const claimed = new Map(); // productId -> first row date
  return rows.map((r) => {
    const base = { line: r.line, name: r.name, urls: r.urls, date: r.date };
    let cands = [];
    let matchedBy = '';
    for (const a of r.asins) if (byAsin.has(a)) cands.push(...byAsin.get(a));
    if (cands.length) matchedBy = 'ASIN';
    if (!cands.length) {
      for (const u of r.urls) if (byUrl.has(normUrl(u))) cands.push(...byUrl.get(normUrl(u)));
      if (cands.length) matchedBy = 'URL';
    }
    const nk = norm(r.name);
    if (!cands.length && nk.length >= 4 && rowNames.get(nk) === 1 && byName.get(nk)?.length === 1) {
      cands = byName.get(nk);
      matchedBy = '商品名';
    }
    cands = [...new Set(cands)];
    const candidates = cands.map((p) => ({ id: p.id, name: p.name, itemDate: p.itemDate || null }));
    if (!cands.length) return { ...base, status: 'nomatch', matchedBy, candidates };
    if (!r.date) return { ...base, status: 'nodate', matchedBy, candidates };
    if (cands.length > 1) return { ...base, status: 'ambiguous', matchedBy, candidates };
    const p = cands[0];
    if (claimed.has(p.id) && claimed.get(p.id) !== r.date) return { ...base, status: 'conflict', matchedBy, candidates };
    claimed.set(p.id, r.date);
    const status = p.itemDate === r.date ? 'same' : p.itemDate ? 'change' : 'set';
    return { ...base, status, matchedBy, candidates };
  });
}

/**
 * Plan and (unless dryRun) apply. `include` = line numbers of ambiguous/conflict rows
 * the user explicitly ticked; those are applied to all their candidates.
 */
export function importDates(store, actor, { text, dryRun = true, include = [] }) {
  const plan = planDates(store.list(), parseDateRows(text));
  const forced = new Set(include.map(Number));
  const counts = {};
  for (const r of plan) counts[r.status] = (counts[r.status] || 0) + 1;
  const applied = [];
  const errors = [];
  if (!dryRun) {
    for (const r of plan) {
      const go = r.status === 'set' || r.status === 'change' || ((r.status === 'ambiguous' || r.status === 'conflict') && forced.has(r.line));
      if (!go) continue;
      for (const c of r.candidates) {
        try {
          const res = store.updateFields(c.id, actor, { itemDate: r.date }, { reason: '日付の一括反映' });
          applied.push({ id: c.id, date: r.date, proposed: res.proposed.length > 0 });
        } catch (e) {
          errors.push({ id: c.id, line: r.line, error: e.message });
        }
      }
    }
  }
  return { rows: plan, counts, total: plan.length, applied, errors };
}
