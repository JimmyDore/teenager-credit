import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { buildApp } from '../app.mjs';

const T0 = Date.parse('2026-09-16T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

async function makeApp(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'credit-app-'));
  const publicDir = path.join(root, 'public');
  await fs.mkdir(publicDir);
  await fs.writeFile(path.join(publicDir, 'index.html'), '<h1>familles</h1>');
  await fs.writeFile(path.join(publicDir, 'admin.html'), '<h1>admin</h1>');
  await fs.writeFile(path.join(publicDir, 'app.js'), 'console.log(1)');

  const clock = { now: T0 };
  const app = await buildApp({
    dataDir: path.join(root, 'data'),
    publicDir,
    adminPassword: 's3cret',
    title: 'Crédit ados 2026-2027',
    publicUrl: 'https://credit-ado.example',
    isProduction: false,
    now: () => clock.now,
    ...options,
  });
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { app, clock, dataDir: path.join(root, 'data') };
}

function cookie(res, name) {
  return res.cookies.find((c) => c.name === name);
}

async function loginAdmin(app, password = 's3cret') {
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password } });
  assert.equal(res.statusCode, 200, res.body);
  const { value } = cookie(res, 'admin_session');
  return { admin_session: value };
}

describe('public endpoints', () => {
  test('GET /health answers ok', async (t) => {
    const { app } = await makeApp(t);
    const res = await app.inject('/health');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  });

  test('GET /api/config gives the title', async (t) => {
    const { app } = await makeApp(t, { title: 'Crédit ados 2027-2028' });
    const res = await app.inject('/api/config');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { title: 'Crédit ados 2027-2028' });
  });

  test('nothing static is cached without revalidation (unversioned JS must not outlive a deploy)', async (t) => {
    const { app } = await makeApp(t);

    const home = await app.inject('/');
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /familles/);
    assert.equal(home.headers['cache-control'], 'no-cache');

    const admin = await app.inject('/admin');
    assert.equal(admin.statusCode, 200);
    assert.match(admin.body, /admin/);
    assert.equal(admin.headers['cache-control'], 'no-cache');

    const script = await app.inject('/app.js');
    assert.equal(script.statusCode, 200);
    assert.equal(script.headers['cache-control'], 'no-cache');
    assert.ok(script.headers.etag, 'assets keep an ETag so revalidation is a cheap 304');
  });

  test('the split rule is served to the browser so the admin preview uses the very same code', async (t) => {
    const { app } = await makeApp(t);

    const res = await app.inject('/shared/split.mjs');

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^text\/javascript/);
    assert.equal(res.headers['cache-control'], 'no-cache');
    const source = await fs.readFile(new URL('../domain/split.mjs', import.meta.url), 'utf8');
    assert.equal(res.body, source);
  });

  test('the data file is created on first start', async (t) => {
    const { dataDir } = await makeApp(t);
    const data = JSON.parse(await fs.readFile(path.join(dataDir, 'credits.json'), 'utf8'));
    assert.deepEqual(data, { version: 1, families: [], teens: [], actions: [], movements: [] });
  });

  test('unknown API routes answer a JSON 404', async (t) => {
    const { app } = await makeApp(t);
    const res = await app.inject('/api/nope');
    assert.equal(res.statusCode, 404);
    assert.equal(typeof res.json().error, 'string');
  });
});

describe('admin authentication', () => {
  test('a wrong password is refused with a French message and no cookie', async (t) => {
    const { app } = await makeApp(t);

    const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'nope' } });

    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: 'Mot de passe incorrect' });
    assert.equal(cookie(res, 'admin_session'), undefined);
  });

  test('logging in sets a 90-day httpOnly session cookie signed with the password', async (t) => {
    const { app } = await makeApp(t);

    const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 's3cret' } });

    assert.equal(res.statusCode, 200);
    const session = cookie(res, 'admin_session');
    const expiresAt = T0 + 90 * DAY_MS;
    const signature = createHmac('sha256', 's3cret').update(String(expiresAt)).digest('hex');
    assert.equal(session.value, `${expiresAt}.${signature}`);
    assert.equal(session.maxAge, 90 * 24 * 60 * 60);
    assert.equal(session.httpOnly, true);
    assert.equal(session.sameSite, 'Lax');
    assert.equal(session.path, '/');
    assert.equal(session.secure, undefined);
  });

  test('in production the session cookie is Secure', async (t) => {
    const { app } = await makeApp(t, { isProduction: true });
    const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 's3cret' } });
    assert.equal(cookie(res, 'admin_session').secure, true);
  });

  test('admin routes require a valid session', async (t) => {
    const { app, clock } = await makeApp(t);
    const cookies = await loginAdmin(app);

    const anonymous = await app.inject('/api/admin/state');
    assert.equal(anonymous.statusCode, 401);
    assert.equal(typeof anonymous.json().error, 'string');

    const tampered = await app.inject({ url: '/api/admin/state', cookies: { admin_session: cookies.admin_session.replace(/.$/, (c) => (c === '0' ? '1' : '0')) } });
    assert.equal(tampered.statusCode, 401);

    const forgedExpiry = `${T0 + 1000 * DAY_MS}.${cookies.admin_session.split('.')[1]}`;
    assert.equal((await app.inject({ url: '/api/admin/state', cookies: { admin_session: forgedExpiry } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/admin/state', cookies: { admin_session: 'garbage' } })).statusCode, 401);

    assert.equal((await app.inject({ url: '/api/admin/state', cookies })).statusCode, 200);

    clock.now = T0 + 90 * DAY_MS - 1;
    assert.equal((await app.inject({ url: '/api/admin/state', cookies })).statusCode, 200);
    clock.now = T0 + 90 * DAY_MS;
    assert.equal((await app.inject({ url: '/api/admin/state', cookies })).statusCode, 401, 'expired');
  });

  test('changing the admin password invalidates existing sessions', async (t) => {
    const { app, dataDir } = await makeApp(t);
    const cookies = await loginAdmin(app);
    await app.close();

    const { app: restarted } = await makeApp(t, { dataDir, adminPassword: 'new-password' });

    assert.equal((await restarted.inject({ url: '/api/admin/state', cookies })).statusCode, 401);
  });

  test('logging out clears the session cookie', async (t) => {
    const { app } = await makeApp(t);
    const cookies = await loginAdmin(app);

    const res = await app.inject({ method: 'POST', url: '/api/admin/logout', cookies });

    assert.equal(res.statusCode, 200);
    const cleared = cookie(res, 'admin_session');
    assert.equal(cleared.value, '');
    assert.ok(cleared.maxAge === 0 || cleared.expires.getTime() <= Date.now());
  });
});

async function adminClient(app) {
  const cookies = await loginAdmin(app);
  return async (method, url, payload) => {
    const res = await app.inject({ method, url, cookies, ...(payload === undefined ? {} : { payload }) });
    return { status: res.statusCode, body: res.headers['content-type']?.includes('json') ? res.json() : res.body, res };
  };
}

describe('admin API', () => {
  test('families, teens, actions and movements can be managed end to end', async (t) => {
    const { app, dataDir } = await makeApp(t);
    const api = await adminClient(app);

    const family = await api('POST', '/api/admin/families', { name: 'Martin' });
    assert.equal(family.status, 201);
    assert.match(family.body.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);

    const renamed = await api('PATCH', `/api/admin/families/${family.body.id}`, { name: 'Martin-Dupont' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'Martin-Dupont');

    const regenerated = await api('POST', `/api/admin/families/${family.body.id}/regenerate-code`);
    assert.equal(regenerated.status, 200);
    assert.notEqual(regenerated.body.code, family.body.code);

    const lea = await api('POST', `/api/admin/families/${family.body.id}/teens`, { firstName: 'Léa' });
    assert.equal(lea.status, 201);
    const tom = await api('POST', `/api/admin/families/${family.body.id}/teens`, { firstName: 'Tim' });
    assert.equal((await api('PATCH', `/api/admin/teens/${tom.body.id}`, { firstName: 'Tom' })).body.firstName, 'Tom');

    const action = await api('POST', '/api/admin/actions', {
      label: 'Vente de gâteaux',
      date: '2026-12-14',
      totalCents: 1000,
      participants: [{ teenId: lea.body.id, parts: 1 }, { teenId: tom.body.id, parts: 1 }],
    });
    assert.equal(action.status, 201);
    assert.deepEqual(action.body.participants.map((p) => p.amountCents), [500, 500]);

    const updated = await api('PUT', `/api/admin/actions/${action.body.id}`, {
      label: 'Vente de gâteaux',
      date: '2026-12-14',
      totalCents: 1001,
      participants: [{ teenId: lea.body.id, parts: 1 }, { teenId: tom.body.id, parts: 1 }],
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.participants.map((p) => p.amountCents), [501, 500]);

    const movement = await api('POST', '/api/admin/movements', {
      teenId: lea.body.id, kind: 'debit', label: 'Facture', date: '2026-12-20', amountCents: 200,
    });
    assert.equal(movement.status, 201);

    const state = await api('GET', '/api/admin/state');
    assert.equal(state.status, 200);
    assert.equal(state.body.title, 'Crédit ados 2026-2027');
    assert.deepEqual(
      state.body.families.map((f) => [f.name, f.code, f.totalCents, f.teens.map((x) => [x.firstName, x.balanceCents])]),
      [['Martin-Dupont', regenerated.body.code, 801, [['Léa', 301], ['Tom', 500]]]],
    );
    assert.equal(
      state.body.families[0].shareMessage,
      `Bonjour, retrouvez les crédits ados de la famille Martin-Dupont sur https://credit-ado.example avec le code : ${regenerated.body.code}`,
    );
    assert.equal(state.body.actions.length, 1);
    assert.equal(state.body.movements.length, 1);

    // Everything is on disk: a restarted app sees the same state.
    await app.close();
    const { app: restarted } = await makeApp(t, { dataDir });
    const restartedApi = await adminClient(restarted);
    assert.deepEqual((await restartedApi('GET', '/api/admin/state')).body, state.body);

    assert.deepEqual((await restartedApi('DELETE', `/api/admin/movements/${movement.body.id}`)).body, { ok: true });
    assert.deepEqual((await restartedApi('DELETE', `/api/admin/actions/${action.body.id}`)).body, { ok: true });
    assert.deepEqual((await restartedApi('DELETE', `/api/admin/teens/${tom.body.id}`)).body, { ok: true });
    assert.deepEqual((await restartedApi('DELETE', `/api/admin/families/${family.body.id}`)).body, { ok: true });
    const empty = await restartedApi('GET', '/api/admin/state');
    assert.deepEqual([empty.body.families, empty.body.actions, empty.body.movements], [[], [], []]);
  });

  test('domain errors become JSON errors with 400, 404 and 409 statuses', async (t) => {
    const { app } = await makeApp(t);
    const api = await adminClient(app);
    const family = await api('POST', '/api/admin/families', { name: 'Martin' });
    const lea = await api('POST', `/api/admin/families/${family.body.id}/teens`, { firstName: 'Léa' });

    const invalid = await api('POST', '/api/admin/families', { name: '  ' });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /nom de famille est obligatoire/);

    const missing = await api('PATCH', '/api/admin/teens/nope', { firstName: 'X' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'Ado introuvable.');

    const negative = await api('POST', '/api/admin/movements', {
      teenId: lea.body.id, kind: 'debit', label: 'Facture', date: '2026-12-20', amountCents: 1,
    });
    assert.equal(negative.status, 409);
    assert.match(negative.body.error, /Léa \(Martin\)/);

    for (const [method, url] of [
      ['DELETE', '/api/admin/families/nope'],
      ['POST', '/api/admin/families/nope/regenerate-code'],
      ['POST', '/api/admin/families/nope/teens'],
      ['DELETE', '/api/admin/teens/nope'],
      ['PUT', '/api/admin/actions/nope'],
      ['DELETE', '/api/admin/actions/nope'],
      ['DELETE', '/api/admin/movements/nope'],
    ]) {
      const res = await api(method, url, method === 'DELETE' ? undefined : { name: 'x' });
      assert.equal(res.status, 404, `${method} ${url}`);
      assert.equal(typeof res.body.error, 'string');
    }
  });

  test('malformed JSON is a 400 with a French message; body-less POSTs sent as JSON are accepted', async (t) => {
    const { app } = await makeApp(t);
    const cookies = await loginAdmin(app);
    const family = await app.inject({ method: 'POST', url: '/api/admin/families', cookies, payload: { name: 'Martin' } });

    const malformed = await app.inject({
      method: 'POST', url: '/api/admin/families', cookies, headers: { 'content-type': 'application/json' }, payload: '{"name": ',
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().error, 'Requête invalide.');

    const emptyJson = await app.inject({
      method: 'POST', url: `/api/admin/families/${family.json().id}/regenerate-code`, cookies, headers: { 'content-type': 'application/json' },
    });
    assert.equal(emptyJson.statusCode, 200);
  });

  test('mutations require an admin session', async (t) => {
    const { app } = await makeApp(t);
    const res = await app.inject({ method: 'POST', url: '/api/admin/families', payload: { name: 'Martin' } });
    assert.equal(res.statusCode, 401);
  });

  test('the CSV export is a downloadable UTF-8 file with BOM', async (t) => {
    const { app } = await makeApp(t);
    const api = await adminClient(app);
    const family = await api('POST', '/api/admin/families', { name: 'Martin' });
    const lea = await api('POST', `/api/admin/families/${family.body.id}/teens`, { firstName: 'Léa' });
    await api('POST', '/api/admin/movements', { teenId: lea.body.id, kind: 'credit', label: 'Bonus', date: '2026-10-01', amountCents: 1234 });

    const csv = await api('GET', '/api/admin/export.csv');

    assert.equal(csv.status, 200);
    assert.equal(csv.res.headers['content-type'], 'text/csv; charset=utf-8');
    assert.match(csv.res.headers['content-disposition'], /^attachment; filename="credits-ados-2026-09-16\.csv"$/);
    assert.equal(csv.res.rawPayload.subarray(0, 3).toString('hex'), 'efbbbf');
    assert.equal(csv.body, '﻿Date;Famille;Ado;Type;Libellé;Parts;Montant\r\n01/10/2026;Martin;Léa;Ajout;Bonus;;12,34\r\n');
    assert.equal((await app.inject('/api/admin/export.csv')).statusCode, 401);
  });
});

async function seedTwoFamilies(app) {
  const api = await adminClient(app);
  const martin = (await api('POST', '/api/admin/families', { name: 'Martin' })).body;
  const durand = (await api('POST', '/api/admin/families', { name: 'Durand' })).body;
  const lea = (await api('POST', `/api/admin/families/${martin.id}/teens`, { firstName: 'Léa' })).body;
  const zoe = (await api('POST', `/api/admin/families/${durand.id}/teens`, { firstName: 'Zoé' })).body;
  await api('POST', '/api/admin/actions', {
    label: 'Vente de gâteaux',
    date: '2026-12-14',
    totalCents: 10000,
    participants: [{ teenId: lea.id, parts: 2 }, { teenId: zoe.id, parts: 1 }],
  });
  await api('POST', '/api/admin/movements', { teenId: lea.id, kind: 'debit', label: 'Déduit facture', date: '2026-11-02', amountCents: 2500 });
  return { api, martin, durand, lea, zoe };
}

const MARTIN_VIEW = {
  title: 'Crédit ados 2026-2027',
  family: { name: 'Martin' },
  teens: [
    {
      firstName: 'Léa',
      balanceCents: 4167,
      history: [
        { date: '2026-12-14', label: 'Vente de gâteaux', amountCents: 6667, parts: 2 },
        { date: '2026-11-02', label: 'Déduit facture', amountCents: -2500, parts: null },
      ],
    },
  ],
  totalCents: 4167,
  updatedAt: '2026-09-16T10:00:00.000Z',
};

describe('family access', () => {
  test('a valid code, however typed, opens a 400-day session and returns only this family view', async (t) => {
    const { app } = await makeApp(t);
    const { martin } = await seedTwoFamilies(app);
    const typed = `${martin.code.slice(0, 3).toLowerCase()} - ${martin.code.slice(3)}`;

    const res = await app.inject({ method: 'POST', url: '/api/family/session', payload: { code: typed } });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), MARTIN_VIEW);
    const session = cookie(res, 'family_code');
    assert.equal(session.value, martin.code);
    assert.equal(session.maxAge, 400 * 24 * 60 * 60);
    assert.equal(session.httpOnly, true);
    assert.equal(session.sameSite, 'Lax');
    assert.equal(session.path, '/');
    assert.equal(session.secure, undefined);
  });

  test('in production the family cookie is Secure', async (t) => {
    const { app } = await makeApp(t, { isProduction: true });
    const { martin } = await seedTwoFamilies(app);
    const res = await app.inject({ method: 'POST', url: '/api/family/session', payload: { code: martin.code } });
    assert.equal(cookie(res, 'family_code').secure, true);
  });

  test('an unknown code is refused', async (t) => {
    const { app } = await makeApp(t);
    await seedTwoFamilies(app);

    for (const payload of [{ code: 'ZZZZZZ' }, { code: '' }, {}]) {
      const res = await app.inject({ method: 'POST', url: '/api/family/session', payload });
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.json(), { error: 'Code inconnu' });
      assert.equal(cookie(res, 'family_code'), undefined);
    }
  });

  test('GET /api/family shows the family of the cookie, never another one', async (t) => {
    const { app } = await makeApp(t);
    const { martin, durand } = await seedTwoFamilies(app);

    const res = await app.inject({ url: '/api/family', cookies: { family_code: martin.code } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), MARTIN_VIEW);
    assert.doesNotMatch(res.body, /Durand|Zoé|10000|3333|participants|code/);

    const other = await app.inject({ url: '/api/family', cookies: { family_code: durand.code } });
    assert.deepEqual(other.json().teens.map((x) => [x.firstName, x.balanceCents]), [['Zoé', 3333]]);

    const anonymous = await app.inject('/api/family');
    assert.equal(anonymous.statusCode, 401);
    assert.equal(typeof anonymous.json().error, 'string');
  });

  test('regenerating the code logs the family out', async (t) => {
    const { app } = await makeApp(t);
    const { api, martin } = await seedTwoFamilies(app);
    await api('POST', `/api/admin/families/${martin.id}/regenerate-code`);

    const res = await app.inject({ url: '/api/family', cookies: { family_code: martin.code } });

    assert.equal(res.statusCode, 401);
    assert.equal(cookie(res, 'family_code').value, '');
  });

  test('logging out clears the family cookie', async (t) => {
    const { app } = await makeApp(t);

    const res = await app.inject({ method: 'POST', url: '/api/family/logout' });

    assert.equal(res.statusCode, 200);
    assert.equal(cookie(res, 'family_code').value, '');
  });
});

describe('brute-force protection', () => {
  const TOO_MANY = { error: "Trop d'essais, réessayez dans quelques minutes" };
  const from = (ip) => ({ 'x-forwarded-for': ip });
  const tryCode = (app, ip, code) =>
    app.inject({ method: 'POST', url: '/api/family/session', headers: from(ip), payload: { code } });

  test('after 10 failed codes in 15 minutes an IP gets 429, even with a valid code, until the window passes', async (t) => {
    const { app, clock } = await makeApp(t);
    const { martin } = await seedTwoFamilies(app);

    for (let i = 0; i < 10; i++) {
      clock.now += 60_000;
      assert.equal((await tryCode(app, '203.0.113.7', 'ZZZZZZ')).statusCode, 401, `failure ${i + 1}`);
    }

    const blocked = await tryCode(app, '203.0.113.7', martin.code);
    assert.equal(blocked.statusCode, 429);
    assert.deepEqual(blocked.json(), TOO_MANY);
    assert.equal(cookie(blocked, 'family_code'), undefined);

    assert.equal((await tryCode(app, '198.51.100.1', martin.code)).statusCode, 200, 'other IPs are not affected');

    // Sliding window: blocked until the first failure is 15 minutes old.
    clock.now += 6 * 60_000 - 1;
    assert.equal((await tryCode(app, '203.0.113.7', martin.code)).statusCode, 429);
    clock.now += 1;
    assert.equal((await tryCode(app, '203.0.113.7', martin.code)).statusCode, 200);
  });

  test('a bad family cookie counts as a failure too, a missing cookie does not', async (t) => {
    const { app } = await makeApp(t);
    const { martin } = await seedTwoFamilies(app);
    const ip = '203.0.113.8';

    for (let i = 0; i < 20; i++) {
      assert.equal((await app.inject({ url: '/api/family', headers: from(ip) })).statusCode, 401);
    }
    for (let i = 0; i < 5; i++) {
      assert.equal((await tryCode(app, ip, 'ZZZZZZ')).statusCode, 401);
      assert.equal((await app.inject({ url: '/api/family', headers: from(ip), cookies: { family_code: 'ZZZZZZ' } })).statusCode, 401);
    }

    const blocked = await app.inject({ url: '/api/family', headers: from(ip), cookies: { family_code: martin.code } });
    assert.equal(blocked.statusCode, 429);
    assert.deepEqual(blocked.json(), TOO_MANY);
  });

  test('admin login failures are limited the same way, with a separate counter', async (t) => {
    const { app } = await makeApp(t);
    const { martin } = await seedTwoFamilies(app);
    const ip = '203.0.113.9';
    const login = (password) =>
      app.inject({ method: 'POST', url: '/api/admin/login', headers: from(ip), payload: { password } });

    for (let i = 0; i < 10; i++) assert.equal((await login('wrong')).statusCode, 401);

    const blocked = await login('s3cret');
    assert.equal(blocked.statusCode, 429);
    assert.deepEqual(blocked.json(), TOO_MANY);
    assert.equal(cookie(blocked, 'admin_session'), undefined);
    assert.equal((await tryCode(app, ip, martin.code)).statusCode, 200, 'family counter is separate');
  });
});
