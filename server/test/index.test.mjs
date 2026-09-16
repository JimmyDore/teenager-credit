import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const entrypoint = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs');

test('the server refuses to start without ADMIN_PASSWORD', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'credit-index-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { ADMIN_PASSWORD, ...env } = process.env;

  const result = spawnSync(process.execPath, [entrypoint], {
    env: { ...env, DATA_DIR: dataDir, PORT: '0' },
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ADMIN_PASSWORD/);
  assert.deepEqual(fs.readdirSync(dataDir), [], 'nothing is created');
});
