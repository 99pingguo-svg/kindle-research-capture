// File-based product store. The data directory itself is the source of truth and is
// readable without this app: data/products/<id>/{product.json,listing.txt,history.jsonl,photos/,versions/}.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  AppError, nowIso, newId, clone, getPath, setPath, same, writeJson, writeFileAtomic, readJson,
  appendJsonl, readJsonl, pad4, truncate, yen,
} from './util.js';
import {
  FIELD_MAP, DECISION_IDS, STAGE_IDS, USER_ONLY_STAGES, DEFAULT_SETTINGS, FACT_CONFIDENCE,
  LINK_TYPES, PHOTO_TAGS, AI_TASK_TYPES, MERCARI_LIMITS, IMAGE_QC_CHECK_IDS, QC_CHECKS, coerceField, stageLabel,
  decisionLabel, PREPARE_DECISIONS, PHOTO_KINDS, PHOTO_KIND_IDS, LISTABLE_KINDS, CHANNEL_IDS, channelLabel,
  REVIEW_STATUSES, REVIEW_FORMATS,
} from './schema.js';
import { readiness, actualPhotos, listablePhotos, livePhotos, isListablePhoto, findDuplicates } from './rules.js';
import { isFood } from './food.js';
import { normalizeBrowserInfo, sameBrowserInfo } from './browser-sync.js';
import { decodeDateId } from '../public/js/datecode.js';
import { exifTime } from '../public/js/photo-time.js';

const VERSIONS_KEPT = 100;
const OPERATIONS_KEPT = 5000;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif' };

export const isUser = (actor) => actor === 'user';
export const FNSKU_RE = /^X00[0-9A-Z]{7}$/;
export const normalizeFnsku = (raw) => String(raw ?? '').normalize('NFKC').trim().toUpperCase();
/** The photo is one of the listing photos (common or a destination's own list). */
export const photoInUse = (p, photoId) => p.listingPhotoIds.includes(photoId) || Object.values(p.channelPhotos || {}).some((ids) => (ids || []).includes(photoId));

/**
 * A per-destination field must not let the AI route around the user's decisions on the common listing:
 * a per-destination price needs the user like 販売価格 does, and per-destination text follows the common field's lock.
 * Returns the reason (for the proposal note) or ''.
 */
function guardedOverride(p, def) {
  if (!def.base) return '';
  if (FIELD_MAP[def.base]?.confirm) return `${FIELD_MAP[def.base].label}はユーザーの確定が必要`;
  if (p.locks[def.base]) return `共通の${FIELD_MAP[def.base].label}がユーザー確定済み`;
  return '';
}

const fmtStamp = (iso) => new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const SCAN_EVENTS_KEPT = 50;

function forbidAi(actor, what) {
  if (!isUser(actor)) throw new AppError(403, `${what}はユーザーのみ実行できます（AIの権限外）`, 'forbidden');
}

function newProduct(id, at, settings) {
  return {
    id,
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    rev: 1,
    name: '',
    brand: '',
    model: '',
    jan: '',
    fnsku: '',
    quantity: 1,
    color: '',
    conditionNote: '',
    aiInstruction: '',
    notes: '',
    itemDate: '',
    orderDate: '',
    arrivalDate: '',
    category: '',
    purchaseDate: '',
    purchasePrice: null,
    plannedPrice: null,
    soldPrice: null,
    location: '',
    decision: 'undecided',
    stage: 'unsorted',
    archived: false,
    trashedAt: null,
    shootPlan: false,
    openCheckedAt: null, // 開封して中身を確かめた日時（ユーザーのみ）
    reviewPlan: null, // レビュー・発信の予定 { status, formats[], note, draft, url, updatedAt, by }
    stockCheckedAt: null, // 現在の最新在庫チェック日時（ユーザーのみ）
    stockUnknownAt: null, // 在庫状況「不明」チェック日時（ユーザーのみ）
    lastScanAt: null, // 台帳スキャンで最後に読んだ日時（取り消していないスキャンのうち一番新しいもの）
    scanEvents: [], // スキャンの記録（取り消し用に、触った項目の前後の値。取り消しても消さず undoneAt を付ける。新しい50件）
    fnskuCorrections: [], // FNSKU 訂正履歴（旧番号・新番号・理由・操作ID）
    asideAt: null, // 別枠に移した日時（ユーザーのみ）。一覧の「すべて」などから外し、「別枠」チップで見る
    browser: null, // 観察ブラウザ連携: { asin, lists: { vineOrders|reviewPending|reviewed|orders: { ordered, delivered } }, vineOrderDate, syncedAt }
    lastPhotoAt: null,
    shotDoneAt: null,
    links: [],
    photos: [],
    listingPhotoIds: [],
    facts: [],
    targets: [],
    override: Object.fromEntries(CHANNEL_IDS.map((c) => [c, { title: '', description: '', price: null }])),
    channelPhotos: {},
    research: null,
    amazon: null,
    market: null,
    marketYahoo: null,
    marketRakuma: null,
    marketPaypay: null,
    sizeEstimate: null,
    textCandidates: [],
    listing: {
      title: '',
      description: '',
      category: '',
      brand: '',
      condition: '',
      price: null,
      shippingPayer: settings.shippingPayer || '',
      shippingMethod: settings.shippingMethod || '',
      shippingFrom: settings.shippingFrom || '',
      shippingDays: settings.shippingDays || '',
      priceCandidates: [],
      aiNotes: '',
      titleSource: 'unknown',
      descriptionSource: 'unknown',
    },
    locks: {},
    proposals: {},
    qc: null,
    photoRequests: [],
    aiTasks: [],
    channels: { mercari: {} },
  };
}

/** Collects what a mutation did, for history and for the rev counter. */
const MATCH_TYPES = ['same', 'similar', 'none'];
/** Clean a market record; the median/low/high come from the sold examples of the stated match type. */
// Links kept per site: only that site's own item / search pages.
const SITE_URLS = {
  mercari: { item: /^https:\/\/(jp\.mercari\.com|mercari-shops\.com|item\.mercari\.com)\//, search: /^https:\/\/(jp\.mercari\.com|lens\.google\.com|www\.google\.com)\// },
  yahoo: { item: /^https:\/\/(page\.auctions\.yahoo\.co\.jp|auctions\.yahoo\.co\.jp)\//, search: /^https:\/\/(auctions\.yahoo\.co\.jp|lens\.google\.com|www\.google\.com)\// },
  rakuma: { item: /^https:\/\/item\.fril\.jp\//, search: /^https:\/\/(fril\.jp|lens\.google\.com|www\.google\.com)\// },
  paypay: { item: /^https:\/\/paypayfleamarket\.yahoo\.co\.jp\/item\//, search: /^https:\/\/(paypayfleamarket\.yahoo\.co\.jp|lens\.google\.com|www\.google\.com)\// },
};
export const MARKET_SITES = Object.keys(SITE_URLS);

export function normalizeMarket(m, actor, site = 'mercari') {
  if (!m) return null;
  const urls = SITE_URLS[site];
  if (!urls) throw new AppError(400, `相場のサイトが不正です: ${site}`);
  const matchType = MATCH_TYPES.includes(m.matchType) ? m.matchType : 'none';
  const examples = (Array.isArray(m.examples) ? m.examples : []).slice(0, 20).map((e) => ({
    title: String(e.title || '').slice(0, 120),
    price: Number.isFinite(Number(e.price)) ? Math.round(Number(e.price)) : null,
    url: urls.item.test(e.url || '') ? e.url : '',
    match: MATCH_TYPES.slice(0, 2).includes(e.match) ? e.match : matchType === 'none' ? 'similar' : matchType,
    soldAt: String(e.soldAt || '').slice(0, 20),
    note: String(e.note || '').slice(0, 80),
  })).filter((e) => e.price != null && e.price > 0);
  const basis = examples.filter((e) => e.match === matchType).map((e) => e.price).sort((a, b) => a - b);
  const mid = basis.length ? (basis.length % 2 ? basis[(basis.length - 1) / 2] : Math.round((basis[basis.length / 2 - 1] + basis[basis.length / 2]) / 2)) : null;
  return {
    matchType,
    method: ['image', 'keyword'].includes(m.method) ? m.method : 'keyword',
    query: String(m.query || '').slice(0, 100),
    searchUrl: urls.search.test(m.searchUrl || '') ? m.searchUrl : '',
    examples,
    median: mid,
    low: basis[0] ?? null,
    high: basis.at(-1) ?? null,
    count: basis.length,
    note: String(m.note || '').slice(0, 300),
    checkedAt: m.checkedAt || nowIso(),
    by: actor,
  };
}

class Ctx {
  constructor() {
    this.changes = [];
    this.notes = [];
    this.bumped = false;
    this.dirty = false;
  }
  change(p, from, to) {
    this.changes.push({ path: p, label: FIELD_MAP[p]?.label || p, from: truncate(from, 300), to: truncate(to, 300) });
    this.dirty = true;
  }
  note(text) {
    this.notes.push(text);
    this.dirty = true;
  }
  bump() {
    this.bumped = true;
    this.dirty = true;
  }
  summary() {
    const fmt = (v) => (v == null || v === '' ? '（空）' : typeof v === 'number' ? v.toLocaleString('ja-JP') : String(v).replace(/\s+/g, ' ').slice(0, 40));
    const parts = [...this.notes];
    const fieldChanges = this.changes.filter((c) => !c.silent);
    if (fieldChanges.length === 1 && !parts.length) {
      const c = fieldChanges[0];
      parts.push(`${c.label} ${fmt(c.from)} → ${fmt(c.to)}`);
    } else if (fieldChanges.length) {
      parts.push(`${fieldChanges.map((c) => c.label).join('・')} を更新`);
    }
    return parts.join(' / ');
  }
}

/** Saved list views: [{ name, view }] — the view is the list's filter/sort prefs, kept as plain data. */
export function normalizeListViews(v) {
  if (!Array.isArray(v)) throw new AppError(400, 'listViews は配列で指定してください');
  if (v.length > 40) throw new AppError(400, '保存できる表示は40件までです');
  return v.map((x) => {
    const name = String(x?.name || '').trim().slice(0, 40);
    if (!name) throw new AppError(400, '表示の名前が空です');
    const view = x?.view && typeof x.view === 'object' && !Array.isArray(x.view) ? x.view : {};
    if (JSON.stringify(view).length > 4000) throw new AppError(400, `「${name}」の条件が長すぎます`);
    return { name, view };
  });
}

/** When the photo was really taken: the JPEG's own EXIF time (also for photos picked from the library), else what the sender said. */
export function photoTakenAt(buf, claimed) {
  const exif = buf?.length ? exifTime(new DataView(buf.buffer, buf.byteOffset, Math.min(buf.length, 256 * 1024))) : null;
  if (exif) return new Date(exif).toISOString();
  return claimed && !Number.isNaN(Date.parse(claimed)) ? new Date(claimed).toISOString() : null;
}

export class Store extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = path.resolve(dataDir);
    this.productsDir = path.join(this.dataDir, 'products');
    this.products = new Map();
    this.fnskuIndex = new Map(); // normalizedFnsku -> productId (live products only)
    this.clientPhotoIndex = new Map(); // clientPhotoId -> { productId, photoId }
    this.operations = new Map(); // operationId -> { productId, kind, at, meta }
    this._writeQueue = Promise.resolve();
    this.load();
  }

  /** Process-wide exclusive write lock: serializes read -> validate -> atomic persist across all write routes. */
  withWriteLock(fn) {
    const run = this._writeQueue.then(() => fn());
    this._writeQueue = run.catch(() => {});
    return run;
  }

  // ---------- persistence ----------

  load() {
    fs.mkdirSync(this.productsDir, { recursive: true });
    this.meta = readJson(path.join(this.dataDir, 'meta.json'), { nextId: 1, settings: {} });
    this.meta.settings = { ...DEFAULT_SETTINGS, ...this.meta.settings };
    this.products.clear();
    this.fnskuIndex.clear();
    this.clientPhotoIndex.clear();
    for (const dir of fs.readdirSync(this.productsDir)) {
      const file = path.join(this.productsDir, dir, 'product.json');
      if (!fs.existsSync(file)) continue;
      const p = this.migrate(readJson(file));
      if (this.backfillPhotoHashes(p)) this.persist(p);
      this.products.set(p.id, p);
      if (!p.trashedAt && p.fnsku) {
        const nf = normalizeFnsku(p.fnsku);
        if (nf && !this.fnskuIndex.has(nf)) this.fnskuIndex.set(nf, p.id);
      }
      for (const ph of p.photos || []) {
        const cpid = ph.clientPhotoId || ph.clientId;
        if (cpid) this.clientPhotoIndex.set(cpid, { productId: p.id, photoId: ph.id });
      }
      const n = parseInt(p.id, 10);
      if (Number.isFinite(n) && n >= this.meta.nextId) this.meta.nextId = n + 1;
    }
    this.operations.clear();
    const ops = readJson(path.join(this.dataDir, 'operations.json'), {});
    for (const [k, v] of Object.entries(ops || {})) this.operations.set(k, v);
  }

  _saveOperations() {
    const entries = [...this.operations.entries()].slice(-OPERATIONS_KEPT);
    this.operations = new Map(entries);
    writeJson(path.join(this.dataDir, 'operations.json'), Object.fromEntries(entries));
  }

  _checkOperationId(operationId, productId) {
    const opId = String(operationId || '').trim();
    if (!opId) return null;
    const hit = this.operations.get(opId);
    if (!hit) return null;
    if (hit.productId !== String(productId)) {
      const err = new AppError(409, `操作ID ${opId} は別商品 #${hit.productId} で既に使用されています`, 'OPERATION_ID_CONFLICT');
      err.productId = hit.productId;
      throw err;
    }
    return hit;
  }

  _recordOperationId(operationId, productId, kind, meta = {}) {
    const opId = String(operationId || '').trim();
    if (!opId) return;
    this.operations.set(opId, { productId: String(productId), kind, at: nowIso(), meta });
    this._saveOperations();
  }

  _ownerSummary(ownerId) {
    const o = this.products.get(String(ownerId));
    return o ? { productId: o.id, id: o.id, name: o.name || '', fnsku: o.fnsku || '' } : { productId: String(ownerId), id: String(ownerId), name: '', fnsku: '' };
  }

  _validateFnskuForProduct(draft) {
    const normCode = normalizeFnsku(draft.fnsku);
    if (normCode && !FNSKU_RE.test(normCode)) {
      throw new AppError(400, `Amazon管理番号の形が違います: ${normCode}`, 'INVALID_FNSKU_FORMAT');
    }
    draft.fnsku = normCode;
    if (!draft.trashedAt && normCode) {
      const ownerId = this.fnskuIndex.get(normCode);
      if (ownerId && ownerId !== draft.id) {
        const owner = this._ownerSummary(ownerId);
        const err = new AppError(409, `この FNSKU（${normCode}）は既に #${owner.id}「${owner.name}」に登録されています`, 'FNSKU_OWNED_BY_OTHER');
        err.owner = owner;
        err.fnskuOwner = owner;
        throw err;
      }
    }
  }

  _syncFnskuIndex(current, draft) {
    const oldCode = current && !current.trashedAt ? normalizeFnsku(current.fnsku) : '';
    const newCode = draft && !draft.trashedAt ? normalizeFnsku(draft.fnsku) : '';
    if (oldCode && oldCode !== newCode && this.fnskuIndex.get(oldCode) === current.id) {
      this.fnskuIndex.delete(oldCode);
      // If another live product somehow held the same code (legacy anomaly), re-point to it.
      for (const p of this.products.values()) {
        if (p.id !== current.id && !p.trashedAt && normalizeFnsku(p.fnsku) === oldCode) {
          this.fnskuIndex.set(oldCode, p.id);
          break;
        }
      }
    }
    if (newCode) this.fnskuIndex.set(newCode, draft.id);
  }

  migrate(p) {
    const base = newProduct(p.id, p.createdAt || nowIso(), {});
    const out = { ...base, ...p, listing: { ...base.listing, ...p.listing }, channels: { ...base.channels, ...p.channels } };
    out.override = Object.fromEntries(CHANNEL_IDS.map((c) => [c, { ...base.override[c], ...(p.override?.[c] || {}) }]));
    return out;
  }

  /** One-time: give older photos a sha256 of their original file, so changed images can be detected later. */
  backfillPhotoHashes(p) {
    let changed = false;
    for (const ph of p.photos || []) {
      if (ph.sha256 || !ph.files?.original) continue;
      const f = path.join(this.dir(p.id), ph.files.original);
      if (!fs.existsSync(f)) continue;
      ph.sha256 = sha256(fs.readFileSync(f));
      changed = true;
    }
    return changed;
  }

  saveMeta() {
    writeJson(path.join(this.dataDir, 'meta.json'), this.meta);
  }

  get settings() {
    return this.meta.settings;
  }

  // ---------- 純正カメラ連携（iPhone のショートカットから写真を受け取る） ----------

  /** Which product photos from the native Camera app go to, and since when they count. */
  get nativeShoot() {
    return this.meta.nativeShoot || null;
  }

  setNativeShoot(actor, productId) {
    forbidAi(actor, '純正カメラの撮影対象の設定');
    const p = this.get(productId);
    // A few seconds of slack: the Camera app may already have been open when the button was tapped.
    this.meta.nativeShoot = { productId: p.id, since: new Date(Date.now() - 10_000).toISOString(), at: nowIso() };
    this.saveMeta();
    this.emit('change', { type: 'settings' });
    return this.meta.nativeShoot;
  }

  clearNativeShoot(actor) {
    forbidAi(actor, '純正カメラの撮影対象の解除');
    this.meta.nativeShoot = null;
    this.saveMeta();
    return null;
  }

  /** Key for the iPhone shortcut: it can only read the shoot target and send photos to it. */
  uploadKey({ rotate = false } = {}) {
    if (!this.meta.uploadKey || rotate) {
      this.meta.uploadKey = crypto.randomBytes(18).toString('base64url');
      this.saveMeta();
    }
    return this.meta.uploadKey;
  }

  updateSettings(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULT_SETTINGS)) throw new AppError(400, `不明な設定: ${k}`);
      this.meta.settings[k] = k === 'listViews' ? normalizeListViews(v)
        // 種類ごとの置き場: 文字だけ・短く（空は消す）
        : k === 'categoryPlaces' ? Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).map(([c, t]) => [String(c).slice(0, 40), String(t ?? '').trim().slice(0, 60)]).filter(([, t]) => t))
        : v;
    }
    this.saveMeta();
    this.emit('change', { type: 'settings' });
    return this.meta.settings;
  }

  dir(id) {
    return path.join(this.productsDir, id);
  }

  persist(p) {
    writeJson(path.join(this.dir(p.id), 'product.json'), p);
    writeFileAtomic(path.join(this.dir(p.id), 'listing.txt'), listingText(p));
  }

  // ---------- reads ----------

  list({ includeTrash = true } = {}) {
    return [...this.products.values()].filter((p) => includeTrash || !p.trashedAt).sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id) {
    const p = this.products.get(String(id));
    if (!p) throw new AppError(404, `商品 ${id} が見つかりません`, 'not_found');
    return p;
  }

  history(id, { limit = 200 } = {}) {
    this.get(id);
    const all = readJsonl(path.join(this.dir(id), 'history.jsonl'));
    return all.slice(-limit).reverse().map((h) => ({ ...h, revertible: fs.existsSync(path.join(this.dir(id), 'versions', `${h.id}.json`)) }));
  }

  activity({ limit = 200, since } = {}) {
    let all = readJsonl(path.join(this.dataDir, 'activity.jsonl'));
    if (since) all = all.filter((a) => a.at >= since);
    return all.slice(-limit).reverse();
  }

  duplicatesFor(cand, excludeId) {
    return findDuplicates(cand, this.list(), { excludeId });
  }

  // ---------- core mutation ----------

  /**
   * Run `fn` against a draft copy; on success persist, snapshot the previous state
   * (for undo) and append to history. Throwing inside `fn` leaves nothing changed.
   */
  mutate(id, actor, action, fn, { extraHistory } = {}) {
    const current = this.get(id);
    const draft = clone(current);
    const ctx = new Ctx();
    const result = fn(draft, ctx);
    if (!ctx.dirty) return result ?? draft;
    this._validateFnskuForProduct(draft);
    if (ctx.bumped) draft.rev += 1;
    this.reconcileStage(draft, ctx);
    draft.updatedAt = nowIso();
    const entry = {
      id: newId('h'),
      at: draft.updatedAt,
      actor,
      action,
      summary: ctx.summary(),
      changes: ctx.changes.filter((c) => !c.silent),
      ...(extraHistory || {}),
    };
    writeJson(path.join(this.dir(id), 'versions', `${entry.id}.json`), current);
    this.persist(draft);
    this.changedAt = draft.updatedAt;
    this.changeSeq = (this.changeSeq || 0) + 1;
    appendJsonl(path.join(this.dir(id), 'history.jsonl'), entry);
    appendJsonl(path.join(this.dataDir, 'activity.jsonl'), {
      at: entry.at, actor, productId: id, productName: draft.name, action, summary: entry.summary, historyId: entry.id,
    });
    this.products.set(id, draft);
    this._syncFnskuIndex(current, draft);
    this.pruneVersions(id);
    this.emit('change', { type: 'product', id, actor, action });
    return result ?? draft;
  }

  pruneVersions(id) {
    const dir = path.join(this.dir(id), 'versions');
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return;
    }
    if (files.length <= VERSIONS_KEPT) return;
    const byTime = files.map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t);
    for (const { f } of byTime.slice(0, byTime.length - VERSIONS_KEPT)) fs.rmSync(path.join(dir, f), { force: true });
  }

  /** Automatic workflow transitions. Only ever moves between "preparation" stages. */
  reconcileStage(p, ctx) {
    if (p.trashedAt || p.archived) return;
    const from = p.stage;
    let to = from;
    const hasPhotos = listablePhotos(p).length > 0;
    if (PREPARE_DECISIONS.includes(p.decision) && to === 'unsorted') to = hasPhotos ? 'shooting' : 'needs_photos';
    if (to === 'needs_photos' && hasPhotos && !p.shotDoneAt) to = 'shooting';
    const rd = readiness(p, this.settings);
    if (rd.ok && ['unsorted', 'needs_photos', 'shooting', 'ai_pending', 'needs_review'].includes(to)) to = 'ready';
    if (!rd.ok && ['ready', 'queued'].includes(to)) to = 'needs_review';
    if (to !== from) {
      p.stage = to;
      ctx.changes.push({ path: 'stage', label: 'ステータス', from: stageLabel(from), to: stageLabel(to), auto: true });
    }
  }

  // ---------- products ----------

  create(fields = {}, actor = 'user', { links = [], allowDuplicate = true } = {}) {
    const preFnsku = fields.fnsku !== undefined ? normalizeFnsku(fields.fnsku) : '';
    if (preFnsku && !FNSKU_RE.test(preFnsku)) {
      throw new AppError(400, `Amazon管理番号の形が違います: ${preFnsku}`, 'INVALID_FNSKU_FORMAT');
    }
    if (preFnsku) {
      const ownerId = this.fnskuIndex.get(preFnsku);
      if (ownerId) {
        const owner = this._ownerSummary(ownerId);
        const err = new AppError(409, `この FNSKU（${preFnsku}）は既に #${owner.id}「${owner.name}」に登録されています`, 'FNSKU_OWNED_BY_OTHER');
        err.owner = owner;
        err.fnskuOwner = owner;
        throw err;
      }
    }
    const dups = this.duplicatesFor({ ...fields, fnsku: preFnsku, links });
    if (dups.length && !allowDuplicate) {
      const e = new AppError(409, `重複の可能性: ${dups.map((d) => `#${d.id} ${d.name}（${d.reasons.join('・')}）`).join(' / ')}`, 'duplicate');
      e.duplicates = dups;
      throw e;
    }
    const id = pad4(this.meta.nextId++);
    this.saveMeta();
    const at = nowIso();
    const p = newProduct(id, at, this.settings);
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'decision') {
        if (!DECISION_IDS.includes(v)) throw new AppError(400, `decision が不正: ${v}`);
        if (isUser(actor)) p.decision = v;
      } else if (k === 'shootPlan') p.shootPlan = !!v;
      else {
        const def = FIELD_MAP[k];
        if (!def) throw new AppError(400, `不明な項目: ${k}`);
        try {
          const coerced = coerceField(def, v);
          setPath(p, k, k === 'fnsku' ? normalizeFnsku(coerced) : coerced);
        } catch (e) {
          throw new AppError(400, e.message);
        }
      }
    }
    this._validateFnskuForProduct(p);
    for (const l of links) p.links.push(makeLink(l, actor));
    fs.mkdirSync(path.join(this.dir(id), 'photos'), { recursive: true });
    this.products.set(id, p);
    this.persist(p);
    this._syncFnskuIndex(null, p);
    const entry = { id: newId('h'), at, actor, action: 'create', summary: `商品登録「${p.name || '名称未設定'}」`, changes: [] };
    appendJsonl(path.join(this.dir(id), 'history.jsonl'), entry);
    appendJsonl(path.join(this.dataDir, 'activity.jsonl'), { at, actor, productId: id, productName: p.name, action: 'create', summary: entry.summary, historyId: entry.id });
    this.emit('change', { type: 'product', id, actor, action: 'create' });
    return { product: p, duplicates: dups };
  }

  /**
   * Set fields by path. User writes confirm (lock) the field. AI writes to a locked
   * field are stored as proposals instead of overwriting the user's decision.
   */
  updateFields(id, actor, set, { reason, lock = true, append, expectedRev } = {}) {
    const curCheck = this.get(id);
    if (expectedRev !== undefined && expectedRev !== null && Number(expectedRev) !== curCheck.rev) {
      const err = new AppError(409, `別の場所で更新されています（現在 rev=${curCheck.rev}、想定 rev=${expectedRev}）`, 'REVISION_CONFLICT');
      err.currentRev = curCheck.rev;
      err.currentTitle = curCheck.listing?.title || '';
      err.currentDescription = curCheck.listing?.description || '';
      throw err;
    }
    const outcome = { set: [], proposed: [], unchanged: [] };
    this.mutate(id, actor, 'update', (p, ctx) => {
      const entries = [
        ...Object.entries(set || {}).map(([field, raw]) => [field, raw, false]),
        ...Object.entries(append || {}).map(([field, raw]) => [field, raw, true]),
      ];
      for (const [field, raw, isAppend] of entries) {
        const def = FIELD_MAP[field];
        if (!def) throw new AppError(400, `不明な項目: ${field}`);
        let value;
        try {
          value = coerceField(def, raw);
        } catch (e) {
          throw new AppError(400, e.message);
        }
        if (field === 'fnsku') value = normalizeFnsku(value);
        const old = getPath(p, field);
        if (isAppend) {
          const addition = String(value ?? '').trim();
          if (!addition) { outcome.unchanged.push(field); continue; }
          value = old ? `${old}\n${addition}` : addition;
        }
        // UTF-16 length guard for listing title (40) and description (1000)
        if (field === 'listing.title' && String(value ?? '').length > MERCARI_LIMITS.titleMax) {
          throw new AppError(400, `タイトルは${MERCARI_LIMITS.titleMax}文字以内にしてください（現在${String(value).length}文字）`, 'LENGTH_EXCEEDED');
        }
        if (field === 'listing.description' && String(value ?? '').length > MERCARI_LIMITS.descriptionMax) {
          throw new AppError(400, `商品説明は${MERCARI_LIMITS.descriptionMax}文字以内にしてください（現在${String(value).length}文字）`, 'LENGTH_EXCEEDED');
        }
        const humanProtected =
          !isUser(actor) &&
          ((field === 'listing.title' && p.listing?.titleSource === 'human_edited') ||
            (field === 'listing.description' && p.listing?.descriptionSource === 'human_edited'));
        if (isUser(actor)) {
          if (!same(old, value)) {
            setPath(p, field, value);
            if (field === 'listing.title') p.listing.titleSource = 'human_edited';
            if (field === 'listing.description') p.listing.descriptionSource = 'human_edited';
            ctx.change(field, old, value);
            // 日付・種類などの整理用の項目は出品内容ではないので、QC をやり直させない。
            if (!def.meta) ctx.bump();
            outcome.set.push(field);
          } else outcome.unchanged.push(field);
          if (lock && value !== '' && value != null && !p.locks[field]) {
            p.locks[field] = { by: actor, at: nowIso() };
            ctx.dirty = true;
          }
          if (p.proposals[field]) {
            delete p.proposals[field];
            ctx.dirty = true;
          }
        } else if (p.locks[field] || humanProtected || guardedOverride(p, def)) {
          if (same(old, value)) {
            outcome.unchanged.push(field);
            continue;
          }
          p.proposals[field] = { value, by: actor, at: nowIso(), reason: reason || '' };
          ctx.note(`${def.label} の変更を提案（${humanProtected ? '人間編集済み' : p.locks[field] ? 'ユーザー確定済み' : guardedOverride(p, def)}のため上書きせず）`);
          outcome.proposed.push(field);
        } else if (!same(old, value)) {
          setPath(p, field, value);
          if (field === 'listing.title' && p.listing.titleSource !== 'human_edited') p.listing.titleSource = 'ai_generated';
          if (field === 'listing.description' && p.listing.descriptionSource !== 'human_edited') p.listing.descriptionSource = 'ai_generated';
          ctx.change(field, old, value);
          if (!def.meta) ctx.bump();
          outcome.set.push(field);
        } else outcome.unchanged.push(field);
      }
    });
    return { ...outcome, product: this.get(id) };
  }

  confirmFields(id, actor, fields) {
    forbidAi(actor, '項目の確定');
    return this.mutate(id, actor, 'confirm', (p, ctx) => {
      for (const f of fields) {
        if (!FIELD_MAP[f]) throw new AppError(400, `不明な項目: ${f}`);
        const v = getPath(p, f);
        if (v == null || v === '') throw new AppError(400, `${FIELD_MAP[f].label}が空のため確定できません`);
        if (!p.locks[f]) {
          p.locks[f] = { by: actor, at: nowIso() };
          ctx.note(`${FIELD_MAP[f].label}を確定（${typeof v === 'number' ? yen(v) : truncate(String(v), 20)}）`);
        }
      }
    });
  }

  unlockFields(id, actor, fields) {
    forbidAi(actor, '確定の解除');
    return this.mutate(id, actor, 'unlock', (p, ctx) => {
      for (const f of fields) {
        if (p.locks[f]) {
          delete p.locks[f];
          ctx.note(`${FIELD_MAP[f]?.label || f}の確定を解除（AIが更新可能）`);
        }
      }
    });
  }

  resolveProposal(id, actor, field, accept) {
    forbidAi(actor, 'AI提案の採用／却下');
    const p = this.get(id);
    const prop = p.proposals[field];
    if (!prop) throw new AppError(404, '提案が見つかりません');
    if (field === 'listingPhotos') {
      return this.mutate(id, actor, accept ? 'accept_proposal' : 'reject_proposal', (d, ctx) => {
        delete d.proposals.listingPhotos;
        if (accept) this._applyListingPhotos(d, prop.value, ctx);
        ctx.note(`出品用写真の提案を${accept ? '採用' : '却下'}`);
      });
    }
    if (accept) {
      this.updateFields(id, actor, { [field]: prop.value });
      return this.get(id);
    }
    return this.mutate(id, actor, 'reject_proposal', (d, ctx) => {
      delete d.proposals[field];
      ctx.note(`${FIELD_MAP[field]?.label || field} のAI提案を却下`);
    });
  }

  setDecision(id, actor, decision) {
    forbidAi(actor, '出品／下書き／保留／出さない の判断');
    if (!DECISION_IDS.includes(decision)) throw new AppError(400, `decision が不正: ${decision}`);
    return this.mutate(id, actor, 'decision', (p, ctx) => {
      if (p.decision === decision) return;
      ctx.changes.push({ path: 'decision', label: '出品判断', from: decisionLabel(p.decision), to: decisionLabel(decision) });
      ctx.dirty = true;
      p.decision = decision;
    });
  }

  setStage(id, actor, stage, { note } = {}) {
    if (!STAGE_IDS.includes(stage)) throw new AppError(400, `stage が不正: ${stage}（候補: ${STAGE_IDS.join(', ')}）`);
    const cur = this.get(id);
    if (!isUser(actor) && USER_ONLY_STAGES.has(stage)) {
      const approved = cur.channels.mercari?.publishApproved;
      if (!(stage === 'listed' && approved)) throw new AppError(403, `「${stageLabel(stage)}」への変更はユーザーのみ可能です`, 'forbidden');
    }
    return this.mutate(id, actor, 'stage', (p, ctx) => {
      if (p.stage === stage) return;
      ctx.changes.push({ path: 'stage', label: 'ステータス', from: stageLabel(p.stage), to: stageLabel(stage) });
      ctx.dirty = true;
      p.stage = stage;
      if (note) ctx.note(note);
    });
  }

  setArchived(id, actor, archived) {
    forbidAi(actor, 'アーカイブ');
    return this.mutate(id, actor, 'archive', (p, ctx) => {
      if (p.archived === !!archived) return;
      p.archived = !!archived;
      ctx.note(archived ? 'アーカイブ' : 'アーカイブから戻す');
    });
  }

  setShootPlan(id, actor, on) {
    return this.mutate(id, actor, 'shoot_plan', (p, ctx) => {
      if (p.shootPlan === !!on) return;
      p.shootPlan = !!on;
      ctx.note(on ? '撮影予定に追加' : '撮影予定から外す');
    });
  }

  /** 開封チェック済み: the user opened the package and checked the contents. Only the user can know, so only the user sets it. */
  setOpenChecked(id, actor, on) {
    forbidAi(actor, '開封チェック');
    return this.mutate(id, actor, 'open_check', (p, ctx) => {
      if (!!p.openCheckedAt === !!on) return;
      p.openCheckedAt = on ? nowIso() : null;
      ctx.note(on ? '開封チェック済みにした' : '開封チェックを外した');
    });
  }

  /** 別枠: the user moves a product out of the normal list (still kept and processed; shown under 「別枠」). */
  setAside(id, actor, on) {
    forbidAi(actor, '別枠への移動');
    return this.mutate(id, actor, 'aside', (p, ctx) => {
      if (!!p.asideAt === !!on) return;
      p.asideAt = on ? nowIso() : null;
      ctx.note(on ? '別枠に移した' : '別枠から一覧に戻した');
    });
  }

  /** Which 観察ブラウザ lists the product is in (written by the Mac sync). Organising data only: no QC redo. */
  setBrowserInfo(id, actor, info) {
    const next = info ? normalizeBrowserInfo(info) : null;
    return this.mutate(id, actor, 'browser', (p, ctx) => {
      if (next ? sameBrowserInfo(p.browser, next) : !p.browser) return;
      p.browser = next;
      ctx.note(next ? `観察ブラウザの一覧: ${Object.keys(next.lists).length ? Object.keys(next.lists).join('・') : 'なし'}` : '観察ブラウザの情報を外した');
    });
  }

  /** 日付ID（server/dateid.js が注文の一覧から決める）。整理用なので QC はやり直しにならない。 */
  setDateId(id, actor, dateId, productCode = '') {
    const v = String(dateId || '');
    const c = String(productCode || '');
    if (v && !/^\d{7}[1-9?]$/.test(v)) throw new AppError(400, `日付IDの形が違います: ${v}`);
    if (c && !decodeDateId(c).length) throw new AppError(400, `商品IDの形が違います: ${c}`);
    return this.mutate(id, actor, 'date_id', (p, ctx) => {
      if ((p.dateId || '') !== v) { ctx.note(p.dateId ? `日付ID ${p.dateId} → ${v || 'なし'}` : `日付ID ${v}`); p.dateId = v; }
      if ((p.productCode || '') !== c) { ctx.note(p.productCode ? `商品ID ${p.productCode} → ${c || 'なし'}` : `商品ID ${c}`); p.productCode = c; }
    });
  }

  /** 現在の最新在庫チェック: 今手元にあることを確かめた日時（ユーザーのみ）。 */
  setStockChecked(id, actor, on) {
    forbidAi(actor, '最新在庫チェック');
    return this.mutate(id, actor, 'stock_check', (p, ctx) => {
      if (!!p.stockCheckedAt === !!on && (!on || !p.stockUnknownAt)) return;
      p.stockCheckedAt = on ? nowIso() : null;
      if (on) p.stockUnknownAt = null;
      ctx.note(on ? '最新在庫チェック済みにした' : '最新在庫チェックを外した');
    });
  }

  /**
   * あるかないか（ユーザーのみ）を1回で: have=手元にある（最新在庫チェック）・gone=ない（出品判断「在庫なし」）・
   * unknown=わからない・null=未確認に戻す。今までの3つの印（stockCheckedAt / decision no_stock / stockUnknownAt）をそろえて書く。
   */
  setPresence(id, actor, state) {
    forbidAi(actor, 'あるかないかのチェック');
    if (![null, 'have', 'gone', 'unknown'].includes(state)) throw new AppError(400, `state が不正: ${state}`);
    return this.mutate(id, actor, 'presence', (p, ctx) => {
      const before = { c: p.stockCheckedAt, u: p.stockUnknownAt, d: p.decision };
      const now = nowIso();
      p.stockCheckedAt = state === 'have' ? (p.stockCheckedAt || now) : null;
      p.stockUnknownAt = state === 'unknown' ? (p.stockUnknownAt || now) : null;
      if (state === 'gone' && p.decision !== 'no_stock') p.decision = 'no_stock';
      if (state !== 'gone' && p.decision === 'no_stock') p.decision = 'undecided';
      if (state === 'have') p.stockCheckedAt = now; // re-tapping ある refreshes the date it was last seen
      if (before.c === p.stockCheckedAt && before.u === p.stockUnknownAt && before.d === p.decision) return;
      if (before.d !== p.decision) ctx.changes.push({ path: 'decision', label: '出品判断', from: decisionLabel(before.d), to: decisionLabel(p.decision) });
      const word = { have: 'ある', gone: 'ない', unknown: 'わからない' }[state];
      ctx.note(word ? `あるかないか: ${word}` : 'あるかないかを未確認に戻した');
      ctx.dirty = true;
    });
  }

  /**
   * 台帳スキャン（iPhone のラベル読み取り・その記録の取り込み）: 利用者が現物を手に取って確かめた記録を写す。
   * ある と同じ印（stockCheckedAt・stockUnknownAt を外す・在庫なし→未定）を、読んだ時刻 scannedAt で付ける。
   * setPresence は呼ばないが、ある の印を付けるのは同じくユーザーだけ。presence:false なら在庫の印は変えずに記録だけ（昔の写真・AI の取り込み）。
   * FNSKU は空なら入れ、別の番号が入っていれば上書きせず conflict で返す。前の値は scanEvents に残し、undoScan で戻せる。
   */
  recordScan(id, actor, { fnsku = '', scannedAt, presence = true, via = 'scan', operationId = '', strictFnsku = false } = {}) {
    const code = normalizeFnsku(fnsku);
    if (code && !FNSKU_RE.test(code)) throw new AppError(400, `Amazon管理番号の形が違います: ${code}`, 'INVALID_FNSKU_FORMAT');
    const t = Date.parse(scannedAt);
    if (Number.isNaN(t)) throw new AppError(400, `scannedAt が日時ではありません: ${scannedAt}`);
    const at = new Date(t).toISOString();
    // ある の印はユーザーだけ（setPresence と同じ境界）。AI が取り込む記録は FNSKU・lastScanAt・履歴だけ。
    if (presence) forbidAi(actor, 'スキャンでの在庫確認（ある）');
    const opHit = this._checkOperationId(operationId, id);
    if (opHit) return { product: this.get(id), idempotent: true, ...(opHit.meta?.conflict ? { conflict: opHit.meta.conflict } : {}) };

    const cur = this.get(id);
    if (code) {
      const ownerId = this.fnskuIndex.get(code);
      if (ownerId && ownerId !== cur.id && (strictFnsku || !cur.fnsku)) {
        const owner = this._ownerSummary(ownerId);
        const err = new AppError(409, `この FNSKU（${code}）は既に #${owner.id}「${owner.name}」に登録されています`, 'FNSKU_OWNED_BY_OTHER');
        err.owner = owner;
        err.fnskuOwner = owner;
        throw err;
      }
      if (strictFnsku && cur.fnsku && normalizeFnsku(cur.fnsku) !== code) {
        const err = new AppError(409, `対象商品 #${cur.id} には別の管理番号 ${cur.fnsku} が登録されています（読んだ番号 ${code}）`, 'PRODUCT_HAS_DIFFERENT_FNSKU');
        err.productId = cur.id;
        err.currentFnsku = cur.fnsku;
        err.scannedFnsku = code;
        throw err;
      }
    }

    let conflict = '';
    const product = this.mutate(id, actor, 'scan', (p, ctx) => {
      const snap = () => ({ fnsku: p.fnsku || '', fnskuLock: p.locks?.fnsku || null, stockCheckedAt: p.stockCheckedAt || null, stockUnknownAt: p.stockUnknownAt || null, decision: p.decision, lastScanAt: p.lastScanAt || null });
      const before = snap();
      if (code && p.fnsku && normalizeFnsku(p.fnsku) !== code) conflict = `この商品には別の管理番号 ${p.fnsku} が入っています（読んだ番号 ${code}）`;
      else if (code && !p.fnsku) {
        if (p.locks?.fnsku && !isUser(actor)) conflict = `管理番号はユーザー確定済みのため入れませんでした（読んだ番号 ${code}）`;
        else {
          p.fnsku = code;
          ctx.change('fnsku', '', code);
          if (isUser(actor) && !p.locks.fnsku) p.locks.fnsku = { by: actor, at: nowIso() }; // the old confirm route locked it too
        }
      }
      if (presence) {
        // A record imported late must not move the last-seen date backwards.
        if (!p.stockCheckedAt || p.stockCheckedAt < at) p.stockCheckedAt = at;
        p.stockUnknownAt = null;
        if (p.decision === 'no_stock') {
          p.decision = 'undecided';
          ctx.changes.push({ path: 'decision', label: '出品判断', from: decisionLabel('no_stock'), to: decisionLabel('undecided') });
        }
      }
      if (!p.lastScanAt || p.lastScanAt < at) p.lastScanAt = at;
      const event = {
        id: newId('s'),
        at: nowIso(),
        scannedAt: at,
        actor,
        via,
        fnsku: code,
        presence: !!presence,
        ...(operationId ? { operationId: String(operationId).trim() } : {}),
        before,
        after: snap(),
        undoneAt: null,
        undoneBy: null,
        invalidatedAt: null,
        invalidationReason: null,
      };
      p.scanEvents = [...(p.scanEvents || []), event].slice(-SCAN_EVENTS_KEPT);
      ctx.note(presence ? 'スキャンで在庫確認' : 'スキャンを記録（在庫の印は変えない）');
    });
    this._recordOperationId(operationId, id, 'scan', { conflict });
    return { product, ...(conflict ? { conflict } : {}) };
  }

  /**
   * FNSKU の専用訂正操作（付け替えではなく訂正履歴を history.jsonl と fnskuCorrections に残す）。
   * 過去のスキャン記録（scanEvents）は書き換えない。他商品と競合する番号への訂正は拒否。
   */
  correctFnsku(id, actor, { newFnsku = '', reason = '', operationId = '' } = {}) {
    forbidAi(actor, 'FNSKU の訂正');
    const opHit = this._checkOperationId(operationId, id);
    if (opHit) return { product: this.get(id), idempotent: true, correction: opHit.meta?.correction || null };
    const next = normalizeFnsku(newFnsku);
    if (next && !FNSKU_RE.test(next)) {
      throw new AppError(400, `Amazon管理番号の形が違います: ${next}`, 'INVALID_FNSKU_FORMAT');
    }
    const cur = this.get(id);
    if (next) {
      const ownerId = this.fnskuIndex.get(next);
      if (ownerId && ownerId !== cur.id) {
        const owner = this._ownerSummary(ownerId);
        const err = new AppError(409, `この FNSKU（${next}）は既に #${owner.id}「${owner.name}」に登録されています`, 'FNSKU_OWNED_BY_OTHER');
        err.owner = owner;
        err.fnskuOwner = owner;
        throw err;
      }
    }
    const oldFnsku = normalizeFnsku(cur.fnsku);
    const cleanReason = String(reason || '').trim();
    const opId = String(operationId || '').trim() || null;
    const correction = { id: newId('fc'), at: nowIso(), actor, oldFnsku, newFnsku: next, reason: cleanReason, operationId: opId };
    const product = this.mutate(id, actor, 'fnsku_correct', (p, ctx) => {
      p.fnsku = next;
      p.locks.fnsku = { by: actor, at: correction.at };
      p.fnskuCorrections = [...(p.fnskuCorrections || []), correction];
      ctx.change('fnsku', oldFnsku, next);
      ctx.note(`FNSKU訂正: ${oldFnsku || '（空）'} → ${next || '（空）'}${cleanReason ? `（理由: ${cleanReason}）` : ''}`);
    }, { extraHistory: { oldFnsku, newFnsku: next, reason: cleanReason, operationId: opId } });
    this._recordOperationId(operationId, id, 'fnsku_correct', { correction });
    return { product, correction };
  }

  /**
   * 誤って記録された scanEvent を物理削除せず無効化マークを付け、有効な記録から在庫確認状態を再計算する。
   */
  invalidateScanEvent(id, actor, eventId, reason = '') {
    forbidAi(actor, 'スキャン記録の無効化');
    const cleanReason = String(reason || '').trim() || '誤スキャン無効化';
    let target = null;
    const product = this.mutate(id, actor, 'scan_invalidate', (p, ctx) => {
      const ev = (p.scanEvents || []).find((e) => e.id === eventId);
      if (!ev) throw new AppError(404, `スキャン記録 ${eventId} が見つかりません`, 'not_found');
      if (!ev.invalidatedAt) {
        ev.invalidatedAt = nowIso();
        ev.invalidationReason = cleanReason;
        ev.invalidatedBy = actor;
        target = { ...ev };
        const valid = (p.scanEvents || []).filter((e) => !e.undoneAt && !e.invalidatedAt);
        p.lastScanAt = valid.map((e) => e.scannedAt).sort().at(-1) || null;
        const validPresenceAt = valid.filter((e) => e.presence !== false).map((e) => e.scannedAt).sort().at(-1) || null;
        if (validPresenceAt) {
          p.stockCheckedAt = validPresenceAt;
        } else if (ev.presence !== false && p.stockCheckedAt === ev.scannedAt) {
          p.stockCheckedAt = null;
        }
        ctx.note(`スキャン記録を無効化（${ev.id} / ${ev.fnsku || '番号なし'} / ${cleanReason}）`);
      } else {
        target = { ...ev };
      }
    });
    return { product, event: target };
  }

  /**
   * 読み取り専用の FNSKU 整合性チェック:
   * 1. anomalies（確実な異常）: 複数商品への重複FNSKU / 訂正履歴なしの scanEvents FNSKU 食い違い
   * 2. explainable（説明可能な差異）: 正式な訂正履歴または無効化マークにより説明がつく差異
   * 3. indeterminate（判定不能）: 番号未記録の古いスキャンイベント等
   */
  auditFnskuIntegrity() {
    const live = this.list({ includeTrash: false });
    const byFnsku = new Map();
    for (const p of live) {
      const code = normalizeFnsku(p.fnsku);
      if (!code) continue;
      if (!byFnsku.has(code)) byFnsku.set(code, []);
      byFnsku.get(code).push({ id: p.id, name: p.name || '' });
    }
    const anomalies = [];
    const explainable = [];
    const indeterminate = [];
    let duplicateFnskuCount = 0;

    for (const [fnsku, owners] of byFnsku.entries()) {
      if (owners.length > 1) {
        duplicateFnskuCount += 1;
        anomalies.push({ type: 'duplicate_fnsku', fnsku, products: owners });
      }
    }

    for (const p of live) {
      const cur = normalizeFnsku(p.fnsku);
      const correctedOlds = new Set((p.fnskuCorrections || []).map((c) => normalizeFnsku(c.oldFnsku)).filter(Boolean));
      for (const ev of p.scanEvents || []) {
        const evCode = normalizeFnsku(ev.fnsku);
        if (ev.invalidatedAt) {
          explainable.push({
            type: 'invalidated_scan_event',
            productId: p.id,
            productName: p.name || '',
            eventId: ev.id,
            scannedAt: ev.scannedAt,
            eventFnsku: evCode,
            currentFnsku: cur,
            invalidatedAt: ev.invalidatedAt,
            invalidationReason: ev.invalidationReason || '',
          });
          continue;
        }
        if (!evCode) {
          indeterminate.push({
            type: 'scan_without_fnsku',
            productId: p.id,
            productName: p.name || '',
            eventId: ev.id,
            scannedAt: ev.scannedAt,
            currentFnsku: cur,
          });
          continue;
        }
        if (cur && evCode !== cur) {
          if (correctedOlds.has(evCode)) {
            explainable.push({
              type: 'explained_by_correction',
              productId: p.id,
              productName: p.name || '',
              eventId: ev.id,
              scannedAt: ev.scannedAt,
              eventFnsku: evCode,
              currentFnsku: cur,
            });
          } else {
            const ownerId = this.fnskuIndex.get(evCode) || null;
            anomalies.push({
              type: 'scan_fnsku_mismatch',
              productId: p.id,
              productName: p.name || '',
              eventId: ev.id,
              scannedAt: ev.scannedAt,
              eventFnsku: evCode,
              currentFnsku: cur,
              undoneAt: ev.undoneAt || null,
              fnskuOwnerId: ownerId,
            });
          }
        }
      }
    }

    return {
      summary: {
        duplicateFnskuCount,
        anomalyCount: anomalies.length,
        explainableCount: explainable.length,
        indeterminateCount: indeterminate.length,
      },
      anomalies,
      explainable,
      indeterminate,
    };
  }

  /**
   * 一番新しいスキャンを取り消す: そのスキャンが変えた項目を前の値へ戻す（後から別の操作で変わった項目はそのまま、kept で返す）。
   * 記録は消さず undoneAt・undoneBy を付ける。ユーザーはどのスキャンも、AI は自分が記録したスキャンだけ取り消せる。
   */
  undoScan(id, actor) {
    const ev = [...(this.get(id).scanEvents || [])].reverse().find((e) => !e.undoneAt);
    if (!ev) throw new AppError(404, '取り消せるスキャンがありません', 'no_scan');
    if (!isUser(actor) && ev.actor !== actor) throw new AppError(403, 'ほかの人が記録したスキャンの取り消しはユーザーのみ実行できます（AIの権限外）', 'forbidden');
    const kept = [];
    const product = this.mutate(id, actor, 'scan-undo', (p, ctx) => {
      const b = ev.before;
      const a = ev.after;
      const back = (field, cur, set) => {
        if (same(a[field], b[field])) return;
        if (!same(cur, a[field])) { kept.push(field); return; } // changed again after the scan: leave the newer value
        set(b[field]);
      };
      back('fnsku', p.fnsku || '', (v) => { ctx.change('fnsku', p.fnsku, v); p.fnsku = v; });
      back('fnskuLock', p.locks?.fnsku || null, (v) => { if (v) p.locks.fnsku = v; else delete p.locks.fnsku; });
      back('stockCheckedAt', p.stockCheckedAt || null, (v) => { p.stockCheckedAt = v; });
      back('stockUnknownAt', p.stockUnknownAt || null, (v) => { p.stockUnknownAt = v; });
      back('decision', p.decision, (v) => { ctx.changes.push({ path: 'decision', label: '出品判断', from: decisionLabel(p.decision), to: decisionLabel(v) }); p.decision = v; });
      p.scanEvents = (p.scanEvents || []).map((e) => (e.id === ev.id ? { ...e, undoneAt: nowIso(), undoneBy: actor } : e));
      p.lastScanAt = p.scanEvents.filter((e) => !e.undoneAt).map((e) => e.scannedAt).sort().at(-1) || null;
      ctx.note(`スキャン取り消し（${fmtStamp(ev.scannedAt)} のスキャン）`);
    });
    return { product, undone: ev.id, kept };
  }

  /**
   * レビュー・発信の予定。ユーザーは全部決められる。AI（投稿エージェント等）は 下書き（draft・status drafted）と、
   * ユーザーが「投稿OK」にしたものの投稿済み報告（status posted・url）だけ。
   */
  setReviewPlan(id, actor, patch = {}) {
    const ST = REVIEW_STATUSES.map((s) => s.id);
    const FM = REVIEW_FORMATS.map((f) => f.id);
    if (patch.status !== undefined && !ST.includes(patch.status)) throw new AppError(400, `status が不正: ${patch.status}`);
    if (patch.formats !== undefined && (!Array.isArray(patch.formats) || patch.formats.some((f) => !FM.includes(f)))) throw new AppError(400, `formats が不正（${FM.join('/')}）`);
    if (patch.url !== undefined && patch.url !== '' && !/^https?:\/\/[^\s]+$/i.test(String(patch.url))) throw new AppError(400, '投稿先の URL は http:// か https:// で始まるものだけです');
    const cur = this.get(id).reviewPlan || {};
    if (!isUser(actor)) {
      const allowed = ['draft', 'status', 'url'];
      const extra = Object.keys(patch).filter((k) => !allowed.includes(k));
      if (extra.length) throw new AppError(403, `AI が変えられるのは下書き・投稿済みの報告だけです（${extra.join(', ')}）`, 'forbidden');
      if (patch.status !== undefined && !['drafted', 'posted'].includes(patch.status)) throw new AppError(403, 'その状態はユーザーだけが決められます', 'forbidden');
      // 下書きは「する」「下書きあり」のあいだだけ（ユーザーが投稿OKにした下書きは AI が書き換えられない）。
      if ((patch.draft !== undefined || patch.status === 'drafted') && !['todo', 'drafted'].includes(cur.status)) throw new AppError(409, '下書きを付けられるのは「する」「下書きあり」の商品だけです', 'not_requested');
      // 投稿先 URL は「投稿OK」の商品の投稿済み報告と一緒にだけ。
      if (patch.status === 'posted' && cur.status !== 'approved') throw new AppError(403, '投稿済みにできるのは、ユーザーが「投稿OK」にした商品だけです', 'not_approved');
      if (patch.url !== undefined && patch.status !== 'posted') throw new AppError(403, '投稿先 URL は投稿済みの報告と一緒にだけ送れます', 'forbidden');
      if (patch.status === 'posted' && patch.draft !== undefined) throw new AppError(403, '投稿済みの報告で下書きは変えられません', 'forbidden');
    }
    return this.mutate(id, actor, 'review_plan', (p, ctx) => {
      const next = { status: '', formats: [], note: '', draft: '', url: '', ...(p.reviewPlan || {}) };
      for (const k of ['status', 'formats', 'note', 'draft', 'url']) if (patch[k] !== undefined) next[k] = k === 'formats' ? [...new Set(patch[k])] : String(patch[k] ?? '').slice(0, k === 'draft' ? 20000 : 2000);
      if (!isUser(actor) && patch.draft !== undefined && patch.status === undefined) next.status = 'drafted';
      if (same(next, { status: '', formats: [], note: '', draft: '', url: '', ...(p.reviewPlan || {}) })) return;
      next.updatedAt = nowIso();
      next.by = actor;
      const label = (s) => REVIEW_STATUSES.find((x) => x.id === s)?.label || '未定';
      if ((p.reviewPlan?.status || '') !== next.status) ctx.changes.push({ path: 'reviewPlan.status', label: 'レビュー', from: label(p.reviewPlan?.status || ''), to: label(next.status) });
      ctx.note(`レビュー・発信の予定を更新（${label(next.status)}${next.formats.length ? `・${next.formats.map((f) => REVIEW_FORMATS.find((x) => x.id === f)?.label).join('/')}` : ''}）`);
      p.reviewPlan = next;
      ctx.dirty = true;
    });
  }

  /** 在庫状況「不明」: 手元にあるかすぐ分からない日時（ユーザーのみ）。 */
  setStockUnknown(id, actor, on) {
    forbidAi(actor, '在庫不明チェック');
    return this.mutate(id, actor, 'stock_unknown', (p, ctx) => {
      if (!!p.stockUnknownAt === !!on && (!on || !p.stockCheckedAt)) return;
      p.stockUnknownAt = on ? nowIso() : null;
      if (on) p.stockCheckedAt = null;
      ctx.note(on ? '在庫状況を「不明」にした' : '在庫状況「不明」を外した');
    });
  }

  trash(id, actor) {
    forbidAi(actor, '削除（ゴミ箱へ移動）');
    return this.mutate(id, actor, 'trash', (p, ctx) => {
      if (p.trashedAt) return;
      p.trashedAt = nowIso();
      ctx.note('ゴミ箱へ移動');
    });
  }

  restore(id, actor) {
    forbidAi(actor, 'ゴミ箱からの復元');
    return this.mutate(id, actor, 'restore', (p, ctx) => {
      if (!p.trashedAt) return;
      p.trashedAt = null;
      ctx.note('ゴミ箱から復元');
    });
  }

  /** Permanent deletion: only from the trash, and only with the id typed back as confirmation. */
  purge(id, actor, confirmId) {
    forbidAi(actor, '完全削除');
    const p = this.get(id);
    if (!p.trashedAt) throw new AppError(400, '完全削除はゴミ箱内の商品のみ可能です');
    if (String(confirmId) !== p.id) throw new AppError(400, '確認のため商品IDを入力してください');
    fs.rmSync(this.dir(id), { recursive: true, force: true });
    this.products.delete(id);
    this._syncFnskuIndex(p, null);
    for (const ph of p.photos || []) {
      const cpid = ph.clientPhotoId || ph.clientId;
      if (cpid && this.clientPhotoIndex.get(cpid)?.productId === id) this.clientPhotoIndex.delete(cpid);
    }
    appendJsonl(path.join(this.dataDir, 'activity.jsonl'), { at: nowIso(), actor, productId: id, productName: p.name, action: 'purge', summary: '完全削除' });
    this.emit('change', { type: 'product', id, actor, action: 'purge' });
  }

  // ---------- links ----------

  addLink(id, actor, link) {
    return this.mutate(id, actor, 'link_add', (p, ctx) => {
      const l = makeLink(link, actor);
      if (p.links.some((x) => x.url === l.url)) return;
      p.links.push(l);
      ctx.note(`URL追加: ${l.title || l.url}`);
      return l;
    });
  }

  updateLink(id, actor, linkId, patch) {
    return this.mutate(id, actor, 'link_update', (p, ctx) => {
      const l = p.links.find((x) => x.id === linkId);
      if (!l) throw new AppError(404, 'リンクが見つかりません');
      for (const k of ['url', 'type', 'title', 'note']) {
        if (patch[k] !== undefined && patch[k] !== l[k]) {
          if (k === 'type' && !LINK_TYPES.some((t) => t.id === patch[k])) throw new AppError(400, `リンク種別が不正: ${patch[k]}`);
          l[k] = patch[k];
          ctx.dirty = true;
        }
      }
      if (ctx.dirty) ctx.note(`URL更新: ${l.title || l.url}`);
    });
  }

  removeLink(id, actor, linkId) {
    return this.mutate(id, actor, 'link_remove', (p, ctx) => {
      const l = p.links.find((x) => x.id === linkId);
      if (!l) return;
      if (!isUser(actor) && l.by === 'user') throw new AppError(403, 'ユーザーが登録したURLはAIからは削除できません', 'forbidden');
      p.links = p.links.filter((x) => x.id !== linkId);
      ctx.note(`URL削除: ${l.title || l.url}`);
    });
  }

  // ---------- photos ----------

  /**
   * files: { original: {buffer, mime}, work?: {buffer}, thumb?: {buffer} }.
   * `clientId` makes retried uploads idempotent (the iPhone queue may resend).
   */
  addPhoto(id, actor, meta, files) {
    const isScanScene = meta.source === 'scan';
    const kind = isScanScene ? 'reference' : (meta.kind || 'actual');
    if (!PHOTO_KIND_IDS.includes(kind)) throw new AppError(400, `kind が不正: ${kind}`);
    if (!files?.original?.buffer?.length) throw new AppError(400, '画像データがありません');
    const cpid = String(meta.clientPhotoId || meta.clientId || '').trim() || null;
    if (cpid) {
      const hit = this.clientPhotoIndex.get(cpid);
      if (hit && hit.productId !== String(id)) {
        const err = new AppError(409, `clientPhotoId ${cpid} は別商品 #${hit.productId} で既に使用されています`, 'CLIENT_PHOTO_ID_CONFLICT');
        err.productId = hit.productId;
        throw err;
      }
      const existing = this.get(id).photos.find((ph) => (ph.clientPhotoId || ph.clientId) === cpid);
      if (existing) return { photo: existing, duplicate: true };
    }
    if (kind === 'actual' && meta.derivedFrom) {
      const src = this.get(id).photos.find((ph) => ph.id === meta.derivedFrom);
      if (!src) throw new AppError(400, '編集元の写真が見つかりません');
      if (src.kind !== 'actual') throw new AppError(400, '参考資料画像から出品用（現物）写真は作れません');
    }

    const pid = newId('ph');
    const photosDir = path.join(this.dir(id), 'photos');
    fs.mkdirSync(photosDir, { recursive: true });
    const ext = MIME_EXT[files.original.mime] || sniffExt(files.original.buffer) || 'jpg';
    const record = {
      id: pid,
      kind,
      source: meta.source || (kind === 'actual' ? 'camera' : kind),
      tag: meta.tag && PHOTO_TAGS.includes(meta.tag) ? meta.tag : meta.tag || (isScanScene ? 'スキャン場面' : ''),
      note: meta.note || '',
      sourceUrl: meta.sourceUrl || '',
      derivedFrom: meta.derivedFrom || null,
      edit: meta.edit || null,
      width: Number(meta.width) || null,
      height: Number(meta.height) || null,
      clientId: cpid,
      clientPhotoId: cpid,
      sha256: sha256(files.original.buffer),
      takenAt: photoTakenAt(files.original.buffer, meta.takenAt),
      createdAt: nowIso(),
      by: actor,
      deletedAt: null,
      files: {},
    };
    const write = (variant, buf, e) => {
      const name = `${pid}.${variant}.${e}`;
      fs.writeFileSync(path.join(photosDir, name), buf);
      record.files[variant] = `photos/${name}`;
    };
    write('original', files.original.buffer, ext);
    if (files.work?.buffer?.length) write('work', files.work.buffer, 'jpg');
    else record.files.work = record.files.original;
    if (files.thumb?.buffer?.length) write('thumb', files.thumb.buffer, 'jpg');
    else record.files.thumb = record.files.work;

    // manual_camera / manual_library photos default to NOT adopted (isAdopted = false).
    const isManualSource = ['manual_camera', 'manual_library'].includes(record.source);
    const shouldAutoSelect = meta.autoSelect !== undefined ? meta.autoSelect === true || meta.autoSelect === 'true' : !isManualSource;

    let replaced = [];
    this.mutate(id, actor, 'photo_add', (p, ctx) => {
      // 読み取り場面の画像は1商品につき1つだけ（新しいスキャンで差し替える）。
      if (isScanScene) {
        replaced = p.photos.filter((x) => x.source === 'scan');
        if (replaced.length) {
          const oldIds = new Set(replaced.map((x) => x.id));
          p.photos = p.photos.filter((x) => x.source !== 'scan');
          p.listingPhotoIds = p.listingPhotoIds.filter((lid) => !oldIds.has(lid));
        }
      }
      p.photos.push(record);
      const kindLabel = isScanScene ? 'スキャン場面画像' : kind === 'actual' ? (record.derivedFrom ? '編集写真' : '現物写真') : kind === 'generated' ? '生成画像' : '参考画像';
      ctx.note(`${kindLabel}${replaced.length ? 'を更新' : '追加'}${!isScanScene && record.tag ? `（${record.tag}）` : ''}`);
      if (kind === 'actual') {
        p.lastPhotoAt = record.createdAt;
        ctx.bump();
        const req = p.photoRequests.find((r) => !r.doneAt && !r.cancelledAt && (r.id === meta.requestId || (record.tag && r.label === record.tag)));
        if (req) {
          req.doneAt = record.createdAt;
          req.photoId = pid;
          ctx.note(`追加撮影「${req.label}」完了`);
        }
        if (record.derivedFrom && meta.replaceInListing) {
          // Takes the place of the photo it was made from (or of an older finished version, `replacePhotoId`).
          const i = [meta.replacePhotoId, record.derivedFrom].map((x) => (x ? p.listingPhotoIds.indexOf(x) : -1)).find((x) => x >= 0) ?? -1;
          if (i >= 0) p.listingPhotoIds[i] = pid;
        } else if (
          shouldAutoSelect &&
          this.settings.autoSelectListingPhotos &&
          !record.derivedFrom &&
          !p.locks.listingPhotos &&
          p.listingPhotoIds.length < MERCARI_LIMITS.photosMax
        ) {
          p.listingPhotoIds.push(pid);
        }
      }
    });
    if (cpid) this.clientPhotoIndex.set(cpid, { productId: String(id), photoId: pid });
    for (const old of replaced) {
      const oldCpid = old.clientPhotoId || old.clientId;
      if (oldCpid && oldCpid !== cpid && this.clientPhotoIndex.get(oldCpid)?.photoId === old.id) this.clientPhotoIndex.delete(oldCpid);
      for (const rel of new Set(Object.values(old.files || {}))) {
        if (rel) fs.rmSync(path.join(this.dir(id), rel), { force: true });
      }
    }
    return { photo: record, duplicate: false };
  }

  updatePhoto(id, actor, photoId, patch) {
    return this.mutate(id, actor, 'photo_update', (p, ctx) => {
      const ph = p.photos.find((x) => x.id === photoId);
      if (!ph) throw new AppError(404, '写真が見つかりません');
      if (patch.tag !== undefined && patch.tag !== ph.tag) {
        ph.tag = patch.tag;
        ctx.note(`写真タグ: ${patch.tag || '（なし）'}`);
        ctx.bump();
      }
      if (patch.note !== undefined && patch.note !== ph.note) {
        ph.note = patch.note;
        ctx.note('写真メモ更新');
      }
      if (patch.kind !== undefined && patch.kind !== ph.kind) {
        if (!PHOTO_KIND_IDS.includes(patch.kind)) throw new AppError(400, `kind が不正: ${patch.kind}`);
        if (patch.kind === 'actual') forbidAi(actor, '現物写真への変更（自分で撮った写真かはユーザーにしか分からない）');
        ph.kind = patch.kind;
        if (!isListablePhoto(ph)) p.listingPhotoIds = p.listingPhotoIds.filter((x) => x !== ph.id);
        ctx.note(`写真の種別を「${PHOTO_KINDS.find((k) => k.id === ph.kind).label}」に変更`);
        ctx.bump();
      }
      if (patch.adopted !== undefined) {
        const want = !!patch.adopted;
        const has = p.listingPhotoIds.includes(ph.id);
        if (want && !has) {
          if (!isListablePhoto(ph)) throw new AppError(400, `写真 ${ph.id} は出品用候補の対象外です`);
          if (p.listingPhotoIds.length >= MERCARI_LIMITS.photosMax) throw new AppError(400, `出品用写真は${MERCARI_LIMITS.photosMax}枚までです`);
          p.listingPhotoIds.push(ph.id);
          ctx.note(`写真を出品用に採用（${ph.id}）`);
          ctx.bump();
        } else if (!want && has) {
          p.listingPhotoIds = p.listingPhotoIds.filter((x) => x !== ph.id);
          ctx.note(`写真の出品採用を外した（${ph.id}）`);
          ctx.bump();
        }
      }
    });
  }

  /**
   * Redo an automatic finish in place: new image files for a photo the AI itself made from an original (source studio).
   * The id stays, so the listing order is kept; new file names so no device shows a cached old picture.
   */
  refinishPhoto(id, actor, photoId, meta, files) {
    const cur = this.get(id).photos.find((x) => x.id === photoId && !x.deletedAt);
    if (!cur || cur.source !== 'studio' || !cur.derivedFrom || isUser(cur.by)) throw new AppError(400, '作り直せるのはAI仕上げの写真だけです');
    // A 🔒 listing (出品用写真の確定) is the user's: an AI may not change the picture of a photo in it.
    // (also when the photo is used in a destination's own photo list)
    const lockedFor = (p) => !isUser(actor) && p.locks?.listingPhotos && photoInUse(p, photoId);
    if (lockedFor(this.get(id))) throw new AppError(403, '出品用写真が🔒確定されているので作り直しません', 'locked');
    const photosDir = path.join(this.dir(id), 'photos');
    const stamp = Date.now().toString(36);
    const names = {};
    for (const v of ['original', 'work', 'thumb']) {
      if (!files[v]?.buffer?.length) continue;
      const name = `${photoId}.${stamp}.${v}.jpg`;
      fs.writeFileSync(path.join(photosDir, name), files[v].buffer);
      names[v] = `photos/${name}`;
    }
    return this.mutate(id, actor, 'photo_edit', (p, ctx) => {
      if (lockedFor(p)) throw new AppError(403, '出品用写真が🔒確定されているので作り直しません', 'locked');
      const ph = p.photos.find((x) => x.id === photoId);
      const old = { ...ph.files, replacedAt: nowIso() };
      ph.files = { ...ph.files, ...names };
      if (!names.work && names.original) ph.files.work = names.original;
      if (!names.thumb) ph.files.thumb = ph.files.work;
      Object.assign(ph, { note: meta.note ?? ph.note, edit: meta.edit ?? ph.edit, width: Number(meta.width) || ph.width, height: Number(meta.height) || ph.height, sha256: sha256(files.original.buffer) });
      ctx.note('AI仕上げを作り直し');
      ctx.bump();
      ph.previousFiles = [...(ph.previousFiles || []), old].slice(-3); // kept on disk, not deleted
    });
  }

  deletePhoto(id, actor, photoId) {
    forbidAi(actor, '写真の削除');
    return this.mutate(id, actor, 'photo_delete', (p, ctx) => {
      const ph = p.photos.find((x) => x.id === photoId);
      if (!ph || ph.deletedAt) return;
      ph.deletedAt = nowIso();
      p.listingPhotoIds = p.listingPhotoIds.filter((x) => x !== photoId);
      ctx.note(`写真を削除（ゴミ箱）${ph.tag ? `: ${ph.tag}` : ''}`);
      ctx.bump();
    });
  }

  restorePhoto(id, actor, photoId) {
    return this.mutate(id, actor, 'photo_restore', (p, ctx) => {
      const ph = p.photos.find((x) => x.id === photoId);
      if (!ph || !ph.deletedAt) return;
      ph.deletedAt = null;
      ctx.note('写真を復元');
      ctx.bump();
    });
  }

  _applyListingPhotos(p, ids, ctx) {
    const valid = new Map(livePhotos(p).map((ph) => [ph.id, ph]));
    const uniq = [...new Set(ids)];
    for (const x of uniq) {
      const ph = valid.get(x);
      if (!ph) throw new AppError(400, `写真 ${x} が見つかりません`);
      if (!isListablePhoto(ph)) throw new AppError(400, `写真 ${x} は参考資料画像またはスキャン場面のため出品用にできません`);
    }
    if (uniq.length > MERCARI_LIMITS.photosMax) throw new AppError(400, `出品用写真は${MERCARI_LIMITS.photosMax}枚までです`);
    if (same(uniq, p.listingPhotoIds)) return false;
    p.listingPhotoIds = uniq;
    ctx.bump();
    return true;
  }

  /** Ordered selection of 出品用 photos: 現物 (actual) photos and disclaimed AI-generated images; never reference images. */
  setListingPhotos(id, actor, ids, { reason } = {}) {
    return this.mutate(id, actor, 'listing_photos', (p, ctx) => {
      if (!isUser(actor) && p.locks.listingPhotos) {
        if (same(ids, p.listingPhotoIds)) return { proposed: false };
        // Validate before storing as proposal.
        this._applyListingPhotos(clone(p), ids, new Ctx());
        p.proposals.listingPhotos = { value: [...new Set(ids)], by: actor, at: nowIso(), reason: reason || '' };
        ctx.note('出品用写真の構成を提案（ユーザー確定済みのため上書きせず）');
        return { proposed: true };
      }
      if (this._applyListingPhotos(p, ids, ctx)) ctx.note(`出品用写真を${p.listingPhotoIds.length}枚に設定`);
      if (isUser(actor)) {
        if (!p.locks.listingPhotos) {
          p.locks.listingPhotos = { by: actor, at: nowIso() };
          ctx.dirty = true;
        }
        if (p.proposals.listingPhotos) delete p.proposals.listingPhotos;
      }
      return { proposed: false };
    });
  }

  // ---------- AI facts / QC / requests ----------

  /** Merge facts by key. AI cannot overwrite a fact the user entered; it becomes a proposal. */
  setFacts(id, actor, facts, { replace = false } = {}) {
    const conf = new Set(FACT_CONFIDENCE.map((c) => c.id));
    return this.mutate(id, actor, 'facts', (p, ctx) => {
      if (replace && isUser(actor)) p.facts = [];
      else if (replace) p.facts = p.facts.filter((f) => f.by === 'user' || facts.some((n) => n.key === f.key));
      let n = 0;
      for (const f of facts) {
        if (!f.key) throw new AppError(400, 'fact.key は必須です');
        const confidence = f.confidence || 'unverified';
        if (!conf.has(confidence)) throw new AppError(400, `confidence が不正: ${confidence}`);
        const value = f.value == null ? '' : String(f.value);
        const next = { key: f.key, label: f.label || f.key, value, confidence, source: f.source || '', by: actor, at: nowIso() };
        const cur = p.facts.find((x) => x.key === f.key);
        if (!cur) {
          p.facts.push(next);
          n++;
        } else if (cur.value === value && cur.confidence === confidence && cur.source === next.source) {
          continue;
        } else if (!isUser(actor) && cur.by === 'user') {
          cur.proposal = { value, confidence, source: next.source, by: actor, at: next.at };
          ctx.note(`「${cur.label}」の修正を提案`);
        } else {
          Object.assign(cur, next);
          delete cur.proposal;
          n++;
        }
      }
      if (n) {
        ctx.note(`商品情報 ${n} 件を整理`);
        ctx.bump();
      }
    });
  }

  resolveFactProposal(id, actor, key, accept) {
    forbidAi(actor, 'AI提案の採用／却下');
    return this.mutate(id, actor, 'fact_proposal', (p, ctx) => {
      const f = p.facts.find((x) => x.key === key);
      if (!f?.proposal) throw new AppError(404, '提案が見つかりません');
      if (accept) {
        Object.assign(f, { value: f.proposal.value, confidence: f.proposal.confidence, source: f.proposal.source, by: 'user', at: nowIso() });
        ctx.bump();
      }
      delete f.proposal;
      ctx.note(`「${f.label}」の提案を${accept ? '採用' : '却下'}`);
    });
  }

  removeFact(id, actor, key) {
    return this.mutate(id, actor, 'fact_remove', (p, ctx) => {
      const f = p.facts.find((x) => x.key === key);
      if (!f) return;
      if (!isUser(actor) && f.by === 'user') throw new AppError(403, 'ユーザーが入力した情報はAIからは削除できません', 'forbidden');
      p.facts = p.facts.filter((x) => x.key !== key);
      ctx.note(`情報「${f.label}」を削除`);
      ctx.bump();
    });
  }

  /**
   * Save an AI QC result. QC (which includes 画像QC: image quality, cross-photo
   * consistency and anomaly checks) must come from a model in settings.imageQcModels.
   * A PASS additionally requires every image check to be evaluated and none failed.
   */
  saveQc(id, actor, { result, summary, model, checks = [], issues = [], photoRequests = [] }) {
    if (!['pass', 'needs_review', 'fail'].includes(result)) throw new AppError(400, 'result は pass / needs_review / fail のいずれか');
    const allowed = this.settings.imageQcModels || [];
    if (!model || !allowed.includes(model)) {
      throw new AppError(403, `QC（画像QCを含む）は ${allowed.join(' / ')} で実施してください（申告モデル: ${model || '未指定'}）`, 'qc_model');
    }
    const p0 = this.get(id);
    if (result === 'pass') {
      const byId = new Map(checks.map((c) => [c.id, c]));
      const missingImg = IMAGE_QC_CHECK_IDS.filter((cid) => !byId.has(cid));
      if (missingImg.length) throw new AppError(400, `画像QCの未評価項目があるため PASS にできません: ${missingImg.join(', ')}`);
      const failed = checks.filter((c) => c.result === 'fail');
      if (failed.length) throw new AppError(400, `fail のチェック項目があるため PASS にできません: ${failed.map((c) => c.id).join(', ')}`);
      const errors = readiness({ ...p0, qc: { result: 'pass', rev: p0.rev, model } }, this.settings).missing.filter((m) => m.code.startsWith('lint:'));
      if (errors.length) throw new AppError(400, `機械チェックでエラーがあるため PASS にできません: ${errors.map((e) => e.message).join(' / ')}`);
    }
    const labels = Object.fromEntries(QC_CHECKS.map((c) => [c.id, c]));
    return this.mutate(id, actor, 'qc', (p, ctx) => {
      p.qc = {
        result,
        summary: summary || (result === 'pass' ? 'QC PASS' : '要確認'),
        model,
        checks: checks.map((c) => ({ id: c.id, label: labels[c.id]?.label || c.label || c.id, group: labels[c.id]?.group || 'content', result: c.result, note: c.note || '' })),
        issues: issues.map((i) => ({ severity: i.severity || 'warn', message: i.message, field: i.field || null })),
        at: nowIso(),
        by: actor,
        rev: p.rev,
      };
      ctx.note(`${result === 'pass' ? 'QC PASS' : `QC ${result === 'fail' ? 'NG' : '要確認'}: ${p.qc.summary}`}（${model}）`);
      for (const r of photoRequests) this._addPhotoRequest(p, actor, r, ctx);
    });
  }

  _addPhotoRequest(p, actor, r, ctx) {
    const label = (typeof r === 'string' ? r : r.label || '').trim();
    if (!label) return;
    if (p.photoRequests.some((x) => !x.doneAt && !x.cancelledAt && x.label === label)) return;
    p.photoRequests.push({ id: newId('rq'), label, reason: r.reason || '', by: actor, at: nowIso(), doneAt: null, cancelledAt: null, photoId: null });
    ctx.note(`追加撮影を依頼: ${label}`);
  }

  addPhotoRequests(id, actor, requests) {
    return this.mutate(id, actor, 'photo_request', (p, ctx) => {
      for (const r of requests) this._addPhotoRequest(p, actor, r, ctx);
    });
  }

  updatePhotoRequest(id, actor, reqId, { done, cancel }) {
    return this.mutate(id, actor, 'photo_request', (p, ctx) => {
      const r = p.photoRequests.find((x) => x.id === reqId);
      if (!r) throw new AppError(404, '撮影依頼が見つかりません');
      if (cancel) {
        forbidAi(actor, '撮影依頼の取り消し');
        r.cancelledAt = nowIso();
        ctx.note(`撮影依頼「${r.label}」を取り消し`);
      } else if (done !== undefined) {
        r.doneAt = done ? nowIso() : null;
        ctx.note(`撮影依頼「${r.label}」を${done ? '完了' : '未完了'}に`);
      }
    });
  }

  // ---------- AI task queue ----------

  requestAiTask(id, actor, type, note = '') {
    if (!AI_TASK_TYPES.some((t) => t.id === type)) throw new AppError(400, `AIタスク種別が不正: ${type}`);
    return this.mutate(id, actor, 'ai_request', (p, ctx) => {
      if (p.aiTasks.some((t) => t.type === type && (t.status === 'pending' || t.status === 'processing'))) return;
      const t = { id: newId('t'), type, status: 'pending', note, requestedBy: actor, requestedAt: nowIso(), startedAt: null, finishedAt: null, message: '' };
      p.aiTasks.push(t);
      if (p.aiTasks.length > 50) p.aiTasks = p.aiTasks.slice(-50);
      if (['unsorted', 'needs_photos', 'shooting', 'needs_review'].includes(p.stage) && type !== 'transfer') p.stage = 'ai_pending';
      ctx.note(`AI依頼: ${AI_TASK_TYPES.find((x) => x.id === type).label}`);
      return t;
    });
  }

  startAiTask(id, actor, taskId) {
    return this.mutate(id, actor, 'ai_start', (p, ctx) => {
      const t = p.aiTasks.find((x) => x.id === taskId);
      if (!t) throw new AppError(404, 'AIタスクが見つかりません');
      if (t.status !== 'pending') throw new AppError(409, `このタスクは ${t.status} です`);
      t.status = 'processing';
      t.startedAt = nowIso();
      t.worker = actor;
      if (['unsorted', 'needs_photos', 'shooting', 'ai_pending', 'needs_review'].includes(p.stage) && t.type !== 'transfer') p.stage = 'ai_processing';
      ctx.note(`AI処理開始: ${AI_TASK_TYPES.find((x) => x.id === t.type)?.label}`);
      return t;
    });
  }

  finishAiTask(id, actor, taskId, { status = 'done', message = '' } = {}) {
    if (!['done', 'error'].includes(status)) throw new AppError(400, 'status は done / error');
    return this.mutate(id, actor, 'ai_finish', (p, ctx) => {
      const t = p.aiTasks.find((x) => x.id === taskId);
      if (!t) throw new AppError(404, 'AIタスクが見つかりません');
      t.status = status;
      t.finishedAt = nowIso();
      t.message = message;
      if (p.stage === 'ai_processing' && !p.aiTasks.some((x) => x.status === 'processing' && x.id !== t.id)) {
        p.stage = 'needs_review'; // reconcileStage promotes to ready when everything is in place
      }
      ctx.note(`AI処理${status === 'done' ? '完了' : 'エラー'}: ${AI_TASK_TYPES.find((x) => x.id === t.type)?.label}${message ? ` — ${message}` : ''}`);
    });
  }

  cancelAiTask(id, actor, taskId) {
    return this.mutate(id, actor, 'ai_cancel', (p, ctx) => {
      const t = p.aiTasks.find((x) => x.id === taskId);
      if (!t || !['pending', 'processing'].includes(t.status)) return;
      t.status = 'cancelled';
      t.finishedAt = nowIso();
      if (['ai_pending', 'ai_processing'].includes(p.stage) && !p.aiTasks.some((x) => ['pending', 'processing'].includes(x.status))) p.stage = 'needs_review';
      ctx.note('AI依頼を取り消し');
    });
  }

  /** Called from the camera when the user taps 撮影完了. */
  shootDone(id, actor, { requestAi = true } = {}) {
    this.mutate(id, actor, 'shoot_done', (p, ctx) => {
      p.shotDoneAt = nowIso();
      p.shootPlan = false;
      if (['unsorted', 'needs_photos', 'shooting', 'needs_review'].includes(p.stage)) p.stage = 'ai_pending';
      ctx.note(`撮影完了（現物写真${actualPhotos(p).length}枚）`);
    });
    if (requestAi) this.requestAiTask(id, actor, 'full', '撮影完了後の自動依頼');
    return this.get(id);
  }

  // ---------- channels (Mercari etc.) ----------

  updateChannel(id, actor, channel, patch, { summary, stage } = {}) {
    return this.mutate(id, actor, `${channel}_update`, (p, ctx) => {
      p.channels[channel] = { ...(p.channels[channel] || {}), ...patch, updatedAt: nowIso() };
      if (stage && stage !== p.stage) {
        ctx.changes.push({ path: 'stage', label: 'ステータス', from: stageLabel(p.stage), to: stageLabel(stage) });
        p.stage = stage;
      }
      if (patch?.status === 'sold' || patch?.status === 'trading' || stage === 'sold' || stage === 'trading') {
        p.stockCheckedAt = null;
        p.stockUnknownAt = null;
        if (p.decision !== 'no_stock') {
          ctx.changes.push({ path: 'decision', label: '出品判断', from: decisionLabel(p.decision), to: decisionLabel('no_stock') });
          p.decision = 'no_stock';
        }
      }
      ctx.note(summary || `${channel} 情報を更新`);
    });
  }

  // ---------- destinations, per-destination photos, research, text candidates ----------

  /** Where the user wants to offer the product (メルカリ／ジモティー／ヤフオク／ラクマ／フリマ, any number). User-only. */
  setTargets(id, actor, targets, { confirmFoodFlea = false } = {}) {
    forbidAi(actor, '出品先の選択');
    const next = [...new Set(targets || [])];
    for (const t of next) if (!CHANNEL_IDS.includes(t)) throw new AppError(400, `出品先が不正: ${t}`);
    const ordered = CHANNEL_IDS.filter((c) => next.includes(c));
    return this.mutate(id, actor, 'targets', (p, ctx) => {
      if (same(ordered, p.targets || [])) return;
      // 飲食料品のフリマは、確認ダイアログを通したときだけ（どの経路からでも）。
      if (ordered.includes('flea') && !(p.targets || []).includes('flea') && isFood(p)) {
        if (!confirmFoodFlea) throw new AppError(409, '飲食料品はフリマで禁止のことが多いので、商品ごとに確認してチェックしてください', 'food_flea_confirm');
        p.foodFleaRuleAt = p.foodFleaRuleAt || nowIso(); // the one-time removal must not undo this confirmed choice
      }
      ctx.changes.push({ path: 'targets', label: '出品先', from: (p.targets || []).map(channelLabel).join('・') || 'なし', to: ordered.map(channelLabel).join('・') || 'なし' });
      ctx.dirty = true;
      // A destination the user turned on/off by hand is never touched again by the defaults (server/defaults.js).
      for (const c of CHANNEL_IDS) if ((p.targets || []).includes(c) !== ordered.includes(c)) p.targetsManual = { ...p.targetsManual, [c]: nowIso() };
      p.targets = ordered;
    });
  }

  /** The user's standing rule adds a destination once (server/defaults.js). Not for AI tools. */
  applyDefaultTarget(id, channel, reason, rule = 'flea') {
    return this.mutate(id, 'system', 'targets', (p, ctx) => {
      if (p.targetDefaults?.[channel] || p.targetsManual?.[channel] || (p.targets || []).includes(channel)) return;
      const ordered = CHANNEL_IDS.filter((c) => c === channel || (p.targets || []).includes(c));
      ctx.note(`既定ルールで${channelLabel(channel)}を追加（${reason}）`);
      ctx.changes.push({ path: 'targets', label: '出品先', from: (p.targets || []).map(channelLabel).join('・') || 'なし', to: ordered.map(channelLabel).join('・') });
      p.targetDefaults = { ...p.targetDefaults, [channel]: { at: nowIso(), reason, rule } };
      p.targets = ordered;
    });
  }

  /**
   * A destination the user asked to have added as a default (shown green): added if missing, and marked as a default
   * even when it was already set or had been toggled by hand (the request itself comes from the user).
   */
  markDefaultTarget(id, actor, channel, reason) {
    if (!CHANNEL_IDS.includes(channel)) throw new AppError(400, `出品先が不正: ${channel}`);
    const cur = this.get(id);
    if (channel === 'flea' && isFood(cur)) return false; // 飲食料品のフリマは確認ダイアログからだけ
    // Only the user may re-add a destination they cleared by hand. (One they ticked by hand stays ticked; it only turns green.)
    if (!isUser(actor) && cur.targetsManual?.[channel] && !(cur.targets || []).includes(channel)) return false;
    if ((cur.targets || []).includes(channel) && cur.targetDefaults?.[channel] && !cur.targetsManual?.[channel]) return false;
    this.mutate(id, actor, 'targets', (p, ctx) => {
      const has = (p.targets || []).includes(channel);
      const ordered = CHANNEL_IDS.filter((c) => c === channel || (p.targets || []).includes(c));
      ctx.note(`${channelLabel(channel)}を既定として${has ? '緑に' : '追加'}（${reason}）`);
      if (!has) ctx.changes.push({ path: 'targets', label: '出品先', from: (p.targets || []).map(channelLabel).join('・') || 'なし', to: ordered.map(channelLabel).join('・') });
      // `added` only when this call ticked it: a box the user had ticked (now just green) can never be taken away by unmark.
      p.targetDefaults = { ...p.targetDefaults, [channel]: { at: nowIso(), reason, rule: 'request', by: actor, ...(has ? {} : { added: true }) } };
      if (p.targetsManual?.[channel]) {
        const { [channel]: _, ...rest } = p.targetsManual;
        p.targetsManual = rest;
      }
      p.targets = ordered;
    });
    return true;
  }

  /**
   * 飲食料品のフリマを外す（ユーザー指定の規則。商品ごとに1回、手で入れたものも含む）。
   * これ以降にユーザーが確認ダイアログを通して入れたものには触らない（setTargets が foodFleaRuleAt を付ける）。
   */
  clearFoodFlea(id, reason) {
    return this.mutate(id, 'system', 'targets', (p, ctx) => {
      if (p.foodFleaRuleAt || !isFood(p)) return;
      p.foodFleaRuleAt = nowIso();
      ctx.dirty = true;
      if (p.targetsManual?.flea) { const { flea: _m, ...rest } = p.targetsManual; p.targetsManual = rest; }
      if (p.targetDefaults?.flea) { const { flea: _d, ...rest } = p.targetDefaults; p.targetDefaults = rest; }
      if (!(p.targets || []).includes('flea')) return;
      const next = p.targets.filter((c) => c !== 'flea');
      ctx.note(`フリマを外す（${reason}）`);
      ctx.changes.push({ path: 'targets', label: '出品先', from: p.targets.map(channelLabel).join('・'), to: next.map(channelLabel).join('・') || 'なし' });
      p.targets = next;
    });
  }

  /** Undo markDefaultTarget: only a destination this same actor added on request, untouched by the user since. */
  unmarkDefaultTarget(id, actor, channel) {
    const cur = this.get(id);
    const d = cur.targetDefaults?.[channel];
    if (d?.rule !== 'request' || !d.added || d.by !== actor || cur.targetsManual?.[channel] || !(cur.targets || []).includes(channel)) return false;
    this.mutate(id, actor, 'targets', (p, ctx) => {
      const next = p.targets.filter((c) => c !== channel);
      ctx.note(`${channelLabel(channel)}の既定を取り消し`);
      ctx.changes.push({ path: 'targets', label: '出品先', from: p.targets.map(channelLabel).join('・'), to: next.map(channelLabel).join('・') || 'なし' });
      const { [channel]: _, ...rest } = p.targetDefaults;
      p.targetDefaults = rest;
      p.targets = next;
    });
    return true;
  }

  /** Take back a destination the 手取り rule added (only while the user has not touched it). */
  /** Take back every destination a default rule put on this product (not the user's own). The record stays so no rule adds it again. */
  removeRuleTargets(id, reason) {
    return this.mutate(id, 'system', 'targets', (p, ctx) => {
      const drop = (p.targets || []).filter((c) => p.targetDefaults?.[c] && !p.targetDefaults[c].removedAt && !p.targetsManual?.[c]);
      if (!drop.length) return;
      const next = p.targets.filter((c) => !drop.includes(c));
      ctx.note(`既定ルールで入れた${drop.map(channelLabel).join('・')}を外す（${reason}）`);
      ctx.changes.push({ path: 'targets', label: '出品先', from: p.targets.map(channelLabel).join('・'), to: next.map(channelLabel).join('・') || 'なし' });
      p.targetDefaults = { ...p.targetDefaults, ...Object.fromEntries(drop.map((c) => [c, { ...p.targetDefaults[c], removedAt: nowIso(), removedReason: reason }])) };
      p.targets = next;
    });
  }

  removeDefaultTarget(id, channel, reason) {
    return this.mutate(id, 'system', 'targets', (p, ctx) => {
      if (p.targetDefaults?.[channel]?.rule !== 'net' || p.targetsManual?.[channel] || !(p.targets || []).includes(channel)) return;
      const next = p.targets.filter((c) => c !== channel);
      ctx.note(`既定ルールで${channelLabel(channel)}を外す（${reason}）`);
      ctx.changes.push({ path: 'targets', label: '出品先', from: p.targets.map(channelLabel).join('・'), to: next.map(channelLabel).join('・') || 'なし' });
      const { [channel]: _, ...rest } = p.targetDefaults;
      p.targetDefaults = rest;
      p.targets = next;
    });
  }

  /** Photos for one destination, in order. null = same as the common 出品用写真. */
  setChannelPhotos(id, actor, channel, ids) {
    if (!CHANNEL_IDS.includes(channel)) throw new AppError(400, `出品先が不正: ${channel}`);
    return this.mutate(id, actor, 'channel_photos', (p, ctx) => {
      const cur = p.channelPhotos?.[channel] ?? null;
      if (ids == null) {
        if (cur == null) return;
        delete p.channelPhotos[channel];
        ctx.note(`${channelLabel(channel)}の写真を共通に戻す`);
        ctx.bump();
        return;
      }
      const draft = clone(p);
      this._applyListingPhotos(draft, ids, new Ctx());
      if (cur && same(cur, draft.listingPhotoIds)) return;
      p.channelPhotos = { ...(p.channelPhotos || {}), [channel]: draft.listingPhotoIds };
      ctx.note(`${channelLabel(channel)}の写真を${draft.listingPhotoIds.length}枚に設定`);
      ctx.bump();
    });
  }

  /** Reference research (price check, size, where it suits). Not a listing field: does not invalidate QC. */
  setResearch(id, actor, research) {
    return this.mutate(id, actor, 'research', (p, ctx) => {
      const a = JSON.stringify({ ...(p.research || {}), importedAt: null });
      const b = JSON.stringify({ ...(research || {}), importedAt: null });
      if (a === b) return;
      p.research = research;
      ctx.note(`価格・分類の調査を更新（${research?.group || '分類なし'}${research?.amazonPrice != null ? `・Amazon ${yen(research.amazonPrice)}` : ''}）`);
    });
  }

  /**
   * Facts read from the public Amazon page (logged out): official title, package/product size and weight, main image.
   * Used for size and shipping classification; never touches the listing.
   */
  setAmazonInfo(id, actor, info) {
    return this.mutate(id, actor, 'amazon', (p, ctx) => {
      const keep = ({ fetchedAt, ...rest } = {}) => JSON.stringify(rest);
      if (keep(p.amazon || {}) === keep(info || {})) return;
      p.amazon = info || null;
      const sz = info?.package?.dims || info?.product?.dims;
      ctx.note(`Amazonの商品情報を更新${sz ? `（${sz.join('×')}cm）` : ''}`);
    });
  }

  /**
   * Packed size judged from the name and photos when Amazon lists none. Shown as 見立て with a confidence and a reason.
   */
  setSizeEstimate(id, actor, est) {
    return this.mutate(id, actor, 'sizeEstimate', (p, ctx) => {
      if (!est) { if (!p.sizeEstimate) return; p.sizeEstimate = null; ctx.note('サイズの見立てを削除'); return; }
      const dims = (est.dims || []).map(Number);
      if (dims.length !== 3 || dims.some((d) => !(d > 0) || d > 400)) throw new AppError(400, 'dims は [長さ, 幅, 高さ]（cm）の3つ');
      const kg = est.kg == null || est.kg === '' ? null : Number(est.kg);
      if (kg != null && !(kg > 0 && kg < 200)) throw new AppError(400, 'kg が不正');
      const confidence = ['high', 'mid', 'low'].includes(est.confidence) ? est.confidence : 'low';
      p.sizeEstimate = { dims, kg, confidence, reason: String(est.reason || '').slice(0, 300), by: actor, at: nowIso() };
      ctx.note(`サイズの見立て ${dims.join('×')}cm${kg != null ? `・${kg}kg` : ''}（確信度${{ high: '高', mid: '中', low: '低' }[confidence]}）`);
    });
  }

  /**
   * Recently sold prices on Mercari for the same item (found by image search) or, failing that, similar items.
   * Research, not a listing field: anyone may record it; the user decides prices.
   */
  setMarket(id, actor, market, site = 'mercari') {
    return this.mutate(id, actor, 'market', (p, ctx) => {
      const m = normalizeMarket(market, actor, site);
      if (site === 'yahoo') p.marketYahoo = m;
      else if (site === 'rakuma') p.marketRakuma = m;
      else if (site === 'paypay') p.marketPaypay = m;
      else p.market = m;
      const name = { yahoo: 'ヤフオク相場', rakuma: 'ラクマ相場', paypay: 'ヤフーフリマ相場' }[site] || 'メルカリ相場';
      ctx.note(m ? `${name}を記録（${m.matchType === 'same' ? '同じ商品' : m.matchType === 'similar' ? '似た商品' : '見つからず'}${m.median != null ? `・中央値 ${yen(m.median)}・${m.count}件` : ''}）` : `${name}の記録を削除`);
    });
  }

  /**
   * Alternative texts the user can pick from (latest manuscript, 販売用原稿, earlier versions…).
   * Upsert by `key`; a changed text keeps the previous one as 旧版 so it stays selectable.
   */
  upsertTextCandidates(id, actor, items) {
    return this.mutate(id, actor, 'text_candidates', (p, ctx) => {
      const list = [...(p.textCandidates || [])];
      const fresh = [];
      for (const it of items) {
        if (!it.key || !it.field || typeof it.text !== 'string' || !it.text.trim()) continue;
        const i = list.findIndex((c) => c.key === it.key);
        if (i >= 0 && list[i].text === it.text) continue;
        if (i >= 0) list[i] = { ...list[i], key: `${it.key}@${list[i].at}`, label: `${list[i].label}（旧版）`, old: true };
        fresh.push({ key: it.key, field: it.field, label: it.label || it.key, text: it.text, source: it.source || '', at: nowIso(), by: actor });
      }
      if (!fresh.length) return;
      const n = fresh.length;
      // New ones first in the order given, then the unchanged current ones, then up to 20 earlier versions.
      p.textCandidates = [...fresh, ...list.filter((c) => !c.old), ...list.filter((c) => c.old).slice(0, 20)];
      ctx.note(`文章の候補を${n}件更新`);
    });
  }

  /** Note when a channel was last checked, without a history entry (nothing about the product changed). */
  touchChannel(id, channel, patch) {
    const p = this.get(id);
    p.channels[channel] = { ...(p.channels[channel] || {}), ...patch };
    this.persist(p);
  }

  recordChannelCheck(channel, info) {
    this.meta.channelChecks = { ...(this.meta.channelChecks || {}), [channel]: info };
    this.saveMeta();
  }

  // ---------- whole-app snapshots (状態の保存) and rollback ----------

  get snapshotsDir() {
    return path.join(this.dataDir, 'snapshots');
  }

  /**
   * Save every product (and settings) as they are now. Photos are append-only, so files are not copied.
   * kind: 'manual' = a save point the user made (kept until deleted), 'auto' = periodic autosave,
   * 'before' = taken automatically just before a bulk edit or a rollback, 'ai' = requested by the AI.
   * Each kind is pruned separately, so one kind can never push another kind's undo points out.
   */
  saveSnapshot(actor, { label = '', kind = 'manual', auto } = {}) {
    if (auto && kind === 'manual') kind = 'before';
    const at = nowIso();
    const id = `${at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${newId('s').slice(-4)}`;
    const dir = path.join(this.snapshotsDir, id);
    fs.mkdirSync(path.join(dir, 'products'), { recursive: true });
    const list = this.list();
    for (const p of list) writeJson(path.join(dir, 'products', `${p.id}.json`), p);
    writeJson(path.join(dir, 'meta.json'), this.meta);
    const info = { id, label: String(label || '').slice(0, 80), kind, auto: kind !== 'manual', at, by: actor, count: list.length };
    writeJson(path.join(dir, 'info.json'), info);
    this.lastSnapshotAt = at;
    this.snapshotSeq = this.changeSeq || 0;
    this.pruneSnapshots();
    return info;
  }

  /**
   * The AI may save the state before mass edits, in its own bucket (newest 10) and at most once per 5 minutes,
   * so it can neither push the user's undo points out nor fill the disk.
   */
  saveAiSnapshot(actor, label = '') {
    const last = this.listSnapshots().find((s) => s.kind === 'ai');
    if (last && Date.now() - Date.parse(last.at) < 5 * 60_000) return { ...last, reused: true };
    return this.saveSnapshot(actor, { label: `${String(label || '').slice(0, 60)}（AI）`, kind: 'ai' });
  }

  /** Periodic autosave: only when something changed since the last snapshot of any kind. */
  autoSaveIfChanged() {
    // Within this process count changes (timestamps can tie within a millisecond); at startup compare times.
    if (this.snapshotSeq !== undefined) {
      if ((this.changeSeq || 0) <= this.snapshotSeq) return null;
    } else {
      const last = this.listSnapshots()[0]?.at ?? '';
      const changed = this.list().reduce((m, p) => (p.updatedAt > m ? p.updatedAt : m), '');
      if (!changed || changed <= last) return null;
    }
    return this.saveSnapshot('system', { label: '自動保存', kind: 'auto' });
  }

  listSnapshots() {
    if (!fs.existsSync(this.snapshotsDir)) return [];
    return fs.readdirSync(this.snapshotsDir)
      .map((d) => readJson(path.join(this.snapshotsDir, d, 'info.json'), null))
      .filter(Boolean)
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  /** Keep every save point; keep the newest 48 periodic autosaves, 30 pre-operation ones and 10 AI-requested ones. */
  pruneSnapshots() {
    const all = this.listSnapshots();
    const kindOf = (s) => s.kind || (s.auto ? 'before' : 'manual');
    const keep = { auto: 48, before: 30, ai: 10 };
    const drop = Object.entries(keep).flatMap(([k, n]) => all.filter((s) => kindOf(s) === k).slice(n));
    for (const s of drop) fs.rmSync(path.join(this.snapshotsDir, s.id), { recursive: true, force: true });
  }

  /** Server-side cleanup of an automatic snapshot that turned out unnecessary (the operation changed nothing). */
  discardAutoSnapshot(id) {
    const dir = path.join(this.snapshotsDir, path.basename(id));
    const info = readJson(path.join(dir, 'info.json'), null);
    if (info && info.kind !== 'manual') fs.rmSync(dir, { recursive: true, force: true });
  }

  deleteSnapshot(actor, id) {
    forbidAi(actor, '保存した状態の削除');
    const dir = path.join(this.snapshotsDir, path.basename(id));
    if (!fs.existsSync(path.join(dir, 'info.json'))) throw new AppError(404, '保存した状態が見つかりません');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /**
   * Put every product back as it was in snapshot `id`. The state just before is saved first (so this can be undone),
   * products added later go to the trash (not deleted), and each change is in the product's history.
   */
  rollbackTo(actor, id) {
    forbidAi(actor, 'ロールバック');
    const dir = path.join(this.snapshotsDir, path.basename(id));
    const info = readJson(path.join(dir, 'info.json'), null);
    if (!info) throw new AppError(404, '保存した状態が見つかりません');
    const name = info.label || fmtStamp(info.at);
    const before = this.saveSnapshot(actor, { label: `「${name}」に戻す前（自動）`, kind: 'before' });
    const snap = new Map();
    for (const f of fs.readdirSync(path.join(dir, 'products'))) {
      const p = this.migrate(readJson(path.join(dir, 'products', f)));
      snap.set(p.id, p);
    }
    const out = { before: before.id, restored: 0, unchanged: 0, trashed: 0, missing: [] };
    const strip = (x) => JSON.stringify({ ...x, rev: 0, updatedAt: '' });
    for (const cur of this.list()) {
      const old = snap.get(cur.id);
      if (!old) {
        if (!cur.trashedAt) {
          this.mutate(cur.id, actor, 'rollback', (p, ctx) => {
            p.trashedAt = nowIso();
            ctx.note(`「${name}」に戻す（この時点に無かった商品のためゴミ箱へ）`);
          });
          out.trashed++;
        } else out.unchanged++;
        continue;
      }
      if (strip(old) === strip(cur)) {
        out.unchanged++;
        continue;
      }
      this.mutate(cur.id, actor, 'rollback', (p, ctx) => {
        const rev = Math.max(p.rev, old.rev);
        for (const k of Object.keys(p)) delete p[k];
        Object.assign(p, clone(old), { rev });
        ctx.note(`「${name}」の状態に戻す`);
        ctx.bump();
      });
      out.restored++;
    }
    for (const sid of snap.keys()) if (!this.products.has(sid)) out.missing.push(sid);
    const meta = readJson(path.join(dir, 'meta.json'), null);
    if (meta?.settings) {
      this.meta.settings = { ...DEFAULT_SETTINGS, ...meta.settings };
      this.saveMeta();
    }
    this.emit('change', { type: 'settings' });
    return out;
  }

  // ---------- undo ----------

  /**
   * Restore the product to how it was just before history entry `historyId`.
   * Photos are never lost by a revert (current photos are kept), and external
   * state (Mercari channel, AI task queue, trash) is not rolled back.
   */
  revert(id, actor, historyId) {
    const file = path.join(this.dir(id), 'versions', `${historyId}.json`);
    if (!fs.existsSync(file)) throw new AppError(404, 'この変更の復元データはありません');
    const snap = this.migrate(readJson(file));
    return this.mutate(id, actor, 'revert', (p, ctx) => {
      const keep = { id: p.id, createdAt: p.createdAt, channels: p.channels, aiTasks: p.aiTasks, trashedAt: p.trashedAt, rev: p.rev };
      const known = new Set(snap.photos.map((x) => x.id));
      const photos = [...snap.photos, ...p.photos.filter((x) => !known.has(x.id))];
      const qcWasFresh = snap.qc && snap.qc.rev === snap.rev;
      for (const k of Object.keys(p)) delete p[k];
      Object.assign(p, snap, keep, { photos });
      ctx.bump();
      if (qcWasFresh) p.qc.rev = p.rev + 1;
      ctx.note('以前の状態に復元');
    });
  }

  /** Undo everything `targetActor` changed since `since` (e.g. a bad AI batch run). */
  revertActorSince(actor, targetActor, since) {
    forbidAi(actor, '一括取り消し');
    const results = [];
    for (const p of this.list()) {
      const entries = readJsonl(path.join(this.dir(p.id), 'history.jsonl')).filter((h) => h.actor === targetActor && h.at >= since && h.action !== 'create');
      if (!entries.length) continue;
      try {
        this.revert(p.id, actor, entries[0].id);
        results.push({ id: p.id, ok: true, changes: entries.length });
      } catch (e) {
        results.push({ id: p.id, ok: false, error: e.message });
      }
    }
    return results;
  }
}

function makeLink(l, actor) {
  const o = typeof l === 'string' ? { url: l } : l;
  const url = String(o.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new AppError(400, `URLが不正です: ${url}`);
  const type = o.type && LINK_TYPES.some((t) => t.id === o.type) ? o.type : guessLinkType(url);
  return { id: newId('l'), url, type, title: o.title || '', note: o.note || '', by: actor, at: nowIso() };
}

function guessLinkType(url) {
  if (/amazon\.|rakuten\.|yodobashi|biccamera|yahoo\.co\.jp\/.*(store|shopping)|kakaku|joshinweb|monotaro/i.test(url)) return 'purchase';
  if (/manual|support|\.pdf($|\?)/i.test(url)) return 'manual';
  if (/mercari|fril\.jp|rakuma|aucfan|auctions\.yahoo|paypayfleamarket/i.test(url)) return 'market';
  return 'other';
}

function sniffExt(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.slice(4, 12).toString().includes('ftyphei')) return 'heic';
  return null;
}

/** Plain-text listing for humans and as a manual copy/paste fallback. */
export function listingText(p) {
  const L = p.listing;
  return [
    `# ${p.id} ${p.name}`,
    '',
    `タイトル: ${L.title}`,
    `価格: ${L.price != null ? yen(L.price) : ''}${p.locks['listing.price'] ? '' : '（未確認）'}`,
    `カテゴリー: ${L.category}`,
    `ブランド: ${L.brand}`,
    `商品の状態: ${L.condition}${p.locks['listing.condition'] ? '' : '（未確認）'}`,
    `配送料の負担: ${L.shippingPayer}`,
    `配送の方法: ${L.shippingMethod}`,
    `発送元の地域: ${L.shippingFrom}`,
    `発送までの日数: ${L.shippingDays}`,
    '',
    '--- 商品説明 ---',
    L.description,
    '',
  ].join('\n');
}
