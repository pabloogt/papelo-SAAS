import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AppDeps, Auth, Env, OrgRow } from './context.ts';
import { htmlResponse } from './context.ts';
import { one } from './db.ts';
import { sha256, safeEqual } from './lib/security.ts';
import { effectivePlan } from './services/plans.ts';
import { publicPage } from './views/layout.ts';
import { h } from './lib/html.ts';
import { authRoutes, sessionCookieName } from './routes/auth.ts';
import { publicRoutes } from './routes/public.ts';
import { appRoutes } from './routes/app.ts';
import { portalRoutes } from './routes/portal.ts';
import { billingRoutes, webhookRoutes } from './routes/billing.ts';

export function createApp(deps: AppDeps) {
  const { config, db } = deps;
  const app = new Hono<Env>();

  // Cabeceras de seguridad en todas las respuestas.
  app.use('*', async (c, next) => {
    await next();
    c.header('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; " +
      "frame-ancestors 'none'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com");
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    // same-origin: los enlaces del portal llevan un token en la URL y no deben filtrarse a terceros.
    // (no-referrer haría que los navegadores enviasen "Origin: null" en los formularios y rompería la defensa CSRF).
    c.header('Referrer-Policy', 'same-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.env === 'production') c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  });

  // Defensa CSRF de primera capa: las peticiones que modifican estado deben venir de nuestro origen.
  app.use('*', async (c, next) => {
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD' && !c.req.path.startsWith('/webhooks/')) {
      const origin = c.req.header('origin');
      if (origin) {
        const allowed = new Set([config.appUrl, new URL(c.req.url).origin]);
        if (!allowed.has(origin)) return c.text('Origen no permitido', 403);
      }
    }
    await next();
  });

  // Carga de sesión.
  app.use('*', async (c, next) => {
    c.set('auth', null);
    const sid = getCookie(c, sessionCookieName(config));
    if (sid && sid.length < 100) {
      const idHash = sha256(sid);
      const row = one<any>(db,
        `SELECT s.csrf_token, s.expires_at, u.id AS user_id, u.name AS user_name, u.email AS user_email, m.role, o.*
         FROM sessions s JOIN users u ON u.id = s.user_id
         JOIN memberships m ON m.user_id = s.user_id AND m.org_id = s.org_id
         JOIN organizations o ON o.id = s.org_id
         WHERE s.id_hash = ? AND s.expires_at > ?`, idHash, new Date().toISOString());
      if (row) {
        const org: OrgRow = {
          id: row.id, name: row.name, reply_to: row.reply_to, plan: row.plan, stripe_customer_id: row.stripe_customer_id,
          stripe_subscription_id: row.stripe_subscription_id, subscription_status: row.subscription_status,
          current_period_end: row.current_period_end, created_at: row.created_at,
        };
        const auth: Auth = {
          user: { id: row.user_id, name: row.user_name, email: row.user_email },
          org, role: row.role, csrf: row.csrf_token, sessionHash: idHash, plan: effectivePlan(org),
        };
        c.set('auth', auth);
      }
    }
    await next();
  });

  // Zona privada: sesión obligatoria y token CSRF en toda petición que modifica estado.
  const guard = async (c: any, next: any) => {
    const auth: Auth | null = c.get('auth');
    if (!auth) {
      if (c.req.method === 'GET') return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`, 303);
      return c.text('Sesión caducada', 401);
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const ct = c.req.header('content-type') ?? '';
      let token = c.req.header('x-csrf-token') ?? '';
      if (!token && (ct.includes('form'))) {
        const body = await c.req.parseBody({ all: true });
        token = typeof body._csrf === 'string' ? body._csrf : '';
      }
      if (!token || !safeEqual(token, auth.csrf)) return c.text('Token CSRF inválido. Recarga la página e inténtalo de nuevo.', 403);
    }
    await next();
  };
  app.use('/app/*', guard);
  app.use('/app', guard);
  app.use('/logout', guard);

  app.use('/static/*', serveStatic({ root: './public', rewriteRequestPath: (p) => p.replace(/^\/static/, '') }));

  app.route('/', publicRoutes(deps));
  app.route('/', authRoutes(deps));
  app.route('/', portalRoutes(deps));
  app.route('/', webhookRoutes(deps));
  app.route('/app/billing', billingRoutes(deps));
  app.route('/app', appRoutes(deps));

  app.notFound((c) => htmlResponse(c as any, publicPage('No encontrado', h`<div class="card center"><h1>Página no encontrada</h1><p>El enlace no existe o ya no está disponible.</p><a class="btn" href="/">Volver al inicio</a></div>`, { narrow: true }), 404));

  app.onError((err, c) => {
    console.error(`[error] ${c.req.method} ${c.req.path}:`, err);
    return htmlResponse(c as any, publicPage('Error', h`<div class="card center"><h1>Algo ha fallado</h1><p>Lo sentimos. El error ha quedado registrado; inténtalo de nuevo en unos minutos.</p></div>`, { narrow: true }), 500);
  });

  return app;
}
