// File-based product store. The data directory itself is the source of truth and is
// readable without this app: data/products/<id>/{product.json,listing.txt,history.jsonl,photos/,versions/}.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  AppError, nowIso, newId, clone, getPath, setPath, same, writeJson, writeFileAtomic, readJson,
  appendJsonl, readJsonl, pad4, truncate, yen,
} from './util.js';
import {
  FIELD_MAP, DECISION_IDS, STAGE_IDS, USER_ONLY_STAGES, DEFAULT_SETTINGS, FACT_CONFIDENCE,
  LINK_TYPES, PHOTO_TAGS, AI_TASK_TYPES, MERCARI_LIMITS, IMAGE_QC_CHECK_IDS, QC_CHECKS, coerceField, stageLabel,
} from './schema.js';
import { readiness, actualPhotos, livePhotos, findDuplicates } from './rules.js';

const VERSIONS_KEPT = 100;
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif' };

export const isUser = (actor) => actor === 'user';

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
    quantity: 1,
    color: '',
    conditionNote: '',
    notes: '',
    itemDate: '',
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
    lastPhotoAt: null,
    shotDoneAt: null,
    links: [],
    photos: [],
    listingPhotoIds: [],
    facts: [],
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

export class Store extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = path.resolve(dataDir);
    this.productsDir = path.join(this.dataDir, 'products');
    this.products = new Map();
    this.load();
  }

  // ---------- persistence ----------

  load() {
    fs.mkdirSync(this.productsDir, { recursive: true });
    this.meta = readJson(path.join(this.dataDir, 'meta.json'), { nextId: 1, settings: {} });
    this.meta.settings = { ...DEFAULT_SETTINGS, ...this.meta.settings };
    this.products.clear();
    for (const dir of fs.readdirSync(this.productsDir)) {
      const file = path.join(this.productsDir, dir, 'product.json');
      if (!fs.existsSync(file)) continue;
      const p = this.migrate(readJson(file));
      this.products.set(p.id, p);
      const n = parseInt(p.id, 10);
      if (Number.isFinite(n) && n >= this.meta.nextId) this.meta.nextId = n + 1;
    }
  }

  migrate(p) {
    const base = newProduct(p.id, p.createdAt || nowIso(), {});
    const out = { ...base, ...p, listing: { ...base.listing, ...p.listing }, channels: { ...base.channels, ...p.channels } };
    return out;
  }

  saveMeta() {
    writeJson(path.join(this.dataDir, 'meta.json'), this.meta);
  }

  get settings() {
    return this.meta.settings;
  }

  updateSettings(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULT_SETTINGS)) throw new AppError(400, `不明な設定: ${k}`);
      this.meta.settings[k] = v;
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
  mutate(id, actor, action, fn) {
    const current = this.get(id);
    const draft = clone(current);
    const ctx = new Ctx();
    const result = fn(draft, ctx);
    if (!ctx.dirty) return result ?? draft;
    if (ctx.bumped) draft.rev += 1;
    this.reconcileStage(draft, ctx);
    draft.updatedAt = nowIso();
    const entry = { id: newId('h'), at: draft.updatedAt, actor, action, summary: ctx.summary(), changes: ctx.changes.filter((c) => !c.silent) };
    writeJson(path.join(this.dir(id), 'versions', `${entry.id}.json`), current);
    this.persist(draft);
    appendJsonl(path.join(this.dir(id), 'history.jsonl'), entry);
    appendJsonl(path.join(this.dataDir, 'activity.jsonl'), {
      at: entry.at, actor, productId: id, productName: draft.name, action, summary: entry.summary, historyId: entry.id,
    });
    this.products.set(id, draft);
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
    const hasPhotos = actualPhotos(p).length > 0;
    if (p.decision === 'sell' && to === 'unsorted') to = hasPhotos ? 'shooting' : 'needs_photos';
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
    const dups = this.duplicatesFor({ ...fields, links });
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
          setPath(p, k, coerceField(def, v));
        } catch (e) {
          throw new AppError(400, e.message);
        }
      }
    }
    for (const l of links) p.links.push(makeLink(l, actor));
    fs.mkdirSync(path.join(this.dir(id), 'photos'), { recursive: true });
    this.products.set(id, p);
    this.persist(p);
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
  updateFields(id, actor, set, { reason, lock = true } = {}) {
    const outcome = { set: [], proposed: [], unchanged: [] };
    this.mutate(id, actor, 'update', (p, ctx) => {
      for (const [field, raw] of Object.entries(set || {})) {
        const def = FIELD_MAP[field];
        if (!def) throw new AppError(400, `不明な項目: ${field}`);
        let value;
        try {
          value = coerceField(def, raw);
        } catch (e) {
          throw new AppError(400, e.message);
        }
        const old = getPath(p, field);
        if (isUser(actor)) {
          if (!same(old, value)) {
            setPath(p, field, value);
            ctx.change(field, old, value);
            ctx.bump();
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
        } else if (p.locks[field]) {
          if (same(old, value)) {
            outcome.unchanged.push(field);
            continue;
          }
          p.proposals[field] = { value, by: actor, at: nowIso(), reason: reason || '' };
          ctx.note(`${def.label} の変更を提案（ユーザー確定済みのため上書きせず）`);
          outcome.proposed.push(field);
        } else if (!same(old, value)) {
          setPath(p, field, value);
          ctx.change(field, old, value);
          ctx.bump();
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
    forbidAi(actor, '出品する／保留／出品しない の判断');
    if (!DECISION_IDS.includes(decision)) throw new AppError(400, `decision が不正: ${decision}`);
    return this.mutate(id, actor, 'decision', (p, ctx) => {
      if (p.decision === decision) return;
      const labels = { undecided: '未定', sell: '出品する', hold: '保留', no_sell: '出品しない' };
      ctx.changes.push({ path: 'decision', label: '出品判断', from: labels[p.decision], to: labels[decision] });
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
    const kind = meta.kind || 'actual';
    if (!['actual', 'reference'].includes(kind)) throw new AppError(400, `kind が不正: ${kind}`);
    if (!files?.original?.buffer?.length) throw new AppError(400, '画像データがありません');
    const existing = meta.clientId && this.get(id).photos.find((ph) => ph.clientId === meta.clientId);
    if (existing) return { photo: existing, duplicate: true };
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
      source: meta.source || (kind === 'reference' ? 'reference' : 'camera'),
      tag: meta.tag && PHOTO_TAGS.includes(meta.tag) ? meta.tag : meta.tag || '',
      note: meta.note || '',
      sourceUrl: meta.sourceUrl || '',
      derivedFrom: meta.derivedFrom || null,
      edit: meta.edit || null,
      width: Number(meta.width) || null,
      height: Number(meta.height) || null,
      clientId: meta.clientId || null,
      takenAt: meta.takenAt || null,
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

    this.mutate(id, actor, 'photo_add', (p, ctx) => {
      p.photos.push(record);
      const kindLabel = kind === 'actual' ? (record.derivedFrom ? '編集写真' : '現物写真') : '参考画像';
      ctx.note(`${kindLabel}追加${record.tag ? `（${record.tag}）` : ''}`);
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
          const i = p.listingPhotoIds.indexOf(record.derivedFrom);
          if (i >= 0) p.listingPhotoIds[i] = pid;
        } else if (
          this.settings.autoSelectListingPhotos &&
          !record.derivedFrom &&
          !p.locks.listingPhotos &&
          p.listingPhotoIds.length < MERCARI_LIMITS.photosMax
        ) {
          p.listingPhotoIds.push(pid);
        }
      }
    });
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
        if (!['actual', 'reference'].includes(patch.kind)) throw new AppError(400, `kind が不正: ${patch.kind}`);
        if (patch.kind === 'actual') forbidAi(actor, '参考画像を現物写真に変更すること');
        ph.kind = patch.kind;
        if (ph.kind === 'reference') p.listingPhotoIds = p.listingPhotoIds.filter((x) => x !== ph.id);
        ctx.note(`写真の種別を「${ph.kind === 'actual' ? '現物写真' : '参考資料画像'}」に変更`);
        ctx.bump();
      }
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
      if (ph.kind !== 'actual') throw new AppError(400, `写真 ${x} は参考資料画像のため出品用にできません`);
    }
    if (uniq.length > MERCARI_LIMITS.photosMax) throw new AppError(400, `出品用写真は${MERCARI_LIMITS.photosMax}枚までです`);
    if (same(uniq, p.listingPhotoIds)) return false;
    p.listingPhotoIds = uniq;
    ctx.bump();
    return true;
  }

  /** Ordered selection of 出品用 photos. Only 現物 (actual) photos may be chosen. */
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
      ctx.note(summary || `${channel} 情報を更新`);
    });
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
  if (/mercari|fril\.jp|rakuma|aucfan|auctions\.yahoo/i.test(url)) return 'market';
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
