import { createHmac } from 'node:crypto';
import type { Config } from '../config.ts';
import { safeEqual } from '../lib/security.ts';
import type { PlanId } from './plans.ts';

// Cliente mínimo de la API REST de Stripe (sin SDK): menos dependencias y fácil de simular en tests.
export type FetchLike = typeof fetch;

function encodeForm(data: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) if (v !== undefined) p.append(k, String(v));
  return p.toString();
}

export class Stripe {
  private key: string;
  private fetchFn: FetchLike;
  constructor(key: string, fetchFn: FetchLike = fetch) {
    this.key = key;
    this.fetchFn = fetchFn;
  }

  async post<T = any>(path: string, data: Record<string, string | number | boolean | undefined>): Promise<T> {
    const res = await this.fetchFn(`https://api.stripe.com/v1/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-06-20',
      },
      body: encodeForm(data),
    });
    const json = (await res.json()) as any;
    if (!res.ok) throw new Error(`Stripe ${path}: ${json?.error?.message ?? res.status}`);
    return json as T;
  }

  createCheckoutSession(opts: {
    priceId: string; orgId: string; customerId: string | null; email: string; successUrl: string; cancelUrl: string;
  }) {
    return this.post<{ id: string; url: string }>('checkout/sessions', {
      mode: 'subscription',
      'line_items[0][price]': opts.priceId,
      'line_items[0][quantity]': 1,
      client_reference_id: opts.orgId,
      'subscription_data[metadata][org_id]': opts.orgId,
      'metadata[org_id]': opts.orgId,
      customer: opts.customerId ?? undefined,
      customer_email: opts.customerId ? undefined : opts.email,
      allow_promotion_codes: true,
      'tax_id_collection[enabled]': true,
      billing_address_collection: 'required',
      success_url: opts.successUrl,
      cancel_url: opts.cancelUrl,
    });
  }

  createPortalSession(customerId: string, returnUrl: string) {
    return this.post<{ url: string }>('billing_portal/sessions', { customer: customerId, return_url: returnUrl });
  }
}

export function planForPrice(config: Config, priceId: string | undefined): PlanId | null {
  if (!priceId) return null;
  if (priceId === config.stripe.pricePro) return 'pro';
  if (priceId === config.stripe.priceDespacho) return 'despacho';
  return null;
}

export function priceForPlan(config: Config, plan: string): string | null {
  if (plan === 'pro') return config.stripe.pricePro;
  if (plan === 'despacho') return config.stripe.priceDespacho;
  return null;
}

// Verificación de la cabecera Stripe-Signature (esquema v1, HMAC-SHA256 sobre "timestamp.payload").
export function verifyStripeSignature(
  payload: string, header: string | undefined, secret: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  let timestamp = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't') timestamp = v;
    else if (k === 'v1' && v) signatures.push(v);
  }
  const ts = Number(timestamp);
  if (!timestamp || !Number.isFinite(ts) || signatures.length === 0) return false;
  if (Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return signatures.some((s) => safeEqual(s, expected));
}

export function signStripePayload(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}
