import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Browser, createClient, createRequest, lastEmail, makeApp, pdfBytes, portalPathFromEmail, signup, upload,
} from './helpers.ts';
import { runReminders, spawnRecurring } from '../src/services/requests.ts';
import { signStripePayload } from '../src/services/stripe.ts';

test('registro, login, logout y protección de rutas privadas', async () => {
  const { app } = makeApp();
  const anon = new Browser(app);
  const r1 = await anon.get('/app');
  assert.equal(r1.status, 303);
  assert.match(r1.headers.get('location')!, /^\/login/);

  const b = await signup(app);
  const dash = await b.get('/app');
  assert.equal(dash.status, 200);
  assert.match(await dash.text(), /Primeros pasos/);

  // Duplicado
  const dup = await new Browser(app).post('/signup', { name: 'X', org: 'Y', email: 'ANA@gestoria.es', password: 'una-clave-segura-123', terms: '1' });
  assert.equal(dup.status, 409);

  const csrf = await b.csrf();
  assert.equal((await b.post('/logout', { _csrf: csrf })).status, 303);
  assert.equal((await b.get('/app')).status, 303);

  const bad = await new Browser(app).post('/login', { email: 'ana@gestoria.es', password: 'mala-clave-0000' });
  assert.equal(bad.status, 400);
  const good = new Browser(app);
  const ok = await good.post('/login', { email: 'ana@gestoria.es', password: 'una-clave-segura-123', next: '/app/clients' });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/app/clients');
  // Redirección abierta bloqueada
  const evil = await new Browser(app).post('/login', { email: 'ana@gestoria.es', password: 'una-clave-segura-123', next: '//evil.com' });
  assert.equal(evil.headers.get('location'), '/app');
});

test('CSRF: sin token o con origen ajeno se rechaza', async () => {
  const { app } = makeApp();
  const b = await signup(app);
  const noToken = await b.post('/app/clients', { name: 'X' });
  assert.equal(noToken.status, 403);
  const csrf = await b.csrf();
  const foreign = await b.post('/app/clients', { _csrf: csrf, name: 'X' }, { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  const ok = await b.post('/app/clients', { _csrf: csrf, name: 'X' }, { origin: 'http://localhost' });
  assert.equal(ok.status, 303);
});

test('flujo completo: petición → email → portal → subida → revisión → completada', async () => {
  const { app, db } = makeApp();
  const b = await signup(app);
  const { id: clientId } = await createClient(b);
  const { res, id: requestId } = await createRequest(b, clientId);
  assert.equal(res.status, 303);

  const mail = lastEmail(db, 'request');
  assert.equal(mail.to_email, 'cliente@ejemplo.es');
  assert.match(mail.body_text, /Facturas emitidas/);
  const portal = portalPathFromEmail(mail.body_text);

  // El cliente abre el portal sin sesión
  const client = new Browser(app);
  const page = await client.get(portal);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Te faltan 2 documento/);
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');

  const items = db.prepare('SELECT * FROM request_items WHERE request_id = ? ORDER BY position').all(requestId) as any[];
  assert.equal(items.length, 3);
  assert.equal(items[2].required, 0);

  // Subida no permitida
  const badUp = await upload(client, portal, items[0].id, [{ name: 'malware.exe', data: new Uint8Array([1, 2]) }]);
  assert.equal(badUp.status, 400);
  // Subida que miente sobre su tipo
  const fake = await upload(client, portal, items[0].id, [{ name: 'factura.pdf', data: new TextEncoder().encode('<html>') }]);
  assert.equal(fake.status, 400);

  // Subidas válidas
  for (const it of items.slice(0, 2)) {
    const up = await upload(client, portal, it.id, [{ name: 'factura 1.pdf', data: pdfBytes() }]);
    assert.equal(up.status, 200);
  }
  assert.match(lastEmail(db, 'upload_notice').subject, /ha subido documentos/);
  assert.match(await (await client.get(portal)).text(), /Ya has enviado todo lo obligatorio/);

  // El despacho descarga el archivo
  const file = db.prepare('SELECT id FROM files LIMIT 1').get() as any;
  const dl = await b.get(`/app/files/${file.id}`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition')!, /attachment/);
  assert.match(Buffer.from(await dl.arrayBuffer()).toString(), /^%PDF/);

  // Rechazo de uno → email al cliente y estado reabierto
  let csrf = await b.csrf(`/app/requests/${requestId}`);
  await b.post(`/app/requests/${requestId}/items/${items[0].id}/review`, { _csrf: csrf, action: 'reject', reason: 'Foto ilegible' });
  assert.match(lastEmail(db, 'reminder').body_text, /Foto ilegible/);
  assert.match(await (await client.get(portal)).text(), /Foto ilegible/);

  // Aprobación de los obligatorios → completada (el opcional no bloquea)
  await upload(client, portal, items[0].id, [{ name: 'factura-buena.pdf', data: pdfBytes() }]);
  csrf = await b.csrf(`/app/requests/${requestId}`);
  for (const it of items.slice(0, 2)) {
    await b.post(`/app/requests/${requestId}/items/${it.id}/review`, { _csrf: csrf, action: 'approve' });
  }
  const req = db.prepare('SELECT status FROM requests WHERE id = ?').get(requestId) as any;
  assert.equal(req.status, 'completed');
  assert.match(await (await client.get(portal)).text(), /Todo recibido/);
});

test('enlaces del portal: token inválido y revocación', async () => {
  const { app, db } = makeApp();
  const b = await signup(app);
  const { id: clientId } = await createClient(b);
  const { id: requestId } = await createRequest(b, clientId);
  const portal = portalPathFromEmail(lastEmail(db, 'request').body_text);
  const client = new Browser(app);
  assert.equal((await client.get(portal + 'x')).status, 404);
  assert.equal((await client.get(`/p/${requestId}/abc`)).status, 404);

  const csrf = await b.csrf(`/app/requests/${requestId}`);
  await b.post(`/app/requests/${requestId}/regenerate-link`, { _csrf: csrf });
  assert.equal((await client.get(portal)).status, 404, 'el enlace antiguo deja de funcionar');
});

test('aislamiento entre despachos (multi-tenant)', async () => {
  const { app, db } = makeApp();
  const a = await signup(app, 'a@uno.es', 'Uno');
  const bOrg = await signup(app, 'b@dos.es', 'Dos');
  const { id: clientId } = await createClient(a);
  const { id: requestId } = await createRequest(a, clientId);
  const portal = portalPathFromEmail(lastEmail(db, 'request').body_text);
  const item = db.prepare('SELECT id FROM request_items WHERE request_id = ? LIMIT 1').get(requestId) as any;
  await upload(new Browser(app), portal, item.id, [{ name: 'doc.pdf', data: pdfBytes() }]);
  const file = db.prepare('SELECT id FROM files LIMIT 1').get() as any;

  assert.equal((await bOrg.get(`/app/clients/${clientId}`)).status, 404);
  assert.equal((await bOrg.get(`/app/requests/${requestId}`)).status, 404);
  assert.equal((await bOrg.get(`/app/files/${file.id}`)).status, 404);
  const csrf = await bOrg.csrf();
  assert.equal((await bOrg.post(`/app/requests/${requestId}/cancel`, { _csrf: csrf })).status, 404);
  assert.equal((await bOrg.post(`/app/clients/${clientId}/delete`, { _csrf: csrf })).status, 404);
  // B no puede crear peticiones para clientes de A
  const cross = await createRequest(bOrg, clientId);
  assert.equal(cross.res.status, 400);
  assert.doesNotMatch(await (await bOrg.get('/app/clients')).text(), /Panadería Ruiz/);
});

test('límites del plan gratuito: clientes y recurrencia', async () => {
  const { app } = makeApp();
  const b = await signup(app);
  for (let i = 0; i < 5; i++) assert.equal((await createClient(b, { name: `Cliente ${i}` })).res.status, 303);
  const sixth = await createClient(b, { name: 'Sexto' });
  assert.equal(sixth.res.status, 409);
  const csrf = await b.csrf('/app/clients');
  const list = await (await b.get('/app/clients')).text();
  const firstId = list.match(/\/app\/clients\/([0-9a-f-]{36})/)![1];
  const rec = await createRequest(b, firstId, { recurrence: 'quarterly' });
  assert.equal(rec.res.status, 400);
  // Archivar libera plaza
  await b.post(`/app/clients/${firstId}/archive`, { _csrf: csrf });
  assert.equal((await createClient(b, { name: 'Sexto' })).res.status, 303);
});

test('recordatorios automáticos y peticiones recurrentes', async () => {
  const { app, db, config, mailer } = makeApp();
  const b = await signup(app);
  // Activar plan Pro directamente para permitir recurrencia
  db.prepare(`UPDATE organizations SET plan = 'pro', subscription_status = 'active'`).run();
  const { id: clientId } = await createClient(b);
  const { id: requestId } = await createRequest(b, clientId, { due_date: '2030-01-20', recurrence: 'quarterly' });
  db.prepare(`UPDATE requests SET created_at = '2030-01-01 10:00:00' WHERE id = ?`).run(requestId);
  const deps = { db, config, mailer };

  assert.equal(await runReminders(deps, new Date('2030-01-10T09:00:00Z')), 0);
  assert.equal(await runReminders(deps, new Date('2030-01-13T09:00:00Z')), 1);
  assert.equal(await runReminders(deps, new Date('2030-01-13T12:00:00Z')), 0, 'no duplica el mismo día');
  assert.match(lastEmail(db, 'reminder').subject, /Recordatorio/);
  assert.equal(await runReminders(deps, new Date('2030-01-18T09:00:00Z')), 1);

  // Al vencer, se crea la petición del siguiente trimestre
  assert.equal(await spawnRecurring(deps, new Date('2030-01-19T09:00:00Z')), 0);
  assert.equal(await spawnRecurring(deps, new Date('2030-01-20T09:00:00Z')), 1);
  assert.equal(await spawnRecurring(deps, new Date('2030-01-21T09:00:00Z')), 0, 'sólo una vez');
  const next = db.prepare(`SELECT * FROM requests WHERE id != ? AND client_id = ?`).get(requestId, clientId) as any;
  assert.equal(next.due_date, '2030-04-20');
  assert.equal(next.recurrence, 'quarterly');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM request_items WHERE request_id = ?').get(next.id) as any).n, 3);

  // Una petición cancelada no recibe recordatorios
  const csrf = await b.csrf(`/app/requests/${next.id}`);
  await b.post(`/app/requests/${next.id}/cancel`, { _csrf: csrf });
  assert.equal(await runReminders(deps, new Date('2030-04-13T09:00:00Z')), 1, 'sólo la original vencida, no la cancelada');
});

test('Stripe: checkout y webhook actualizan el plan de forma idempotente', async () => {
  const calls: { url: string; body: string }[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: String(init.body) });
    return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }), { status: 200 });
  }) as unknown as typeof fetch;
  const { app, db } = makeApp({}, fakeFetch);
  const b = await signup(app);
  const org = db.prepare('SELECT id FROM organizations').get() as any;

  const csrf = await b.csrf('/app/billing');
  const res = await b.post('/app/billing/checkout', { _csrf: csrf, plan: 'pro' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_1');
  assert.match(calls[0].url, /checkout\/sessions/);
  assert.match(decodeURIComponent(calls[0].body), /line_items\[0\]\[price\]=price_pro/);
  assert.match(calls[0].body, new RegExp(`client_reference_id=${org.id}`));

  const sendEvent = (event: object, secret = 'whsec_test') => {
    const payload = JSON.stringify(event);
    return app.request('http://localhost/webhooks/stripe', {
      method: 'POST', body: payload, headers: { 'stripe-signature': signStripePayload(payload, secret), 'content-type': 'application/json' },
    });
  };

  assert.equal((await sendEvent({ id: 'evt_x', type: 'x', data: { object: {} } }, 'whsec_mala')).status, 400);

  await sendEvent({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { client_reference_id: org.id, customer: 'cus_1', subscription: 'sub_1' } } });
  const subEvent = {
    id: 'evt_2', type: 'customer.subscription.updated',
    data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { org_id: org.id }, current_period_end: 1900000000, items: { data: [{ price: { id: 'price_pro' } }] } } },
  };
  assert.equal((await sendEvent(subEvent)).status, 200);
  const dup = await (await sendEvent(subEvent)).json();
  assert.equal(dup.duplicate, true);

  let o = db.prepare('SELECT * FROM organizations WHERE id = ?').get(org.id) as any;
  assert.equal(o.plan, 'pro');
  assert.equal(o.subscription_status, 'active');
  assert.equal(o.stripe_customer_id, 'cus_1');
  assert.match(await (await b.get('/app/billing')).text(), /Plan Profesional/);

  await sendEvent({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled', items: { data: [] } } } });
  o = db.prepare('SELECT * FROM organizations WHERE id = ?').get(org.id) as any;
  assert.equal(o.plan, 'free');
});

test('invitaciones de equipo respetan el límite del plan', async () => {
  const { app, db } = makeApp();
  const owner = await signup(app);
  let csrf = await owner.csrf('/app/settings');
  const r1 = await owner.post('/app/settings/invite', { _csrf: csrf, email: 'socio@gestoria.es' });
  assert.equal(r1.status, 303);
  // Plan gratis = 1 usuario: no se crea invitación
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM invitations').get() as any).n, 0);

  db.prepare(`UPDATE organizations SET plan = 'pro', subscription_status = 'active'`).run();
  csrf = await owner.csrf('/app/settings');
  await owner.post('/app/settings/invite', { _csrf: csrf, email: 'socio@gestoria.es' });
  const mail = lastEmail(db, 'invite');
  const path = mail.body_text.match(/http:\/\/localhost(\/invite\/\S+)/)[1];
  const member = new Browser(app);
  assert.equal((await member.get(path)).status, 200);
  const acc = await member.post(path, { name: 'Socio', password: 'otra-clave-segura-1' });
  assert.equal(acc.status, 303);
  assert.equal((await member.get('/app')).status, 200);
  // Un miembro no puede borrar clientes ni cambiar ajustes
  const mcsrf = await member.csrf();
  assert.equal((await member.post('/app/settings', { _csrf: mcsrf, name: 'Hack' })).status, 403);
  // El enlace de invitación es de un solo uso
  assert.equal((await new Browser(app).get(path)).status, 404);
});

test('exportación RGPD y borrado de cuenta', async () => {
  const { app, db } = makeApp();
  const b = await signup(app);
  const { id: clientId } = await createClient(b);
  await createRequest(b, clientId);
  const exp = await b.get('/app/settings/export');
  assert.equal(exp.status, 200);
  const data = await exp.json();
  assert.equal(data.clients.length, 1);
  assert.equal(data.requests.length, 1);

  const csrf = await b.csrf('/app/settings');
  const wrong = await b.post('/app/settings/delete', { _csrf: csrf, confirm: 'otro' });
  assert.equal(wrong.status, 303);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM organizations').get() as any).n, 1);
  await b.post('/app/settings/delete', { _csrf: csrf, confirm: 'Gestoría Ana' });
  for (const t of ['organizations', 'users', 'clients', 'requests', 'request_items']) {
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n, 0, t);
  }
});

test('cabeceras de seguridad y XSS escapado', async () => {
  const { app } = makeApp();
  const b = await signup(app);
  await createClient(b, { name: '<script>alert(1)</script>' });
  const res = await b.get('/app/clients');
  const html = await res.text();
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(res.headers.get('content-security-policy')!, /script-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});
