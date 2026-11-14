import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { openDb, type DB } from '../src/db.ts';
import { createMailer } from '../src/services/email.ts';
import { createDiskStorage } from '../src/services/storage.ts';
import { Stripe } from '../src/services/stripe.ts';

export type TestCtx = ReturnType<typeof makeApp>;

export function makeApp(overrides: Partial<Config> = {}, stripeFetch?: typeof fetch) {
  process.env.NODE_ENV = 'test';
  const config = loadConfig({
    appUrl: 'http://localhost',
    dbPath: ':memory:',
    uploadDir: mkdtempSync(join(tmpdir(), 'papelo-test-')),
    maxUploadBytes: 1024 * 1024,
    stripe: { secretKey: 'sk_test_x', webhookSecret: 'whsec_test', pricePro: 'price_pro', priceDespacho: 'price_desp' },
    ...overrides,
  });
  const db: DB = openDb(':memory:');
  const mailer = createMailer(config, db);
  const storage = createDiskStorage(config.uploadDir);
  const stripe = stripeFetch ? new Stripe('sk_test_x', stripeFetch) : null;
  const app = createApp({ config, db, mailer, storage, stripe });
  return { app, db, config, mailer, storage };
}

// Cliente HTTP con cookies para simular un navegador.
export class Browser {
  cookies = new Map<string, string>();
  app: TestCtx['app'];
  constructor(app: TestCtx['app']) {
    this.app = app;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await this.app.request(`http://localhost${path}`, { ...init, headers, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a) || /expires=Thu, 01 Jan 1970/i.test(a));
      if (!value || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  get(path: string) {
    return this.fetch(path);
  }

  post(path: string, data: Record<string, string>, extraHeaders: Record<string, string> = {}) {
    return this.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders },
      body: new URLSearchParams(data).toString(),
    });
  }

  async csrf(path = '/app'): Promise<string> {
    const html = await (await this.get(path)).text();
    const m = html.match(/name="_csrf" value="([^"]+)"/);
    if (!m) throw new Error(`Sin token CSRF en ${path}`);
    return m[1];
  }
}

export async function signup(app: TestCtx['app'], email = 'ana@gestoria.es', org = 'Gestoría Ana') {
  const b = new Browser(app);
  const res = await b.post('/signup', { name: 'Ana López', org, email, password: 'una-clave-segura-123', terms: '1' });
  if (res.status !== 303) throw new Error(`signup falló: ${res.status} ${await res.text()}`);
  return b;
}

export async function createClient(b: Browser, data: Record<string, string> = {}) {
  const csrf = await b.csrf();
  const res = await b.post('/app/clients', { _csrf: csrf, name: 'Panadería Ruiz', email: 'cliente@ejemplo.es', ...data });
  const loc = res.headers.get('location') ?? '';
  return { res, id: loc.split('/').pop()! };
}

export async function createRequest(b: Browser, clientId: string, data: Record<string, string> = {}) {
  const csrf = await b.csrf();
  const res = await b.post('/app/requests', {
    _csrf: csrf, client_id: clientId, title: 'IVA 3T', message: 'Hola', due_date: '2099-01-20',
    items: 'Facturas emitidas\nExtracto bancario\nTickets (opcional)', recurrence: 'none', reminders: '1', send_now: '1', ...data,
  });
  const loc = res.headers.get('location') ?? '';
  return { res, id: loc.split('/').pop()! };
}

export function lastEmail(db: DB, kind?: string) {
  return db.prepare(`SELECT * FROM emails ${kind ? 'WHERE kind = ?' : ''} ORDER BY rowid DESC LIMIT 1`).get(...(kind ? [kind] : [])) as any;
}

export function portalPathFromEmail(body: string): string {
  const m = body.match(/http:\/\/localhost(\/p\/[^\s]+)/);
  if (!m) throw new Error('Sin enlace de portal');
  return m[1];
}

export function pdfBytes(): Uint8Array {
  return new TextEncoder().encode('%PDF-1.4\n%prueba\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
}

export async function upload(b: Browser, portalPath: string, itemId: string, files: { name: string; data: Uint8Array }[]) {
  const fd = new FormData();
  for (const f of files) fd.append('files', new File([f.data], f.name));
  return b.fetch(`${portalPath}/items/${itemId}`, { method: 'POST', body: fd });
}
