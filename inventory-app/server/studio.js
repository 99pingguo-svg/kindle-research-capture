// 撮った写真の自動仕上げ（Mac 上・無料）。新しい現物写真が届くたびに順番に処理する。
//  1) tools/bin/studio（macOS Vision の切り抜き＋Core Image の自動補正）で 白背景・正方形トリミング・色補正・商品に落ちた影を明るく
//     （影消しの強さは設定 studioDeshadow、既定 0.6。黒い商品は黒のまま。小さな軽量AIは影の有無を見分けられなかったので数値処理で行う）
//     被写体が画面からはみ出す／大写し／見つからない写真は色・明るさの補正だけ（構図はそのまま）
//  2) 白背景にした写真はローカルAI（Ollama の視覚モデル）が元写真と見比べる。欠けの指摘はメモに「要確認」と書くだけ（誤判定が多いため）
//  3) 仕上げた写真は「編集写真」（元写真から派生）として追加。白抜き／グレー背景の2枚を作り、主の1枚（設定 studioStyle）が出品用写真で
//     元写真の位置に入る（構成が🔒確定なら入れ替えない）
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
const VERSION = 3; // 3 = 傾き補正・形に合わせたトリミング（2 = 白抜き/グレー・余白・接地影）

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

  const STYLE_NOTE = { white: '白抜き', grey: 'グレー背景' };
  const lastJson = (out) => JSON.parse(String(out).trim().split('\n').pop() || '{}');

  /**
   * Finish one original photo: the main style (setting studioStyle, auto = grey for whitish products, else white)
   * takes the original's place among the listing photos; the other background is added beside it as a candidate.
   * redo: make the current-style versions again for a photo finished earlier, replacing the old one in the listing.
   */
  async function processOne({ productId, photoId, redo = false }) {
    const p = store.get(productId);
    const ph = p.photos.find((x) => x.id === photoId && (redo || !x.deletedAt));
    if (!ph || ph.kind !== 'actual' || ph.derivedFrom) return;
    const finished = p.photos.filter((x) => !x.deletedAt && x.derivedFrom === ph.id && x.edit?.auto);
    if (finished.length && !redo) return; // already finished
    const mine = finished.filter((x) => x.edit?.v >= 2 && x.by !== 'user' && x.edit?.auto === 'studio');
    if (redo && mine.length && mine.every((x) => x.edit.v === VERSION)) return; // already in the current style
    if (redo && mine.length) return refinish(productId, ph, mine);
    const dir = store.dir(productId);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-studio-'));
    try {
      const src = path.join(dir, ph.files.original);
      const ds = ['--deshadow', String(store.settings.studioDeshadow ?? DESHADOW)];
      const out = path.join(tmp, 'main.jpg');
      const info = lastJson(await run(TOOL, [src, out, '--bg', store.settings.studioStyle || 'auto', ...ds]));
      if (!info.ok) return;
      const made = [{ file: out, info, main: true }];
      let qc = null;
      if (info.mode === 'studio') {
        // The small local model is unreliable (it called "Background clutter removed." a failure; 2 of 2 doubts were
        // wrong), so a doubt only adds 要確認 to the note. The original photo is always kept.
        qc = (await localQc(path.join(dir, ph.files.work || ph.files.original), out, tmp)) ?? null;
        const other = info.background === 'grey' ? 'white' : 'grey';
        const out2 = path.join(tmp, 'alt.jpg');
        const info2 = lastJson(await run(TOOL, [src, out2, '--mode', 'studio', '--bg', other, ...ds]));
        if (info2.ok) made.push({ file: out2, info: info2, main: false });
      }
      const fresh = store.get(productId); // the user may have changed things meanwhile
      if (!fresh.photos.some((x) => x.id === ph.id && (redo || !x.deletedAt))) return;
      const inListing = finished.find((x) => fresh.listingPhotoIds.includes(x.id));
      for (const m of made) {
        const thumb = path.join(tmp, `t-${m.main ? 'm' : 'a'}.jpg`);
        await run('sips', ['-Z', '400', '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', m.file, '--out', thumb]);
        const buf = fs.readFileSync(m.file);
        const style = m.info.mode === 'studio' ? `${STYLE_NOTE[m.info.background] || '白抜き'}${m.info.straightened ? `・傾き${Math.abs(m.info.straightened)}°補正` : ''}` : '';
        const doubt = m.main && qc && !qc.ok ? `・要確認: ローカルAIが欠けを指摘（${qc.reason}）` : '';
        store.addPhoto(productId, ACTOR, {
          kind: 'actual',
          source: 'studio',
          derivedFrom: ph.id,
          tag: ph.tag || '',
          note: style ? `AI仕上げ（${style}・トリミング・色補正・影を明るく${doubt}）` : `AI仕上げ（色・明るさ補正のみ: ${m.info.why || ''}）`,
          edit: { auto: m.info.mode, v: VERSION, style: m.info.background || null, why: m.info.why || '', qc: m.main ? qc : null, deshadow: m.info.deshadow, shadowScore: m.info.shadowScore },
          width: m.info.width,
          height: m.info.height,
          clientId: `studio2:${ph.id}:${m.main ? 'main' : 'alt'}`,
          replaceInListing: m.main && !fresh.locks.listingPhotos,
          replacePhotoId: inListing?.id,
        }, { original: { buffer: buf, mime: 'image/jpeg' }, work: { buffer: buf, mime: 'image/jpeg' }, thumb: { buffer: fs.readFileSync(thumb), mime: 'image/jpeg' } });
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Make the finished photos again in the current style, in place (same photo, same listing position). */
  async function refinish(productId, ph, photos) {
    const src = path.join(store.dir(productId), ph.files.original);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-studio-'));
    try {
      for (const x of photos) {
        const out = path.join(tmp, `${x.id}.jpg`);
        const info = lastJson(await run(TOOL, [src, out, '--mode', 'studio', '--bg', x.edit.style || 'white', '--deshadow', String(store.settings.studioDeshadow ?? DESHADOW)]));
        if (!info.ok || info.mode !== 'studio') continue;
        const thumb = path.join(tmp, `${x.id}.t.jpg`);
        await run('sips', ['-Z', '400', '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', out, '--out', thumb]);
        const buf = fs.readFileSync(out);
        const note = String(x.note || '').replace(/^AI仕上げ（[^・）]+/, `AI仕上げ（${STYLE_NOTE[info.background] || '白抜き'}`);
        store.refinishPhoto(productId, ACTOR, x.id, {
          note: info.straightened ? note.replace('トリミング', `傾き${Math.abs(info.straightened)}°補正・トリミング`) : note,
          edit: { ...x.edit, v: VERSION, style: info.background, straightened: info.straightened, deshadow: info.deshadow, shadowScore: info.shadowScore },
          width: info.width,
          height: info.height,
        }, { original: { buffer: buf }, work: { buffer: buf }, thumb: { buffer: fs.readFileSync(thumb) } });
      }
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
    /** Photos finished in the old style: make them again (the new version replaces the old one in the listing; the old stays as a photo). */
    redo(productIds) {
      let n = 0;
      for (const p of store.list({ includeTrash: false })) {
        if (productIds && !productIds.includes(p.id)) continue;
        const srcs = new Set(p.photos.filter((x) => !x.deletedAt && x.source === 'studio' && x.edit?.auto && x.edit?.v !== VERSION).map((x) => x.derivedFrom));
        for (const id of srcs) {
          queue.push({ productId: p.id, photoId: id, redo: true });
          n++;
        }
      }
      setImmediate(pump);
      return n;
    },
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
