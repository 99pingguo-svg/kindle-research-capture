// メルカリの相場（売り切れ）と、新品をメルカリで売った場合の手取り（メルカリ上だけの計算: 販売額 − 手数料 − 送料。仕入れ額は含めない）。
import { shippingOf } from './shipping.js';

export const MERCARI_FEE_RATE = 0.1; // 販売手数料 10%（2026年時点）

/** Keyword for a sold-items search: the product name without bracketed shop tags, cut at a word boundary. */
export function marketKeyword(p) {
  if (p.market?.query) return p.market.query;
  const base = (p.name || p.amazon?.title || '').normalize('NFKC')
    .replace(/[【\[（(][^】\]）)]{0,30}[】\]）)]/g, ' ')
    .replace(/[|｜].*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (base.length <= 32) return base;
  const cut = base.slice(0, 32);
  return cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut;
}

/** Mercari web search limited to sold items, newest first. */
export const mercariSoldUrl = (keyword) =>
  `https://jp.mercari.com/search?keyword=${encodeURIComponent(keyword)}&status=sold_out&sort=created_time&order=desc`;

/** Yahoo!オークション 落札相場 (closed auctions, readable without signing in). */
export const yahooClosedUrl = (keyword) =>
  `https://auctions.yahoo.co.jp/closedsearch/closedsearch?p=${encodeURIComponent(keyword)}&va=${encodeURIComponent(keyword)}&b=1&n=50`;

/** ヤフーフリマ（旧PayPayフリマ）sold-out items. */
export const paypaySoldUrl = (keyword) => `https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(keyword)}?sold=1`;

/** ラクマ sold-out items, newest first. */
export const rakumaSoldUrl = (keyword) => `https://fril.jp/s?query=${encodeURIComponent(keyword)}&transaction=soldout&sort=created_at&order=desc`;

/** Image search with the official (Amazon) photo — the basic way to find the very same item. */
export const imageSearchUrl = (imageUrl) => (imageUrl ? `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}` : '');

const SITE_NAMES = { mercari: 'メルカリ', yahoo: 'ヤフオク', paypay: 'ヤフーフリマ', rakuma: 'ラクマ' };
const siteRecords = (p) => [['mercari', p.market], ['paypay', p.marketPaypay], ['rakuma', p.marketRakuma], ['yahoo', p.marketYahoo]];

/**
 * Price basis, best first: a sold median of the very same item (メルカリ → ヤフーフリマ → ラクマ → ヤフオク), then a median of similar
 * items (same order), then the price the user set. Similar-only is shown as 参考 (reference).
 */
export function mercariNet(p, ship = shippingOf(p.amazon, p.sizeEstimate)) {
  const pick = (type) => siteRecords(p).find(([, m]) => m?.matchType === type && m.median != null);
  const hit = pick('same') || pick('similar');
  const basis = hit
    ? { kind: 'market', price: hit[1].median, site: hit[0], matchType: hit[1].matchType, count: hit[1].count }
    : p.listing?.price != null ? { kind: 'listing', price: p.listing.price } : null;
  if (!basis) return null;
  const fee = Math.floor(basis.price * MERCARI_FEE_RATE);
  const shipPrice = ship.cheapest?.price ?? null;
  return {
    basis: basis.kind,
    site: basis.site || null,
    siteLabel: basis.site ? SITE_NAMES[basis.site] : '',
    matchType: basis.matchType || null,
    count: basis.count ?? null,
    reference: basis.matchType === 'similar',
    price: basis.price,
    fee,
    ship: shipPrice,
    shipLabel: ship.cheapest?.label || '',
    net: shipPrice == null ? null : basis.price - fee - shipPrice,
  };
}

/** The one sold item to open from the list: same/similar as recorded, price closest to the median. */
function refItem(m) {
  const pool = (m?.examples || []).filter((e) => e.url && e.match === m.matchType);
  if (!pool.length) return null;
  const e = pool.reduce((a, b) => (Math.abs(b.price - m.median) < Math.abs(a.price - m.median) ? b : a));
  return { url: e.url, price: e.price, match: e.match };
}

const stats = (m) => ({
  matchType: m?.matchType || null,
  median: m?.median ?? null,
  low: m?.low ?? null,
  high: m?.high ?? null,
  count: m?.count ?? 0,
  checkedAt: m?.checkedAt || null,
  ref: refItem(m),
});

export function marketBrief(p) {
  const kw = marketKeyword(p);
  return {
    keyword: kw,
    soldUrl: mercariSoldUrl(kw),
    yahooUrl: yahooClosedUrl(p.marketYahoo?.query || kw),
    rakumaUrl: rakumaSoldUrl(p.marketRakuma?.query || kw),
    paypayUrl: paypaySoldUrl(p.marketPaypay?.query || kw),
    imageUrl: imageSearchUrl(p.amazon?.image),
    ...stats(p.market),
    yahoo: stats(p.marketYahoo),
    rakuma: stats(p.marketRakuma),
    paypay: stats(p.marketPaypay),
  };
}
