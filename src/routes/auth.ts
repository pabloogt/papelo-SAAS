import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import type { AppDeps, C, Env } from '../context.ts';
import { clientIp, htmlResponse, mustAuth, redirectWith, str, takeFlash } from '../context.ts';
import type { Config } from '../config.ts';
import { one, run, tx } from '../db.ts';
import { h } from '../lib/html.ts';
import {
  getDummyHash, hashPassword, isValidEmail, newId, passwordProblem, randomToken, RateLimiter, sha256, verifyPassword,
} from '../lib/security.ts';
import { audit, seedTemplates } from '../services/requests.ts';
import { publicPage, type Flash } from '../views/layout.ts';
import { effectivePlan } from '../services/plans.ts';

const SESSION_DAYS = 30;

export function sessionCookieName(config: Config) {
  return config.env === 'production' ? '__Host-sid' : 'sid';
}

export function createSession(c: C, deps: AppDeps, userId: string, orgId: string) {
  const sid = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  run(deps.db, 'INSERT INTO sessions (id_hash, user_id, org_id, csrf_token, expires_at) VALUES (?, ?, ?, ?, ?)',
    sha256(sid), userId, orgId, randomToken(24), expires.toISOString());
  setCookie(c, sessionCookieName(deps.config), sid, {
    path: '/', httpOnly: true, sameSite: 'Lax', secure: deps.config.env === 'production', expires,
  });
}

function safeNext(next: string): string {
  return next.startsWith('/app') && !next.startsWith('//') ? next : '/app';
}

function authForm(kind: 'login' | 'signup', values: Record<string, string>, flash: Flash) {
  const isSignup = kind === 'signup';
  return publicPage(isSignup ? 'Crear cuenta' : 'Entrar', h`
<div class="card auth-card">
  <h1>${isSignup ? 'Crea tu cuenta gratis' : 'Bienvenido de nuevo'}</h1>
  <p class="muted">${isSignup ? 'Sin tarjeta. Hasta 5 clientes gratis para siempre.' : 'Entra en tu despacho.'}</p>
  <form method="post" action="/${kind}" class="stack">
    ${isSignup ? h`
    <label>Tu nombre<input name="name" required maxlength="100" autocomplete="name" value="${values.name ?? ''}"></label>
    <label>Nombre del despacho o gestoría<input name="org" required maxlength="120" value="${values.org ?? ''}"></label>` : ''}
    <label>Email<input type="email" name="email" required maxlength="254" autocomplete="email" value="${values.email ?? ''}"></label>
    <label>Contraseña<input type="password" name="password" required minlength="${isSignup ? 10 : 1}" maxlength="200" autocomplete="${isSignup ? 'new-password' : 'current-password'}"></label>
    ${isSignup ? h`<p class="hint">Mínimo 10 caracteres.</p>
    <label class="check"><input type="checkbox" name="terms" value="1" required> Acepto los <a href="/legal/terminos" target="_blank">términos</a> y la <a href="/legal/privacidad" target="_blank">política de privacidad</a>, incluido el encargo de tratamiento de datos (RGPD).</label>` : ''}
    <input type="hidden" name="next" value="${values.next ?? ''}">
    <button class="btn btn-block" type="submit">${isSignup ? 'Crear cuenta' : 'Entrar'}</button>
  </form>
  <p class="muted center">${isSignup ? h`¿Ya tienes cuenta? <a href="/login">Entra</a>` : h`¿Nuevo en Papelo? <a href="/signup">Crea una cuenta</a>`}</p>
</div>`, { flash, narrow: true });
}

export function authRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const r = new Hono<Env>();
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
  const signupLimiter = new RateLimiter(5, 60 * 60 * 1000);

  r.get('/signup', (c) => c.get('auth') ? c.redirect('/app') : htmlResponse(c, authForm('signup', {}, takeFlash(c))));
  r.get('/login', (c) => c.get('auth') ? c.redirect('/app') : htmlResponse(c, authForm('login', { next: c.req.query('next') ?? '' }, takeFlash(c))));

  r.post('/signup', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const values = { name: str(body, 'name', 100), org: str(body, 'org', 120), email: str(body, 'email', 254).toLowerCase() };
    const fail = (text: string, status: 400 | 409 | 429 = 400) => htmlResponse(c, authForm('signup', values, { type: 'error', text }), status);
    if (!signupLimiter.check(clientIp(c, config.trustProxy))) return fail('Demasiados intentos. Espera un rato.', 429);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!values.name || !values.org) return fail('Completa tu nombre y el del despacho.');
    if (!isValidEmail(values.email)) return fail('Introduce un email válido.');
    const pwErr = passwordProblem(password);
    if (pwErr) return fail(pwErr);
    if (body.terms !== '1') return fail('Debes aceptar los términos para continuar.');
    if (one(db, 'SELECT 1 FROM users WHERE email = ?', values.email)) return fail('Ya existe una cuenta con ese email. ¿Quieres entrar?', 409);

    const hash = await hashPassword(password);
    const userId = newId();
    const orgId = newId();
    tx(db, () => {
      run(db, 'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)', userId, values.email, values.name, hash);
      run(db, 'INSERT INTO organizations (id, name, reply_to) VALUES (?, ?, ?)', orgId, values.org, values.email);
      run(db, `INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, 'owner')`, userId, orgId);
      seedTemplates(db, orgId);
      audit(db, orgId, userId, 'org.created');
    });
    createSession(c, deps, userId, orgId);
    return redirectWith(c, '/app', 'ok', `¡Bienvenido, ${values.name}! Empieza añadiendo tu primer cliente.`);
  });

  r.post('/login', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const email = str(body, 'email', 254).toLowerCase();
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    const next = safeNext(str(body, 'next', 200));
    const ip = clientIp(c, config.trustProxy);
    if (!loginLimiter.check(`ip:${ip}`) || !loginLimiter.check(`email:${email}`)) {
      return htmlResponse(c, authForm('login', { email, next }, { type: 'error', text: 'Demasiados intentos. Espera 15 minutos.' }), 429);
    }
    const user = one<{ id: string; password_hash: string }>(db, 'SELECT id, password_hash FROM users WHERE email = ?', email);
    const ok = await verifyPassword(password, user?.password_hash ?? (await getDummyHash()));
    if (!user || !ok) {
      return htmlResponse(c, authForm('login', { email, next }, { type: 'error', text: 'Email o contraseña incorrectos.' }), 400);
    }
    const membership = one<{ org_id: string }>(db, 'SELECT org_id FROM memberships WHERE user_id = ? ORDER BY created_at LIMIT 1', user.id);
    if (!membership) return htmlResponse(c, authForm('login', { email }, { type: 'error', text: 'Tu usuario no pertenece a ningún despacho.' }), 400);
    createSession(c, deps, user.id, membership.org_id);
    audit(db, membership.org_id, user.id, 'user.login', null, { ip });
    return c.redirect(next, 303);
  });

  r.post('/logout', (c) => {
    const auth = mustAuth(c);
    run(db, 'DELETE FROM sessions WHERE id_hash = ?', auth.sessionHash);
    deleteCookie(c, sessionCookieName(config), { path: '/', secure: config.env === 'production' });
    return c.redirect('/', 303);
  });

  // ---------- Invitaciones a miembros del despacho ----------
  const invitePage = (token: string, inv: { email: string; org_name: string }, flash: Flash, existing: boolean) => publicPage('Invitación', h`
<div class="card auth-card">
  <h1>Únete a ${inv.org_name}</h1>
  <p class="muted">Invitación para <strong>${inv.email}</strong>.</p>
  <form method="post" action="/invite/${token}" class="stack">
    ${existing ? h`<label>Tu contraseña actual<input type="password" name="password" required></label>` : h`
    <label>Tu nombre<input name="name" required maxlength="100"></label>
    <label>Crea una contraseña<input type="password" name="password" required minlength="10" maxlength="200" autocomplete="new-password"></label>`}
    <button class="btn btn-block" type="submit">Aceptar invitación</button>
  </form>
</div>`, { flash, narrow: true });

  const findInvite = (token: string) => one<{ id: string; org_id: string; email: string; org_name: string }>(db,
    `SELECT i.id, i.org_id, i.email, o.name AS org_name FROM invitations i JOIN organizations o ON o.id = i.org_id
     WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > ?`, sha256(token), new Date().toISOString());

  r.get('/invite/:token', (c) => {
    const inv = findInvite(c.req.param('token'));
    if (!inv) return c.notFound();
    const existing = !!one(db, 'SELECT 1 FROM users WHERE email = ?', inv.email);
    return htmlResponse(c, invitePage(c.req.param('token'), inv, takeFlash(c), existing));
  });

  r.post('/invite/:token', async (c) => {
    const token = c.req.param('token');
    const inv = findInvite(token);
    if (!inv) return c.notFound();
    if (!loginLimiter.check(`invite:${clientIp(c, config.trustProxy)}`)) return c.text('Demasiados intentos', 429);
    const body = await c.req.parseBody({ all: true });
    const password = typeof body.password === 'string' ? body.password : '';
    const existing = one<{ id: string; password_hash: string }>(db, 'SELECT id, password_hash FROM users WHERE email = ?', inv.email);

    // Límite de usuarios del plan.
    const org = one<any>(db, 'SELECT * FROM organizations WHERE id = ?', inv.org_id);
    const members = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?', inv.org_id)!.n;
    if (members >= effectivePlan(org).maxMembers) {
      return htmlResponse(c, invitePage(token, inv, { type: 'error', text: 'El despacho ha alcanzado el límite de usuarios de su plan.' }, !!existing), 409);
    }

    let userId: string;
    if (existing) {
      if (!(await verifyPassword(password, existing.password_hash))) {
        return htmlResponse(c, invitePage(token, inv, { type: 'error', text: 'Contraseña incorrecta.' }, true), 400);
      }
      userId = existing.id;
    } else {
      const name = str(body, 'name', 100);
      const pwErr = passwordProblem(password);
      if (!name || pwErr) return htmlResponse(c, invitePage(token, inv, { type: 'error', text: pwErr ?? 'Indica tu nombre.' }, false), 400);
      userId = newId();
      run(db, 'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)', userId, inv.email, name, await hashPassword(password));
    }
    tx(db, () => {
      run(db, `INSERT OR IGNORE INTO memberships (user_id, org_id, role) VALUES (?, ?, 'member')`, userId, inv.org_id);
      run(db, `UPDATE invitations SET accepted_at = datetime('now') WHERE id = ?`, inv.id);
      audit(db, inv.org_id, userId, 'member.joined');
    });
    createSession(c, deps, userId, inv.org_id);
    return redirectWith(c, '/app', 'ok', `Ya formas parte de ${inv.org_name}.`);
  });

  return r;
}
