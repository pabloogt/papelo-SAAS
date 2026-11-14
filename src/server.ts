import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { createApp } from './app.ts';
import { createMailer } from './services/email.ts';
import { createDiskStorage } from './services/storage.ts';
import { Stripe } from './services/stripe.ts';
import { runScheduledJobs } from './services/requests.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
const mailer = createMailer(config, db);
const storage = createDiskStorage(config.uploadDir);
const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;

const app = createApp({ config, db, mailer, storage, stripe });

// Programador en proceso: recordatorios y peticiones recurrentes.
// Diseñado para UNA instancia; con varias, mover a un cron externo o usar un bloqueo.
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const result = await runScheduledJobs({ db, config, mailer });
    if (result.reminders || result.spawned) console.log(`[scheduler] recordatorios=${result.reminders} recurrentes=${result.spawned}`);
  } catch (err) {
    console.error('[scheduler] error', err);
  } finally {
    running = false;
  }
}
setTimeout(tick, 5000);
const timer = setInterval(tick, config.schedulerIntervalMs);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Papelo escuchando en ${config.appUrl} (puerto ${info.port}, entorno ${config.env})`);
  if (!config.email.resendApiKey) {
    console.log(config.env === 'production'
      ? 'AVISO: RESEND_API_KEY no configurada: los correos NO se están enviando'
      : 'Email en modo registro: revisa /dev/mail');
  }
  if (!stripe) console.log('Stripe no configurado: los pagos están desactivados');
});

function shutdown() {
  clearInterval(timer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
