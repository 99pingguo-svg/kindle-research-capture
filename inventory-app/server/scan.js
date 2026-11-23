// iPhone の「台帳スキャン」用: カメラが読んだバーコード（FNSKU・JAN）とラベルの文字から商品を探し、
// 「◯月◯日到着、◯◯」と読み上げる文を返す。決まった商品には「ある」と FNSKU を記録する（写真は photos の口で source 'scan'）。
import { ocrCandidates, fnskusIn, norm } from '../public/js/search.js';
import { arrivalIdOf } from '../public/js/datecode.js';
import { asinOf } from './dates.js';
import { AppError, similarity } from './util.js';
import { summary } from './rules.js';
import { isUser, normalizeFnsku } from './store.js';

const FNSKU_RE = /^X00[0-9A-Z]{7}$/;
const LABEL_NOISE_RE = /^(new|used|新品|中古|ほぼ新品|非常に良い|良い|可|made\s*in\s*.+|中国製|日本製|\d+)$/i;

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

// Before this day only the month is said (older items are told apart by month; FNSKU_SCAN_SPEC.md).
const DAY_FROM = '2026-11-01';

/** The date part of what the phone says: arrival first, else order date; day-precise only from DAY_FROM on. */
export function sayDate(p) {
  const pick = (v) => (/^\d{4}-\d\d-\d\d$/.test(v || '') ? v : '');
  const arrival = pick(p.arrivalDate);
  const order = pick(p.orderDate);
  const d = arrival || order;
  if (!d) return '到着日なし';
  const [, m, day] = d.split('-').map(Number);
  return `${d >= DAY_FROM ? `${m}月${day}日` : `${m}月`}${arrival ? '到着' : '購入'}`;
}

/** What the phone says for one product. */
export function sayFor(p) {
  return `${sayDate(p)}、${shortName(p)}`;
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
  const normLines = lines.map(norm).filter((l) => l.length >= 3 && ![...fnskus].some((f) => l.includes(norm(f))));
  const labelLines = normLines.filter((l) => l.length >= 5);
  if (normLines.length) {
    const lg = labelLines.map(grams);
    for (const p of live) {
      const name = norm([p.name, p.title, p.brand, p.model].join(' '));
      const brand = norm(p.brand);
      let best = 0;
      let why = 'ラベルの商品名';
      if (name.length >= 4 && lg.length) {
        for (const g of lg) {
          let hit = 0;
          for (const x of g) if (name.includes(x)) hit++;
          best = Math.max(best, (hit / g.size) * Math.min(1, g.size / 12)); // a short line proves less
        }
      }
      if (brand.length >= 3 && normLines.some((l) => l === brand || l.includes(brand))) {
        if (best * 0.9 < 0.35) { best = 0.35 / 0.9; why = 'ブランド一致'; }
      }
      if (best < 0.3) continue;
      const cur = byId.get(p.id);
      if (!cur) byId.set(p.id, { p, score: best * 0.9, why });
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

/** The product's latest scans for the phone (newest first), each with whether it was taken back. */
export function recentScans(p, limit = 5) {
  return (p.scanEvents || []).slice(-limit).reverse().map((e) => ({
    id: e.id, scannedAt: e.scannedAt, actor: e.actor, via: e.via, fnsku: e.fnsku || '', presence: e.presence !== false,
    undone: !!e.undoneAt, undoneAt: e.undoneAt || null,
  }));
}

/** `scans` comes from the full product (the list summary does not carry the scan events). */
export function scanCard(p, why = '', score = 0, scans) {
  return {
    id: p.id, name: p.name || p.title || '', short: shortName(p), say: sayFor(p),
    brand: p.brand || '', model: p.model || '', jan: p.jan || '',
    orderDate: p.orderDate || '', arrivalDate: p.arrivalDate || '',
    arrivalId: arrivalIdOf(p.arrivalDate), dateId: p.dateId || '', productCode: p.productCode || '',
    fnsku: p.fnsku || '', sourceUrl: p.sourceUrl || null,
    thumb: p.thumb || null, official: p.official || null,
    scanScene: p.scanScene || null, scanSceneThumb: p.scanSceneThumb || null, scanSceneAt: p.scanSceneAt || null,
    shotDate: p.shotDate || '', presence: p.presence || null, decision: p.decision || 'undecided',
    conditionNote: p.conditionNote || '', aiInstruction: p.aiInstruction || '',
    lastScanAt: p.lastScanAt || null, ...(scans ? { scans } : {}), hasOwnPhoto: (p.counts?.actual || 0) > 0, why, score: Math.round(score * 100) / 100,
  };
}

/** Build a clean registration draft from the FNSKU, barcodes (JAN), and OCR label lines. */
export function draftFromScan({ fnsku = '', codes = [], lines = [] } = {}) {
  const cleanLines = [];
  const seen = new Set();
  for (const raw of lines) {
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (s.length < 2) continue;
    if (fnskusIn(s).length && norm(s).length <= 12) continue;
    if (LABEL_NOISE_RE.test(s)) continue;
    const key = norm(s);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    cleanLines.push(s);
  }
  const jan = codes.map((c) => String(c || '').replace(/\D/g, '')).find((c) => /^\d{8}$|^\d{13}$/.test(c)) || '';
  const name = cleanLines.slice(0, 2).join(' ').slice(0, 80).trim();
  return { fnsku, jan, name, lines: cleanLines.slice(0, 12) };
}

/**
 * The answer for one reading (3-state matching):
 * - status 'registered' (状態A): FNSKU already exists in the ledger
 * - status 'candidates' (状態B): FNSKU unregistered, label/barcode candidates found
 * - status 'unregistered' (状態C): FNSKU unregistered and no candidates found (ready for new registration)
 */
export function scanLookup(products, input) {
  const codes = input?.codes || [];
  const lines = input?.lines || [];
  const fnsku = fnskusIn([...codes, ...lines].join(' '))[0] || '';
  const live = products.filter((p) => !p.trashedAt);
  const fnskuOwners = fnsku ? live.filter((p) => String(p.fnsku || '').toUpperCase() === fnsku) : [];
  const draft = draftFromScan({ fnsku, codes, lines });

  if (fnskuOwners.length > 0) {
    const cards = fnskuOwners.map((p) => scanCard(p, 'Amazon管理番号（FNSKU）一致', 2));
    if (fnskuOwners.length === 1) {
      const p = fnskuOwners[0];
      const say = sayFor(p);
      return {
        status: 'registered', registered: true, fnsku, fnskuOwner: cards[0], fnskuOwners: cards,
        pick: cards[0], candidates: cards, say, voiceSay: `登録済みの商品です。${say}`, draft,
      };
    }
    return {
      status: 'registered', registered: true, fnsku, fnskuOwner: cards[0], fnskuOwners: cards,
      pick: null, candidates: cards, say: `候補${cards.length}件。画面で選んでください`,
      voiceSay: '登録済みの番号ですが、候補が複数あります。確認してください', draft,
    };
  }

  const c = scanCandidates(live, { codes, lines }, 6);
  let pick = clearPick(c);
  // If an unregistered FNSKU matched text on a product that already has a DIFFERENT FNSKU, never auto-bind it.
  if (fnsku && pick && pick.p.fnsku && String(pick.p.fnsku).toUpperCase() !== fnsku) pick = null;
  const candidates = c.map((x) => scanCard(x.p, x.why, x.score));

  if (c.length > 0) {
    const say = pick ? sayFor(pick.p) : `候補${c.length}件。画面で選んでください`;
    const voiceSay = pick ? say : (c.length > 1 ? '候補が複数あります。確認してください' : '候補があります。確認してください');
    return {
      status: 'candidates', registered: false, fnsku, fnskuOwner: null, fnskuOwners: [],
      pick: pick ? scanCard(pick.p, pick.why, pick.score) : null, candidates, say, voiceSay, draft,
    };
  }

  const say = fnsku ? '台帳にない番号です' : '見つかりません';
  const voiceSay = fnsku ? '未登録の商品です。新規登録できます' : '見つかりません。新規登録できます';
  return {
    status: 'unregistered', registered: false, fnsku, fnskuOwner: null, fnskuOwners: [],
    pick: null, candidates: [], say, voiceSay, draft,
  };
}

/**
 * Duplicate and similar-product check before creating a new product from a scan.
 * Prevents duplicate FNSKUs and surfaces similar existing items so the user notices past registrations.
 */
export function checkScanDuplicates(store, { fnsku = '', name = '', brand = '', model = '', jan = '', url = '', lines = [] } = {}) {
  const code = String(fnsku || '').trim().toUpperCase();
  const validFnsku = FNSKU_RE.test(code) ? code : '';
  const all = store.list({ includeTrash: true });
  const live = all.filter((p) => !p.trashedAt);
  const fnskuOwnerRaw = validFnsku ? live.find((p) => String(p.fnsku || '').toUpperCase() === validFnsku) : null;
  const smOf = (p) => summary(p, store.settings);
  const fnskuOwner = fnskuOwnerRaw ? scanCard(smOf(fnskuOwnerRaw), 'FNSKUが一致', 2) : null;

  const links = url ? [{ url: String(url).trim() }] : [];
  const rawDups = store.duplicatesFor({ name, brand, model, jan, fnsku: validFnsku, links });
  const byId = new Map(all.map((p) => [p.id, p]));
  const duplicates = rawDups.map((d) => {
    const p = byId.get(d.id);
    const card = p ? scanCard(smOf(p), d.reasons.join('・'), 2) : { id: d.id, name: d.name, why: d.reasons.join('・'), score: 2 };
    return { ...card, reasons: d.reasons, trashed: !!p?.trashedAt };
  });

  const dupIds = new Set(duplicates.map((d) => d.id));
  if (fnskuOwner) dupIds.add(fnskuOwner.id);
  const queryLines = [name, brand, model, ...(Array.isArray(lines) ? lines : [])].map((x) => String(x || '').trim()).filter(Boolean);
  const liveSm = live.map(smOf);
  const candHits = scanCandidates(liveSm, { codes: jan ? [String(jan)] : [], lines: queryLines }, 8);
  const simMap = new Map();
  for (const hit of candHits) {
    if (dupIds.has(hit.p.id)) continue;
    simMap.set(hit.p.id, scanCard(hit.p, hit.why, hit.score));
  }
  if (name && norm(name).length >= 3) {
    for (const p of liveSm) {
      if (dupIds.has(p.id) || simMap.has(p.id)) continue;
      const sim = similarity(name, p.name);
      if (sim >= 0.45) simMap.set(p.id, scanCard(p, `商品名が近い（${Math.round(sim * 100)}%）`, sim));
    }
  }
  const similar = [...simMap.values()].sort((a, b) => b.score - a.score).slice(0, 6);
  return { fnskuOwner, duplicates, similar, hasConflict: !!(fnskuOwner || duplicates.length) };
}

/**
 * POST /api/scan/register: create a new product from scan draft after duplicate checking,
 * then record the FNSKU + scan event on it.
 */
export function registerFromScan(store, actor, body = {}) {
  const name = String(body.name || '').trim();
  if (!name) throw new AppError(400, '商品名を入れてください');
  const rawFnsku = normalizeFnsku(body.fnsku);
  if (rawFnsku && !FNSKU_RE.test(rawFnsku)) throw new AppError(400, `Amazon管理番号の形が違います: ${rawFnsku}`, 'INVALID_FNSKU_FORMAT');
  const presence = body.presence !== false;
  if (presence && !isUser(actor)) throw new AppError(403, 'あるかないかのチェックはユーザーのみ実行できます（AIの権限外）', 'forbidden');
  const scannedAt = body.scannedAt ? new Date(body.scannedAt).toISOString() : new Date().toISOString();
  if (Number.isNaN(Date.parse(scannedAt))) throw new AppError(400, 'scannedAt が日時ではありません');

  const brand = String(body.brand || '').trim();
  const model = String(body.model || '').trim();
  const jan = String(body.jan || '').trim();
  const url = String(body.url || '').trim();
  const conditionNote = String(body.conditionNote || '').trim();
  const aiInstruction = String(body.aiInstruction || '').trim();
  const notes = String(body.notes || '').trim();
  const lines = Array.isArray(body.lines) ? body.lines.map(String) : [];

  const dup = checkScanDuplicates(store, { fnsku: rawFnsku, name, brand, model, jan, url, lines });
  if (dup.fnskuOwner) {
    const err = new AppError(409, `この FNSKU（${rawFnsku}）は既に #${dup.fnskuOwner.id}「${dup.fnskuOwner.name}」に登録されています`, 'FNSKU_OWNED_BY_OTHER');
    err.owner = { productId: dup.fnskuOwner.id, id: dup.fnskuOwner.id, name: dup.fnskuOwner.name, fnsku: dup.fnskuOwner.fnsku };
    err.fnskuOwner = dup.fnskuOwner;
    err.duplicates = dup.duplicates;
    err.similar = dup.similar;
    throw err;
  }
  if (dup.duplicates.length && !body.allowDuplicate) {
    const err = new AppError(409, `重複の可能性がある商品があります: ${dup.duplicates.map((d) => `#${d.id} ${d.name}`).join(' / ')}`, 'duplicate');
    err.duplicates = dup.duplicates;
    err.similar = dup.similar;
    throw err;
  }

  const fields = { name };
  if (brand) fields.brand = brand;
  if (model) fields.model = model;
  if (jan) fields.jan = jan;
  if (conditionNote) fields.conditionNote = conditionNote;
  if (aiInstruction) fields.aiInstruction = aiInstruction;
  if (notes) fields.notes = notes;
  const links = url ? [{ url, type: 'purchase' }] : [];

  const { product } = store.create(fields, actor, { links, allowDuplicate: true });
  const { product: recorded, conflict } = store.recordScan(product.id, actor, { fnsku: rawFnsku, scannedAt, presence, via: 'register' });
  return {
    ...scanCard(summary(recorded, store.settings), '', 0, recentScans(recorded)),
    created: true,
    noted: conflict || '',
    similar: dup.similar,
  };
}

/**
 * Plan an import of scan records ({ fnsku, scannedAt, productId?, asin? }) against the products.
 * Match: productId → the product with that FNSKU → the product with that ASIN (観察ブラウザ・Amazon 情報・リンクの /dp/<ASIN>).
 * Two products for one FNSKU/ASIN is not guessed (unmatched, reason ambiguous).
 */
export function planScanImport(products, records, now = Date.now()) {
  const live = products.filter((p) => !p.trashedAt);
  const asinsOf = (p) => new Set([p.browser?.asin, p.amazon?.asin, ...(p.links || []).map((l) => asinOf(l.url)), asinOf(p.research?.url)].filter(Boolean).map((a) => String(a).toUpperCase()));
  const out = { invalid: [], unmatched: [], matched: [] };
  (Array.isArray(records) ? records : []).forEach((r, index) => {
    const fnsku = String(r?.fnsku || '').trim().toUpperCase();
    const row = { index, fnsku, scannedAt: r?.scannedAt ?? null };
    const t = typeof r?.scannedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(r.scannedAt) ? Date.parse(r.scannedAt) : NaN;
    if (!/^X00[0-9A-Z]{7}$/.test(fnsku)) return out.invalid.push({ ...row, reason: 'fnsku の形が違います（X00 と英数字7文字）' });
    if (Number.isNaN(t)) return out.invalid.push({ ...row, reason: 'scannedAt が ISO 8601 の日時ではありません' });
    if (t > now + 5 * 60 * 1000) return out.invalid.push({ ...row, reason: 'scannedAt が未来の日時です' });
    const scannedAt = new Date(t).toISOString();
    let hit = [];
    let by = '';
    if (r.productId) {
      hit = live.filter((p) => p.id === String(r.productId));
      by = 'productId';
      if (!hit.length) return out.unmatched.push({ ...row, productId: String(r.productId), reason: 'productId の商品がありません（ゴミ箱を含む）' });
    } else {
      hit = live.filter((p) => p.fnsku === fnsku);
      by = 'fnsku';
      const asin = String(r.asin || '').trim().toUpperCase();
      if (!hit.length && /^[A-Z0-9]{10}$/.test(asin)) { hit = live.filter((p) => asinsOf(p).has(asin)); by = 'asin'; }
      if (!hit.length) return out.unmatched.push({ ...row, asin: asin || undefined, reason: asin ? 'FNSKU・ASIN に合う商品がありません' : 'FNSKU に合う商品がありません' });
      if (hit.length > 1) return out.unmatched.push({ ...row, asin: asin || undefined, reason: `${by === 'asin' ? 'ASIN' : 'FNSKU'} に合う商品が${hit.length}件あります`, candidates: hit.map((p) => p.id) });
    }
    const p = hit[0];
    const conflict = p.fnsku && p.fnsku !== fnsku ? `この商品には別の管理番号 ${p.fnsku} が入っています` : '';
    const duplicate = (p.scanEvents || []).some((e) => !e.undoneAt && e.scannedAt === scannedAt && (e.fnsku || '') === fnsku);
    out.matched.push({ ...row, scannedAt, productId: p.id, name: p.name || '', by, conflict, duplicate });
  });
  return out;
}

/** POST /api/scan/import: plan, then (unless dryRun) record each matched scan. Same record twice is skipped. */
export function importScans(store, actor, { records, dryRun = true } = {}) {
  if (!Array.isArray(records) || !records.length) throw new AppError(400, 'records（{ fnsku, scannedAt } の配列）がありません');
  if (records.length > 2000) throw new AppError(400, 'records は一度に2000件までです');
  const plan = planScanImport(store.list(), records);
  // ある の印はユーザーの取り込みだけ。AI の取り込みは FNSKU・lastScanAt・スキャンの記録だけ（在庫の印は変えない）。
  const presence = isUser(actor);
  const todo = plan.matched.filter((m) => !m.duplicate);
  const result = {
    dryRun, presence, total: records.length, matched: plan.matched.length, applied: 0,
    unmatched: plan.unmatched, invalid: plan.invalid,
    conflicts: plan.matched.filter((m) => m.conflict).map(({ index, fnsku, productId, name, conflict }) => ({ index, fnsku, productId, name, reason: conflict })),
    duplicates: plan.matched.filter((m) => m.duplicate).map(({ index, fnsku, productId, scannedAt }) => ({ index, fnsku, productId, scannedAt, reason: '同じスキャンが記録済み' })),
    records: plan.matched.map(({ index, fnsku, scannedAt, productId, by, duplicate }) => ({ index, fnsku, scannedAt, productId, by, duplicate })),
    errors: [],
  };
  if (dryRun || !todo.length) return result;
  if (new Set(todo.map((m) => m.productId)).size >= 10) result.snapshot = store.saveSnapshot(actor, { label: `スキャンを取り込む前（${todo.length}件）`, kind: 'before' }).id;
  for (const m of todo) {
    try {
      store.recordScan(m.productId, actor, { fnsku: m.fnsku, scannedAt: m.scannedAt, presence, via: 'import' });
      result.applied++;
    } catch (e) {
      result.errors.push({ index: m.index, fnsku: m.fnsku, productId: m.productId, error: e.message });
    }
  }
  return result;
}
