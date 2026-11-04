// 税額の試算（目安）。確定申告の計算そのものではない。足りない値は推測せず「未設定」と返す。
// 年度ごとの値は TAX_YEARS（出典と確認日つき）。verified=false は公式ページで数値を確かめきれていないもの（画面に出す）。
// 障害年金は非課税なので所得に入れない。ほかの年金・給与などがある場合は対象外（画面で注意）。
export const SOURCES = {
  basic: { title: '国税庁 No.1199 基礎控除', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1199.htm', checked: '2026-11-04' },
  rate: { title: '国税庁 No.2260 所得税の税率', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2260.htm', checked: '2026-11-04' },
  disability: { title: '国税庁 No.1160 障害者控除', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1160.htm', checked: '2026-11-04' },
  resident: { title: '総務省 個人住民税', url: 'https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/150790_06.html', checked: '2026-11-04' },
};

// [合計所得金額の上限, 基礎控除額]
export const TAX_YEARS = {
  2025: { label: '令和7年分', basic: [[1320000, 950000], [3360000, 880000], [4890000, 680000], [6550000, 630000], [23500000, 580000], [24000000, 480000], [24500000, 320000], [25000000, 160000], [Infinity, 0]] },
  2026: { label: '令和8年分', basic: [[4890000, 1040000], [6550000, 670000], [23500000, 620000], [24000000, 480000], [24500000, 320000], [25000000, 160000], [Infinity, 0]] },
  2027: { label: '令和9年分', basic: [[4890000, 1040000], [6550000, 670000], [23500000, 620000], [24000000, 480000], [24500000, 320000], [25000000, 160000], [Infinity, 0]] },
};
// [課税所得の上限, 税率, 控除額]（国税庁 速算表）
const BRACKETS = [[1949000, 0.05, 0], [3299000, 0.10, 97500], [6949000, 0.20, 427500], [8999000, 0.23, 636000], [17999000, 0.33, 1536000], [39999000, 0.40, 2796000], [Infinity, 0.45, 4796000]];
const RECONSTRUCTION = 0.021; // 復興特別所得税: 基準所得税額の2.1%（令和9年分以後は防衛特別所得税と合わせて同じ率・国税庁 No.2260）
const DISABILITY = { none: 0, general: 270000, special: 400000, cohabit_special: 750000 }; // 所得税
// 住民税: 税率・均等割・森林環境税は総務省ページで確認。基礎控除・障害者控除・障害者の非課税基準は未確認（一般に知られた値）。
const RESIDENT = {
  rate: { value: 0.10, verified: true }, perCapita: { value: 4000, verified: true }, forest: { value: 1000, verified: true },
  basic: { value: 430000, verified: false },
  disability: { value: { none: 0, general: 260000, special: 300000, cohabit_special: 530000 }, verified: false },
  exemptDisabled: { value: 1350000, verified: false }, // 障害者で前年の合計所得 135万円以下は非課税
};
const BLUE = { none: 0, blue10: 100000, blue55: 550000, blue65: 650000 }; // 青色申告特別控除（事業所得のみ。要件あり）

const floorTo = (v, unit) => Math.floor(v / unit) * unit;
const basicFor = (year, total) => {
  const y = TAX_YEARS[year];
  if (!y) return null;
  return y.basic.find(([max]) => total <= max)[1];
};
function incomeTax(taxable) {
  const [, r, d] = BRACKETS.find(([max]) => taxable <= max);
  return Math.max(0, Math.floor(taxable * r - d));
}

/**
 * input: { year, vineIncome, expense, otherIncome, kind: 'misc'|'business', blue: 'none'|'blue10'|'blue55'|'blue65',
 *          disability: 'none'|'general'|'special'|'cohabit_special', socialInsurance, otherDeductions,
 *          nhi?: { rate, perCapita, perHousehold, cap }, pensionLimit?: { half, full } }
 */
export function simulate(input) {
  const year = Number(input.year) || new Date().getFullYear();
  const notes = [];
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  const vine = n(input.vineIncome), other = n(input.otherIncome), expense = n(input.expense);
  const revenue = vine + other;
  const business = input.kind === 'business';
  const blue = business ? Math.min(BLUE[input.blue] || 0, Math.max(0, revenue - expense)) : 0;
  const income = Math.max(0, revenue - expense - blue); // 合計所得金額（この活動だけの場合）
  if (!business && input.blue && input.blue !== 'none') notes.push('青色申告特別控除は事業所得のときだけです（雑所得では使えません）');
  const basic = basicFor(year, income);
  if (basic == null) return { year, error: `${year}年分の基礎控除の値がまだ入っていません（server/tax.js の TAX_YEARS）` };
  const dis = DISABILITY[input.disability] ?? 0;
  const social = n(input.socialInsurance), otherDed = n(input.otherDeductions);
  const taxable = floorTo(Math.max(0, income - basic - dis - social - otherDed), 1000);
  const it = incomeTax(taxable);
  const rec = Math.floor(it * RECONSTRUCTION);
  const nationalTotal = floorTo(it + rec, 100);

  // 住民税（翌年度に課税。前年の所得で計算）
  let resident;
  if (input.disability && input.disability !== 'none' && income <= RESIDENT.exemptDisabled.value) {
    resident = { total: 0, exempt: true, note: `障害者で合計所得 ${RESIDENT.exemptDisabled.value / 10000}万円以下のため非課税（基準は未確認）` };
  } else {
    const rTaxable = floorTo(Math.max(0, income - RESIDENT.basic.value - (RESIDENT.disability.value[input.disability] || 0) - social - otherDed), 1000);
    const incomePart = Math.max(0, Math.floor(rTaxable * RESIDENT.rate.value) - (rTaxable > 0 ? 2500 : 0)); // 調整控除は最小額で概算
    const perCapita = income > 450000 ? RESIDENT.perCapita.value + RESIDENT.forest.value : 0; // 均等割の非課税基準は市町村で違う（目安）
    resident = { total: floorTo(incomePart, 100) + perCapita, incomePart: floorTo(incomePart, 100), perCapita, exempt: false,
      note: '調整控除は最小額・均等割の非課税基準は目安。市町村の税率が標準と違うことがある' };
  }

  // 国民健康保険料: 市町村ごとに違うので、料率が入っているときだけ
  let nhi = null;
  if (input.nhi && Number(input.nhi.rate) > 0) {
    const base = Math.max(0, income - 430000);
    const raw = Math.floor(base * Number(input.nhi.rate)) + n(input.nhi.perCapita) + n(input.nhi.perHousehold);
    nhi = { total: input.nhi.cap ? Math.min(raw, n(input.nhi.cap)) : raw, base, note: '入力した料率での概算（軽減・減免は含めない）' };
  } else notes.push('国民健康保険料は市町村の料率を入れると概算します（未設定）');

  let pension = null;
  if (input.pensionLimit && (Number(input.pensionLimit.half) > 0 || Number(input.pensionLimit.full) > 0)) {
    const half = n(input.pensionLimit.half), full = n(input.pensionLimit.full);
    pension = { income, state: full && income > full ? '全額支給停止の基準を超える' : half && income > half ? '2分の1支給停止の基準を超える' : '基準以下', half, full,
      note: '20歳前傷病による障害基礎年金の所得制限の目安（基準額は入力値。所得の数え方は日本年金機構で確認）' };
  }
  if (other) notes.push('YouTube広告・アフィリエイト・売却益などは「そのほかの収入」にまとめています');
  return {
    year, label: TAX_YEARS[year].label,
    revenue, expense, blue, income, deductions: { basic, disability: dis, social, other: otherDed }, taxable,
    incomeTax: it, reconstruction: rec, nationalTotal, resident, nhi, pension,
    notes,
    unverified: ['住民税の基礎控除・障害者控除・障害者の非課税基準（135万円）'],
    sources: Object.values(SOURCES),
  };
}

/** The standard what-if table: Vine income 100/200/300万円 × expenses 0 / half / all, with the same other settings. */
export function scenarios(base) {
  const amounts = (base.amounts?.length ? base.amounts : [1000000, 2000000, 3000000]).map(Number);
  const ratios = [['経費なし', 0], ['半分が経費', 0.5], ['全額が経費', 1]];
  return amounts.map((v) => ({
    vineIncome: v,
    rows: ratios.map(([label, r]) => ({ label, ratio: r, result: simulate({ ...base, vineIncome: v, expense: Math.round(v * r) + Math.round(Number(base.expense) || 0) }) })),
  }));
}
