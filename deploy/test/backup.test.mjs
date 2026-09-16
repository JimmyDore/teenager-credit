// Tests de deploy/backup.sh : on remplace `docker` et `curl` par des faux
// exécutables (placés en tête du PATH) qui journalisent leurs arguments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../backup.sh', import.meta.url));
const WEBHOOK = 'https://hooks.slack.test/services/T000/B000/from-env-file';
const SEP = '\x1f';

// Faux binaire : une ligne par appel, arguments séparés par \x1f.
// FAKE_DOCKER_FAIL_ON=<arg> fait échouer l'appel docker contenant cet argument.
const FAKE = (logVar, failVar) => `#!/bin/sh
{ for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\n'; } >> "$${logVar}"
if [ -n "\${${failVar}:-}" ]; then
  for a in "$@"; do
    if [ "$a" = "$${failVar}" ]; then echo "fake: failing on $a" >&2; exit 42; fi
  done
fi
exit 0
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'credit-ado-backup-'));
  const bin = join(root, 'bin');
  const dataDir = join(root, 'data');
  mkdirSync(bin);
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'credits.json'), '{"version":1}\n');
  writeFileSync(join(bin, 'docker'), FAKE('FAKE_DOCKER_LOG', 'FAKE_DOCKER_FAIL_ON'));
  writeFileSync(join(bin, 'curl'), FAKE('FAKE_CURL_LOG', 'FAKE_CURL_FAIL_ON'));
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
  const envFile = join(root, 'backup.env');
  writeFileSync(
    envFile,
    [
      'RCLONE_CONFIG_R2_TYPE=s3',
      'RCLONE_CONFIG_R2_PROVIDER=Cloudflare',
      'RCLONE_CONFIG_R2_REGION=auto',
      'RCLONE_CONFIG_R2_ENDPOINT=https://account.r2.cloudflarestorage.com',
      'RCLONE_CONFIG_R2_ACCESS_KEY_ID=abc',
      'RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=def',
      'RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true',
      `SLACK_WEBHOOK_URL=${WEBHOOK}`,
      '',
    ].join('\n'),
  );
  return {
    root,
    bin,
    dataDir,
    envFile,
    dockerLog: join(root, 'docker.log'),
    curlLog: join(root, 'curl.log'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function run(ctx, extraEnv = {}) {
  const env = { ...process.env };
  for (const k of ['DATA_DIR', 'BACKUP_ENV_FILE', 'R2_BUCKET', 'R2_PREFIX', 'SLACK_WEBHOOK_URL']) delete env[k];
  Object.assign(env, {
    PATH: `${ctx.bin}:${process.env.PATH}`,
    DATA_DIR: ctx.dataDir,
    BACKUP_ENV_FILE: ctx.envFile,
    FAKE_DOCKER_LOG: ctx.dockerLog,
    FAKE_CURL_LOG: ctx.curlLog,
    ...extraEnv,
  });
  return spawnSync('bash', [SCRIPT], { env, encoding: 'utf8' });
}

function calls(logFile) {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(SEP).slice(0, -1));
}

const rcloneCmd = (call) => call[call.indexOf('rclone/rclone:1') + 1];
const optValue = (call, flag) => call[call.indexOf(flag) + 1];

test('succès : copie horodatée vers R2, purge du préfixe seulement, aucun message Slack', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const res = run(ctx);
  assert.equal(res.status, 0, res.stderr + res.stdout);

  const dockerCalls = calls(ctx.dockerLog);
  assert.deepEqual(dockerCalls.map(rcloneCmd), ['copy', 'delete', 'rmdirs']);

  const [copy, del, rmdirs] = dockerCalls;
  assert.deepEqual(copy.slice(0, 2), ['run', '--rm']);
  assert.equal(optValue(copy, '--env-file'), ctx.envFile);
  assert.equal(optValue(copy, '-v'), `${ctx.dataDir}:/data:ro`);
  const src = copy[copy.indexOf('copy') + 1];
  const dest = copy[copy.indexOf('copy') + 2];
  assert.equal(src, '/data');
  assert.match(dest, /^r2:hetzner-backups\/credit-ado\/\d{8}_\d{6}\/$/);

  for (const c of [del, rmdirs]) {
    assert.deepEqual(c.slice(0, 2), ['run', '--rm']);
    assert.equal(optValue(c, '--env-file'), ctx.envFile);
    assert.ok(!c.includes('-v'), 'la purge ne monte pas les données');
    assert.equal(c[c.indexOf(rcloneCmd(c)) + 1], 'r2:hetzner-backups/credit-ado');
  }
  assert.equal(optValue(del, '--min-age'), '365d');
  assert.ok(rmdirs.includes('--leave-root'));

  for (const c of dockerCalls) {
    assert.ok(!c.includes('--progress'), 'pas de --progress sous cron');
    for (const arg of c.filter((a) => a.startsWith('r2:'))) {
      assert.ok(arg.startsWith('r2:hetzner-backups/credit-ado'), `cible hors préfixe : ${arg}`);
    }
  }

  assert.deepEqual(calls(ctx.curlLog), [], 'aucune notification en cas de succès');
});

test('échec de la copie : message Slack vers le webhook du fichier env, code non nul, pas de purge', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const res = run(ctx, { FAKE_DOCKER_FAIL_ON: 'copy' });
  assert.notEqual(res.status, 0);

  assert.deepEqual(calls(ctx.dockerLog).map(rcloneCmd), ['copy']);

  const curlCalls = calls(ctx.curlLog);
  assert.equal(curlCalls.length, 1);
  const [curl] = curlCalls;
  assert.ok(curl.includes('-fsS'));
  assert.equal(optValue(curl, '-X'), 'POST');
  assert.equal(optValue(curl, '-H'), 'Content-type: application/json');
  assert.equal(curl.at(-1), WEBHOOK);
  const payload = JSON.parse(optValue(curl, '--data'));
  assert.match(payload.text, /^❌ Sauvegarde credit-ado échouée sur hetzner \(.+\)$/);
});

test('échec de la purge : message Slack et code non nul', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const res = run(ctx, { FAKE_DOCKER_FAIL_ON: 'delete' });
  assert.notEqual(res.status, 0);
  assert.deepEqual(calls(ctx.dockerLog).map(rcloneCmd), ['copy', 'delete']);
  const curlCalls = calls(ctx.curlLog);
  assert.equal(curlCalls.length, 1);
  assert.equal(curlCalls[0].at(-1), WEBHOOK);
});

test('un échec de curl ne masque pas le code de sortie', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const res = run(ctx, { FAKE_DOCKER_FAIL_ON: 'copy', FAKE_CURL_FAIL_ON: WEBHOOK });
  assert.notEqual(res.status, 0);
  assert.equal(calls(ctx.curlLog).length, 1);
});

test('R2_BUCKET et R2_PREFIX sont surchargeables', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const res = run(ctx, { R2_BUCKET: 'other-bucket', R2_PREFIX: 'test-prefix' });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const [copy, del] = calls(ctx.dockerLog);
  assert.match(copy[copy.indexOf('copy') + 2], /^r2:other-bucket\/test-prefix\/\d{8}_\d{6}\/$/);
  assert.equal(del[del.indexOf('delete') + 1], 'r2:other-bucket/test-prefix');
});

test('refuse un préfixe qui viserait la racine du bucket', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const res = run(ctx, { R2_PREFIX: '/' });
  assert.notEqual(res.status, 0);
  assert.deepEqual(calls(ctx.dockerLog), []);
  assert.equal(calls(ctx.curlLog).length, 1);
});

test('dossier de données absent : échec notifié, aucune copie', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const res = run(ctx, { DATA_DIR: join(ctx.root, 'missing') });
  assert.notEqual(res.status, 0);
  assert.deepEqual(calls(ctx.dockerLog), []);
  assert.equal(calls(ctx.curlLog).length, 1);
});

test('fichier env absent : échec sans appel docker', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);
  const res = run(ctx, { BACKUP_ENV_FILE: join(ctx.root, 'missing.env') });
  assert.notEqual(res.status, 0);
  assert.deepEqual(calls(ctx.dockerLog), []);
});
