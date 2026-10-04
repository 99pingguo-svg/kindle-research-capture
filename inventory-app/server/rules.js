// Pure functions over a product: readiness, deterministic lint, list summary, duplicates.
import { MERCARI_LIMITS, CONFIRM_FIELDS, FIELD_MAP, stageLabel } from './schema.js';
import { norm, normUrl, similarity } from './util.js';

export const livePhotos = (p) => p.photos.filter((ph) => !ph.deletedAt);
export const actualPhotos = (p) => livePhotos(p).filter((ph) => ph.kind === 'actual');
export const referencePhotos = (p) => livePhotos(p).filter((ph) => ph.kind === 'reference');
export const openPhotoRequests = (p) => p.photoRequests.filter((r) => !r.doneAt && !r.cancelledAt);

export function listingPhotos(p) {
  const byId = new Map(livePhotos(p).map((ph) => [ph.id, ph]));
  return p.listingPhotoIds.map((id) => byId.get(id)).filter((ph) => ph && ph.kind === 'actual');
}

const EXAGGERATION = ['絶対', '完璧', '完全', '最高', '激レア', '超レア', '確実', '100%', '１００％', '保証します', '間違いなく'];
const PLACEHOLDERS = ['要確認', 'TODO', '???', '？？？', '〇〇', '○○', 'XXX', '{{', '【未定】'];

/**
 * Deterministic checks that do not need an AI: lengths, ranges, placeholders,
 * suspicious wording, unverified facts written into the description.
 */
export function lint(p, settings = {}) {
  const out = [];
  const add = (severity, code, message, field) => out.push({ severity, code, message, field });
  const L = p.listing;
  const desc = L.description || '';
  const title = L.title || '';

  if (title.length > MERCARI_LIMITS.titleMax) add('error', 'title_too_long', `タイトルが${MERCARI_LIMITS.titleMax}文字を超えています（${title.length}文字）`, 'listing.title');
  if (desc.length > MERCARI_LIMITS.descriptionMax) add('error', 'description_too_long', `説明文が${MERCARI_LIMITS.descriptionMax}文字を超えています（${desc.length}文字）`, 'listing.description');
  if (L.price != null && (L.price < MERCARI_LIMITS.priceMin || L.price > MERCARI_LIMITS.priceMax)) {
    add('error', 'price_out_of_range', `販売価格がメルカリの範囲外です（${MERCARI_LIMITS.priceMin}〜${MERCARI_LIMITS.priceMax.toLocaleString()}円）`, 'listing.price');
  }
  if (L.price != null && p.plannedPrice) {
    const r = L.price / p.plannedPrice;
    if (r < 0.5 || r > 2) add('warn', 'price_vs_planned', `販売価格 ${L.price.toLocaleString()}円 が出品予定価格 ${p.plannedPrice.toLocaleString()}円 と大きく異なります（桁の入力ミス？）`, 'listing.price');
  }
  if (L.price != null && L.price % 10 !== 0 && L.price > 1000) add('info', 'price_odd', `価格の端数が不自然です（${L.price}円）`, 'listing.price');

  for (const w of PLACEHOLDERS) {
    if (title.includes(w) || desc.includes(w)) add('error', 'placeholder', `原稿に未確定の記述「${w}」が残っています`, 'listing.description');
  }
  for (const w of EXAGGERATION) {
    if (title.includes(w) || desc.includes(w)) add('warn', 'exaggeration', `誇張・断定の可能性がある表現「${w}」`, 'listing.description');
  }
  if (L.condition && L.condition !== '新品、未使用' && /新品同様|未開封/.test(title + desc)) {
    add('warn', 'condition_wording', `商品の状態「${L.condition}」に対し「新品同様／未開封」と記載されています`, 'listing.description');
  }
  const damageShots = actualPhotos(p).filter((ph) => ph.tag === '傷・汚れ').length;
  if (damageShots && ['新品、未使用', '未使用に近い'].includes(L.condition)) {
    add('warn', 'condition_vs_photos', `「傷・汚れ」タグの写真が${damageShots}枚あるのに状態が「${L.condition}」です`, 'listing.condition');
  }
  if ((p.quantity || 1) > 1 && desc && !new RegExp(`${p.quantity}\\s*(個|点|セット|枚|本|台|冊|組|足|着|箱)|[×xX]\\s*${p.quantity}`).test(title + desc)) {
    add('warn', 'quantity_missing', `数量 ${p.quantity} が原稿に明記されていません`, 'listing.description');
  }
  for (const f of p.facts) {
    if (!['unverified', 'unknown'].includes(f.confidence)) continue;
    const v = String(f.value ?? '').trim();
    if (v.length >= 3 && (desc.includes(v) || title.includes(v))) {
      add('warn', 'unverified_in_text', `要確認の情報「${f.label}: ${v}」が原稿に事実として書かれています`, 'listing.description');
    }
  }
  if (p.model && desc && !norm(title + desc).includes(norm(p.model))) {
    add('info', 'model_not_mentioned', `型番 ${p.model} が原稿に含まれていません`, 'listing.description');
  }
  const minPhotos = settings.recommendedPhotos ?? 3;
  const lp = listingPhotos(p).length;
  if (lp > 0 && lp < minPhotos) add('warn', 'few_photos', `出品用写真が${lp}枚です（推奨${minPhotos}枚以上）`);
  if (lp > MERCARI_LIMITS.photosMax) add('error', 'too_many_photos', `出品用写真は${MERCARI_LIMITS.photosMax}枚までです（${lp}枚）`);
  return out;
}

/**
 * Everything required for 出品準備完了. Each item is a blocker; `warnings` are shown but do not block.
 */
export function readiness(p, settings = {}) {
  const missing = [];
  const add = (code, message, extra) => missing.push({ code, message, ...extra });
  const L = p.listing;

  if (p.decision !== 'sell') add('decision', '出品判断が「出品する」になっていません');
  if (actualPhotos(p).length === 0) add('no_photos', '現物写真がありません');
  else if (listingPhotos(p).length === 0) add('no_listing_photos', '出品用写真が選ばれていません');
  if (!L.title) add('title', 'タイトル未作成');
  if (!L.description) add('description', '説明文未作成');
  if (!L.category) add('category', 'カテゴリー未設定');
  for (const path of CONFIRM_FIELDS) {
    const v = path.split('.').reduce((o, k) => o?.[k], p);
    if (v == null || v === '') add('unset:' + path, `${FIELD_MAP[path].label}未設定`, { field: path });
    else if (!p.locks[path]) add('unconfirmed:' + path, `${FIELD_MAP[path].label}がユーザー未確認`, { field: path });
  }
  if (!L.shippingPayer || !L.shippingMethod || !L.shippingFrom || !L.shippingDays) add('shipping', '配送情報が未設定');
  const reqs = openPhotoRequests(p);
  if (reqs.length) add('photo_requests', `追加撮影: ${reqs.map((r) => r.label).join('、')}`);
  if (Object.keys(p.proposals).length) add('proposals', `未処理のAI提案が${Object.keys(p.proposals).length}件`);
  if (p.facts.some((f) => f.proposal)) add('fact_proposals', '未処理の情報修正提案があります');
  if (!p.qc) add('qc', 'AI QC未実施');
  else if (p.qc.rev !== p.rev) add('qc_stale', 'QC後に内容が変わりました（再QCが必要）');
  else if (!(settings.imageQcModels || []).includes(p.qc.model)) add('qc_model', `QC実施モデル（${p.qc.model || '不明'}）が指定モデルではありません（再QCが必要）`);
  else if (p.qc.result !== 'pass') add('qc_failed', `QC: ${p.qc.summary || '要確認'}`);

  const issues = lint(p, settings);
  for (const i of issues.filter((x) => x.severity === 'error')) add('lint:' + i.code, i.message, { field: i.field });
  return { ok: missing.length === 0, missing, warnings: issues.filter((x) => x.severity !== 'error') };
}

export function statusOf(p) {
  if (p.trashedAt) return { id: 'trash', label: 'ゴミ箱' };
  if (p.archived) return { id: 'archived', label: 'アーカイブ' };
  if (p.decision === 'hold') return { id: 'hold', label: '保留' };
  if (p.decision === 'no_sell') return { id: 'no_sell', label: '出品しない' };
  return { id: p.stage, label: stageLabel(p.stage) };
}

export function aiStateOf(p) {
  const active = p.aiTasks.filter((t) => t.status === 'pending' || t.status === 'processing');
  if (active.some((t) => t.status === 'processing')) return { state: 'processing', label: 'AI処理中', tasks: active.map((t) => t.type) };
  if (active.length) return { state: 'pending', label: 'AI待ち', tasks: active.map((t) => t.type) };
  const last = p.aiTasks.at(-1);
  if (last?.status === 'error') return { state: 'error', label: 'AIエラー', message: last.message };
  if (p.qc) return { state: 'done', label: p.qc.rev === p.rev ? `QC ${p.qc.result === 'pass' ? 'PASS' : '要確認'}` : 'QC要再実行', model: p.qc.model };
  if (p.listing.title || p.facts.length) return { state: 'done', label: 'AI整理済み' };
  return { state: 'idle', label: '' };
}

export function photoUrl(p, ph, variant = 'thumb') {
  const f = ph.files[variant] || ph.files.work || ph.files.original;
  return `/files/products/${p.id}/${f}`;
}

/** Compact record used by the list screen and by list_products. */
export function summary(p, settings) {
  const rd = readiness(p, settings);
  const actual = actualPhotos(p);
  const lp = listingPhotos(p);
  const main = lp[0] || actual[0] || referencePhotos(p)[0];
  const st = statusOf(p);
  const issues = rd.missing
    .filter((m) => !['decision'].includes(m.code))
    .map((m) => m.message)
    .concat(rd.warnings.filter((w) => w.severity === 'warn').map((w) => w.message));
  return {
    id: p.id,
    name: p.name,
    brand: p.brand,
    model: p.model,
    jan: p.jan,
    quantity: p.quantity,
    location: p.location,
    notes: p.notes,
    decision: p.decision,
    stage: p.stage,
    archived: p.archived,
    trashedAt: p.trashedAt,
    shootPlan: p.shootPlan,
    status: st,
    thumb: main ? photoUrl(p, main, 'thumb') : null,
    thumbIsReference: !!main && main.kind === 'reference',
    counts: { actual: actual.length, listing: lp.length, reference: referencePhotos(p).length },
    lastPhotoAt: p.lastPhotoAt,
    shotDoneAt: p.shotDoneAt || null,
    openPhotoRequests: openPhotoRequests(p).map((r) => ({ id: r.id, label: r.label })),
    proposals: Object.keys(p.proposals).length + p.facts.filter((f) => f.proposal).length,
    ready: rd.ok,
    issues: issues.slice(0, 6),
    qc: p.qc ? { result: p.qc.result, stale: p.qc.rev !== p.rev, at: p.qc.at, model: p.qc.model } : null,
    ai: aiStateOf(p),
    price: p.listing.price,
    plannedPrice: p.plannedPrice,
    mercari: p.channels.mercari?.status || null,
    title: p.listing.title,
    updatedAt: p.updatedAt,
    createdAt: p.createdAt,
  };
}

/** Possible duplicates of `cand` (a partial product) among `products`. */
export function findDuplicates(cand, products, { excludeId } = {}) {
  const out = [];
  const urls = new Set((cand.links || []).map((l) => normUrl(l.url ?? l)).filter(Boolean));
  for (const p of products) {
    if (p.id === excludeId || p.trashedAt) continue;
    const reasons = [];
    if (cand.jan && p.jan && norm(cand.jan) === norm(p.jan)) reasons.push('JANが一致');
    if (cand.model && p.model && norm(cand.model).length >= 3 && norm(cand.model) === norm(p.model)) reasons.push('型番が一致');
    if (urls.size && p.links.some((l) => urls.has(normUrl(l.url)))) reasons.push('登録URLが一致');
    const sim = similarity(cand.name, p.name);
    if (sim >= 0.85) reasons.push(`商品名が類似（${Math.round(sim * 100)}%）`);
    if (reasons.length) out.push({ id: p.id, name: p.name, reasons });
  }
  return out;
}
