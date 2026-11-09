// 公式画像の自動取得（設定 autoOfficial）: ASIN があって公式画像（参考画像）がまだの商品を、30分ごとに10件まで
// scripts/amazon-info.js で取りに行く（Cookie を持たない fetch＝ログアウト状態。ロボット確認が出たら突破せず12時間休む）。
// 観察ブラウザ連携が新しい注文を台帳に足すと、ここで公式画像・価格・大きさが付く。
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'amazon-info.js');
const EVERY = 30 * 60_000;
const BATCH = 10;
const PAUSE_AFTER_ROBOT = 12 * 3600_000;
const RETRY_AFTER = 24 * 3600_000;

const hasOfficial = (p) => (p.photos || []).some((ph) => ph.kind === 'reference' && !ph.deletedAt);
const asinOf = (p) => p.browser?.asin || p.amazon?.asin || /\/dp\/([A-Z0-9]{10})/.exec((p.links || []).map((l) => l.url).join(' '))?.[1] || null;

export function createOfficialFetcher(store, { port = 8787 } = {}) {
  const tried = new Map(); // id → last attempt (ms)
  let running = false;
  let pausedUntil = 0;
  let last = null;

  const due = () => store.list({ includeTrash: false })
    .filter((p) => !p.amazon?.fetchedAt && !hasOfficial(p) && asinOf(p) && Date.now() - (tried.get(p.id) || 0) > RETRY_AFTER)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')); // newest first

  function run() {
    if (running || store.settings.autoOfficial === false || Date.now() < pausedUntil) return false;
    const ids = due().slice(0, BATCH).map((p) => p.id);
    if (!ids.length) return false;
    running = true;
    for (const id of ids) tried.set(id, Date.now());
    execFile(process.execPath, [SCRIPT, '--ids', ids.join(','), '--delay', '6'], {
      cwd: ROOT, timeout: 15 * 60_000, env: { ...process.env, INVENTORY_URL: `http://127.0.0.1:${port}` },
    }, (err, out, errOut) => {
      running = false;
      const text = `${out || ''}${errOut || ''}`;
      const robot = /ロボット確認|CAPTCHA/i.test(text);
      if (robot) pausedUntil = Date.now() + PAUSE_AFTER_ROBOT;
      last = { at: new Date().toISOString(), ids, ok: !err, robot, summary: text.trim().split('\n').slice(-2).join(' ').slice(0, 300) };
      if (err && !robot) console.error('official:', last.summary);
    });
    return true;
  }

  setTimeout(run, 60_000);
  setInterval(run, EVERY).unref();
  return {
    run,
    status: () => ({ on: store.settings.autoOfficial !== false, running, waiting: due().length, pausedUntil: pausedUntil > Date.now() ? new Date(pausedUntil).toISOString() : null, last }),
  };
}
