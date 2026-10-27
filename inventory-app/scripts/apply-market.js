#!/usr/bin/env node
// 下調べ（data/imports/market-scan/<ID>.json）と判定（{ "<ID>": [same|similar|none, image|keyword, [同じ商品の番号], [似た商品の番号], "補足"] }）から
// メルカリ相場を記録する。番号は下調べの items の並び（画像の近い順）。
// 使い方: node scripts/apply-market.js <判定.json>... [--actor claude]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.INVENTORY_URL || 'http://127.0.0.1:8787';
const args = process.argv.slice(2);
const actor = args.includes('--actor') ? args[args.indexOf('--actor') + 1] : 'claude';
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--actor');
let ok = 0; let n = 0;
for (const f of files) {
  for (const [id, [matchType, method, same, similar, note]] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')))) {
    n++;
    const scan = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'imports', 'market-scan', `${id}.json`), 'utf8'));
    const pick = (idx, match) => idx.map((i) => scan.items[i]).filter(Boolean).map((it) => ({ title: it.title, price: it.price, url: it.url, match, note: it.dist != null ? `画像の近さ ${64 - it.dist}/64` : '' }));
    const examples = [...pick(same, 'same'), ...pick(similar, 'similar')];
    const used = examples[0] ? scan.searches.find((s) => s.keyword === scan.items.find((it) => it.url === examples[0].url)?.keyword) : scan.searches.find((s) => s.count) || scan.searches[0];
    const market = { matchType, method, query: used?.keyword || '', searchUrl: used?.url || '', examples, note, checkedAt: scan.scannedAt };
    const res = await fetch(`${BASE}/api/products/${id}/market`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-actor': actor }, body: JSON.stringify({ market }) });
    if (res.ok) ok++; else console.log(id, res.status, (await res.json().catch(() => ({}))).error || '');
  }
}
console.log(`記録 ${ok}/${n}件`);
