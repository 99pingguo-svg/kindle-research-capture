// 出品先の既定（ユーザー指定 2026-10-29）: Amazon 価格 1,000円以下 または メルカリ手取り 700円以下 の商品にフリマを入れる。
// 商品ごとに1回だけ入れる（targetDefaults.flea に記録）。ユーザーがその商品のフリマを手で付け外ししたら
// （targetsManual.flea、または以前の履歴）以後は触らない。設定 fleaDefault で止める・基準を変える。
import { mercariNet } from './market.js';
import { shippingOf } from './shipping.js';

/** Why this product should get フリマ by default, or '' if it should not. */
export function fleaReason(p, rule) {
  if (!rule || rule.on === false || p.trashedAt) return '';
  const amazon = p.research?.amazonPrice ?? p.amazon?.price ?? null;
  if (amazon != null && amazon <= rule.amazonMax) return `Amazon ${amazon}円`;
  const net = mercariNet(p, shippingOf(p.amazon, p.sizeEstimate))?.net ?? null;
  if (net != null && net <= rule.netMax) return `手取り ${net}円`;
  return '';
}

export function createDefaults(store) {
  /** The user toggled フリマ on this product before the rule existed. */
  const userTouchedFlea = (id) => store.history(id, { limit: 1000 }).some((h) => h.actor === 'user' && h.action === 'targets'
    && (h.changes || []).some((c) => c.path === 'targets' && String(c.from).split('・').includes('フリマ') !== String(c.to).split('・').includes('フリマ')));

  function check(id) {
    const p = store.products.get(id);
    if (!p || p.targetDefaults?.flea || p.targetsManual?.flea || (p.targets || []).includes('flea')) return false;
    const why = fleaReason(p, store.settings.fleaDefault);
    if (!why || userTouchedFlea(id)) return false;
    store.applyDefaultTarget(id, 'flea', why);
    return true;
  }

  function sweep() {
    const due = store.list({ includeTrash: false }).filter((p) => !p.targetDefaults?.flea && !p.targetsManual?.flea && !(p.targets || []).includes('flea') && fleaReason(p, store.settings.fleaDefault));
    if (due.length >= 5) store.saveSnapshot('system', { label: `フリマ既定 ${due.length}件の前`, kind: 'before' });
    let n = 0;
    for (const p of due) {
      try {
        if (check(p.id)) n++;
      } catch (e) {
        console.error('defaults:', p.id, e.message);
      }
    }
    if (n) console.log(`出品先の既定: ${n}件にフリマを追加`);
    return n;
  }

  // New Amazon prices or market results can make a product qualify later.
  store.on('change', (ev) => {
    if (ev.type === 'settings') return setImmediate(sweep);
    if (ev.type === 'product' && ev.actor !== 'system') setImmediate(() => { try { check(ev.id); } catch (e) { console.error('defaults:', ev.id, e.message); } });
  });
  setImmediate(sweep);
  return { sweep };
}
