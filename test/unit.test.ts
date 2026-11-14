import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, portalToken, verifyPortalToken, RateLimiter, isValidEmail } from '../src/lib/security.ts';
import { h, raw } from '../src/lib/html.ts';
import { addMonths, addDays, isISODate } from '../src/lib/dates.ts';
import { isReminderDue, nextDueDate } from '../src/services/requests.ts';
import { verifyStripeSignature, signStripePayload } from '../src/services/stripe.ts';
import { effectivePlan } from '../src/services/plans.ts';
import { validateUpload, sanitizeFilename } from '../src/services/storage.ts';
import { parseItemsText, itemsToText } from '../src/routes/app.ts';

test('hash de contraseñas: verifica la correcta y rechaza la incorrecta', async () => {
  const hash = await hashPassword('correcta-123456');
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword('correcta-123456', hash), true);
  assert.equal(await verifyPassword('incorrecta-1234', hash), false);
  assert.equal(await verifyPassword('x', 'basura'), false);
});

test('token de portal: determinista, ligado al nonce y a la petición', () => {
  const t = portalToken('secreto', 'req-1', 'nonce-a');
  assert.equal(verifyPortalToken('secreto', 'req-1', 'nonce-a', t), true);
  assert.equal(verifyPortalToken('secreto', 'req-1', 'nonce-b', t), false);
  assert.equal(verifyPortalToken('secreto', 'req-2', 'nonce-a', t), false);
  assert.equal(verifyPortalToken('otro', 'req-1', 'nonce-a', t), false);
});

test('plantillas HTML escapan valores y no escapan SafeHtml anidado', () => {
  const out = h`<p>${'<script>alert(1)</script>'}</p>${h`<b>${'"x"'}</b>`}${[1, 2].map((n) => h`<i>${n}</i>`)}${null}${raw('<hr>')}`;
  assert.equal(out.value, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><b>&quot;x&quot;</b><i>1</i><i>2</i><hr>');
});

test('fechas: suma de meses ajusta fin de mes', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-11-20', 3), '2027-02-20');
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(isISODate('2026-02-30'), false);
  assert.equal(isISODate('2026-02-28'), true);
  assert.equal(nextDueDate('2026-04-20', 'quarterly'), '2026-07-20');
  assert.equal(nextDueDate('2026-04-20', 'none'), null);
});

test('política de recordatorios', () => {
  const base = { dueDate: '2026-01-20', createdDate: '2026-01-01', lastReminderDate: null, remindersSent: 0 };
  assert.equal(isReminderDue({ ...base, today: '2026-01-12' }), false, 'antes del primer hito');
  assert.equal(isReminderDue({ ...base, today: '2026-01-13' }), true, '7 días antes');
  assert.equal(isReminderDue({ ...base, lastReminderDate: '2026-01-13', remindersSent: 1, today: '2026-01-14' }), false, 'ya avisado');
  assert.equal(isReminderDue({ ...base, lastReminderDate: '2026-01-13', remindersSent: 1, today: '2026-01-18' }), true, '2 días antes');
  assert.equal(isReminderDue({ ...base, lastReminderDate: '2026-01-20', remindersSent: 3, today: '2026-01-22' }), false);
  assert.equal(isReminderDue({ ...base, lastReminderDate: '2026-01-20', remindersSent: 3, today: '2026-01-23' }), true, '3 días después');
  assert.equal(isReminderDue({ ...base, remindersSent: 6, today: '2026-02-20' }), false, 'tope alcanzado');
  assert.equal(isReminderDue({ ...base, createdDate: '2026-01-19', today: '2026-01-19' }), false, 'creada hoy');
  assert.equal(isReminderDue({ ...base, createdDate: '2026-01-19', today: '2026-01-20' }), true, 'creada tarde: aviso el día del vencimiento');
});

test('firma de webhooks de Stripe', () => {
  const payload = '{"id":"evt_1"}';
  const now = 1_700_000_000;
  const header = signStripePayload(payload, 'whsec_x', now);
  assert.equal(verifyStripeSignature(payload, header, 'whsec_x', 300, now), true);
  assert.equal(verifyStripeSignature(payload + ' ', header, 'whsec_x', 300, now), false, 'payload alterado');
  assert.equal(verifyStripeSignature(payload, header, 'whsec_y', 300, now), false, 'otro secreto');
  assert.equal(verifyStripeSignature(payload, header, 'whsec_x', 300, now + 301), false, 'caducado');
  assert.equal(verifyStripeSignature(payload, undefined, 'whsec_x'), false);
});

test('plan efectivo según estado de la suscripción', () => {
  assert.equal(effectivePlan({ plan: 'pro', subscription_status: 'active' }).id, 'pro');
  assert.equal(effectivePlan({ plan: 'pro', subscription_status: 'past_due' }).id, 'pro');
  assert.equal(effectivePlan({ plan: 'pro', subscription_status: 'canceled' }).id, 'free');
  assert.equal(effectivePlan({ plan: 'inventado', subscription_status: 'active' }).id, 'free');
});

test('validación de subidas por extensión y firma binaria', () => {
  assert.equal(validateUpload('factura.pdf', new TextEncoder().encode('%PDF-1.7')).ok, true);
  assert.equal(validateUpload('factura.pdf', new TextEncoder().encode('<html>')).ok, false);
  assert.equal(validateUpload('virus.exe', new Uint8Array([1])).ok, false);
  assert.equal(validateUpload('sin-extension', new Uint8Array([1])).ok, false);
  assert.equal(validateUpload('vacio.txt', new Uint8Array()).ok, false);
  assert.equal(sanitizeFilename('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(sanitizeFilename('..'), 'archivo');
});

test('lista de documentos desde texto', () => {
  const items = parseItemsText('Facturas\n\n  Extracto (opcional) \n');
  assert.deepEqual(items, [{ label: 'Facturas', required: true }, { label: 'Extracto', required: false }]);
  assert.equal(itemsToText(items), 'Facturas\nExtracto (opcional)');
});

test('limitador de peticiones', () => {
  const rl = new RateLimiter(2, 1000);
  assert.equal(rl.check('a', 0), true);
  assert.equal(rl.check('a', 1), true);
  assert.equal(rl.check('a', 2), false);
  assert.equal(rl.check('a', 1001), true, 'nueva ventana');
  assert.equal(isValidEmail('a@b.es'), true);
  assert.equal(isValidEmail('a@b'), false);
});
