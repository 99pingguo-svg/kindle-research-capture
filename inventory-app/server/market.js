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

/** Image search with the official (Amazon) photo — the basic way to find the very same item. */
export const imageSearchUrl = (imageUrl) => (imageUrl ? `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}` : '');

/** Price basis: the sold median if researched, else the price the user set. */
export function mercariNet(p, ship = shippingOf(p.amazon)) {
  const m = p.market;
  const basis = m?.median != null ? { kind: 'market', price: m.median } : p.listing?.price != null ? { kind: 'listing', price: p.listing.price } : null;
  if (!basis) return null;
  const fee = Math.floor(basis.price * MERCARI_FEE_RATE);
  const shipPrice = ship.cheapest?.price ?? null;
  return {
    basis: basis.kind,
    price: basis.price,
    fee,
    ship: shipPrice,
    shipLabel: ship.cheapest?.label || '',
    net: shipPrice == null ? null : basis.price - fee - shipPrice,
  };
}

export function marketBrief(p) {
  const kw = marketKeyword(p);
  const m = p.market;
  return {
    keyword: kw,
    soldUrl: mercariSoldUrl(kw),
    imageUrl: imageSearchUrl(p.amazon?.image),
    matchType: m?.matchType || null,
    median: m?.median ?? null,
    low: m?.low ?? null,
    high: m?.high ?? null,
    count: m?.count ?? 0,
    checkedAt: m?.checkedAt || null,
  };
}
