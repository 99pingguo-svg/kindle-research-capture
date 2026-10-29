#!/usr/bin/env node
// 相場の候補（market-scan / yahoo-scan の結果）を、ローカルAI判定（scripts/local_judge.py）の入力 JSONL にする。
//
// 使い方: node scripts/judge-tasks.js --site yahoo|mercari [--ids 0003,0004] [--top 12] [--labels] > tasks.jsonl
//   --top    : 商品ごとに画像の近い順で何件まで判定するか（既定 12）
//   --labels : メルカリの既存の判定（data/imports/market-decisions/*.json）を label に付ける（ローカルAIの精度確認用）
// メルカリのサムネイルは data/imports/market-scan/img/ に保存してから使う（公開の商品画像。Cookie は送らない）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.INVENTORY_DATA || path.join(ROOT, 'data');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const SITE = opt('--site') || 'yahoo';
const TOP = Number(opt('--top')) || 12;
const ONLY = opt('--ids') ? new Set(opt('--ids').split(',')) : null;
const SCAN = path.join(DATA, 'imports', SITE === 'yahoo' ? 'yahoo-scan' : 'market-scan');

function decisions() {
  const dir = path.join(DATA, 'imports', 'market-decisions');
  const out = {};
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.json')) : []) Object.assign(out, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  return out;
}

/** The product's first official image, at list size if it exists. */
function productImage(p) {
  const ref = p.photos.find((ph) => ph.kind === 'reference' && !ph.deletedAt);
  if (!ref) return null;
  const dir = path.join(DATA, 'products', p.id);
  const mini = ref.files.thumb?.replace(/\.thumb\.jpg$/, '.mini.jpg');
  for (const f of [mini, ref.files.thumb, ref.files.work]) if (f && fs.existsSync(path.join(dir, f))) return path.join(dir, f);
  return null;
}

async function mercariThumb(url) {
  const m = /\/item\/(m\d+)/.exec(url);
  if (!m) return null;
  const dir = path.join(SCAN, 'img');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${m[1]}.jpg`);
  if (!fs.existsSync(f)) {
    const res = await fetch(`https://static.mercdn.net/c!/w=240/thumb/photos/${m[1]}_1.jpg`, { credentials: 'omit' });
    if (!res.ok) return null;
    fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
    await new Promise((r) => setTimeout(r, 150));
  }
  return f;
}

const dec = args.includes('--labels') ? decisions() : null;
const files = fs.readdirSync(SCAN).filter((f) => /^\d{4}\.json$/.test(f)).sort();
for (const f of files) {
  const id = f.slice(0, 4);
  if (ONLY && !ONLY.has(id)) continue;
  if (dec && !dec[id]) continue;
  const scan = JSON.parse(fs.readFileSync(path.join(SCAN, f), 'utf8'));
  const p = JSON.parse(fs.readFileSync(path.join(DATA, 'products', id, 'product.json'), 'utf8'));
  const pimg = productImage(p);
  if (!pimg) continue;
  const title = p.amazon?.title || p.name;
  const [, , same = [], similar = []] = dec?.[id] || [];
  const n = dec ? scan.items.length : Math.min(TOP, scan.items.length);
  for (let i = 0; i < n; i++) {
    const it = scan.items[i];
    const img = SITE === 'yahoo' ? (it.thumb ? path.join(SCAN, it.thumb) : null) : await mercariThumb(it.url).catch(() => null);
    if (!img) continue;
    const task = { key: `${id}:${i}`, product_title: title, product_image: pimg, cand_title: it.title, cand_price: it.price, cand_image: img, dist: it.dist };
    if (dec) task.label = same.includes(i) ? 'same' : similar.includes(i) ? 'similar' : 'other';
    process.stdout.write(JSON.stringify(task) + '\n');
  }
}
