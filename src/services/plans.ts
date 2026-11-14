export type PlanId = 'free' | 'pro' | 'despacho';

export type Plan = {
  id: PlanId;
  name: string;
  priceEur: number; // mensual, sin IVA
  maxClients: number; // clientes activos (no archivados)
  maxMembers: number;
  maxStorageBytes: number;
  features: string[];
};

const GB = 1024 * 1024 * 1024;

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free', name: 'Gratis', priceEur: 0, maxClients: 5, maxMembers: 1, maxStorageBytes: 0.5 * GB,
    features: ['5 clientes activos', '1 usuario', 'Recordatorios automáticos', '500 MB'],
  },
  pro: {
    id: 'pro', name: 'Profesional', priceEur: 29, maxClients: 150, maxMembers: 3, maxStorageBytes: 25 * GB,
    features: ['150 clientes activos', '3 usuarios', 'Peticiones recurrentes', 'Plantillas ilimitadas', '25 GB'],
  },
  despacho: {
    id: 'despacho', name: 'Despacho', priceEur: 79, maxClients: 1000, maxMembers: 10, maxStorageBytes: 150 * GB,
    features: ['1.000 clientes activos', '10 usuarios', 'Todo lo de Profesional', 'Soporte prioritario', '150 GB'],
  },
};

const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

export function effectivePlan(org: { plan: string; subscription_status: string | null }): Plan {
  const id = (org.plan in PLANS ? org.plan : 'free') as PlanId;
  if (id === 'free') return PLANS.free;
  return org.subscription_status && ACTIVE_STATUSES.has(org.subscription_status) ? PLANS[id] : PLANS.free;
}
