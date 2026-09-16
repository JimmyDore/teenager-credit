// Entry point: reads the environment, builds the app and listens.
import { buildApp } from './app.mjs';

const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
  console.error('ADMIN_PASSWORD is required: refusing to start without an admin password.');
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 8787;

const app = await buildApp({
  dataDir: process.env.DATA_DIR || './data',
  adminPassword,
  title: process.env.APP_TITLE || 'Crédit ados 2026-2027',
  publicUrl: process.env.PUBLIC_URL || 'https://credit-ado.jimmydore.fr',
  isProduction: process.env.NODE_ENV === 'production',
  logger: true,
});

// Let pending writes finish when Docker stops the container.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
