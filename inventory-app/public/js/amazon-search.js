// お客さんの質問や値段調整に素早く対応するための Amazon 商品検索モーダル。
// 部分一致やキーワードから、該当する Amazon の商品リンクをすぐに出してお客さんに見せられます。

import { state } from './state.js';
import { h, sheet, yen } from './ui.js';
import { norm, termsOf } from './search.js';

/**
 * どこからでも起動できる Amazon 商品リンク検索モーダル
 */
export function openAmazonSearch(initialQuery = '') {
  return sheet((close) => {
    const input = h('input', {
      type: 'search',
      class: 'amz-sheet-input',
      placeholder: '商品名・型番・ASIN・キーワード（部分一致）',
      value: initialQuery,
      enterkeyhint: 'search',
      autofocus: true,
    });

    const countEl = h('div', { class: 'amz-sheet-count' }, '…');
    const listEl = h('div', { class: 'amz-sheet-list' });

    function renderMatches(q) {
      listEl.replaceChildren();
      const query = (q || '').trim();
      const terms = termsOf(query);

      const all = Array.from(state.products.values());
      let matches = [];

      if (!terms.length) {
        // キーワード未入力時は、Amazon リンクのある商品を最新順に表示
        matches = all.filter((p) => p.sourceUrl || p.fnsku).slice(0, 30);
      } else {
        matches = all.filter((p) => {
          const hay = norm([p.id, p.name, p.brand, p.model, p.jan, p.fnsku, p.notes, p.location, p.sourceUrl].join(' '));
          return terms.every((t) => hay.includes(t));
        });
      }

      countEl.textContent = `${matches.length}件一致（全${all.length}件中）`;

      if (matches.length === 0) {
        const fallbackUrl = `https://www.amazon.co.jp/s?k=${encodeURIComponent(query)}`;
        listEl.append(
          h('div', { class: 'amz-empty-box' },
            h('p', { class: 'muted' }, `「${query}」に一致する商品は台帳に見つかりませんでした。`),
            h('a', { class: 'btn primary amz-fallback-btn', href: fallbackUrl, target: '_blank', rel: 'noopener noreferrer' },
              `Amazon全体で「${query}」を直接検索 ↗`)));
        return;
      }

      for (const p of matches.slice(0, 50)) {
        const amzUrl = p.sourceUrl || `https://www.amazon.co.jp/s?k=${encodeURIComponent(p.name || '')}`;
        const hasDirectLink = !!p.sourceUrl;

        const card = h('div', { class: `amz-sheet-card ${hasDirectLink ? 'has-link' : ''}` },
          p.thumb ? h('img', { class: 'amz-sheet-img', src: p.thumb, alt: '', loading: 'lazy' }) : h('div', { class: 'amz-sheet-noimg' }, '📦'),
          h('div', { class: 'amz-sheet-body' },
            h('div', { class: 'amz-sheet-top' },
              h('span', { class: 'amz-sheet-id' }, `#${p.id}`),
              p.fnsku ? h('span', { class: 'amz-badge-fnsku' }, p.fnsku) : null,
              p.decision === 'no_stock' ? h('span', { class: 'badge warn' }, '在庫なし') : null),
            h('div', { class: 'amz-sheet-name' }, p.name || '名称未設定'),
            h('div', { class: 'amz-sheet-prices' },
              h('span', { class: 'amz-price-ref' }, `Amazon参考: ${p.research?.amazonPrice ? yen(p.research.amazonPrice) : '未確認'}`),
              p.prices?.common ? h('span', { class: 'amz-price-flea' }, `フリマ: ${yen(p.prices.common)}`) : null),
            h('div', { class: 'amz-sheet-actions' },
              h('a', { class: 'btn primary amz-open-btn', href: amzUrl, target: '_blank', rel: 'noopener noreferrer' },
                hasDirectLink ? 'Amazonで商品を見る ↗' : 'Amazonで検索 ↗'),
              h('button', { class: 'btn ghost small', onclick: () => { close(); location.hash = `#/p/${p.id}`; } }, '台帳で開く'))));

        listEl.append(card);
      }
    }

    input.addEventListener('input', (e) => renderMatches(e.target.value));

    // Wait for DOM insertion then focus
    setTimeout(() => {
      input.focus();
      renderMatches(initialQuery);
    }, 50);

    return h('div', { class: 'amz-search-modal' },
      h('div', { class: 'amz-sheet-header' },
        h('h2', null, '🛒 Amazon商品リンク検索'),
        h('button', { class: 'icon-btn', onclick: () => close(), 'aria-label': '閉じる' }, '✕')),
      h('p', { class: 'small muted', style: { margin: '0 0 10px' } }, '商品名の一部から該当のAmazon商品ページを即時表示し、お客さんに見せられます。'),
      input,
      countEl,
      listEl);
  });
}

/**
 * グローバルショートカット: Alt+A または Cmd+K / Ctrl+K でいつでも Amazon 検索を起動
 */
export function initGlobalAmazonShortcut() {
  if (typeof window === 'undefined') return;
  window.addEventListener('keydown', (e) => {
    if ((e.altKey && e.key.toLowerCase() === 'a') || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
      e.preventDefault();
      openAmazonSearch();
    }
  });
}
