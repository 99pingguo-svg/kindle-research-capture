// 送り方と送料の目安（同じ物をメルカリで送るとしたら）。
// 料金・サイズは メルカリ公式「送料一覧」（2026年1月時点の表、jp-news.mercari.com/contents/1882）と日本郵便の料金。
// 改定されたらこの表だけ直す。専用資材が要るものは資材代込みの金額。

const box = (L, W, H) => ({ L, W, H });
const fitsBox = (d, b) => d.L <= b.L && d.W <= b.W && d.H <= b.H;
const sum = (d) => d.L + d.W + d.H;

/** Weight steps: [maxKg, price]. */
const byWeight = (steps) => (kg) => {
  if (kg == null) return null;
  const s = steps.find(([max]) => kg <= max);
  return s ? s[1] : null;
};

const SIZE_STEPS = (rows, maxSum) => rows.map(([size, kg, price]) => ({ size, kg, price, maxSum }));

export const SHIPPING_GROUPS = [
  { id: 'rakuraku', label: 'らくらくメルカリ便', mercari: true },
  { id: 'yuyu', label: 'ゆうゆうメルカリ便', mercari: true },
  { id: 'eco', label: 'エコメルカリ便', mercari: true },
  { id: 'tanomeru', label: 'たのメル便', mercari: true },
  { id: 'post', label: '郵便（自分で手配）', mercari: false },
];

/**
 * Each method: fits(d, kg) → price | null. d = { L, W, H } in cm (L ≥ W ≥ H), kg may be null (unknown).
 * Unknown weight is treated as "fits" for size-priced methods (most small items are light) and
 * as "can't price" for weight-priced ones (定形外).
 */
const okKg = (kg, max) => kg == null || kg <= max;
export const SHIPPING_METHODS = [
  { id: 'yupacket_mini', group: 'yuyu', label: 'ゆうパケットポストmini', note: '専用封筒21×17cm', fits: (d, kg) => (fitsBox(d, box(19, 15, 2.5)) && okKg(kg, 2) ? 160 : null) },
  { id: 'nekopos', group: 'rakuraku', label: 'ネコポス', note: 'A4・厚さ3cm・1kg', fits: (d, kg) => (fitsBox(d, box(31.2, 22.8, 3)) && okKg(kg, 1) ? 210 : null) },
  { id: 'yupacket_post', group: 'yuyu', label: 'ゆうパケットポスト（シール）', note: '3辺60cm・長辺34cm・厚さ3cm・2kg', fits: (d, kg) => (d.L <= 34 && d.H <= 3 && sum(d) <= 60 && okKg(kg, 2) ? 220 : null) },
  { id: 'yupacket', group: 'yuyu', label: 'ゆうパケット', note: '3辺60cm・長辺34cm・厚さ3cm・1kg', fits: (d, kg) => (d.L <= 34 && d.H <= 3 && sum(d) <= 60 && okKg(kg, 1) ? 230 : null) },
  { id: 'yupacket_plus', group: 'yuyu', label: 'ゆうパケットプラス', note: '専用箱24×17×7cm・2kg（箱65円込み）', fits: (d, kg) => (fitsBox(d, box(24, 17, 7)) && okKg(kg, 2) ? 520 : null) },
  { id: 'compact', group: 'rakuraku', label: '宅急便コンパクト', note: '専用箱25×20×5cm（箱70円込み）', fits: (d) => (fitsBox(d, box(25, 20, 5)) ? 520 : null) },
  { id: 'eco', group: 'eco', label: 'エコメルカリ便', note: '3辺100cm・10kg・到着まで日数がかかる', fits: (d, kg) => (sum(d) <= 100 && okKg(kg, 10) ? 730 : null) },
  {
    id: 'takkyubin', group: 'rakuraku', label: '宅急便', sized: true,
    steps: SIZE_STEPS([[60, 2, 750], [80, 5, 850], [100, 10, 1050], [120, 15, 1200], [140, 20, 1450], [160, 25, 1700], [180, 30, 2100], [200, 30, 2500]]),
  },
  {
    id: 'yupack', group: 'yuyu', label: 'ゆうパック', sized: true,
    steps: SIZE_STEPS([[60, 25, 770], [80, 25, 870], [100, 25, 1070], [120, 25, 1200], [140, 25, 1450], [160, 25, 1700], [170, 25, 1900]]),
  },
  {
    id: 'tanomeru', group: 'tanomeru', label: 'たのメル便', sized: true, note: '梱包から発送まで任せる大型向け',
    steps: SIZE_STEPS([[80, 999, 1700], [120, 999, 2400], [160, 999, 3400], [200, 999, 5000], [250, 999, 8600], [300, 999, 12000]]),
  },
  { id: 'clickpost', group: 'post', label: 'クリックポスト', note: '34×25×3cm・1kg', fits: (d, kg) => (fitsBox(d, box(34, 25, 3)) && okKg(kg, 1) ? 185 : null) },
  { id: 'smartletter', group: 'post', label: 'スマートレター', note: '25×17×2cm・1kg', fits: (d, kg) => (fitsBox(d, box(25, 17, 2)) && okKg(kg, 1) ? 210 : null) },
  { id: 'teikeigai', group: 'post', label: '定形外（規格内）', note: '34×25×3cm・1kg・重さで料金', fits: (d, kg) => (fitsBox(d, box(34, 25, 3)) ? byWeight([[0.05, 140], [0.1, 180], [0.15, 270], [0.25, 320], [0.5, 510], [1, 750]])(kg) : null) },
  { id: 'teikeigai_big', group: 'post', label: '定形外（規格外）', note: '長辺60cm・3辺90cm・4kg・重さで料金', fits: (d, kg) => (d.L <= 60 && sum(d) <= 90 ? byWeight([[0.05, 260], [0.1, 290], [0.15, 390], [0.25, 450], [0.5, 660], [1, 920], [2, 1350], [4, 1750]])(kg) : null) },
  { id: 'letterpack_light', group: 'post', label: 'レターパックライト', note: '34×24.8×3cm・4kg', fits: (d, kg) => (fitsBox(d, box(34, 24.8, 3)) && okKg(kg, 4) ? 430 : null) },
  { id: 'letterpack_plus', group: 'post', label: 'レターパックプラス', note: '34×24.8cm・封筒が閉じれば厚さ自由・4kg（目安7cm）', fits: (d, kg) => (fitsBox(d, box(34, 24.8, 7)) && okKg(kg, 4) ? 600 : null) },
];
for (const m of SHIPPING_METHODS) {
  if (!m.sized) continue;
  m.fits = (d, kg) => {
    const s = m.steps.find((st) => sum(d) <= st.size && okKg(kg, st.kg));
    return s ? s.price : null;
  };
  m.note = m.note || `${m.steps[0].size}〜${m.steps.at(-1).size}サイズ`;
}
const groupOf = (id) => SHIPPING_GROUPS.find((g) => g.id === id);

/** Size classes for sorting the shelf: thin (mailbox) → small box → courier sizes. */
export const SIZE_CLASSES = [
  { id: 'thin', label: '薄型（厚さ3cm・A4以内）' },
  { id: 'small', label: '小箱（コンパクト箱に入る）' },
  { id: 's60', label: '60サイズ' },
  { id: 's80', label: '80サイズ' },
  { id: 's100', label: '100サイズ' },
  { id: 's120', label: '120サイズ' },
  { id: 's140', label: '140サイズ' },
  { id: 's160', label: '160サイズ' },
  { id: 'big', label: '160超' },
  { id: 'unknown', label: 'サイズ不明' },
];

/** Bands of the cheapest Mercari shipping (what a buyer-facing price has to absorb). */
export const SHIP_BANDS = [
  { id: 'b230', label: '〜¥230（ポスト投函）', max: 230 },
  { id: 'b520', label: '〜¥520（小箱）', max: 520 },
  { id: 'b870', label: '〜¥870（60〜80）', max: 870 },
  { id: 'b1200', label: '〜¥1,200（100〜120）', max: 1200 },
  { id: 'b1201', label: '¥1,201〜（大型）', max: Infinity },
  { id: 'unknown', label: '送料不明', max: null },
];

function sizeClassOf(d) {
  if (!d) return 'unknown';
  if (fitsBox(d, box(34, 25, 3))) return 'thin';
  if (fitsBox(d, box(25, 20, 5)) || fitsBox(d, box(24, 17, 7))) return 'small';
  const s = sum(d);
  for (const n of [60, 80, 100, 120, 140, 160]) if (s <= n) return `s${n}`;
  return 'big';
}

/**
 * Dimensions to ship: Amazon's package size if known, else the product size plus a little packing.
 * Returns { L, W, H, kg, estimated, source } or null.
 */
export function shipDims(amazon) {
  const pk = amazon?.package;
  const pr = amazon?.product;
  const pick = pk?.dims ? { ...pk, source: 'package' } : pr?.dims ? { ...pr, source: 'product' } : null;
  if (!pick) return null;
  const pad = pick.source === 'product' ? 1 : 0;
  const [L, W, H] = [...pick.dims].map((x) => Number(x) + pad).sort((a, b) => b - a);
  const kgRaw = pk?.kg ?? pr?.kg ?? null;
  const kg = kgRaw == null ? null : Math.round((kgRaw + (pick.source === 'product' ? 0.05 : 0)) * 1000) / 1000;
  return { L, W, H: H ?? 0, kg, estimated: pick.source !== 'package', source: pick.source };
}

/** Everything the list needs: size class, all ways it could go (cheapest first), cheapest Mercari way, band. */
export function shippingOf(amazon) {
  const d = shipDims(amazon);
  if (!d) return { sizeClass: 'unknown', band: 'unknown', options: [], cheapest: null, dims: null };
  const options = SHIPPING_METHODS
    .map((m) => ({ id: m.id, label: m.label, group: m.group, price: m.fits(d, d.kg) }))
    .filter((o) => o.price != null)
    .sort((a, b) => a.price - b.price);
  const cheapest = options.find((o) => groupOf(o.group)?.mercari) || null;
  const band = cheapest ? SHIP_BANDS.find((b) => b.max != null && cheapest.price <= b.max).id : 'unknown';
  return {
    sizeClass: sizeClassOf(d),
    band,
    options,
    cheapest,
    dims: { L: d.L, W: d.W, H: d.H, sum: Math.round((d.L + d.W + d.H) * 10) / 10, kg: d.kg, estimated: d.estimated, source: d.source },
  };
}

/** Plain data for the UI (no functions). */
export function shippingMeta() {
  return {
    groups: SHIPPING_GROUPS,
    methods: SHIPPING_METHODS.map(({ id, group, label, note }) => ({ id, group, label, note: note || '' })),
    sizeClasses: SIZE_CLASSES,
    bands: SHIP_BANDS.map(({ id, label }) => ({ id, label })),
    source: 'メルカリ公式「送料一覧」2026年1月時点の表・日本郵便の料金',
  };
}
