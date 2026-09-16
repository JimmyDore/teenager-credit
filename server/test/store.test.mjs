import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';

const initialData = () => ({ version: 1, items: [] });

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'credit-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

test('the data file is created with the initial data on first open, including missing directories', async (t) => {
  const dataDir = path.join(await tempDir(t), 'nested', 'data');

  const store = await openStore(dataDir, { initialData });

  assert.deepEqual(store.read(), { version: 1, items: [] });
  assert.deepEqual(await readJson(path.join(dataDir, 'credits.json')), { version: 1, items: [] });
});

test('updates are persisted and survive a reopen', async (t) => {
  const dataDir = await tempDir(t);
  const store = await openStore(dataDir, { initialData });

  const result = await store.update((data) => {
    data.items.push('first');
    return 'done';
  });

  assert.equal(result, 'done');
  assert.deepEqual(store.read().items, ['first']);
  const reopened = await openStore(dataDir, { initialData });
  assert.deepEqual(reopened.read(), { version: 1, items: ['first'] });
});

test('a failing update changes nothing, and later updates still go through', async (t) => {
  const dataDir = await tempDir(t);
  const store = await openStore(dataDir, { initialData });
  await store.update((data) => data.items.push('kept'));

  await assert.rejects(
    store.update((data) => {
      data.items.push('half-done');
      throw new Error('rule broken');
    }),
    /rule broken/,
  );

  assert.deepEqual(store.read().items, ['kept']);
  assert.deepEqual((await readJson(path.join(dataDir, 'credits.json'))).items, ['kept']);
  await store.update((data) => data.items.push('after'));
  assert.deepEqual(store.read().items, ['kept', 'after']);
});

test('concurrent updates are serialized and leave one valid file without temp files', async (t) => {
  const dataDir = await tempDir(t);
  const store = await openStore(dataDir, { initialData });

  await Promise.all(
    Array.from({ length: 50 }, (_, i) => store.update((data) => data.items.push(i))),
  );

  const expected = Array.from({ length: 50 }, (_, i) => i);
  assert.deepEqual(store.read().items, expected);
  assert.deepEqual((await readJson(path.join(dataDir, 'credits.json'))).items, expected);
  assert.deepEqual(await fs.readdir(dataDir), ['credits.json']);
});

test('when the file cannot be written, the update fails and the previous state stays intact', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, async (t) => {
  const dataDir = await tempDir(t);
  const store = await openStore(dataDir, { initialData });
  await store.update((data) => data.items.push('kept'));
  await fs.chmod(dataDir, 0o555);
  try {
    await assert.rejects(store.update((data) => data.items.push('lost')));
  } finally {
    await fs.chmod(dataDir, 0o755);
  }

  assert.deepEqual(store.read().items, ['kept']);
  assert.deepEqual((await readJson(path.join(dataDir, 'credits.json'))).items, ['kept']);
});

test('a corrupted data file is never overwritten: opening fails loudly', async (t) => {
  const dataDir = await tempDir(t);
  await fs.writeFile(path.join(dataDir, 'credits.json'), '{"version": 1, "fami');

  await assert.rejects(openStore(dataDir, { initialData }));

  assert.equal(await fs.readFile(path.join(dataDir, 'credits.json'), 'utf8'), '{"version": 1, "fami');
});

test('read() hands out a snapshot callers cannot use to bypass update()', async (t) => {
  const dataDir = await tempDir(t);
  const store = await openStore(dataDir, { initialData });
  const before = store.read();

  await store.update((data) => data.items.push('new'));

  assert.deepEqual(before.items, []);
});
