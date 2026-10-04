// Mercari Adapter. The app's product data is the source of truth; this module only
// (1) turns a finished product into a channel-neutral "listing package",
// (2) compares what the agent observed on Mercari against that package, and
// (3) records channel state. It contains NO DOM selectors: the browser agent locates
// form fields semantically by the labels below, so a Mercari UI change only affects
// the agent procedure (.claude/skills/mercari-adapter/SKILL.md), never the app.
import fs from 'node:fs';
import path from 'node:path';
import { AppError, nowIso, norm, writeJson, writeFileAtomic } from '../util.js';
import { readiness, listingPhotos } from '../rules.js';
import { listingText, isUser } from '../store.js';

export const CHANNEL = 'mercari';
export const SELL_URL = 'https://jp.mercari.com/sell/create';

/** Semantic description of the Mercari web sell form, in on-screen order. */
export const FORM = [
  { key: 'photos', label: '出品画像', hint: '最大20枚。1枚目がサムネイル。outbox の 01.jpg から順にアップロード' },
  { key: 'title', label: '商品名', hint: '最大40文字' },
  { key: 'description', label: '商品の説明', hint: '最大1000文字。改行を保持' },
  { key: 'category', label: 'カテゴリー', hint: '「>」区切りの階層を上から順に選ぶ' },
  { key: 'brand', label: 'ブランド', hint: '任意。候補から選択、無ければ空欄' },
  { key: 'condition', label: '商品の状態' },
  { key: 'shippingPayer', label: '配送料の負担' },
  { key: 'shippingMethod', label: '配送の方法' },
  { key: 'shippingFrom', label: '発送元の地域' },
  { key: 'shippingDays', label: '発送までの日数' },
  { key: 'price', label: '販売価格', hint: '数字のみ' },
];

const TEXT_KEYS = ['title', 'description', 'category', 'brand', 'condition', 'shippingPayer', 'shippingMethod', 'shippingFrom', 'shippingDays'];

export function outboxDir(store, id) {
  return path.join(store.dataDir, 'outbox', CHANNEL, id);
}

/** Build the package and stage numbered photo files for upload. */
export function buildPackage(store, id, { force = false } = {}) {
  const p = store.get(id);
  const rd = readiness(p, store.settings);
  if (!rd.ok && !force) {
    throw new AppError(409, `出品準備が完了していません: ${rd.missing.map((m) => m.message).join(' / ')}`, 'not_ready');
  }
  const dir = outboxDir(store, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const photos = listingPhotos(p).map((ph, i) => {
    const name = `${String(i + 1).padStart(2, '0')}.jpg`;
    const dest = path.join(dir, name);
    fs.copyFileSync(path.join(store.dir(id), ph.files.work), dest);
    return { order: i + 1, photoId: ph.id, tag: ph.tag, path: dest, url: `/files/outbox/${CHANNEL}/${id}/${name}` };
  });
  const L = p.listing;
  const pkg = {
    channel: CHANNEL,
    productId: p.id,
    rev: p.rev,
    builtAt: nowIso(),
    sellUrl: SELL_URL,
    fields: {
      title: L.title,
      description: L.description,
      category: L.category,
      brand: L.brand,
      condition: L.condition,
      shippingPayer: L.shippingPayer,
      shippingMethod: L.shippingMethod,
      shippingFrom: L.shippingFrom,
      shippingDays: L.shippingDays,
      price: L.price,
    },
    photos,
    outboxDir: dir,
    form: FORM,
    readiness: rd,
  };
  writeJson(path.join(dir, 'listing.json'), pkg);
  writeFileAtomic(path.join(dir, 'listing.txt'), listingText(p));
  return pkg;
}

const normText = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function categoryMatches(expected, observed) {
  if (!expected || !observed) return false;
  const seg = (s) => String(s).split(/>|＞|\/|›/).map((x) => norm(x)).filter(Boolean);
  const e = seg(expected);
  const o = seg(observed);
  if (e.join('>') === o.join('>')) return true;
  return e.length > 0 && o.length > 0 && e.at(-1) === o.at(-1);
}

/**
 * Deterministic field-by-field comparison between the canonical product and what the
 * agent read back from the Mercari form. Fields the agent did not report count as
 * "未確認" (not a pass).
 */
export function compare(p, observed = {}) {
  const L = p.listing;
  const mismatches = [];
  const unchecked = [];
  for (const k of TEXT_KEYS) {
    if (!(k in observed)) {
      if (k === 'brand' && !L.brand) continue;
      unchecked.push(k);
      continue;
    }
    const exp = L[k] ?? '';
    const obs = observed[k] ?? '';
    const ok = k === 'category' ? categoryMatches(exp, obs) : normText(exp) === normText(obs);
    if (!ok) mismatches.push({ field: k, expected: exp, observed: obs });
  }
  if (!('price' in observed)) unchecked.push('price');
  else if (Number(String(observed.price).replace(/[^\d]/g, '')) !== L.price) mismatches.push({ field: 'price', expected: L.price, observed: observed.price });

  const expectedPhotos = listingPhotos(p).length;
  if (!('photoCount' in observed)) unchecked.push('photoCount');
  else if (Number(observed.photoCount) !== expectedPhotos) mismatches.push({ field: 'photoCount', expected: expectedPhotos, observed: observed.photoCount });
  for (const k of ['photoOrderOk', 'photosMatchProduct', 'productMatches']) {
    if (!(k in observed)) unchecked.push(k);
    else if (observed[k] !== true) mismatches.push({ field: k, expected: true, observed: observed[k] });
  }
  return { result: mismatches.length === 0 && unchecked.length === 0 ? 'pass' : 'fail', mismatches, unchecked };
}

export function recordEntry(store, id, actor, { draftUrl = '', itemUrl = '', itemId = '', savedAs = 'draft', note = '' } = {}) {
  const p = store.get(id);
  if (!['queued', 'ready', 'mercari_entered', 'final_check'].includes(p.stage)) {
    throw new AppError(409, `ステータス「${p.stage}」の商品は転記対象ではありません（出品待ち／出品準備完了のみ）`);
  }
  if (savedAs === 'listed' && !isUser(actor) && !p.channels.mercari?.publishApproved) {
    throw new AppError(403, 'ユーザーの公開承認なしに公開状態で記録することはできません', 'forbidden');
  }
  return store.updateChannel(
    id,
    actor,
    CHANNEL,
    { status: 'entered', savedAs, draftUrl, itemUrl, itemId, note, enteredAt: nowIso(), enteredRev: p.rev, transferQc: null },
    { summary: `メルカリ入力完了（${savedAs === 'draft' ? '下書き保存' : savedAs}）`, stage: 'mercari_entered' }
  );
}

export function recordVerification(store, id, actor, observed) {
  const p = store.get(id);
  const ch = p.channels.mercari || {};
  if (ch.status !== 'entered' && ch.status !== 'transfer_ng' && ch.status !== 'transfer_ok') {
    throw new AppError(409, 'メルカリ入力が記録されていません（先に record_mercari_entry）');
  }
  const cmp = compare(p, observed);
  const stale = ch.enteredRev !== p.rev;
  if (stale) cmp.mismatches.push({ field: 'rev', expected: p.rev, observed: ch.enteredRev, message: '入力後に商品データが変更されています。再入力が必要です' });
  const result = cmp.mismatches.length || cmp.unchecked.length ? 'fail' : 'pass';
  const transferQc = { result, at: nowIso(), by: actor, mismatches: cmp.mismatches, unchecked: cmp.unchecked, notes: observed.notes || '' };
  store.updateChannel(
    id,
    actor,
    CHANNEL,
    { status: result === 'pass' ? 'transfer_ok' : 'transfer_ng', transferQc },
    {
      summary: result === 'pass' ? '転記QC PASS' : `転記QC NG: ${[...cmp.mismatches.map((m) => m.field), ...cmp.unchecked.map((u) => `${u}未確認`)].join(', ')}`,
      stage: result === 'pass' ? 'final_check' : 'mercari_entered',
    }
  );
  return transferQc;
}

export function approvePublish(store, id, actor, approved = true) {
  if (!isUser(actor)) throw new AppError(403, '公開承認はユーザーのみ可能です', 'forbidden');
  const p = store.get(id);
  if (approved && p.channels.mercari?.status !== 'transfer_ok') throw new AppError(409, '転記QCがPASSしていません');
  return store.updateChannel(id, actor, CHANNEL, { publishApproved: approved ? { by: actor, at: nowIso(), rev: p.rev } : null }, { summary: approved ? '公開を承認' : '公開承認を取り消し' });
}

export function markListed(store, id, actor, { itemUrl = '', itemId = '', price } = {}) {
  const p = store.get(id);
  const ch = p.channels.mercari || {};
  if (!isUser(actor) && (!ch.publishApproved || ch.publishApproved.rev !== p.rev)) {
    throw new AppError(403, 'ユーザーの公開承認がない（または承認後に内容が変わった）ため、AIは公開できません', 'forbidden');
  }
  return store.updateChannel(
    id,
    actor,
    CHANNEL,
    { status: 'listed', itemUrl: itemUrl || ch.itemUrl || '', itemId: itemId || ch.itemId || '', listedAt: nowIso(), listedPrice: price ?? p.listing.price },
    { summary: `メルカリ出品中${itemUrl ? `: ${itemUrl}` : ''}`, stage: 'listed' }
  );
}

export function markSold(store, id, actor, { price, soldAt } = {}) {
  store.updateChannel(id, actor, CHANNEL, { status: 'sold', soldAt: soldAt || nowIso(), soldPrice: price ?? null }, { summary: `売却済み${price ? `（${Number(price).toLocaleString()}円）` : ''}`, stage: 'sold' });
  if (price != null) {
    store.mutate(id, actor, 'sold_price', (p, ctx) => {
      if (p.soldPrice === Number(price)) return;
      ctx.change('soldPrice', p.soldPrice, Number(price));
      p.soldPrice = Number(price);
    });
  }
  return store.get(id);
}

export function markStopped(store, id, actor) {
  if (!isUser(actor)) throw new AppError(403, '出品停止の記録はユーザーのみ可能です', 'forbidden');
  return store.updateChannel(id, actor, CHANNEL, { status: 'stopped', stoppedAt: nowIso(), publishApproved: null }, { summary: 'メルカリ出品停止', stage: 'mercari_entered' });
}

/** Products waiting for transfer to Mercari (user put them in 出品待ち). */
export function queue(store) {
  return store.list({ includeTrash: false }).filter((p) => !p.archived && p.stage === 'queued');
}
