#!/usr/bin/env node
// ローカルAIの判定（scripts/local_judge.py の出力）と画像の近さから、相場の判定ファイル（apply-market.js の入力）を作る。
//
// 使い方: node scripts/judge-decide.js --site yahoo|rakuma|mercari --results r.jsonl[,r2.jsonl] [--ids …] [--model 名前] > decisions.json
//
// 決め方（メルカリで Claude が判定済みの 51商品・約600候補で確かめた基準）:
//   同じ商品 = 公式画像とほぼ同じ写真（dHash 距離 10 以下）、または ローカルAIが「同じ」かつ距離 12 以下
//              → この条件では既存の判定と 100% 一致。AIの「同じ」だけだと半分は似た商品だったので使わない。
//   似た商品 = それ以外で ローカルAIが「同じ／似た」と答え、Amazon価格の1.2倍以下・距離30以下のもの
//              （Claude が選んだ似た商品は 92件中90件がこの範囲。AIが余分に拾う高い別物を落とす）
//   ヤフオクの中古等は、新品の例が2件以上あれば除く。Amazon価格の5倍を超える例（まとめ売り等）も除く。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.INVENTORY_DATA || path.join(ROOT, 'data');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const SITE = opt('--site') || 'yahoo';
const MODEL = opt('--model') || 'qwen3.5:4b';
const SCAN = path.join(DATA, 'imports', SITE === 'mercari' ? 'market-scan' : `${SITE}-scan`);
import { SAME_DIST, SAME_DIST_WITH_AI, SIMILAR_PRICE_CAP, SIMILAR_MAX_DIST } from './judge-rules.js';

const ai = {};
for (const f of (opt('--results') || '').split(',').filter(Boolean)) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    ai[r.key] = r.label;
  }
}

const out = {};
// Every scanned product: some are decided by the rules alone (all candidates near-identical, or none comparable) and never reach the AI.
const ONLY = opt('--ids') ? new Set(opt('--ids').split(',')) : null;
const ids = fs.readdirSync(SCAN).filter((f) => /^\d{4}\.json$/.test(f)).map((f) => f.slice(0, 4)).filter((id) => !ONLY || ONLY.has(id));
for (const id of ids.sort()) {
  const scanFile = path.join(SCAN, `${id}.json`);
  if (!fs.existsSync(scanFile)) continue;
  const scan = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
  const cap = scan.amazonPrice ? scan.amazonPrice * 5 : Infinity;
  const same = [];
  const similar = [];
  scan.items.forEach((it, i) => {
    const lab = ai[`${id}:${i}`];
    const d = it.dist ?? 99;
    if (it.price > cap) return;
    if (d <= SAME_DIST || (lab === 'same' && d <= SAME_DIST_WITH_AI)) same.push(i);
    else if ((lab === 'same' || lab === 'similar') && d <= SIMILAR_MAX_DIST && (!scan.amazonPrice || it.price <= scan.amazonPrice * SIMILAR_PRICE_CAP)) similar.push(i);
  });
  // Prefer new items (we would sell new) when there are enough of them.
  const preferNew = (idx) => {
    const fresh = idx.filter((i) => !scan.items[i].condition || scan.items[i].condition === 'NEW');
    return fresh.length >= 2 ? fresh : idx;
  };
  const s = preferNew(same).slice(0, 10);
  const m = preferNew(similar).slice(0, 10);
  const matchType = s.length ? 'same' : m.length ? 'similar' : 'none';
  const note = `ローカルAI（${MODEL}）の判定＋画像照合。同じ商品＝公式画像とほぼ同じ写真のもの。`;
  out[id] = [matchType, s.length ? 'image' : 'keyword', s, matchType === 'same' ? [] : m, note];
}
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
