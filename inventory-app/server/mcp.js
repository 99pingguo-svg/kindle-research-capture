// MCP server (Streamable HTTP transport, stateless JSON responses) exposing the product
// ledger to Claude. Every write goes through the same Store rules as the UI, with the
// AI actor, so locks/proposals and user-only operations are enforced here too.
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './util.js';
import {
  STAGES, DECISIONS, MERCARI_CONDITIONS, SHIPPING_PAYERS, SHIPPING_METHODS, SHIPPING_DAYS, PREFECTURES,
  MERCARI_LIMITS, QC_CHECKS, PHOTO_TAGS, FACT_CONFIDENCE, LINK_TYPES, FIELDS, AI_TASK_TYPES,
} from './schema.js';
import { summary, readiness, lint, listingPhotos, livePhotos, openPhotoRequests } from './rules.js';
import { IMAGE_QC_CHECK_IDS } from './schema.js';
import * as mercari from './adapters/mercari.js';
import { importDates } from './dates.js';

const SERVER_INFO = { name: 'shohin-daicho', title: '商品台帳', version: '0.1.0' };
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `商品台帳（個人の商品在庫・メルカリ出品準備アプリ）へのアクセス。
原則:
- このアプリのデータが正本。メルカリはコピー先。
- 情報には確度を付ける: confirmed(確定)/reference(参考情報)/unverified(要確認)/unknown(不明)。推測を事実として書かない。
- 写真: kind=actual は現物写真、kind=reference は参考資料画像。参考画像は絶対に出品用にしない（サーバーも拒否する）。
- ユーザーが確定(🔒)した項目をAIが更新すると「提案」として保存され、ユーザーが採用するまで反映されない。
- 出品する/しない判断・公開承認・削除・「出品待ち」への移動はユーザーのみ。販売価格と商品の状態はユーザーの確定が必要。
- 作業の流れ: ai_task_queue → start_ai_task → get_product/get_photos → set_facts → save_listing_draft → save_qc_result → finish_ai_task。
- QC は get_reference_data の qcChecks を全項目評価し、足りない写真は photo_requests で依頼する。
- 画像QC（画質・写真間の整合性・違和感チェック）を含むQCは Claude Opus 5.5（claude-opus-5-5）が実施する。save_qc_result の model に実際のモデルIDを入れる。他モデルのQCは拒否される。
- QC PASS の前に、出品用写真をすべて get_photos(size=work) で実際に見ること（見ていない写真があると PASS できない）。
詳細手順はリポジトリの .claude/skills/ を参照。`;

const s = {
  id: { type: 'string', description: '商品ID（例: "0012"）' },
  str: (description) => ({ type: 'string', description }),
  int: (description) => ({ type: 'integer', description }),
  bool: (description) => ({ type: 'boolean', description }),
  enumOf: (values, description) => ({ type: 'string', enum: values, description }),
};

const LIST_FILTERS = ['all', 'sell', 'undecided', 'hold', 'no_sell', 'needs_photos', 'shot_today', 'shoot_plan', 'ai_queue', 'review', 'qc_issue', 'ready', 'queued', 'mercari', 'listed', 'sold', 'archived', 'trash'];

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const isToday = (iso) => {
  if (!iso) return false;
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === today();
};

export function matchesFilter(sm, filter) {
  const active = !sm.trashedAt && !sm.archived;
  switch (filter) {
    case 'all': return active;
    case 'sell': return active && sm.decision === 'sell' && sm.stage !== 'sold';
    case 'undecided': return active && sm.decision === 'undecided';
    case 'hold': return active && sm.decision === 'hold';
    case 'no_sell': return active && sm.decision === 'no_sell';
    case 'needs_photos': return active && sm.decision !== 'no_sell' && sm.stage !== 'sold' && (sm.counts.actual === 0 || sm.openPhotoRequests.length > 0 || sm.stage === 'needs_photos');
    case 'shot_today': return active && isToday(sm.lastPhotoAt);
    case 'shoot_plan': return active && sm.shootPlan;
    case 'ai_queue': return active && ['pending', 'processing'].includes(sm.ai.state);
    case 'review': return active && (sm.stage === 'needs_review' || sm.proposals > 0 || (sm.qc && sm.qc.result !== 'pass'));
    case 'qc_issue': return active && !!sm.qc && (sm.qc.result !== 'pass' || sm.qc.stale);
    case 'ready': return active && sm.stage === 'ready';
    case 'queued': return active && sm.stage === 'queued';
    case 'mercari': return active && ['mercari_entered', 'final_check'].includes(sm.stage);
    case 'listed': return active && sm.stage === 'listed';
    case 'sold': return !sm.trashedAt && sm.stage === 'sold';
    case 'archived': return !sm.trashedAt && sm.archived;
    case 'trash': return !!sm.trashedAt;
    default: return active;
  }
}

/** Product as the AI should see it: everything relevant, no filesystem noise. */
export function productForAi(store, p) {
  const order = new Map(p.listingPhotoIds.map((id, i) => [id, i + 1]));
  return {
    id: p.id,
    rev: p.rev,
    status: summary(p, store.settings).status,
    decision: p.decision,
    stage: p.stage,
    basic: Object.fromEntries(FIELDS.filter((f) => f.group === 'basic').map((f) => [f.path, p[f.path]])),
    listing: p.listing,
    confirmedByUser: Object.keys(p.locks),
    proposals: p.proposals,
    facts: p.facts,
    links: p.links,
    photos: livePhotos(p).map((ph) => ({
      id: ph.id, kind: ph.kind, tag: ph.tag, note: ph.note, by: ph.by, createdAt: ph.createdAt,
      derivedFrom: ph.derivedFrom, listingOrder: order.get(ph.id) || null, sourceUrl: ph.sourceUrl || undefined,
    })),
    listingPhotoIds: listingPhotos(p).map((x) => x.id),
    openPhotoRequests: openPhotoRequests(p),
    qc: p.qc ? { ...p.qc, stale: p.qc.rev !== p.rev } : null,
    readiness: readiness(p, store.settings),
    lint: lint(p, store.settings),
    aiTasks: p.aiTasks.slice(-5),
    channels: p.channels,
    archived: p.archived,
    trashedAt: p.trashedAt,
    updatedAt: p.updatedAt,
  };
}

/** Date sorts put products without a date last; ties fall back to ID. */
export function sortSummaries(sort) {
  return (a, b) => {
    if (sort === 'date_desc' || sort === 'date_asc') {
      if (!a.itemDate !== !b.itemDate) return a.itemDate ? -1 : 1;
      const c = (a.itemDate || '').localeCompare(b.itemDate || '');
      if (c) return sort === 'date_desc' ? -c : c;
      return sort === 'date_desc' ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id);
    }
    if (sort === 'updated') return b.updatedAt.localeCompare(a.updatedAt);
    return a.id.localeCompare(b.id);
  };
}

const json = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 1) }] });

/**
 * Photos each product's listing set the AI has actually looked at in full size
 * (get_photos size=work). QC PASS requires all current listing photos to be in here.
 * In-memory: after a server restart the AI simply has to look again.
 */
const photoViews = new Map();

function buildTools(store, actor) {
  const T = [];
  const tool = (name, description, properties, required, handler, annotations = {}) =>
    T.push({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, handler, annotations });

  tool('get_reference_data', '選択肢・制約・QCチェックリストなど、原稿作成やQCで使う定義を取得する。最初に一度呼ぶ。', {}, [], () =>
    json({
      stages: STAGES, decisions: DECISIONS, mercariConditions: MERCARI_CONDITIONS, shippingPayers: SHIPPING_PAYERS,
      shippingMethods: SHIPPING_METHODS, shippingDays: SHIPPING_DAYS, prefectures: PREFECTURES, limits: MERCARI_LIMITS,
      qcChecks: QC_CHECKS, photoTags: PHOTO_TAGS, factConfidence: FACT_CONFIDENCE, linkTypes: LINK_TYPES, aiTaskTypes: AI_TASK_TYPES,
      fields: FIELDS.map(({ path: p, label, type, options, confirm, max }) => ({ path: p, label, type, options, confirmRequired: !!confirm, max })),
      settings: store.settings, listFilters: LIST_FILTERS,
    }), { readOnlyHint: true });

  tool('inventory_overview', '在庫全体の状況（ステータス別件数、AIキュー、撮影依頼、今日撮影した商品数、メルカリ待ち）を返す。', {}, [], () => {
    const sms = store.list().map((p) => summary(p, store.settings));
    const byStatus = {};
    for (const sm of sms) byStatus[sm.status.label] = (byStatus[sm.status.label] || 0) + 1;
    const count = (f) => sms.filter((x) => matchesFilter(x, f)).length;
    return json({
      total: sms.filter((x) => !x.trashedAt).length, byStatus,
      aiQueue: count('ai_queue'), shotToday: count('shot_today'), needsPhotos: count('needs_photos'),
      review: count('review'), ready: count('ready'), mercariQueue: count('queued'), listed: count('listed'), sold: count('sold'),
    });
  }, { readOnlyHint: true });

  tool('list_products', '商品一覧（要約）を検索・絞り込みして返す。', {
    filter: s.enumOf(LIST_FILTERS, '絞り込み（既定 all = アーカイブ・ゴミ箱以外）'),
    query: s.str('商品名・型番・ブランド・JAN・メモの部分一致'),
    updated_since: s.str('ISO日時。これ以降に更新された商品のみ'),
    date_from: s.str('日付（注文・購入・到着）がこの日以降（YYYY-MM-DD）'),
    date_to: s.str('日付（注文・購入・到着）がこの日以前（YYYY-MM-DD）'),
    sort: s.enumOf(['date_desc', 'date_asc', 'id', 'updated'], '並び順（既定 date_desc。日付なしは末尾）'),
    limit: s.int('最大件数（既定100）'),
  }, [], ({ filter = 'all', query, updated_since, date_from, date_to, sort = 'date_desc', limit = 100 }) => {
    const q = (query || '').toLowerCase();
    let items = store.list().map((p) => summary(p, store.settings)).filter((sm) => matchesFilter(sm, filter));
    if (q) items = items.filter((sm) => [sm.id, sm.name, sm.brand, sm.model, sm.jan, sm.notes, sm.title].join(' ').toLowerCase().includes(q));
    if (updated_since) items = items.filter((sm) => sm.updatedAt >= updated_since);
    if (date_from) items = items.filter((sm) => sm.itemDate && sm.itemDate >= date_from);
    if (date_to) items = items.filter((sm) => sm.itemDate && sm.itemDate <= date_to);
    items.sort(sortSummaries(sort));
    return json(items.slice(0, limit).map(({ thumb, thumbIsReference, ...rest }) => rest));
  }, { readOnlyHint: true });

  tool('get_product', '商品の全情報（基本情報・確定済み項目・AI提案・整理済み情報・URL・写真一覧・撮影依頼・QC・準備状況・機械チェック・メルカリ状態）を返す。', { id: s.id }, ['id'],
    ({ id }) => json(productForAi(store, store.get(id))), { readOnlyHint: true });

  tool('get_photos', '商品の写真を画像として取得する。kind=listing は出品用の順番どおり。参考画像(reference)は出品に使わないこと。', {
    id: s.id,
    kind: s.enumOf(['actual', 'listing', 'reference', 'all'], '既定 all'),
    photo_ids: { type: 'array', items: { type: 'string' }, description: '特定の写真のみ' },
    size: s.enumOf(['thumb', 'work'], 'thumb=小(一覧確認用) / work=大(詳細確認用、既定)'),
    limit: s.int('最大枚数（既定 work:8 / thumb:20）'),
  }, ['id'], ({ id, kind = 'all', photo_ids, size = 'work', limit }) => {
    const p = store.get(id);
    let photos = kind === 'listing' ? listingPhotos(p) : livePhotos(p).filter((ph) => kind === 'all' || ph.kind === kind);
    if (photo_ids?.length) photos = livePhotos(p).filter((ph) => photo_ids.includes(ph.id));
    photos = photos.slice(0, limit || (size === 'thumb' ? 20 : 8));
    if (size === 'work') {
      const seen = photoViews.get(p.id) || new Set();
      for (const ph of photos) seen.add(ph.id);
      photoViews.set(p.id, seen);
    }
    const order = new Map(p.listingPhotoIds.map((x, i) => [x, i + 1]));
    const content = [{ type: 'text', text: `商品 ${p.id} ${p.name}: ${photos.length}枚` }];
    for (const ph of photos) {
      const file = path.join(store.dir(p.id), ph.files[size] || ph.files.work);
      let data;
      try {
        data = fs.readFileSync(file);
      } catch {
        content.push({ type: 'text', text: `[${ph.id}] ファイルが見つかりません` });
        continue;
      }
      const mime = /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg';
      content.push({ type: 'text', text: `[${ph.id}] ${ph.kind === 'actual' ? '現物写真' : '参考資料画像（出品不可）'}${ph.tag ? ` タグ:${ph.tag}` : ''}${order.get(ph.id) ? ` 出品用#${order.get(ph.id)}` : ''}${ph.derivedFrom ? ` 編集版(元:${ph.derivedFrom})` : ''}${ph.note ? ` メモ:${ph.note}` : ''}` });
      content.push({ type: 'image', data: data.toString('base64'), mimeType: mime });
    }
    return { content };
  }, { readOnlyHint: true });

  tool('create_products', '商品を登録する（ユーザーから受け取った商品一覧・URLの初期登録など）。重複の可能性がある場合は登録せず報告する（allow_duplicates=true で強制）。', {
    products: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, brand: { type: 'string' }, model: { type: 'string' }, jan: { type: 'string' },
          quantity: { type: 'integer' }, notes: { type: 'string' }, location: { type: 'string' },
          purchaseDate: { type: 'string' }, purchasePrice: { type: 'integer' }, plannedPrice: { type: 'integer' },
          links: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { url: { type: 'string' }, type: { type: 'string' }, title: { type: 'string' } }, required: ['url'] }] } },
        },
      },
    },
    allow_duplicates: s.bool('重複候補があっても登録する'),
  }, ['products'], ({ products, allow_duplicates = false }) => {
    const results = products.map((item) => {
      const { links = [], ...fields } = item;
      try {
        const { product, duplicates } = store.create(fields, actor, { links, allowDuplicate: allow_duplicates });
        return { ok: true, id: product.id, name: product.name, duplicates };
      } catch (e) {
        return { ok: false, name: item.name, error: e.message, duplicates: e.duplicates };
      }
    });
    return json(results);
  });

  tool('update_product', '基本情報・原稿の項目を更新する。fields のキーは get_reference_data の fields[].path（例: "model", "listing.title"）。ユーザー確定済み項目は提案として保存される。', {
    id: s.id,
    fields: { type: 'object', additionalProperties: true, description: '{ "path": value }' },
    reason: s.str('変更理由（提案時にユーザーへ表示）'),
  }, ['id', 'fields'], ({ id, fields, reason }) => {
    const r = store.updateFields(id, actor, fields, { reason });
    return json({ set: r.set, proposed: r.proposed, unchanged: r.unchanged, readiness: readiness(r.product, store.settings) });
  });

  tool('save_listing_draft', 'メルカリ用原稿（タイトル・説明・カテゴリー・状態・配送・価格・価格候補）を保存する。確定済み項目は提案扱い。価格と状態はユーザー確定が必要なので、根拠を price_candidates と reason に残すこと。', {
    id: s.id,
    title: s.str(`最大${MERCARI_LIMITS.titleMax}文字`),
    description: s.str(`最大${MERCARI_LIMITS.descriptionMax}文字。推測は書かない、要確認事項は書かない`),
    category: s.str('「>」区切りのメルカリカテゴリー'),
    brand: s.str('メルカリのブランド名'),
    condition: s.enumOf(MERCARI_CONDITIONS, '商品の状態'),
    price: s.int('販売価格の提案'),
    shippingPayer: s.enumOf(SHIPPING_PAYERS, ''),
    shippingMethod: s.enumOf(SHIPPING_METHODS, ''),
    shippingFrom: s.enumOf(PREFECTURES, ''),
    shippingDays: s.enumOf(SHIPPING_DAYS, ''),
    price_candidates: { type: 'array', items: { type: 'object', properties: { price: { type: 'integer' }, basis: { type: 'string' }, source: { type: 'string' } }, required: ['price', 'basis'] }, description: '価格候補と根拠（相場URLなど）' },
    ai_notes: s.str('ユーザー向けメモ（出品文には使われない）'),
    reason: s.str('変更理由'),
  }, ['id'], ({ id, price_candidates, ai_notes, reason, ...rest }) => {
    const set = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) set[`listing.${k}`] = v;
    if (ai_notes !== undefined) set['listing.aiNotes'] = ai_notes;
    const r = store.updateFields(id, actor, set, { reason });
    if (price_candidates) {
      store.mutate(id, actor, 'price_candidates', (p, ctx) => {
        p.listing.priceCandidates = price_candidates.map((c) => ({ price: c.price, basis: c.basis, source: c.source || '', by: actor }));
        ctx.note(`価格候補 ${price_candidates.map((c) => c.price.toLocaleString() + '円').join(' / ')}`);
      });
    }
    return json({ set: r.set, proposed: r.proposed, unchanged: r.unchanged, readiness: readiness(store.get(id), store.settings) });
  });

  tool('set_facts', '商品について整理した情報を確度付きで保存する（key単位でマージ）。例: {key:"model",label:"型番",value:"A1263",confidence:"confirmed",source:"本体ラベル写真"}', {
    id: s.id,
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' }, label: { type: 'string' }, value: { type: 'string' },
          confidence: { type: 'string', enum: FACT_CONFIDENCE.map((c) => c.id) }, source: { type: 'string', description: '根拠（写真ID・URL等）' },
        },
        required: ['key', 'label', 'value', 'confidence'],
      },
    },
    replace: s.bool('AIが以前保存した情報のうち今回含まれないものを消す（ユーザー入力分は残る）'),
  }, ['id', 'facts'], ({ id, facts, replace }) => json(store.setFacts(id, actor, facts, { replace }).facts));

  tool('set_listing_photos', '出品用写真（順番付き）を設定する。現物写真(actual)のIDのみ。1枚目がサムネイル。ユーザーが並べ替え済みなら提案扱い。', {
    id: s.id, photo_ids: { type: 'array', items: { type: 'string' } }, reason: s.str('理由'),
  }, ['id', 'photo_ids'], ({ id, photo_ids, reason }) => {
    const r = store.setListingPhotos(id, actor, photo_ids, { reason });
    return json({ proposed: r.proposed, listingPhotoIds: store.get(id).listingPhotoIds });
  });

  tool('add_link', '参考URLを登録する。', {
    id: s.id, url: s.str('URL'), type: s.enumOf(LINK_TYPES.map((t) => t.id), '種別'), title: s.str('タイトル'), note: s.str('メモ'),
  }, ['id', 'url'], ({ id, ...link }) => json(store.addLink(id, actor, link).links));

  tool('add_reference_image', '参考資料画像（公式サイト・購入ページの画像等）を商品に追加する。メルカリには使われない。', {
    id: s.id, url: s.str('画像URL'), note: s.str('説明'), source_page: s.str('画像の掲載ページURL'),
  }, ['id', 'url'], async ({ id, url, note, source_page }) => {
    store.get(id);
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 shohin-daicho' } });
    if (!res.ok) throw new AppError(502, `画像を取得できません: HTTP ${res.status}`);
    const mime = (res.headers.get('content-type') || '').split(';')[0];
    if (!mime.startsWith('image/')) throw new AppError(400, `画像ではありません: ${mime}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 15 * 1024 * 1024) throw new AppError(413, '画像が大きすぎます');
    const { photo } = store.addPhoto(id, actor, { kind: 'reference', source: 'url', note: note || '', sourceUrl: source_page || url }, { original: { buffer, mime } });
    return json({ photoId: photo.id, kind: 'reference' });
  });

  tool('save_qc_result', `AI QC の結果を保存する。必ず Claude Opus 5.5（model="claude-opus-5-5"）で実施すること（設定 imageQcModels 以外のモデルは拒否）。
手順: get_product → get_photos(kind=listing, size=work) で出品用写真を全部実際に見る → get_photos(kind=reference) で参考画像と比較 → 判定。
checks には次の全項目を評価して入れる（画像QC=group image は PASS に必須）: ${QC_CHECKS.map((c) => `${c.id}[${c.group}](${c.label})`).join(', ')}。
画像QCの観点: ピンぼけ・暗い・ブレ・白飛び・反射・傾き / 写真ごとに色・形状・型番ラベル・傷の位置が矛盾しないか（同一個体か） / 別商品・他人の物の混入、不自然な加工・合成、参考画像やスクショの混入、宛名・画面・顔など個人情報の写り込み。
result: pass=問題なし / needs_review=ユーザー確認が必要 / fail=修正が必要。不足・撮り直しが必要な写真は photo_requests に（例: "背面", "型番ラベル", "傷・汚れ"）。機械チェックのエラーがある間は pass にできない。`, {
    id: s.id,
    model: s.str('QCを実施したモデルID（例: "claude-opus-5-5"）。自分の実際のモデルIDを入れる'),
    result: s.enumOf(['pass', 'needs_review', 'fail'], ''),
    summary: s.str('一行要約（ユーザーに表示）'),
    checks: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, result: { type: 'string', enum: ['pass', 'warn', 'fail', 'na'] }, note: { type: 'string', description: '根拠（どの写真IDで何を確認したか）' } }, required: ['id', 'result'] } },
    issues: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['error', 'warn', 'info'] }, message: { type: 'string' }, field: { type: 'string' } }, required: ['message'] } },
    photo_requests: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { label: { type: 'string' }, reason: { type: 'string' } }, required: ['label'] }] } },
  }, ['id', 'model', 'result', 'summary', 'checks'], ({ id, model, result, summary: sum, checks, issues = [], photo_requests = [] }) => {
    if (result === 'pass') {
      const seen = photoViews.get(id) || new Set();
      const unseen = listingPhotos(store.get(id)).filter((ph) => !seen.has(ph.id)).map((ph) => ph.id);
      if (unseen.length) throw new AppError(400, `出品用写真のうち未確認の写真があります。get_photos(kind=listing, size=work) で確認してから PASS してください: ${unseen.join(', ')}`);
    }
    const p = store.saveQc(id, actor, { result, summary: sum, model, checks, issues, photoRequests: photo_requests });
    return json({ qc: p.qc, stage: p.stage, readiness: readiness(p, store.settings), imageChecks: IMAGE_QC_CHECK_IDS });
  });

  tool('request_photos', 'ユーザーに追加撮影を依頼する（一覧と撮影モードに表示され、そのタグで撮ると自動で完了になる）。ラベルは写真タグ（背面・型番ラベル・傷・汚れ 等）に合わせると良い。', {
    id: s.id, requests: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { label: { type: 'string' }, reason: { type: 'string' } }, required: ['label'] }] } },
  }, ['id', 'requests'], ({ id, requests }) => json(openPhotoRequests(store.addPhotoRequests(id, actor, requests))));

  tool('set_stage', 'ステータスを変更する。通常は自動遷移に任せる。AIは queued(出品待ち)/listed(出品中) には変更できない。', {
    id: s.id, stage: s.enumOf(STAGES.map((x) => x.id), ''), note: s.str('理由'),
  }, ['id', 'stage'], ({ id, stage, note }) => json(summary(store.setStage(id, actor, stage, { note }), store.settings)));

  tool('ai_task_queue', 'ユーザーがアプリから依頼したAIタスク（整理・原稿・QC等）の一覧。古い順。', {
    include_processing: s.bool('処理中のものも含める'),
  }, [], ({ include_processing = false }) => {
    const items = [];
    for (const p of store.list({ includeTrash: false })) {
      for (const t of p.aiTasks) {
        if (t.status === 'pending' || (include_processing && t.status === 'processing')) items.push({ productId: p.id, name: p.name, stage: p.stage, task: t });
      }
    }
    items.sort((a, b) => a.task.requestedAt.localeCompare(b.task.requestedAt));
    return json(items);
  }, { readOnlyHint: true });

  tool('start_ai_task', 'AIタスクを処理中にする（アプリ上で「AI処理中」と表示される）。', { id: s.id, task_id: s.str('タスクID') }, ['id', 'task_id'],
    ({ id, task_id }) => json(store.startAiTask(id, actor, task_id).aiTasks.find((t) => t.id === task_id)));

  tool('finish_ai_task', 'AIタスクを完了／エラーにする。message はユーザー向けの短い結果報告。', {
    id: s.id, task_id: s.str('タスクID'), status: s.enumOf(['done', 'error'], ''), message: s.str('結果'),
  }, ['id', 'task_id', 'status'], ({ id, task_id, status, message }) => {
    const p = store.finishAiTask(id, actor, task_id, { status, message });
    return json({ stage: p.stage, readiness: readiness(p, store.settings) });
  });

  tool('find_duplicates', '重複登録の可能性がある商品を探す。id を渡すとその商品と似た商品を探す。', {
    id: s.id, name: s.str(''), model: s.str(''), jan: s.str(''), urls: { type: 'array', items: { type: 'string' } },
  }, [], ({ id, name, model, jan, urls = [] }) => {
    if (id) {
      const p = store.get(id);
      return json(store.duplicatesFor(p, p.id));
    }
    return json(store.duplicatesFor({ name, model, jan, links: urls }));
  }, { readOnlyHint: true });

  tool('apply_dates', '日付（注文・購入・到着を区別しない1つの日付）を既存商品へ一括反映する。text は「商品名<TAB>URL<TAB>日付…」の行。Amazon ASIN → URL完全一致 → 商品名完全一致(双方で一意の場合のみ) の順で照合し、該当しない行は無視（新規登録しない）。まず dry_run=true で結果を確認してから dry_run=false で反映すること。', {
    text: s.str('貼り付けられた一覧（TSV等）'),
    dry_run: s.bool('true=確認のみ（既定）'),
    include_lines: { type: 'array', items: { type: 'integer' }, description: '要確認(ambiguous/conflict)の行のうち、ユーザーが反映を了承した行番号' },
  }, ['text'], ({ text, dry_run = true, include_lines = [] }) => {
    const r = importDates(store, actor, { text, dryRun: dry_run, include: include_lines });
    const brief = r.rows.filter((x) => x.status !== 'same').map(({ line, name, date, status, matchedBy, candidates }) => ({ line, name: name.slice(0, 40), date, status, matchedBy, ids: candidates.map((c) => c.id) }));
    return json({ total: r.total, counts: r.counts, applied: r.applied.length, proposed: r.applied.filter((a) => a.proposed).length, errors: r.errors, rows: brief });
  });

  tool('get_history', '商品の変更履歴（誰が何を変えたか）。', { id: s.id, limit: s.int('既定30') }, ['id'],
    ({ id, limit = 30 }) => json(store.history(id, { limit })), { readOnlyHint: true });

  // ---- Mercari Adapter ----
  tool('mercari_queue', 'ユーザーが「出品待ち」にした、メルカリへ転記すべき商品の一覧。', {}, [], () =>
    json(mercari.queue(store).map((p) => ({ id: p.id, name: p.name, title: p.listing.title, price: p.listing.price, photos: listingPhotos(p).length }))), { readOnlyHint: true });

  tool('mercari_prepare', 'メルカリ転記用パッケージを作る。出品用写真を outbox に 01.jpg… として書き出し、フォームの意味的な項目一覧（form）と入力値（fields）を返す。準備未完了ならエラー。', { id: s.id }, ['id'],
    ({ id }) => json(mercari.buildPackage(store, id)));

  tool('mercari_record_entry', 'メルカリWebへの入力（原則 下書き保存）が終わったことを記録する。ステータスが「メルカリ入力済み」になる。', {
    id: s.id, saved_as: s.enumOf(['draft', 'unsaved_form'], 'draft=下書き保存済み / unsaved_form=入力済み・未保存'), draft_url: s.str('下書きのURL（あれば）'), note: s.str(''),
  }, ['id'], ({ id, saved_as = 'draft', draft_url, note }) => json(mercari.recordEntry(store, id, actor, { savedAs: saved_as, draftUrl: draft_url, note }).channels.mercari));

  tool('mercari_verify_entry', '転記QC: メルカリ画面に実際に入っている内容を observed に入れて送ると、アプリ内の正本と機械的に照合して記録する。全項目 PASS で「最終確認待ち」へ。', {
    id: s.id,
    observed: {
      type: 'object',
      properties: {
        title: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, brand: { type: 'string' },
        condition: { type: 'string' }, shippingPayer: { type: 'string' }, shippingMethod: { type: 'string' }, shippingFrom: { type: 'string' },
        shippingDays: { type: 'string' }, price: { type: 'integer' }, photoCount: { type: 'integer' },
        photoOrderOk: { type: 'boolean', description: '写真の順番が outbox の番号順と一致' },
        photosMatchProduct: { type: 'boolean', description: '写真がこの商品の現物写真である' },
        productMatches: { type: 'boolean', description: '画面の商品がこの商品IDのものである' },
        notes: { type: 'string' },
      },
    },
  }, ['id', 'observed'], ({ id, observed }) => json(mercari.recordVerification(store, id, actor, observed)));

  tool('mercari_mark_listed', 'メルカリで公開されたことを記録する。AIが公開ボタンを押せるのは、ユーザーがアプリで「公開を承認」した後だけ。', {
    id: s.id, item_url: s.str('公開後の商品ページURL'), price: s.int('公開時の価格'),
  }, ['id'], ({ id, item_url, price }) => json(mercari.markListed(store, id, actor, { itemUrl: item_url, price }).channels.mercari));

  tool('mercari_mark_sold', 'メルカリで売れたことを記録する。', { id: s.id, price: s.int('売却価格') }, ['id'],
    ({ id, price }) => json(mercari.markSold(store, id, actor, { price }).channels.mercari));

  return T;
}

const PROMPTS = [
  {
    name: 'process_today',
    title: '今日撮った商品の出品準備',
    description: '今日撮影した商品を全部確認して出品準備を進める',
    text: '商品台帳で今日撮影した商品（list_products filter=shot_today）と AI タスクキューを全部処理して、出品準備を進めてください。各商品について 情報整理 → 原稿作成 → QC を行い、足りない写真は request_photos で依頼してください。最後に「N商品中M商品が準備完了、残りは何が必要か」をまとめてください。',
  },
  {
    name: 'process_queue',
    title: 'AIタスクキューを処理',
    description: 'アプリから依頼されたAIタスクを順に処理する',
    text: '商品台帳の ai_task_queue を古い順に処理してください。1商品ずつ start_ai_task → 作業 → finish_ai_task。1件の失敗で止めず、最後に結果をまとめてください。',
  },
  {
    name: 'mercari_transfer',
    title: 'メルカリへ転記',
    description: '出品待ちの商品をメルカリWebへ下書き入力し、転記QCする',
    text: '商品台帳の mercari_queue の商品を、.claude/skills/mercari-adapter/SKILL.md の手順でメルカリWebに下書き入力し、mercari_verify_entry で転記QCしてください。公開ボタンは押さないでください。',
  },
];

export function createMcpHandler(store) {
  return async function handle(msg, { actor }) {
    const tools = buildTools(store, actor);
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map((m) => handle(m, { actor })))).filter(Boolean);
      return out.length ? out : null;
    }
    const { id, method, params = {} } = msg || {};
    const isNotification = id === undefined || id === null;
    const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
    const fail = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });
    try {
      switch (method) {
        case 'initialize': {
          const requested = params.protocolVersion;
          return reply({
            protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
            capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          });
        }
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) });
        case 'tools/call': {
          const t = tools.find((x) => x.name === params.name);
          if (!t) return fail(-32602, `Unknown tool: ${params.name}`);
          try {
            return reply(await t.handler(params.arguments || {}));
          } catch (e) {
            return reply({ isError: true, content: [{ type: 'text', text: e.message }] });
          }
        }
        case 'prompts/list':
          return reply({ prompts: PROMPTS.map(({ name, title, description }) => ({ name, title, description })) });
        case 'prompts/get': {
          const pr = PROMPTS.find((x) => x.name === params.name);
          if (!pr) return fail(-32602, `Unknown prompt: ${params.name}`);
          return reply({ description: pr.description, messages: [{ role: 'user', content: { type: 'text', text: pr.text } }] });
        }
        case 'resources/list':
          return reply({ resources: [] });
        default:
          if (method?.startsWith('notifications/')) return null;
          return fail(-32601, `Method not found: ${method}`);
      }
    } catch (e) {
      return fail(-32603, e.message);
    }
  };
}
