#!/usr/bin/env node
// Amazon の商品リストの取り込みと、全商品の「公式画像・価格・サイズ・重さ」の取得。
//
// 1) --add <リスト.txt> : 「商品名<TAB>https://www.amazon.co.jp/dp/ASIN<TAB>日付」の行を新商品として登録（ASIN で重複を除く）
// 2) 取得（既定で実行）  : ASIN のある商品のうち、まだ取得していないものの Amazon 商品ページを読み、
//    公式画像（参考画像がなければ1枚目を登録）・価格（調査記録がない商品だけ）・梱包/本体サイズ・重さを保存する。
//
// Amazon は必ずログアウトした状態で読む: Cookie を一切持たない fetch で開き、ログイン中の表示なら中止する。
// ロボット確認（CAPTCHA）が出たら突破を試みずに中止する（次回はそこから再開）。1件ごとに数秒あける。
//
// 使い方:
//   node scripts/amazon-info.js --add vine-review-links.txt --dry-run   # 追加される件数だけ
//   node scripts/amazon-info.js --add vine-review-links.txt              # 追加して、追加分から取得
//   node scripts/amazon-info.js [--limit N] [--ids 0003,0004] [--refresh] [--delay 秒] # 取得のみ
// 前提: サーバーが起動中（Mac 内の入口 http://127.0.0.1:8787）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.INVENTORY_URL || 'http://127.0.0.1:8787';
const ACTOR = 'import';
const LOG = path.join(process.env.INVENTORY_DATA || path.join(ROOT, 'data'), 'imports', 'amazon-info.jsonl');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const flag = (k) => args.includes(k);
const DRY = flag('--dry-run');
const LIMIT = Number(opt('--limit')) || Infinity;
const ONLY = opt('--ids') ? new Set(opt('--ids').split(',')) : null;
const REFRESH = flag('--refresh');
const DELAY = (Number(opt('--delay')) || 5) * 1000; // seconds between pages (a little random added)
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'x-actor': ACTOR, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${json.error || ''}`);
  return json;
}
const log = (rec) => { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n'); };

// ---------- which products exist (by ASIN) ----------
const ASIN_RE = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/;
function asinsOf(p) {
  const out = new Set();
  for (const l of p.links || []) { const m = ASIN_RE.exec(l.url || ''); if (m) out.add(m[1]); }
  const m = /ASIN:\s*([A-Z0-9]{10})/.exec(p.notes || ''); if (m) out.add(m[1]);
  for (const ph of p.photos || []) { const c = /^([A-Z0-9]{10}):/.exec(ph.clientId || ''); if (c) out.add(c[1]); }
  const r = ASIN_RE.exec(p.research?.url || ''); if (r) out.add(r[1]);
  return [...out];
}
async function allProducts() {
  const list = await api('GET', '/api/products');
  const items = Array.isArray(list) ? list : list.products || list.items || [];
  const out = [];
  for (const s of items) out.push(await api('GET', `/api/products/${s.id}`).then((r) => r.product || r));
  return out;
}

// ---------- 1) add a list ----------
function parseList(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split('\t');
    const url = cols.find((c) => ASIN_RE.test(c));
    if (!url) continue;
    const asin = ASIN_RE.exec(url)[1];
    const full = (cols[0] || '').replace(/&amp;/g, '&').trim();
    const date = cols.find((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.trim()))?.trim() || '';
    rows.push({ asin, full, name: full.split(' | ')[0].trim().slice(0, 120), date, url: `https://www.amazon.co.jp/dp/${asin}` });
  }
  return rows;
}
async function addList(file, products) {
  const have = new Map();
  for (const p of products) if (!p.trashedAt) for (const a of asinsOf(p)) have.set(a, p.id);
  const rows = parseList(fs.readFileSync(file, 'utf8'));
  const seen = new Set();
  const fresh = rows.filter((r) => !have.has(r.asin) && !seen.has(r.asin) && seen.add(r.asin));
  console.log(`リスト ${rows.length}件: 既存と重複 ${rows.length - fresh.length}件 → 新規 ${fresh.length}件`);
  if (DRY) return [];
  const added = [];
  for (const r of fresh) {
    const notes = [`ASIN: ${r.asin}`, `取り込み元: ${path.basename(file)}（${today()}）`, r.full !== r.name ? `Amazonの商品名: ${r.full}` : ''].filter(Boolean).join('\n');
    const { product } = await api('POST', '/api/products', {
      name: r.name, notes, ...(r.date ? { itemDate: r.date } : {}),
      links: [{ url: r.url, type: 'purchase', label: 'Amazon' }],
    });
    added.push(product.id);
    log({ type: 'add', asin: r.asin, id: product.id });
  }
  console.log(`登録 ${added.length}件（${added[0] || ''}〜${added.at(-1) || ''}）`);
  return added;
}

// ---------- 2) read the Amazon page ----------
const clean = (x) => x.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;|&#160;/g, ' ').replace(/[‎‏]/g, '').replace(/\s+/g, ' ').trim();
function detailRows(html) {
  const rows = [];
  for (const m of html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) rows.push([clean(m[1]), clean(m[2])]);
  for (const m of html.matchAll(/<span class="a-text-bold">([\s\S]*?)<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/g)) rows.push([clean(m[1]).replace(/[:：]\s*$/, '').trim(), clean(m[2])]);
  for (const m of html.matchAll(/<span class="a-size-base a-text-bold">([\s\S]*?)<\/span>[\s\S]{0,300}?<span class="a-size-base po-break-word">([\s\S]*?)<\/span>/g)) rows.push([clean(m[1]), clean(m[2])]);
  return rows.filter(([k, v]) => k && v && k.length < 40);
}
const N = '(\\d+(?:[.,]\\d+)?)';
export function parseDims(v) {
  const s = v.normalize('NFKC').replace(/[×xX*]/g, ' x ');
  const m = new RegExp(`${N}\\s*(?:cm|mm|m|インチ)?\\s*x\\s*${N}\\s*(?:cm|mm|m|インチ)?(?:\\s*x\\s*${N})?\\s*(cm|センチ|mm|ミリ|m|メートル|インチ|inch|in)`, 'i').exec(s);
  if (!m) return null;
  const f = { cm: 1, センチ: 1, mm: 0.1, ミリ: 0.1, m: 100, メートル: 100, インチ: 2.54, inch: 2.54, in: 2.54 }[m[4].toLowerCase()] ?? 1;
  const dims = [m[1], m[2], m[3]].filter(Boolean).map((x) => Math.round(Number(x.replace(',', '.')) * f * 10) / 10);
  if (dims.length < 2 || dims.some((d) => !(d > 0) || d > 400)) return null;
  if (dims.length === 2) dims.push(1); // flat goods listed as W×H only
  return dims;
}
export function parseKg(v) {
  const s = v.normalize('NFKC');
  const m = new RegExp(`${N}\\s*(kg|キログラム|g|グラム|ポンド|lb|lbs|オンス|oz)(?![a-z])`, 'i').exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  const u = m[2].toLowerCase();
  const kg = /kg|キロ/.test(u) ? n : /g|グラム/.test(u) ? n / 1000 : /ポンド|lb/.test(u) ? n * 0.4536 : n * 0.02835;
  return kg > 0 && kg < 200 ? Math.round(kg * 1000) / 1000 : null;
}
export function parsePage(html) {
  const title = clean(/id="productTitle"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1] || '');
  const core = /id="(?:corePriceDisplay_desktop_feature_div|corePrice_feature_div|apex_desktop)"[\s\S]{0,6000}/.exec(html)?.[0] || '';
  const whole = /class="a-price-whole">([\d,]+)/.exec(core)?.[1];
  const price = whole ? Number(whole.replace(/,/g, '')) : null;
  const pkg = {}; const prod = {};
  for (const [k, v] of detailRows(html)) {
    const isPkg = /梱包|パッケージ|発送/.test(k);
    if (/寸法|サイズ/.test(k) && !/^サイズ$|フレーム|画面|ディスプレイ|対応|容量|フィット|装着|ベッド|靴/.test(k)) {
      const d = parseDims(v);
      if (d) { const t = isPkg ? pkg : prod; if (!t.dims) Object.assign(t, { dims: d, text: `${k}: ${v}`.slice(0, 120) }); }
      const kg = /[;；]/.test(v) ? parseKg(v.split(/[;；]/).slice(1).join(' ')) : null;
      if (kg != null) { const t = isPkg ? pkg : prod; if (t.kg == null) t.kg = kg; }
    } else if (/重量|重さ/.test(k) && !/耐荷重|最大|積載/.test(k)) {
      const kg = parseKg(v);
      if (kg != null) { const t = isPkg ? pkg : prod; if (t.kg == null) t.kg = kg; }
    }
  }
  // No size table (common for apparel and small goods): take a W×D×H with a unit written in the title or the feature bullets.
  if (!pkg.dims && !prod.dims) {
    const bullets = /id="feature-bullets"[\s\S]{0,8000}/.exec(html)?.[0] || '';
    for (const src of [title, ...[...bullets.matchAll(/<span class="a-list-item">([\s\S]*?)<\/span>/g)].map((m) => clean(m[1]))]) {
      const t = src.normalize('NFKC');
      const m = /(\d+(?:\.\d+)?)\s*(?:cm|mm)?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(?:cm|mm)?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(cm|mm|センチ|ミリ)/i.exec(t);
      const d = m && parseDims(m[0]);
      if (d) { Object.assign(prod, { dims: d, text: `説明文: ${m[0]}`, fromText: true }); break; }
    }
  }
  const image = /"hiRes":"(https:[^"]+)"/.exec(html)?.[1] || /"large":"(https:[^"]+)"/.exec(html)?.[1] || /data-old-hires="(https:[^"]+)"/.exec(html)?.[1] || null;
  return { title, price, package: pkg.dims || pkg.kg != null ? pkg : null, product: prod.dims || prod.kg != null ? prod : null, image };
}

class Stop extends Error {}
async function readPage(asin) {
  const res = await fetch(`https://www.amazon.co.jp/dp/${asin}`, {
    headers: { 'user-agent': UA, 'accept-language': 'ja-JP,ja;q=0.9', accept: 'text/html' },
    redirect: 'follow',
    credentials: 'omit',
  });
  const html = await res.text();
  if (/validateCaptcha|captcha|api-services-support@amazon\.com/i.test(html) && !/productTitle/.test(html)) throw new Stop('Amazonのロボット確認が出たため中止（突破はしない）。時間をおいて再実行すると続きから取得します。');
  if (res.status === 404) return { missing: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const hello = /nav-link-accountList-nav-line-1[^>]*>([^<]*)/.exec(html)?.[1] || '';
  if (hello && !/ログイン/.test(hello)) throw new Stop('ログイン中の表示を検出したため中止（ログアウト状態でのみ取得する）');
  return parsePage(html);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'daicho-amazon-'));
async function uploadOfficial(p, asin, url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, credentials: 'omit' });
  if (!res.ok) throw new Error(`画像 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const src = path.join(TMP, `${asin}.jpg`);
  fs.writeFileSync(src, buf);
  const thumb = path.join(TMP, `${asin}.thumb.jpg`);
  await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', '400', src, '--out', thumb]);
  const fd = new FormData();
  const base = `${asin}_01.jpg`;
  for (const [k, v] of Object.entries({ kind: 'reference', source: 'reference', note: `Amazon商品ページ画像 ${base}（公式画像）`, sourceUrl: `https://www.amazon.co.jp/dp/${asin}`, clientId: `${asin}:ref:${base}` })) fd.append(k, v);
  fd.append('original', new Blob([buf], { type: 'image/jpeg' }), base);
  fd.append('thumb', new Blob([fs.readFileSync(thumb)], { type: 'image/jpeg' }), 'thumb.jpg');
  await api('POST', `/api/products/${p.id}/photos`, fd);
}

const groupOf = (yen) => (yen == null ? '価格未確認' : yen >= 3000 ? '3000円以上' : yen >= 2300 ? '2300〜2999円' : '2300円未満');

async function fetchAll(products, firstIds = []) {
  // Newly added, then products still without an official image, then the rest.
  const rank = (p) => (firstIds.includes(p.id) ? 0 : p.photos.some((ph) => ph.kind === 'reference' && !ph.deletedAt) ? 2 : 1);
  const order = [...products].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  const todo = order.filter((p) => !p.trashedAt && asinsOf(p).length && (ONLY ? ONLY.has(p.id) : true) && (REFRESH || !p.amazon?.fetchedAt)).slice(0, LIMIT);
  console.log(`取得対象 ${todo.length}件${DRY ? '（--dry-run なので読まない）' : ''}`);
  if (DRY) return;
  let ok = 0; let sized = 0; let images = 0; let failed = 0;
  for (const [i, p] of todo.entries()) {
    const asin = asinsOf(p)[0];
    try {
      const page = await readPage(asin);
      if (page.missing) { log({ type: 'missing', id: p.id, asin }); failed++; continue; }
      const info = { asin, url: `https://www.amazon.co.jp/dp/${asin}`, title: page.title, price: page.price, package: page.package, product: page.product, image: page.image, fetchedAt: new Date().toISOString() };
      await api('PUT', `/api/products/${p.id}/amazon`, { amazon: info });
      if (!p.photos.some((ph) => ph.kind === 'reference' && !ph.deletedAt) && page.image) { await uploadOfficial(p, asin, page.image); images++; }
      if (!p.research) {
        await api('PUT', `/api/products/${p.id}/research`, { research: {
          source: 'Amazon商品ページ（自動取得）', checkedDate: today(), group: groupOf(page.price), amazonPrice: page.price,
          priceKind: '表示価格', priceStatus: page.price != null ? '自動取得' : '取得できず', liveTitle: page.title, discounts: [], url: info.url,
        } });
      }
      ok++; if (page.package?.dims || page.product?.dims) sized++;
      log({ type: 'fetched', id: p.id, asin, price: page.price, package: page.package, product: page.product });
    } catch (e) {
      if (e instanceof Stop) { console.log(`\n${e.message}`); log({ type: 'stopped', id: p.id, asin, reason: e.message }); break; }
      failed++; log({ type: 'error', id: p.id, asin, error: e.message });
    }
    if ((i + 1) % 10 === 0 || i === todo.length - 1) console.log(`${i + 1}/${todo.length} 取得${ok}（サイズあり${sized}・画像追加${images}）失敗${failed}`);
    await sleep(DELAY * (0.8 + Math.random() * 0.6));
  }
  console.log(`完了: 取得${ok}件（サイズあり${sized}・公式画像を追加${images}）・失敗${failed}件。記録 ${path.relative(ROOT, LOG)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let products = await allProducts();
  let first = [];
  if (opt('--add')) {
    first = await addList(opt('--add'), products);
    if (first.length) products = await allProducts();
  }
  await fetchAll(products, first);
  fs.rmSync(TMP, { recursive: true, force: true });
}
