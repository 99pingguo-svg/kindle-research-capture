// 撮影トレイ: 純正カメラ（ショートカット「台帳で撮る」）から届いた写真の置き場。商品の写真にはまだ入れない。
// Webアプリに戻ると、撮影中だった商品の候補として出し、ユーザーが 登録（その商品の写真へ）／保留（トレイに残す）／破棄 を決める。
// 正本は data/tray/tray.json と data/tray/<id>.*。破棄した写真は data/tray/discarded/ へ移すだけ（消さない。元は iPhone にもある）。
import fs from 'node:fs';
import path from 'node:path';
import { AppError, nowIso, newId, writeJson, readJson } from './util.js';
import { isUser } from './store.js';

export function createTray(store, { onRegistered = () => {} } = {}) {
  const dir = path.join(store.dataDir, 'tray');
  const discarded = path.join(dir, 'discarded');
  const index = path.join(dir, 'tray.json');
  fs.mkdirSync(discarded, { recursive: true });
  let items = readJson(index, []);
  const save = () => writeJson(index, items);
  const live = () => items.filter((x) => x.status === 'new' || x.status === 'held');

  return {
    /** A photo from the shortcut. files = nativeVariants() result. Returns { item, duplicate }. */
    add({ productId, digest, files }) {
      const dup = items.find((x) => x.digest === digest && x.status !== 'discarded');
      if (dup) return { item: dup, duplicate: true };
      const id = newId('tr');
      const ext = files.original.mime === 'image/heic' ? 'heic' : files.original.mime === 'image/png' ? 'png' : 'jpg';
      fs.writeFileSync(path.join(dir, `${id}.original.${ext}`), files.original.buffer);
      fs.writeFileSync(path.join(dir, `${id}.work.jpg`), files.work.buffer);
      fs.writeFileSync(path.join(dir, `${id}.thumb.jpg`), files.thumb.buffer);
      const item = {
        id, productId, digest, status: 'new', receivedAt: nowIso(), takenAt: files.takenAt?.toISOString() || null,
        width: files.width, height: files.height, mime: files.original.mime, files: { original: `${id}.original.${ext}`, work: `${id}.work.jpg`, thumb: `${id}.thumb.jpg` },
      };
      items.push(item);
      save();
      store.emit('change', { type: 'tray' });
      return { item, duplicate: false };
    },

    /** Candidates: new and held photos (newest first), optionally only those shot for one product. */
    list({ productId } = {}) {
      return live().filter((x) => !productId || x.productId === productId).sort((a, b) => (b.takenAt || b.receivedAt).localeCompare(a.takenAt || a.receivedAt))
        .map(({ id, productId: pid, status, receivedAt, takenAt }) => ({ id, productId: pid, status, receivedAt, takenAt, thumb: `/api/tray/${id}/thumb`, work: `/api/tray/${id}/work` }));
    },

    file(id, variant) {
      const it = items.find((x) => x.id === id);
      if (!it || !['thumb', 'work'].includes(variant) || it.status === 'registered') throw new AppError(404, 'not found');
      const f = path.join(it.status === 'discarded' ? discarded : dir, it.files[variant]);
      if (!fs.existsSync(f)) throw new AppError(404, 'not found');
      return f;
    },

    /**
     * ユーザーが決める: [{ id, action: 'register'|'hold'|'discard', productId? }]。register は productId（省略時は撮影中だった商品）の
     * 現物写真に入れて自動仕上げへ。
     */
    decide(actor, decisions = []) {
      if (!isUser(actor)) throw new AppError(403, '写真の登録・保留・破棄はユーザーのみ実行できます（AIの権限外）', 'forbidden');
      const done = { registered: 0, held: 0, discarded: 0 };
      for (const d of decisions) {
        const it = items.find((x) => x.id === d.id && (x.status === 'new' || x.status === 'held'));
        if (!it) continue;
        if (d.action === 'register') {
          const pid = String(d.productId || it.productId || '');
          const p = store.get(pid);
          const read = (k) => fs.readFileSync(path.join(dir, it.files[k]));
          const { photo, duplicate } = store.addPhoto(p.id, actor, { kind: 'actual', source: 'native', clientId: `native:${it.digest}`, width: it.width, height: it.height, takenAt: it.takenAt },
            { original: { buffer: read('original'), mime: it.mime }, work: { buffer: read('work'), mime: 'image/jpeg' }, thumb: { buffer: read('thumb'), mime: 'image/jpeg' } });
          if (!duplicate) onRegistered(p.id, photo);
          for (const k of Object.keys(it.files)) fs.rmSync(path.join(dir, it.files[k]), { force: true }); // now kept in the product folder
          Object.assign(it, { status: 'registered', productId: p.id, decidedAt: nowIso() });
          done.registered++;
        } else if (d.action === 'hold') {
          Object.assign(it, { status: 'held', decidedAt: nowIso() });
          done.held++;
        } else if (d.action === 'discard') {
          for (const k of Object.keys(it.files)) {
            const f = path.join(dir, it.files[k]);
            if (fs.existsSync(f)) fs.renameSync(f, path.join(discarded, it.files[k]));
          }
          Object.assign(it, { status: 'discarded', decidedAt: nowIso() });
          done.discarded++;
        }
      }
      // Keep the index small: forget registered/discarded entries older than 30 days (their files are elsewhere or in discarded/).
      const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
      items = items.filter((x) => (x.status === 'new' || x.status === 'held') || (x.decidedAt || '') > cutoff);
      save();
      store.emit('change', { type: 'tray' });
      return done;
    },
  };
}
