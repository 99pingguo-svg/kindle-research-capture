// 撮った写真の自動仕上げ（Mac 上・無料）。新しい現物写真が届くたびに順番に処理する。
//  1) tools/bin/studio（macOS Vision の切り抜き＋Core Image の自動補正）で 白背景・正方形トリミング・色補正・商品に落ちた影を明るく
//     （影消しの強さは設定 studioDeshadow、既定 0.6。黒い商品は黒のまま。小さな軽量AIは影の有無を見分けられなかったので数値処理で行う）
//     被写体が画面からはみ出す／大写し／見つからない写真は色・明るさの補正だけ（構図はそのまま）
//  2) 白背景にした写真はローカルAI（Ollama の視覚モデル）が元写真と見比べ、商品が欠けていたら補正だけの版に切り替える
//     （白っぽい商品は白に溶けないよう薄いグレーの背景。判定は tools/studio.swift）
//  3) 仕上げた写真は「編集写真」（元写真から派生）として追加。出品用写真では元写真の位置に入る（構成が🔒確定なら入れ替えない）
// 元写真はそのまま残る。設定 autoStudio=false で止まる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'bin', 'studio');
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const QC_MODEL = process.env.STUDIO_QC_MODEL || 'qwen3.5:4b';
const ACTOR = 'claude';
const DESHADOW = 0.6;

const run = (cmd, args, timeout = 120000) => new Promise((resolve, reject) => execFile(cmd, args, { timeout }, (e, out) => (e && !out ? reject(e) : resolve(String(out)))));

/** Ask the local vision model whether the white-background version still shows the whole product. null = could not ask. */
async function localQc(originalJpg, resultJpg, tmp) {
  try {
    const small = async (f, name) => {
      const out = path.join(tmp, name);
      await run('sips', ['-Z', '768', '-s', 'format', 'jpeg', f, '--out', out]);
      return fs.readFileSync(out).toString('base64');
    };
    const prompt = 'Image 1 is a product photo. Image 2 is the same photo with the background removed and replaced by white, then cropped. '
      + 'Is the WHOLE product from image 1 still in image 2 (no missing parts, nothing important cut off, no leftover clutter from the background)? '
      + 'Return JSON only: {"ok": true|false, "reason": "<8 words>"}';
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: QC_MODEL, prompt, images: [await small(originalJpg, 'a.jpg'), await small(resultJpg, 'b.jpg')], stream: false, think: false, format: 'json', options: { temperature: 0 }, keep_alive: '10m' }),
      signal: AbortSignal.timeout(180000), // the first call also loads the model
    });
    if (!res.ok) return null;
    const d = JSON.parse((await res.json()).response || '{}');
    return typeof d.ok === 'boolean' ? { ok: d.ok, reason: String(d.reason || '').slice(0, 80), model: QC_MODEL } : null;
  } catch {
    return null;
  }
}

export function createStudio(store) {
  const queue = [];
  let busy = false;
  const available = () => fs.existsSync(TOOL);

  async function processOne({ productId, photoId }) {
    const p = store.get(productId);
    const ph = p.photos.find((x) => x.id === photoId && !x.deletedAt);
    if (!ph || ph.kind !== 'actual' || ph.derivedFrom) return;
    if (p.photos.some((x) => !x.deletedAt && x.derivedFrom === ph.id && x.edit?.auto)) return; // already finished
    const dir = store.dir(productId);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-studio-'));
    try {
      const src = path.join(dir, ph.files.original);
      const out = path.join(tmp, 'out.jpg');
      const ds = ['--deshadow', String(store.settings.studioDeshadow ?? DESHADOW)];
      let info = JSON.parse((await run(TOOL, [src, out, ...ds])).trim().split('\n').pop() || '{}');
      if (!info.ok) return;
      let qc = null;
      if (info.mode === 'studio') {
        const orig = path.join(dir, ph.files.work || ph.files.original);
        qc = (await localQc(orig, out, tmp)) ?? (await localQc(orig, out, tmp));
        if (qc && !qc.ok) info = { ...JSON.parse((await run(TOOL, [src, out, '--mode', 'enhance', ...ds])).trim().split('\n').pop() || '{}'), why: `白背景にすると欠ける（${qc.reason}）` };
        if (!info.ok) return;
      }
      const thumb = path.join(tmp, 'thumb.jpg');
      await run('sips', ['-Z', '400', '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', out, '--out', thumb]);
      const buf = fs.readFileSync(out);
      const fresh = store.get(productId); // the user may have changed things meanwhile
      if (!fresh.photos.some((x) => x.id === ph.id && !x.deletedAt)) return;
      store.addPhoto(productId, ACTOR, {
        kind: 'actual',
        source: 'studio',
        derivedFrom: ph.id,
        tag: ph.tag || '',
        note: info.mode === 'studio' ? 'AI仕上げ（白背景・トリミング・色補正・影を明るく）' : `AI仕上げ（色・明るさ補正・影を明るく: ${info.why || ''}）`,
        edit: { auto: info.mode, why: info.why || '', qc, deshadow: info.deshadow, shadowScore: info.shadowScore },
        width: info.width,
        height: info.height,
        clientId: `studio:${ph.id}`,
        replaceInListing: !fresh.locks.listingPhotos,
      }, { original: { buffer: buf, mime: 'image/jpeg' }, work: { buffer: buf, mime: 'image/jpeg' }, thumb: { buffer: fs.readFileSync(thumb), mime: 'image/jpeg' } });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const job = queue.shift();
      try {
        await processOne(job);
      } catch (e) {
        console.error('studio:', job.productId, job.photoId, e.message);
      }
    }
    busy = false;
  }

  return {
    available,
    /** Queue a newly arrived photo (original, actual) if auto-finishing is on. */
    enqueue(productId, photo) {
      if (store.settings.autoStudio === false || !available()) return;
      if (!photo || photo.kind !== 'actual' || photo.derivedFrom) return;
      queue.push({ productId, photoId: photo.id });
      setImmediate(pump);
    },
    pending: () => queue.length + (busy ? 1 : 0),
    /** Photos shot before (or while the tool was off) that have no finished version yet. */
    backfill(productIds) {
      let n = 0;
      for (const p of store.list({ includeTrash: false })) {
        if (productIds && !productIds.includes(p.id)) continue;
        for (const ph of p.photos) {
          if (ph.deletedAt || ph.kind !== 'actual' || ph.derivedFrom) continue;
          if (p.photos.some((x) => !x.deletedAt && x.derivedFrom === ph.id && x.edit?.auto)) continue;
          queue.push({ productId: p.id, photoId: ph.id });
          n++;
        }
      }
      setImmediate(pump);
      return n;
    },
  };
}
