// HTTP layer: one Fastify app serving the static front and the JSON API.
// Domain rules live in ./domain, persistence in ./store.mjs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { createLedger, emptyData, DomainError } from './domain/ledger.mjs';
import { openStore } from './store.mjs';
import { createAdminSessions, createFailureLimiter } from './auth.mjs';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.join(SERVER_DIR, '..', 'public');
const SPLIT_MODULE_PATH = path.join(SERVER_DIR, 'domain', 'split.mjs');
const DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN_SESSION_MAX_AGE_MS = 90 * DAY_MS;
const FAMILY_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const TOO_MANY_ATTEMPTS = { error: "Trop d'essais, réessayez dans quelques minutes" };

export async function buildApp({
  dataDir,
  adminPassword,
  title,
  publicUrl,
  isProduction = false,
  now = Date.now,
  publicDir = DEFAULT_PUBLIC_DIR,
  logger = false,
}) {
  if (!adminPassword) throw new Error('adminPassword is required');

  const store = await openStore(dataDir, { initialData: emptyData });
  const ledger = createLedger({ now });
  const adminSessions = createAdminSessions({ password: adminPassword, now, maxAgeMs: ADMIN_SESSION_MAX_AGE_MS });
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: isProduction, path: '/' };
  const limiterOptions = { maxFailures: MAX_FAILURES, windowMs: FAILURE_WINDOW_MS, now };
  const familyFailures = createFailureLimiter(limiterOptions);
  const adminFailures = createFailureLimiter(limiterOptions);

  const app = Fastify({ logger, trustProxy: true });
  await app.register(fastifyCookie);

  // Assets may be cached, HTML pages never (a cached index.html would keep
  // serving an old front after a deploy).
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    index: false,
    maxAge: '1d',
    setHeaders(reply, filePath) {
      if (filePath.endsWith('.html')) reply.header('cache-control', 'no-cache');
    },
  });

  // Body-less POSTs sent with `content-type: application/json` are accepted.
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (body.trim() === '') return done(null, {});
    parseJson(request, body, done);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      return reply.code(error.status).send({ error: error.message });
    }
    if (error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: 'Requête invalide.' });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'Erreur interne, veuillez réessayer.' });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'Introuvable.' });
  });

  app.addHook('onClose', () => store.flush());

  app.get('/health', async () => ({ ok: true }));
  app.get('/api/config', async () => ({ title }));

  // The admin page imports the split rule from here for its live preview.
  const splitModuleSource = await fs.readFile(SPLIT_MODULE_PATH, 'utf8');
  app.get('/shared/split.mjs', (request, reply) =>
    reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-cache').send(splitModuleSource),
  );

  app.get('/', (request, reply) => reply.sendFile('index.html'));
  app.get('/admin', (request, reply) => reply.sendFile('admin.html'));

  // ---- Families --------------------------------------------------------------

  const familyViewFor = (family) => ({ title, ...ledger.familyView(store.read(), family.id) });

  // Every code lookup counts against the client IP when it fails, whether the
  // code comes from the login form or from a cookie.
  function lookUpFamily(request, reply, code, { fromCookie }) {
    if (familyFailures.isBlocked(request.ip)) {
      reply.code(429).send(TOO_MANY_ATTEMPTS);
      return null;
    }
    const family = ledger.findFamilyByCode(store.read(), code);
    if (!family) {
      familyFailures.recordFailure(request.ip);
      if (fromCookie) reply.clearCookie('family_code', cookieOptions);
      reply.code(401).send({ error: 'Code inconnu' });
      return null;
    }
    return family;
  }

  app.post('/api/family/session', async (request, reply) => {
    const family = lookUpFamily(request, reply, request.body?.code, { fromCookie: false });
    if (!family) return reply;
    reply.setCookie('family_code', family.code, { ...cookieOptions, maxAge: FAMILY_COOKIE_MAX_AGE_S });
    return familyViewFor(family);
  });

  app.get('/api/family', async (request, reply) => {
    const code = request.cookies.family_code;
    if (!code) return reply.code(401).send({ error: 'Saisissez votre code famille.' });
    const family = lookUpFamily(request, reply, code, { fromCookie: true });
    if (!family) return reply;
    return familyViewFor(family);
  });

  app.post('/api/family/logout', async (request, reply) => {
    reply.clearCookie('family_code', cookieOptions);
    return { ok: true };
  });

  // ---- Admin ---------------------------------------------------------------

  app.post('/api/admin/login', async (request, reply) => {
    if (adminFailures.isBlocked(request.ip)) return reply.code(429).send(TOO_MANY_ATTEMPTS);
    if (!adminSessions.checkPassword(request.body?.password)) {
      adminFailures.recordFailure(request.ip);
      return reply.code(401).send({ error: 'Mot de passe incorrect' });
    }
    reply.setCookie('admin_session', adminSessions.issue(), {
      ...cookieOptions,
      maxAge: ADMIN_SESSION_MAX_AGE_MS / 1000,
    });
    return { ok: true };
  });

  app.post('/api/admin/logout', async (request, reply) => {
    reply.clearCookie('admin_session', cookieOptions);
    return { ok: true };
  });

  await app.register(
    async (admin) => {
      admin.addHook('onRequest', async (request, reply) => {
        if (!adminSessions.verify(request.cookies.admin_session)) {
          return reply.code(401).send({ error: 'Session expirée, veuillez vous reconnecter.' });
        }
      });

      const mutate = (fn) => store.update(fn);
      const created = (reply, value) => reply.code(201).send(value);
      const ok = { ok: true };

      admin.get('/state', async () => ({
        title,
        ...ledger.adminState(store.read(), { publicUrl }),
      }));

      admin.get('/export.csv', async (request, reply) => {
        const day = new Date(now()).toISOString().slice(0, 10);
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="credits-ados-${day}.csv"`)
          .send(ledger.exportCsv(store.read()));
      });

      admin.post('/families', async ({ body }, reply) =>
        created(reply, await mutate((data) => ledger.createFamily(data, body))),
      );
      admin.patch('/families/:id', async ({ params, body }) =>
        mutate((data) => ledger.renameFamily(data, params.id, body)),
      );
      admin.post('/families/:id/regenerate-code', async ({ params }) =>
        mutate((data) => ledger.regenerateCode(data, params.id)),
      );
      admin.delete('/families/:id', async ({ params }) => {
        await mutate((data) => ledger.deleteFamily(data, params.id));
        return ok;
      });

      admin.post('/families/:id/teens', async ({ params, body }, reply) =>
        created(reply, await mutate((data) => ledger.addTeen(data, params.id, body))),
      );
      admin.patch('/teens/:id', async ({ params, body }) =>
        mutate((data) => ledger.renameTeen(data, params.id, body)),
      );
      admin.delete('/teens/:id', async ({ params }) => {
        await mutate((data) => ledger.deleteTeen(data, params.id));
        return ok;
      });

      admin.post('/actions', async ({ body }, reply) =>
        created(reply, await mutate((data) => ledger.createAction(data, body))),
      );
      admin.put('/actions/:id', async ({ params, body }) =>
        mutate((data) => ledger.updateAction(data, params.id, body)),
      );
      admin.delete('/actions/:id', async ({ params }) => {
        await mutate((data) => ledger.deleteAction(data, params.id));
        return ok;
      });

      admin.post('/movements', async ({ body }, reply) =>
        created(reply, await mutate((data) => ledger.createMovement(data, body))),
      );
      admin.delete('/movements/:id', async ({ params }) => {
        await mutate((data) => ledger.deleteMovement(data, params.id));
        return ok;
      });
    },
    { prefix: '/api/admin' },
  );

  return app;
}
