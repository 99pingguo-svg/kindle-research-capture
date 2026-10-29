// 画像の近さ（64bit dHash、macOS の sips で 9×8 に縮小）と、商品の公式画像（参考画像）のハッシュ。
// market-scan（メルカリ）と yahoo-scan（ヤフオク）で共有。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.INVENTORY_DATA || path.join(ROOT, 'data');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-hash-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

export async function dhash(file) {
  const out = path.join(TMP, `${path.basename(file)}.${process.hrtime.bigint()}.bmp`);
  await run('sips', ['-s', 'format', 'bmp', '-z', '8', '9', file, '--out', out]);
  const b = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  const off = b.readUInt32LE(10); const w = b.readInt32LE(18); const hRaw = b.readInt32LE(22); const bpp = b.readUInt16LE(28);
  const h = Math.abs(hRaw); const bytes = bpp / 8; const stride = Math.ceil((w * bytes) / 4) * 4;
  const g = (x, y) => {
    const row = hRaw > 0 ? h - 1 - y : y;
    const i = off + row * stride + x * bytes;
    return 0.114 * b[i] + 0.587 * b[i + 1] + 0.299 * b[i + 2];
  };
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += g(x, y) > g(x + 1, y) ? '1' : '0';
  return bits;
}
export const ham = (a, b) => [...a].reduce((n, c, i) => n + (c !== b[i] ? 1 : 0), 0);

export async function officialHashes(id) {
  const p = JSON.parse(fs.readFileSync(path.join(DATA, 'products', id, 'product.json'), 'utf8'));
  const refs = p.photos.filter((ph) => ph.kind === 'reference' && !ph.deletedAt).slice(0, 6);
  const out = [];
  for (const r of refs) {
    const f = path.join(DATA, 'products', id, r.files.thumb || r.files.original);
    if (fs.existsSync(f)) out.push(await dhash(f).catch(() => null));
  }
  return { product: p, hashes: out.filter(Boolean) };
}

