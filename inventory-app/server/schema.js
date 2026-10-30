// Domain constants shared by the server, the MCP tools and (via /api/meta) the UI.

import { CATEGORIES } from './category.js';

/** Workflow stage. Independent from the sell/hold/no-sell decision so toggling "保留" never loses progress. */
export const STAGES = [
  { id: 'unsorted', label: '未整理' },
  { id: 'needs_photos', label: '撮影待ち' },
  { id: 'shooting', label: '撮影中' },
  { id: 'ai_pending', label: 'AI整理待ち' },
  { id: 'ai_processing', label: 'AI整理中' },
  { id: 'needs_review', label: '要確認' },
  { id: 'ready', label: '出品準備完了' },
  { id: 'queued', label: '出品待ち' },
  { id: 'mercari_entered', label: 'メルカリ入力済み' },
  { id: 'final_check', label: '最終確認待ち' },
  { id: 'listed', label: '出品中' },
  { id: 'trading', label: '取引中' },
  { id: 'sold', label: '売却済み' },
];

/** Where a product can be offered. Each channel keeps its own status under product.channels[id]. */
export const CHANNELS = [
  { id: 'mercari', label: 'メルカリ' },
  { id: 'jmty', label: 'ジモティー' },
  { id: 'yahoo', label: 'ヤフオク' },
  { id: 'paypay', label: 'ヤフーフリマ', short: 'Yフリマ' },
  { id: 'rakuma', label: 'ラクマ' },
  { id: 'flea', label: 'フリマ', note: '会場のフリーマーケット（オンラインの出品作業はなし。値札・持ち物の準備用）' },
];
export const CHANNEL_IDS = CHANNELS.map((c) => c.id);
export const channelLabel = (id) => CHANNELS.find((c) => c.id === id)?.label ?? id;
/** Statuses observed on a platform's own pages (what the platform shows), shared by all channels. */
export const OBSERVED_STATUSES = [
  { id: 'draft', label: '下書き' },
  { id: 'listed', label: '出品中' },
  { id: 'stopped', label: '公開停止中' },
  { id: 'trading', label: '取引中（注文あり）' },
  { id: 'sold', label: '売却済み' },
  { id: 'removed', label: '見つからない（削除済み？）' },
];
/** Channel statuses that mean the item is committed to a buyer there. */
export const COMMITTED_STATUSES = ['trading', 'sold'];
/** Channel statuses that mean the item is still offered there. */
export const OFFERED_STATUSES = ['entered', 'transfer_ok', 'transfer_ng', 'listed'];
export const STAGE_IDS = STAGES.map((s) => s.id);
export const STAGE_ORDER = Object.fromEntries(STAGE_IDS.map((id, i) => [id, i]));
export const stageLabel = (id) => STAGES.find((s) => s.id === id)?.label ?? id;

export const DECISIONS = [
  { id: 'undecided', label: '未定' },
  { id: 'sell', label: '出品' },
  { id: 'draft', label: '下書き' },
  { id: 'hold', label: '保留' },
  { id: 'no_sell', label: '出さない' },
  { id: 'no_stock', label: '在庫なし' },
];
export const DECISION_IDS = DECISIONS.map((d) => d.id);
export const decisionLabel = (id) => DECISIONS.find((d) => d.id === id)?.label ?? id;
/** Decisions that move a product through preparation. 'draft' goes as far as a saved Mercari draft and is never published. */
export const PREPARE_DECISIONS = ['sell', 'draft'];

/** Stages the AI may never move a product into on its own. */
export const USER_ONLY_STAGES = new Set(['queued', 'listed']);

export const MERCARI_CONDITIONS = [
  '新品、未使用',
  '未使用に近い',
  '目立った傷や汚れなし',
  'やや傷や汚れあり',
  '傷や汚れあり',
  '全体的に状態が悪い',
];
export const SHIPPING_PAYERS = ['送料込み（出品者負担）', '着払い（購入者負担）'];
export const SHIPPING_METHODS = [
  '未定',
  'らくらくメルカリ便',
  'ゆうゆうメルカリ便',
  '梱包・発送たのメル便',
  'エコメルカリ便',
  '普通郵便(定形、定形外)',
  'クロネコヤマト',
  'ゆうパック',
  'クリックポスト',
  'ゆうパケット',
  'レターパック',
];
export const SHIPPING_DAYS = ['1~2日で発送', '2~3日で発送', '4~7日で発送'];
export const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
  '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
  '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県', '未定',
];

export const MERCARI_LIMITS = { titleMax: 40, descriptionMax: 1000, priceMin: 300, priceMax: 9999999, photosMax: 20 };

export const LINK_TYPES = [
  { id: 'purchase', label: '購入元' },
  { id: 'official', label: '公式' },
  { id: 'maker', label: 'メーカー情報' },
  { id: 'manual', label: '取扱説明書' },
  { id: 'review', label: '商品説明・レビュー' },
  { id: 'market', label: '相場・販売履歴' },
  { id: 'other', label: 'その他' },
];

/** Quick tags offered in the camera; also used by AI QC to judge photo coverage. */
export const PHOTO_TAGS = ['全体', '正面', '背面', '側面', '上面', '底面', '型番ラベル', '付属品', '箱・パッケージ', '傷・汚れ', '動作確認', 'その他'];

export const PHOTO_KINDS = [
  { id: 'actual', label: '現物写真', note: 'ユーザーが撮影した現物。出品用画像はここから選ぶ。' },
  { id: 'generated', label: '生成画像', note: 'AIで作った紹介画像（画像内に「AI生成・実物と異なる場合あり」と明記）。出品用に選べるが現物写真ではない。' },
  { id: 'reference', label: '参考資料画像', note: '公式・購入ページ等の画像。メルカリへはアップロードしない。' },
];
export const PHOTO_KIND_IDS = PHOTO_KINDS.map((k) => k.id);
/** Kinds that may be chosen as 出品用 photos. */
export const LISTABLE_KINDS = ['actual', 'generated'];

export const FACT_CONFIDENCE = [
  { id: 'confirmed', label: '確定' },
  { id: 'reference', label: '参考情報' },
  { id: 'unverified', label: '要確認' },
  { id: 'unknown', label: '不明' },
];

export const AI_TASK_TYPES = [
  { id: 'full', label: 'まとめて（整理→原稿→QC）' },
  { id: 'organize', label: '商品整理' },
  { id: 'draft', label: '出品原稿作成' },
  { id: 'qc', label: 'AI QC' },
  { id: 'price', label: '価格調査' },
  { id: 'transfer', label: 'メルカリ転記' },
];

/**
 * Section 18 of the plan, as a structured checklist the AI fills in.
 * group 'image' = checks that require actually looking at the photos. These form the
 * 画像QC and must be performed by a model listed in settings.imageQcModels (Claude Opus 5.5).
 */
export const QC_CHECKS = [
  { id: 'image_quality', group: 'image', label: '画質: ピント・明るさ・ブレ・白飛び・反射が出品に耐える' },
  { id: 'image_consistency', group: 'image', label: '画像の整合性: 全写真が同一個体で、色・型番・付属品が写真間で矛盾しない' },
  { id: 'image_anomaly', group: 'image', label: '違和感: 別商品の混入・不自然な加工/合成・参考画像の混入・私物や個人情報（宛名・画面等）の写り込みがない' },
  { id: 'photo_matches_name', group: 'image', label: '写真と商品名が一致している' },
  { id: 'color_matches', group: 'image', label: '色が一致している' },
  { id: 'condition_consistent', group: 'image', label: '現物写真と状態説明が矛盾していない' },
  { id: 'no_unphotographed_accessories', group: 'image', label: '写真にない付属品を書いていない' },
  { id: 'photo_coverage', group: 'image', label: '必要な写真（背面・型番・傷など）が揃っている' },
  { id: 'model_matches', group: 'content', label: '型番が一致している' },
  { id: 'quantity_matches', group: 'content', label: '数量が一致している' },
  { id: 'accessories_correct', group: 'content', label: '付属品の記載が正しい' },
  { id: 'reference_same_model', group: 'content', label: '参考ページの商品と現物が同一モデル' },
  { id: 'no_reference_in_listing', group: 'content', label: '参考画像を出品画像にしていない' },
  { id: 'no_exaggeration', group: 'content', label: '誇張・断定しすぎた説明がない' },
  { id: 'no_guess_as_fact', group: 'content', label: 'AIの推測を事実として書いていない' },
  { id: 'price_sane', group: 'content', label: '価格等に明らかな入力ミスがない' },
];
export const IMAGE_QC_CHECK_IDS = QC_CHECKS.filter((c) => c.group === 'image').map((c) => c.id);

/**
 * Editable fields. `confirm: true` marks fields that need an explicit user
 * confirmation (🔒) before the product can become 出品準備完了.
 */
export const FIELDS = [
  { path: 'name', label: '商品名', type: 'text', group: 'basic' },
  { path: 'itemDate', label: '日付（どれか・区別しない）', type: 'date', group: 'basic', meta: true, hint: '注文日か到着日か分からない日付。分かるときは下の欄へ' },
  { path: 'orderDate', label: '注文日・購入日', type: 'date', group: 'basic', meta: true },
  { path: 'arrivalDate', label: '到着日', type: 'date', group: 'basic', meta: true },
  { path: 'category', label: '種類', type: 'select', options: CATEGORIES, group: 'basic', meta: true, hint: '未設定なら商品名から推定して一覧に表示' },
  { path: 'brand', label: 'メーカー／ブランド', type: 'text', group: 'basic' },
  { path: 'model', label: '型番', type: 'text', group: 'basic' },
  { path: 'jan', label: 'JAN等', type: 'text', group: 'basic' },
  // Amazon の倉庫ラベル（X00…10桁）。写真の文字・バーコードから自動で読む。検索・📷で使う。
  { path: 'fnsku', label: 'Amazon管理番号（FNSKU）', type: 'text', group: 'basic', meta: true },
  { path: 'quantity', label: '数量', type: 'int', group: 'basic' },
  { path: 'color', label: '色', type: 'text', group: 'basic' },
  { path: 'conditionNote', label: '商品状態メモ', type: 'textarea', group: 'basic' },
  { path: 'notes', label: 'メモ', type: 'textarea', group: 'basic' },
  { path: 'purchaseDate', label: '購入時期（メモ）', type: 'text', group: 'basic' },
  { path: 'purchasePrice', label: '購入価格', type: 'int', group: 'basic' },
  { path: 'plannedPrice', label: '出品予定価格', type: 'int', group: 'basic' },
  { path: 'soldPrice', label: '実際の販売価格', type: 'int', group: 'basic' },
  { path: 'location', label: '保管場所', type: 'text', group: 'basic' },

  { path: 'listing.title', label: 'タイトル', type: 'text', group: 'listing', max: MERCARI_LIMITS.titleMax },
  { path: 'listing.description', label: '商品説明', type: 'textarea', group: 'listing', max: MERCARI_LIMITS.descriptionMax },
  { path: 'listing.category', label: 'カテゴリー', type: 'text', group: 'listing', hint: '例: 家電・スマホ・カメラ > スマホアクセサリー > モバイルバッテリー' },
  { path: 'listing.brand', label: 'ブランド（メルカリ）', type: 'text', group: 'listing' },
  { path: 'listing.condition', label: '商品の状態', type: 'select', options: MERCARI_CONDITIONS, group: 'listing', confirm: true },
  { path: 'listing.price', label: '販売価格', type: 'int', group: 'listing', confirm: true },
  { path: 'listing.shippingPayer', label: '配送料の負担', type: 'select', options: SHIPPING_PAYERS, group: 'listing' },
  { path: 'listing.shippingMethod', label: '配送の方法', type: 'select', options: SHIPPING_METHODS, group: 'listing' },
  { path: 'listing.shippingFrom', label: '発送元の地域', type: 'select', options: PREFECTURES, group: 'listing' },
  { path: 'listing.shippingDays', label: '発送までの日数', type: 'select', options: SHIPPING_DAYS, group: 'listing' },
  { path: 'listing.aiNotes', label: 'AIメモ（出品には使わない）', type: 'textarea', group: 'listing' },
];
// Per-destination versions of the listing text. Empty = use the common listing (listing.*).
for (const c of CHANNELS) {
  const lim = c.id === 'mercari' ? MERCARI_LIMITS : {};
  FIELDS.push(
    { path: `override.${c.id}.title`, label: `${c.label}のタイトル`, type: 'text', group: `channel:${c.id}`, channel: c.id, base: 'listing.title', ...(lim.titleMax ? { max: lim.titleMax } : {}) },
    { path: `override.${c.id}.description`, label: `${c.label}の説明`, type: 'textarea', group: `channel:${c.id}`, channel: c.id, base: 'listing.description', ...(lim.descriptionMax ? { max: lim.descriptionMax } : {}) },
    { path: `override.${c.id}.price`, label: `${c.label}の価格`, type: 'int', group: `channel:${c.id}`, channel: c.id, base: 'listing.price' },
  );
}
export const FIELD_MAP = Object.fromEntries(FIELDS.map((f) => [f.path, f]));
export const CONFIRM_FIELDS = FIELDS.filter((f) => f.confirm).map((f) => f.path);

export const DEFAULT_SETTINGS = {
  shippingPayer: '送料込み（出品者負担）',
  shippingMethod: '',
  shippingFrom: '',
  shippingDays: '2~3日で発送',
  /** New camera photos are added to the 出品用 selection automatically (can be removed). */
  autoSelectListingPhotos: true,
  /** Minimum listing photos before QC stops warning. */
  recommendedPhotos: 3,
  aiActorName: 'claude',
  /** Models allowed to perform AI QC (incl. 画像QC). QC from any other model is rejected. */
  imageQcModels: ['claude-opus-5-5'],
  /** 撮った写真を自動で仕上げる（白背景・トリミング・色補正、Mac 上で処理。元写真は残す）。 */
  autoStudio: true,
  studioStyle: 'auto', // 自動仕上げの主の背景: auto（白っぽい商品はグレー、ほかは白）／white／grey。もう一方も候補として作る
  studioDeshadow: 0.6, // 自動仕上げで商品に落ちた影を明るく戻す強さ（0=しない〜1）
  // 安い商品は出品先にフリマを既定で入れる（商品ごとに1回。手で変えたらそのまま）
  fleaDefault: { on: true, amazonMax: 1000, netMax: 700 },
  // 手取りのおすすめ: 一番よいサイトと、差が margin 円以内 または ratio 以内のサイトを出品先に入れる（緑で表示）
  netDefault: { on: true, margin: 100, ratio: 0.1 },
  /** 一覧の「保存した表示」（絞り込み・並び順の組み合わせ）。全端末で共有。 */
  listViews: [],
};

/**
 * Normalise a calendar date to YYYY-MM-DD. Accepts 2026-09-23, 2026/9/23, 2026.09.23,
 * 2026年9月23日. Returns null for anything that is not a real date.
 */
export function normalizeDate(raw) {
  const s = String(raw ?? '').normalize('NFKC').trim();
  const m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function coerceField(def, raw) {
  if (raw === undefined) throw new Error('値がありません');
  if (raw === null || raw === '') return def.type === 'int' ? null : '';
  if (def.type === 'int') {
    const n = Number(String(raw).normalize('NFKC').replace(/[,円¥\s]/g, ''));
    if (!Number.isFinite(n)) throw new Error(`${def.label}は数値で入力してください`);
    return Math.round(n);
  }
  const s = String(raw);
  if (def.type === 'date') {
    const d = normalizeDate(s);
    if (!d) throw new Error(`${def.label}は 2026-09-23 の形式で入力してください: ${s}`);
    return d;
  }
  if (def.type === 'select' && s && !def.options.includes(s)) {
    throw new Error(`${def.label}の値が不正です: ${s}（候補: ${def.options.join(' / ')}）`);
  }
  return def.type === 'textarea' ? s.replace(/\r\n/g, '\n') : s.trim();
}
