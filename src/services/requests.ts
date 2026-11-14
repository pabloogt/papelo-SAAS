import type { Config } from '../config.ts';
import { all, one, run, tx, type DB } from '../db.ts';
import { addDays, addMonths, formatDate, todayISO } from '../lib/dates.ts';
import { newId, portalToken, randomToken } from '../lib/security.ts';
import type { Mailer } from './email.ts';

export type Deps = { db: DB; config: Config; mailer: Mailer };

export type Recurrence = 'none' | 'monthly' | 'quarterly' | 'yearly';
export const RECURRENCES: Record<Recurrence, string> = {
  none: 'No se repite', monthly: 'Cada mes', quarterly: 'Cada trimestre', yearly: 'Cada año',
};

export type ItemInput = { label: string; description?: string | null; required?: boolean };

export type RequestRow = {
  id: string; org_id: string; client_id: string; title: string; message: string | null; due_date: string;
  status: 'open' | 'completed' | 'cancelled'; recurrence: Recurrence; next_spawned: number; link_nonce: string;
  reminders_enabled: number; reminders_sent: number; last_reminder_at: string | null; created_by: string | null;
  created_at: string; completed_at: string | null;
};

export type ItemRow = {
  id: string; request_id: string; position: number; label: string; description: string | null; required: number;
  status: 'pending' | 'uploaded' | 'approved' | 'rejected'; reject_reason: string | null; updated_at: string;
};

export const DEFAULT_TEMPLATES: { name: string; message: string; items: ItemInput[] }[] = [
  {
    name: 'IVA trimestral (modelo 303)',
    message: 'Necesitamos la documentación del trimestre para preparar tus impuestos.',
    items: [
      { label: 'Facturas emitidas del trimestre', required: true },
      { label: 'Facturas recibidas (gastos) del trimestre', required: true },
      { label: 'Extracto bancario del trimestre', required: true },
      { label: 'Tickets y otros justificantes de gasto', required: false },
    ],
  },
  {
    name: 'Declaración de la Renta (IRPF)',
    message: 'Ha llegado el momento de preparar tu declaración de la Renta.',
    items: [
      { label: 'DNI/NIE en vigor (ambas caras)', required: true },
      { label: 'Certificado de retenciones de la empresa', required: true },
      { label: 'Recibos de hipoteca / alquiler', required: false },
      { label: 'Certificados de donativos', required: false },
      { label: 'Otros documentos relevantes', required: false },
    ],
  },
  {
    name: 'Alta de nuevo cliente',
    message: 'Bienvenido. Para empezar a trabajar necesitamos estos documentos.',
    items: [
      { label: 'DNI/NIE o CIF y escrituras', required: true },
      { label: 'Certificado de titularidad de la cuenta bancaria', required: true },
      { label: 'Último modelo presentado (303, 130, 111…)', required: false },
      { label: 'Contrato de encargo firmado', required: true },
    ],
  },
  {
    name: 'Cierre contable anual',
    message: 'Preparamos el cierre del ejercicio. Por favor, envíanos lo siguiente.',
    items: [
      { label: 'Extractos bancarios a 31 de diciembre', required: true },
      { label: 'Inventario de existencias', required: false },
      { label: 'Préstamos: cuadro de amortización', required: false },
      { label: 'Facturas de inmovilizado del año', required: false },
    ],
  },
];

export function seedTemplates(db: DB, orgId: string) {
  for (const t of DEFAULT_TEMPLATES) {
    run(db, 'INSERT INTO templates (id, org_id, name, message, items_json) VALUES (?, ?, ?, ?, ?)',
      newId(), orgId, t.name, t.message, JSON.stringify(t.items));
  }
}

export function audit(db: DB, orgId: string | null, actor: string, action: string, entityId: string | null = null, meta: unknown = null) {
  run(db, 'INSERT INTO audit_log (org_id, actor, action, entity_id, meta) VALUES (?, ?, ?, ?, ?)',
    orgId, actor, action, entityId, meta === null ? null : JSON.stringify(meta));
}

export function portalUrl(config: Config, req: { id: string; link_nonce: string }): string {
  return `${config.appUrl}/p/${req.id}/${portalToken(config.appSecret, req.id, req.link_nonce)}`;
}

export function createRequest(deps: Deps, input: {
  orgId: string; clientId: string; title: string; message: string | null; dueDate: string;
  recurrence: Recurrence; items: ItemInput[]; createdBy: string | null; remindersEnabled?: boolean;
}): string {
  const id = newId();
  tx(deps.db, () => {
    run(deps.db,
      `INSERT INTO requests (id, org_id, client_id, title, message, due_date, recurrence, link_nonce, reminders_enabled, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.orgId, input.clientId, input.title, input.message, input.dueDate, input.recurrence,
      randomToken(12), input.remindersEnabled === false ? 0 : 1, input.createdBy);
    input.items.forEach((item, i) => {
      run(deps.db, 'INSERT INTO request_items (id, request_id, position, label, description, required) VALUES (?, ?, ?, ?, ?, ?)',
        newId(), id, i, item.label, item.description ?? null, item.required === false ? 0 : 1);
    });
  });
  return id;
}

type RequestEmailContext = RequestRow & { client_name: string; client_email: string | null; org_name: string; reply_to: string | null };

function loadEmailContext(db: DB, requestId: string): RequestEmailContext | undefined {
  return one<RequestEmailContext>(db,
    `SELECT r.*, c.name AS client_name, c.email AS client_email, o.name AS org_name, o.reply_to
     FROM requests r JOIN clients c ON c.id = r.client_id JOIN organizations o ON o.id = r.org_id WHERE r.id = ?`, requestId);
}

function pendingItems(db: DB, requestId: string): ItemRow[] {
  return all<ItemRow>(db,
    `SELECT * FROM request_items WHERE request_id = ? AND status IN ('pending','rejected') ORDER BY position`, requestId);
}

export async function sendRequestEmail(deps: Deps, requestId: string, kind: 'request' | 'reminder'): Promise<boolean> {
  const ctx = loadEmailContext(deps.db, requestId);
  if (!ctx || !ctx.client_email || ctx.status !== 'open') return false;
  const pending = pendingItems(deps.db, requestId);
  if (kind === 'reminder' && pending.length === 0) return false;
  const list = (kind === 'reminder' ? pending : all<ItemRow>(deps.db, 'SELECT * FROM request_items WHERE request_id = ? ORDER BY position', requestId))
    .map((i) => `  • ${i.label}${i.status === 'rejected' ? ` (revisar: ${i.reject_reason ?? 'rechazado'})` : ''}`).join('\n');
  const overdue = ctx.due_date < todayISO();
  const subject = kind === 'request'
    ? `${ctx.org_name} te solicita documentación: ${ctx.title}`
    : `${overdue ? 'Vencido' : 'Recordatorio'}: documentación pendiente para ${ctx.org_name}`;
  const text = [
    `Hola ${ctx.client_name},`,
    '',
    kind === 'request' ? (ctx.message || `${ctx.org_name} necesita que le envíes la siguiente documentación.`)
      : `Aún tenemos pendiente la siguiente documentación de "${ctx.title}":`,
    '',
    list,
    '',
    `Fecha límite: ${formatDate(ctx.due_date)}`,
    '',
    'Súbela desde este enlace seguro (no necesitas contraseña):',
    portalUrl(deps.config, ctx),
    '',
    `Un saludo,\n${ctx.org_name}`,
  ].join('\n');
  await deps.mailer.send({ to: ctx.client_email, subject, text, replyTo: ctx.reply_to, kind, orgId: ctx.org_id, requestId });
  return true;
}

// Recalcula el estado de la petición a partir de sus elementos.
export function refreshRequestStatus(db: DB, requestId: string) {
  const req = one<RequestRow>(db, 'SELECT * FROM requests WHERE id = ?', requestId);
  if (!req || req.status === 'cancelled') return;
  const items = all<ItemRow>(db, 'SELECT * FROM request_items WHERE request_id = ?', requestId);
  const required = items.filter((i) => i.required);
  const relevant = required.length > 0 ? required : items;
  const done = relevant.length > 0 && relevant.every((i) => i.status === 'approved');
  if (done && req.status === 'open') {
    run(db, `UPDATE requests SET status = 'completed', completed_at = datetime('now') WHERE id = ?`, requestId);
  } else if (!done && req.status === 'completed') {
    run(db, `UPDATE requests SET status = 'open', completed_at = NULL WHERE id = ?`, requestId);
  }
}

// ---------- Recordatorios ----------

// Calendario relativo a la fecha límite: 7 y 2 días antes, el mismo día, y 3/7/14 días después.
export const REMINDER_OFFSETS = [-7, -2, 0, 3, 7, 14];
export const MAX_REMINDERS = REMINDER_OFFSETS.length;

/**
 * Decide si hoy toca recordatorio. Se envía uno si existe un hito del calendario <= hoy
 * posterior al último contacto (creación o último recordatorio). Si el programador estuvo parado,
 * sólo se envía un recordatorio de recuperación, nunca una ráfaga.
 */
export function isReminderDue(p: { dueDate: string; createdDate: string; lastReminderDate: string | null; remindersSent: number; today: string }): boolean {
  if (p.remindersSent >= MAX_REMINDERS) return false;
  const lastContact = p.lastReminderDate ?? p.createdDate;
  if (lastContact >= p.today) return false;
  const milestones = REMINDER_OFFSETS.map((o) => addDays(p.dueDate, o)).filter((d) => d <= p.today);
  if (milestones.length === 0) return false;
  return milestones[milestones.length - 1] > lastContact;
}

export async function runReminders(deps: Deps, now = new Date()): Promise<number> {
  const today = todayISO(now);
  const candidates = all<RequestRow>(deps.db,
    `SELECT r.* FROM requests r JOIN clients c ON c.id = r.client_id
     WHERE r.status = 'open' AND r.reminders_enabled = 1 AND c.email IS NOT NULL AND c.archived_at IS NULL
       AND r.reminders_sent < ?`, MAX_REMINDERS);
  let sent = 0;
  for (const r of candidates) {
    const due = isReminderDue({
      dueDate: r.due_date, createdDate: r.created_at.slice(0, 10),
      lastReminderDate: r.last_reminder_at?.slice(0, 10) ?? null, remindersSent: r.reminders_sent, today,
    });
    if (!due) continue;
    // Se marca antes de enviar: ante un fallo es preferible perder un recordatorio que enviar duplicados.
    run(deps.db, 'UPDATE requests SET reminders_sent = reminders_sent + 1, last_reminder_at = ? WHERE id = ?', now.toISOString(), r.id);
    if (await sendRequestEmail(deps, r.id, 'reminder')) {
      audit(deps.db, r.org_id, 'system', 'request.reminder_sent', r.id);
      sent++;
    }
  }
  return sent;
}

// ---------- Recurrencia ----------

export function nextDueDate(due: string, recurrence: Recurrence): string | null {
  if (recurrence === 'monthly') return addMonths(due, 1);
  if (recurrence === 'quarterly') return addMonths(due, 3);
  if (recurrence === 'yearly') return addMonths(due, 12);
  return null;
}

// Al llegar la fecha límite de una petición recurrente se crea la del siguiente periodo.
export async function spawnRecurring(deps: Deps, now = new Date()): Promise<number> {
  const today = todayISO(now);
  const due = all<RequestRow>(deps.db,
    `SELECT r.* FROM requests r JOIN clients c ON c.id = r.client_id
     WHERE r.recurrence != 'none' AND r.next_spawned = 0 AND r.status != 'cancelled' AND r.due_date <= ? AND c.archived_at IS NULL`, today);
  let created = 0;
  for (const r of due) {
    const nextDue = nextDueDate(r.due_date, r.recurrence)!;
    const items = all<ItemRow>(deps.db, 'SELECT * FROM request_items WHERE request_id = ? ORDER BY position', r.id);
    run(deps.db, 'UPDATE requests SET next_spawned = 1 WHERE id = ?', r.id);
    const id = createRequest(deps, {
      orgId: r.org_id, clientId: r.client_id, title: r.title, message: r.message, dueDate: nextDue,
      recurrence: r.recurrence, createdBy: r.created_by, remindersEnabled: r.reminders_enabled === 1,
      items: items.map((i) => ({ label: i.label, description: i.description, required: i.required === 1 })),
    });
    audit(deps.db, r.org_id, 'system', 'request.recurring_created', id, { from: r.id });
    await sendRequestEmail(deps, id, 'request');
    created++;
  }
  return created;
}

export async function runScheduledJobs(deps: Deps, now = new Date()) {
  const spawned = await spawnRecurring(deps, now);
  const reminders = await runReminders(deps, now);
  run(deps.db, `DELETE FROM sessions WHERE expires_at < ?`, now.toISOString());
  return { spawned, reminders };
}
