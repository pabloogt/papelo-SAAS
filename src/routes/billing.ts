import { Hono } from 'hono';
import type { AppDeps, Env } from '../context.ts';
import { htmlResponse, mustAuth, redirectWith, str, takeFlash, viewer } from '../context.ts';
import { one, run } from '../db.ts';
import { formatBytes, formatDate } from '../lib/dates.ts';
import { h } from '../lib/html.ts';
import { PLANS } from '../services/plans.ts';
import { audit } from '../services/requests.ts';
import { planForPrice, priceForPlan, verifyStripeSignature } from '../services/stripe.ts';
import { appPage, csrfField } from '../views/layout.ts';

const STATUS_LABEL: Record<string, string> = {
  active: 'Activa', trialing: 'En prueba', past_due: 'Pago pendiente', canceled: 'Cancelada', unpaid: 'Impagada', incomplete: 'Incompleta',
};

export function billingRoutes(deps: AppDeps) {
  const { db, config, stripe } = deps;
  const r = new Hono<Env>();
  const enabled = () => !!stripe && !!config.stripe.pricePro && !!config.stripe.priceDespacho;

  r.get('/', (c) => {
    const auth = mustAuth(c);
    const clients = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM clients WHERE org_id = ? AND archived_at IS NULL', auth.org.id)!.n;
    const members = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?', auth.org.id)!.n;
    const storage = one<{ s: number | null }>(db, 'SELECT SUM(size) AS s FROM files WHERE org_id = ?', auth.org.id)!.s ?? 0;
    const p = auth.plan;
    const meter = (label: string, used: number, max: number, fmt: (n: number) => string = String) => {
      const pct = Math.min(100, Math.round((used / max) * 100));
      return h`<div class="meter"><div class="meter-head"><span>${label}</span><span>${fmt(used)} / ${fmt(max)}</span></div><progress class="bar ${pct >= 90 ? 'warn' : ''}" max="100" value="${pct}"></progress></div>`;
    };
    const isOwner = auth.role === 'owner';
    const hasSub = !!auth.org.stripe_customer_id;
    return htmlResponse(c, appPage(viewer(auth), 'billing', 'Plan y pagos', h`
<h1>Plan y pagos</h1>
<section class="card">
  <div class="page-head"><h2>Plan ${p.name}</h2>${auth.org.subscription_status ? h`<span class="badge badge-neutral">Suscripción: ${STATUS_LABEL[auth.org.subscription_status] ?? auth.org.subscription_status}</span>` : ''}</div>
  ${auth.org.current_period_end && p.id !== 'free' ? h`<p class="muted small">Próxima renovación: ${formatDate(auth.org.current_period_end)}</p>` : ''}
  ${auth.org.subscription_status === 'past_due' ? h`<div class="flash flash-error">No hemos podido cobrar tu última factura. Actualiza tu método de pago para no perder el plan.</div>` : ''}
  ${meter('Clientes activos', clients, p.maxClients)}
  ${meter('Usuarios', members, p.maxMembers)}
  ${meter('Almacenamiento', storage, p.maxStorageBytes, formatBytes)}
  ${isOwner && hasSub && enabled() ? h`<form method="post" action="/app/billing/portal">${csrfField(auth.csrf)}<button class="btn btn-secondary" type="submit">Gestionar suscripción, facturas y método de pago</button></form>` : ''}
</section>
${!enabled() ? h`<div class="flash flash-error">Los pagos no están configurados en este entorno (faltan STRIPE_SECRET_KEY y los precios). Consulta el README.</div>` : ''}
<section><h2>Planes</h2>
<div class="pricing">${Object.values(PLANS).map((plan) => h`
  <div class="price-card ${plan.id === p.id ? 'current' : ''}">
    <h3>${plan.name}</h3>
    <div class="price"><span class="amount">${plan.priceEur} €</span><span class="per">/mes + IVA</span></div>
    <ul>${plan.features.map((f) => h`<li>${f}</li>`)}</ul>
    ${plan.id === p.id ? h`<span class="badge badge-success">Tu plan actual</span>`
      : plan.id === 'free' ? (hasSub ? h`<p class="small muted">Para volver a Gratis, cancela desde la gestión de la suscripción.</p>` : '')
      : !isOwner ? h`<p class="small muted">Sólo el titular puede cambiar el plan.</p>`
      : hasSub && p.id !== 'free' ? h`<p class="small muted">Cambia de plan desde la gestión de la suscripción.</p>`
      : h`<form method="post" action="/app/billing/checkout">${csrfField(auth.csrf)}<input type="hidden" name="plan" value="${plan.id}"><button class="btn btn-block" type="submit" ${enabled() ? '' : 'disabled'}>Contratar ${plan.name}</button></form>`}
  </div>`)}</div>
<p class="muted small">Pago seguro con Stripe. Factura con IVA a nombre de tu despacho. Sin permanencia.</p>
</section>`, takeFlash(c)));
  });

  r.post('/checkout', async (c) => {
    const auth = mustAuth(c);
    if (auth.role !== 'owner') return c.text('Sólo el titular puede cambiar el plan', 403);
    if (!enabled()) return redirectWith(c, '/app/billing', 'error', 'Los pagos no están configurados.');
    const plan = str(await c.req.parseBody({ all: true }), 'plan', 20);
    const priceId = priceForPlan(config, plan);
    if (!priceId) return redirectWith(c, '/app/billing', 'error', 'Plan no válido.');
    const session = await stripe!.createCheckoutSession({
      priceId, orgId: auth.org.id, customerId: auth.org.stripe_customer_id, email: auth.user.email,
      successUrl: `${config.appUrl}/app/billing?ok=1`, cancelUrl: `${config.appUrl}/app/billing`,
    });
    audit(db, auth.org.id, auth.user.id, 'billing.checkout_started', null, { plan });
    return c.redirect(session.url, 303);
  });

  r.post('/portal', async (c) => {
    const auth = mustAuth(c);
    if (auth.role !== 'owner' || !auth.org.stripe_customer_id || !stripe) return c.redirect('/app/billing', 303);
    const session = await stripe.createPortalSession(auth.org.stripe_customer_id, `${config.appUrl}/app/billing`);
    return c.redirect(session.url, 303);
  });

  return r;
}

// Webhook de Stripe: única fuente de verdad del estado de la suscripción.
export function webhookRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const r = new Hono<Env>();

  r.post('/webhooks/stripe', async (c) => {
    const secret = config.stripe.webhookSecret;
    if (!secret) return c.text('Webhook no configurado', 503);
    const payload = await c.req.text();
    if (!verifyStripeSignature(payload, c.req.header('stripe-signature'), secret)) return c.text('Firma no válida', 400);
    const event = JSON.parse(payload) as { id: string; type: string; data: { object: any } };

    // Idempotencia: Stripe puede reenviar el mismo evento.
    const inserted = run(db, 'INSERT OR IGNORE INTO webhook_events (id, type) VALUES (?, ?)', event.id, event.type);
    if (inserted.changes === 0) return c.json({ received: true, duplicate: true });

    const obj = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': {
        const orgId = obj.client_reference_id ?? obj.metadata?.org_id;
        if (orgId && obj.customer) {
          run(db, 'UPDATE organizations SET stripe_customer_id = ?, stripe_subscription_id = COALESCE(?, stripe_subscription_id) WHERE id = ?',
            obj.customer, obj.subscription ?? null, orgId);
          audit(db, orgId, 'stripe', 'billing.checkout_completed');
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const orgId = obj.metadata?.org_id
          ?? one<{ id: string }>(db, 'SELECT id FROM organizations WHERE stripe_customer_id = ?', obj.customer)?.id;
        if (!orgId) break;
        const priceId = obj.items?.data?.[0]?.price?.id;
        const plan = event.type === 'customer.subscription.deleted' ? 'free' : (planForPrice(config, priceId) ?? 'free');
        const periodEndSec = obj.current_period_end ?? obj.items?.data?.[0]?.current_period_end;
        const periodEnd = periodEndSec ? new Date(periodEndSec * 1000).toISOString() : null;
        run(db, `UPDATE organizations SET plan = ?, subscription_status = ?, stripe_subscription_id = ?, stripe_customer_id = COALESCE(stripe_customer_id, ?), current_period_end = ? WHERE id = ?`,
          plan, obj.status ?? null, obj.id, obj.customer ?? null, periodEnd, orgId);
        audit(db, orgId, 'stripe', 'billing.subscription_changed', null, { plan, status: obj.status });
        break;
      }
      default:
        break;
    }
    return c.json({ received: true });
  });

  return r;
}
