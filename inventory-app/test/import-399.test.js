import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

test('399の取り込み: 取り込み元（SSD）が見つからなければ失敗にせず休む', () => {
  const out = execFileSync(process.execPath, ['scripts/import-399.js', '--dry-run'], {
    env: { ...process.env, CODEX_399_ROOT: path.join(os.tmpdir(), 'no-such-ssd-399'), INVENTORY_URL: 'http://127.0.0.1:9' },
    encoding: 'utf8',
  });
  assert.match(out, /取り込み元が見つからないので休み/);
});
