// Platform-neutral status sync: what a platform's own pages show (出品中／取引中／売却済み…) is written
// back to product.channels[channel]. Used by "check Mercari now"; another platform (ジモティー…) reuses it
// with its own item URL pattern. Observing is reporting, not acting: it never publishes or approves anything.
import { AppError, nowIso, norm } from './util.js';
import { OBSERVED_STATUSES, CHANNELS, channelLabel } from './schema.js';

const OBS = new Map(OBSERVED_STATUSES.map((s) => [s.id, s.label]));
/** Item id inside a platform URL, e.g. jp.mercari.com/item/m12345678901. */
const ITEM_ID = { mercari: /\/item\/(m\d+)/, jmty: /\/article-([a-z0-9]+)/i, yahoo: /\/auction\/([a-z]?\d+)/i, rakuma: /item\.fril\.jp\/([0-9a-f]+)/i };
const DRAFT_STATUSES = ['entered', 'transfer_ok', 'transfer_ng'];

export function itemIdOf(channel, obs) {
  if (obs.itemId) return String(obs.itemId);
  const m = ITEM_ID[channel]?.exec(obs.itemUrl || '');
  return m ? m[1] : '';
}

/** Find the product an observation refers to: platform item id first, then the exact listing title. */
export function matchProduct(store, channel, obs) {
  const id = itemIdOf(channel, obs);
  const tracked = store.list().filter((p) => !p.trashedAt && p.channels?.[channel]);
  if (id) {
    const hit = tracked.find((p) => p.channels[channel].itemId === id || itemIdOf(channel, { itemUrl: p.channels[channel].itemUrl }) === id);
    if (hit) return hit;
  }
  if (obs.title) {
    const t = norm(obs.title);
    const byTitle = (list) => list.filter((p) => norm(p.channels?.[channel]?.entered?.title || p.listing.title) === t);
    const hits = byTitle(tracked);
    if (hits.length === 1) return hits[0];
    if (!hits.length) {
      const all = byTitle(store.list().filter((p) => !p.trashedAt));
      if (all.length === 1) return all[0];
    }
  }
  return null;
}

/** Write one observation onto the product. Returns { from, to } or null when nothing changed. */
export function applyObserved(store, id, actor, channel, obs) {
  if (!CHANNELS.some((c) => c.id === channel)) throw new AppError(400, `出品先が不正: ${channel}`);
  if (!OBS.has(obs.status)) throw new AppError(400, `状態が不正: ${obs.status}`);
  const p = store.get(id);
  const ch = p.channels[channel] || {};
  const at = obs.observedAt || nowIso();
  const itemId = itemIdOf(channel, obs) || ch.itemId || '';
  const itemUrl = obs.itemUrl || ch.itemUrl || '';
  const base = { itemId, itemUrl, observed: { status: obs.status, at }, lastCheckedAt: at };
  let patch;
  let stage;
  switch (obs.status) {
    case 'draft':
      // A saved draft: keep the finer 転記QC states the app already tracks.
      patch = DRAFT_STATUSES.includes(ch.status) ? {} : { status: 'entered', savedAs: 'draft', enteredAt: ch.enteredAt || at };
      if (channel === 'mercari' && !['mercari_entered', 'final_check'].includes(p.stage)) stage = 'mercari_entered';
      break;
    case 'listed':
      patch = { status: 'listed', listedAt: ch.listedAt || at, ...(obs.price != null ? { listedPrice: Number(obs.price) } : {}) };
      stage = 'listed';
      break;
    case 'stopped':
      patch = { status: 'stopped', stoppedAt: ch.stoppedAt || at };
      break;
    case 'trading':
      patch = { status: 'trading', tradingAt: ch.tradingAt || at, ...(obs.price != null ? { soldPrice: Number(obs.price) } : {}) };
      stage = 'trading';
      break;
    case 'sold':
      patch = { status: 'sold', soldAt: ch.soldAt || at, ...(obs.price != null ? { soldPrice: Number(obs.price) } : {}) };
      stage = 'sold';
      break;
    case 'removed':
      patch = { status: 'removed', removedAt: ch.removedAt || at };
      break;
  }
  const from = ch.status || '';
  const to = patch.status || from;
  const idChanged = itemId !== (ch.itemId || '') || itemUrl !== (ch.itemUrl || '');
  if (to === from && !idChanged && (!stage || stage === p.stage)) {
    // Nothing new: remember the check time without writing a history entry.
    store.touchChannel(id, channel, base);
    return null;
  }
  store.updateChannel(id, actor, channel, { ...base, ...patch }, { summary: `${channelLabel(channel)}で確認: ${OBS.get(obs.status)}`, stage });
  if (obs.status === 'sold' && obs.price != null) {
    store.mutate(id, actor, 'sold_price', (q, ctx) => {
      if (q.soldPrice === Number(obs.price)) return;
      ctx.change('soldPrice', q.soldPrice, Number(obs.price));
      q.soldPrice = Number(obs.price);
    });
  }
  return { from, to };
}

/** One check run: apply every observation, report what changed and what could not be matched. */
export function syncObserved(store, actor, channel, observations = []) {
  const updated = [];
  const unmatched = [];
  let unchanged = 0;
  for (const obs of observations) {
    const p = obs.productId ? store.get(obs.productId) : matchProduct(store, channel, obs);
    if (!p) {
      unmatched.push(obs);
      continue;
    }
    const r = applyObserved(store, p.id, actor, channel, obs);
    if (r) updated.push({ id: p.id, name: p.name, from: r.from, to: r.to });
    else unchanged++;
  }
  store.recordChannelCheck(channel, { at: nowIso(), seen: observations.length, updated: updated.length, unmatched: unmatched.length });
  return { channel, updated, unchanged, unmatched };
}

/** Products the app believes are on a platform (for the checker to compare against). */
export function tracked(store, channel) {
  return store
    .list()
    .filter((p) => !p.trashedAt && p.channels?.[channel]?.status)
    .map((p) => ({
      id: p.id,
      title: p.channels[channel].entered?.title || p.listing.title,
      status: p.channels[channel].status,
      itemId: p.channels[channel].itemId || '',
      itemUrl: p.channels[channel].itemUrl || '',
      lastCheckedAt: p.channels[channel].lastCheckedAt || null,
    }));
}
