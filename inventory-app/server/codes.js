// 写真から Amazon 管理番号（FNSKU: X00…）を読む（Mac 上・無料・外部送信なし）。
// 撮った現物写真が届くたびに tools/bin/ocr（macOS Vision の文字＋バーコード）で読み、商品の fnsku が空なら入れる。
// 検索欄・📷検索でこの番号から商品を探せるようになる。backfill() は今ある写真をまとめて読む。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fnskusIn } from '../public/js/search.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'bin', 'ocr');
const ACTOR = 'claude';

const ownShot = (ph) => ph && !ph.deletedAt && ph.kind === 'actual' && !ph.derivedFrom && ph.source !== 'studio';

export function createCodeReader(store) {
  const queue = [];
  let busy = false;
  const available = () => fs.existsSync(TOOL);

  const read = (file) => new Promise((resolve) => execFile(TOOL, [file], { timeout: 30000 }, (e, out) => {
    try {
      const r = JSON.parse(String(out));
      resolve(r.ok ? fnskusIn([...(r.barcodes || []), ...(r.lines || []).map((l) => l.text)].join(' ')) : []);
    } catch {
      resolve([]);
    }
  }));

  async function one({ productId, photoId }) {
    const p = store.get(productId);
    if (p.fnsku) return true;
    const ph = p.photos.find((x) => x.id === photoId);
    if (!ownShot(ph)) return false;
    const found = await read(path.join(store.dir(productId), ph.files.work || ph.files.original));
    if (found.length !== 1 || store.get(productId).fnsku) return false; // none, or two different labels in one photo
    store.updateFields(productId, ACTOR, { fnsku: found[0] });
    return true;
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const job = queue.shift();
      try {
        // Once a product has its number, its other queued photos are skipped.
        if (await one(job)) for (let i = queue.length - 1; i >= 0; i--) if (queue[i].productId === job.productId) queue.splice(i, 1);
      } catch (e) {
        console.error('codes:', job.productId, e.message);
      }
    }
    busy = false;
  }

  return {
    available,
    enqueue(productId, photo) {
      if (!available() || !ownShot(photo)) return;
      queue.push({ productId, photoId: photo.id });
      setImmediate(pump);
    },
    /** Read the photos already taken, for products that have no number yet. */
    backfill() {
      let n = 0;
      for (const p of store.list({ includeTrash: false })) {
        if (p.fnsku) continue;
        for (const ph of p.photos) if (ownShot(ph)) { queue.push({ productId: p.id, photoId: ph.id }); n++; }
      }
      setImmediate(pump);
      return n;
    },
    pending: () => queue.length + (busy ? 1 : 0),
  };
}
