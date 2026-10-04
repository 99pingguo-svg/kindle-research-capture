// Full backup of the data directory (including photos) to a timestamped tar.gz.
//   npm run backup                      → ./backups-full/daicho-YYYYMMDD-HHMM.tar.gz
//   BACKUP_DIR=/Volumes/USB npm run backup
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.INVENTORY_DATA || path.join(root, 'data'));
const outDir = path.resolve(process.env.BACKUP_DIR || path.join(root, 'backups-full'));
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
const out = path.join(outDir, `daicho-${stamp}.tar.gz`);
const r = spawnSync('tar', ['-czf', out, '--exclude=./backups', '--exclude=./outbox', '-C', dataDir, '.'], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('バックアップに失敗しました');
  process.exit(1);
}
console.log(`バックアップ完了: ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`復元: mkdir data && tar -xzf ${path.basename(out)} -C data`);
