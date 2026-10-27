#!/usr/bin/env node
// 見立てたサイズ（{ "<商品ID>": [長さ, 幅, 高さ, kg, "high|mid|low", "根拠"] }）を商品台帳に記録する。
// 使い方: node scripts/apply-size-estimates.js data/imports/size-estimates-1.json [--actor claude]
import fs from 'node:fs';
const BASE = process.env.INVENTORY_URL || 'http://127.0.0.1:8787';
const file = process.argv[2];
const actor = process.argv.includes('--actor') ? process.argv[process.argv.indexOf('--actor') + 1] : 'claude';
const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
let ok = 0;
for (const [id, [L, W, H, kg, confidence, reason]] of Object.entries(rows)) {
  const res = await fetch(`${BASE}/api/products/${id}/size-estimate`, {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-actor': actor },
    body: JSON.stringify({ estimate: { dims: [L, W, H], kg, confidence, reason } }),
  });
  if (res.ok) ok++; else console.log(id, res.status, (await res.json().catch(() => ({}))).error || '');
}
console.log(`記録 ${ok}/${Object.keys(rows).length}件`);
