import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Config } from './config.ts';
import type { DB } from './db.ts';
import type { Mailer } from './services/email.ts';
import type { Storage } from './services/storage.ts';
import type { Stripe } from './services/stripe.ts';
import type { Plan } from './services/plans.ts';
import type { Flash, Viewer } from './views/layout.ts';
import type { SafeHtml } from './lib/html.ts';

export type AppDeps = {
  config: Config;
  db: DB;
  mailer: Mailer;
  storage: Storage;
  stripe: Stripe | null;
};

export type OrgRow = {
  id: string; name: string; reply_to: string | null; plan: string; stripe_customer_id: string | null;
  stripe_subscription_id: string | null; subscription_status: string | null; current_period_end: string | null; created_at: string;
};

export type Auth = {
  user: { id: string; name: string; email: string };
  org: OrgRow;
  role: 'owner' | 'member';
  csrf: string;
  sessionHash: string;
  plan: Plan;
};

export type Env = { Variables: { auth: Auth | null } };
export type C = Context<Env>;

export function viewer(auth: Auth): Viewer {
  return { user: auth.user, org: auth.org, planName: auth.plan.name, csrf: auth.csrf };
}

export function mustAuth(c: C): Auth {
  const auth = c.get('auth');
  if (!auth) throw new Error('auth requerido');
  return auth;
}

// Mensajes flash en cookie de un solo uso.
export function setFlash(c: C, type: 'ok' | 'error', text: string) {
  setCookie(c, 'flash', encodeURIComponent(JSON.stringify({ type, text })), { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 60 });
}

export function takeFlash(c: C): Flash {
  const raw = getCookie(c, 'flash');
  if (!raw) return null;
  deleteCookie(c, 'flash', { path: '/' });
  try {
    const v = JSON.parse(decodeURIComponent(raw));
    if ((v.type === 'ok' || v.type === 'error') && typeof v.text === 'string') return { type: v.type, text: v.text.slice(0, 300) };
  } catch {}
  return null;
}

export function redirectWith(c: C, url: string, type: 'ok' | 'error', text: string) {
  setFlash(c, type, text);
  return c.redirect(url, 303);
}

export function htmlResponse(c: C, page: SafeHtml, status: 200 | 400 | 403 | 404 | 409 | 413 | 429 | 500 = 200) {
  return c.html(page.value, status);
}

// Lectura segura de campos de formulario.
export function str(body: Record<string, unknown>, key: string, max = 500): string {
  const v = body[key];
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

export function clientIp(c: C, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = c.req.header('fly-client-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (fwd) return fwd;
  }
  const incoming = (c.env as any)?.incoming;
  return incoming?.socket?.remoteAddress ?? 'local';
}
