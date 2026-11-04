// 出品先の既定（ユーザー指定 2026-10-29）: Amazon 価格 1,000円以下 または メルカリ手取り 700円以下 の商品にフリマを入れる。
// 商品ごとに1回だけ入れる（targetDefaults.flea に記録）。ユーザーがその商品のフリマを手で付け外ししたら
// （targetsManual.flea、または以前の履歴）以後は触らない。設定 fleaDefault で止める・基準を変える。
// 手取りのおすすめ（ユーザー指定 2026-10-30）: メルカリ・ヤフーフリマ・ラクマ・ヤフオクの手取り見込みを比べ、一番よいサイトと
// 差が小さいサイト（設定 netDefault: margin 円以内 または ratio 以内）を出品先に入れる（画面では緑）。相場が変わって外れたら、
// この規則が入れたものだけ外す。ユーザーが手で付け外ししたサイト（targetsManual）には触らない。
// 飲食料品（server/food.js）にはフリマを入れず、すでに入っていれば手で入れたものも1回だけ外す（ユーザー指定 2026-10-30）。
// Vine 提供品（観察ブラウザの Vine の一覧にあるもの）には出品先を入れず、規則が入れた分は外す（規約で販売・譲渡不可。ユーザー指定 2026-11-04）。
// ユーザーが手で入れた出品先と出品判断には触らない（画面で警告するだけ）。
import { mercariNet, recommendedChannels } from './market.js';
import { isFood } from './food.js';
import { isVineProvided } from './browser-sync.js';
import { shippingOf } from './shipping.js';

/** Why this product should get フリマ by default, or '' if it should not. */
export function fleaReason(p, rule) {
  if (!rule || rule.on === false || p.trashedAt || isFood(p) || isVineProvided(p)) return '';
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

  const VINE_REASON = 'Vine提供品は販売・譲渡できないため';
  const vineDue = (p) => isVineProvided(p) && (p.targets || []).some((c) => p.targetDefaults?.[c] && !p.targetDefaults[c].removedAt && !p.targetsManual?.[c]);

  /** Bring the 手取り picks in line with the current market. Returns how many destinations changed. */
  function checkNet(id) {
    const rule = store.settings.netDefault;
    const p = store.products.get(id);
    if (p && vineDue(p)) { store.removeRuleTargets(id, VINE_REASON); return 1; }
    if (!rule || rule.on === false || !p || p.trashedAt || isVineProvided(p)) return 0;
    const { channels, nets } = recommendedChannels(p, rule);
    const why = (c) => { const x = nets.find((n) => n.channel === c); return x ? `手取り見込み ${x.label} ${x.net}円${x.matchType === 'similar' ? '（似た商品の相場）' : ''}` : ''; };
    let n = 0;
    for (const c of channels) {
      if ((p.targets || []).includes(c) || p.targetsManual?.[c] || p.targetDefaults?.[c]) continue;
      store.applyDefaultTarget(id, c, why(c), 'net');
      n++;
    }
    const fresh = store.products.get(id);
    for (const c of fresh.targets || []) {
      if (fresh.targetDefaults?.[c]?.rule !== 'net' || fresh.targetsManual?.[c] || channels.includes(c)) continue;
      store.removeDefaultTarget(id, c, nets.length ? `手取りで${nets[0].label}に差がついた` : '相場がなくなった');
      n++;
    }
    return n;
  }
  const netDue = (p) => {
    const rule = store.settings.netDefault;
    if (vineDue(p)) return true;
    if (!rule || rule.on === false || p.trashedAt || isVineProvided(p)) return false;
    const { channels } = recommendedChannels(p, rule);
    return channels.some((c) => !(p.targets || []).includes(c) && !p.targetsManual?.[c] && !p.targetDefaults?.[c])
      || (p.targets || []).some((c) => p.targetDefaults?.[c]?.rule === 'net' && !p.targetsManual?.[c] && !channels.includes(c));
  };

  function check(id) {
    const p = store.products.get(id);
    if (!p || p.targetDefaults?.flea || p.targetsManual?.flea || (p.targets || []).includes('flea')) return false;
    const why = fleaReason(p, store.settings.fleaDefault);
    if (!why || userTouchedFlea(id)) return false;
    store.applyDefaultTarget(id, 'flea', why);
    return true;
  }

  const FOOD_REASON = '飲食料品はフリマで禁止のことが多いため';
  const foodDue = (p) => !p.foodFleaRuleAt && isFood(p);

  function sweep() {
    const all = store.list({ includeTrash: false });
    const foods = all.filter(foodDue);
    if (foods.some((p) => (p.targets || []).includes('flea'))) store.saveSnapshot('system', { label: `飲食料品 ${foods.length}件のフリマを外す前`, kind: 'before' });
    for (const p of foods) {
      try {
        store.clearFoodFlea(p.id, FOOD_REASON);
      } catch (e) {
        console.error('defaults(food):', p.id, e.message);
      }
    }
    if (foods.length) console.log(`出品先の既定: 飲食料品 ${foods.length}件のフリマを確認`);
    const due = all.filter((p) => !p.targetDefaults?.flea && !p.targetsManual?.flea && !(p.targets || []).includes('flea') && fleaReason(p, store.settings.fleaDefault));
    const vines = all.filter(vineDue);
    if (vines.length >= 5) store.saveSnapshot('system', { label: `Vine提供品 ${vines.length}件から規則の出品先を外す前`, kind: 'before' });
    for (const p of vines) {
      try {
        store.removeRuleTargets(p.id, VINE_REASON);
      } catch (e) {
        console.error('defaults(vine):', p.id, e.message);
      }
    }
    if (vines.length) console.log(`出品先の既定: Vine提供品 ${vines.length}件から規則が入れた出品先を外した`);
    const netList = all.filter(netDue);
    if (due.length + netList.length >= 5) store.saveSnapshot('system', { label: `出品先の既定（フリマ ${due.length}件・手取り ${netList.length}件）の前`, kind: 'before' });
    let m = 0;
    for (const p of netList) {
      try {
        m += checkNet(p.id);
      } catch (e) {
        console.error('defaults(net):', p.id, e.message);
      }
    }
    if (m) console.log(`出品先の既定: 手取りのおすすめで ${m}か所を変更（${netList.length}件）`);
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
    if (ev.type === 'product' && ev.actor !== 'system') setImmediate(() => { try { const q = store.products.get(ev.id); if (q && foodDue(q)) store.clearFoodFlea(ev.id, FOOD_REASON); checkNet(ev.id); check(ev.id); } catch (e) { console.error('defaults:', ev.id, e.message); } });
  });
  setImmediate(sweep);
  return { sweep };
}
