// JSON file store: the whole dataset lives in memory and in
// `${dataDir}/credits.json`. Updates run one at a time on a draft copy; the
// draft becomes the current state only once it is safely on disk (temp file
// in the same directory, fsync, rename), so a crash or a rejected update
// never leaves a half-written file or a half-applied change.
import fs from 'node:fs/promises';
import path from 'node:path';

const FILE_NAME = 'credits.json';

export async function openStore(dataDir, { initialData }) {
  const filePath = path.join(dataDir, FILE_NAME);
  await fs.mkdir(dataDir, { recursive: true });

  let current = await load(filePath);
  if (current === undefined) {
    current = initialData();
    await writeAtomically(filePath, current);
  }

  let queue = Promise.resolve();

  return {
    filePath,

    /** Current committed state. Treat as read-only. */
    read() {
      return current;
    },

    /**
     * Runs `mutate(draft)` after every previously queued update, persists the
     * draft and returns what `mutate` returned. If `mutate` throws or the write
     * fails, the state is left untouched and the error is rethrown.
     */
    update(mutate) {
      const run = async () => {
        const draft = structuredClone(current);
        const result = await mutate(draft);
        await writeAtomically(filePath, draft);
        current = draft;
        return result;
      };
      const pending = queue.then(run);
      queue = pending.catch(() => {});
      return pending;
    },

    /** Resolves once every queued update has settled. */
    async flush() {
      await queue;
    },
  };
}

async function load(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid data file ${filePath}: ${err.message}`, { cause: err });
  }
}

let tempCounter = 0;

async function writeAtomically(filePath, data) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${++tempCounter}.tmp`);
  try {
    const handle = await fs.open(tempPath, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
  await syncDirectory(dir);
}

// Makes the rename itself durable. Not supported everywhere: best effort.
async function syncDirectory(dir) {
  let handle;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // ignore
  } finally {
    await handle?.close().catch(() => {});
  }
}
