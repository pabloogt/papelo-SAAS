import { Hono } from 'hono';
import type { AppDeps, Auth, C, Env } from '../context.ts';
import { htmlResponse, mustAuth, redirectWith, str, takeFlash, viewer } from '../context.ts';
import { all, one, run, tx } from '../db.ts';
import { formatBytes, formatDate, isISODate, todayISO, addDays, daysBetween } from '../lib/dates.ts';
import { h, type SafeHtml } from '../lib/html.ts';
import { isValidEmail, newId, randomToken, sha256 } from '../lib/security.ts';
import {
  audit, createRequest, portalUrl, RECURRENCES, refreshRequestStatus, sendRequestEmail,
  type ItemInput, type ItemRow, type Recurrence, type RequestRow,
} from '../services/requests.ts';
import { appPage, csrfField, emptyState, statusBadge, type Flash } from '../views/layout.ts';

type ClientRow = { id: string; org_id: string; name: string; email: string | null; phone: string | null; tax_id: string | null; notes: string | null; archived_at: string | null; created_at: string };
type TemplateRow = { id: string; org_id: string; name: string; message: string | null; items_json: string };
type RequestListRow = RequestRow & { client_name: string; total: number; approved: number; uploaded: number };

export function parseItemsText(text: string): ItemInput[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 30).map((line) => {
    const optional = /\(opcional\)\s*$/i.test(line);
    return { label: line.replace(/\(opcional\)\s*$/i, '').trim().slice(0, 200), required: !optional };
  }).filter((i) => i.label.length > 0);
}

export function itemsToText(items: ItemInput[]): string {
  return items.map((i) => (i.required === false ? `${i.label} (opcional)` : i.label)).join('\n');
}

function requestState(r: { status: string; due_date: string }): string {
  return r.status === 'open' && r.due_date < todayISO() ? 'overdue' : r.status;
}

function dueLabel(r: { status: string; due_date: string }): SafeHtml {
  if (r.status !== 'open') return h`${formatDate(r.due_date)}`;
  const d = daysBetween(todayISO(), r.due_date);
  const rel = d === 0 ? 'hoy' : d > 0 ? `en ${d} d` : `hace ${-d} d`;
  return h`${formatDate(r.due_date)} <span class="muted small">(${rel})</span>`;
}

function progress(r: { total: number; approved: number; uploaded: number }): SafeHtml {
  const pct = r.total ? Math.round(((r.approved + r.uploaded) / r.total) * 100) : 0;
  return h`<progress class="bar" max="100" value="${pct}" title="${r.approved} aprobados, ${r.uploaded} por revisar de ${r.total}"></progress> <span class="small muted">${r.approved + r.uploaded}/${r.total}</span>`;
}

function requestTable(rows: RequestListRow[], showClient = true): SafeHtml {
  return h`<div class="table-wrap"><table class="table">
<thead><tr><th>Petición</th>${showClient ? h`<th>Cliente</th>` : ''}<th>Vence</th><th>Progreso</th><th>Estado</th></tr></thead>
<tbody>${rows.map((r) => h`<tr>
  <td><a href="/app/requests/${r.id}">${r.title}</a>${r.recurrence !== 'none' ? h` <span class="tag" title="${RECURRENCES[r.recurrence]}">↻</span>` : ''}</td>
  ${showClient ? h`<td>${r.client_name}</td>` : ''}
  <td>${dueLabel(r)}</td>
  <td class="nowrap">${progress(r)}</td>
  <td>${r.uploaded > 0 && r.status === 'open' ? statusBadge('uploaded') : statusBadge(requestState(r))}</td>
</tr>`)}</tbody></table></div>`;
}

const LIST_SQL = `SELECT r.*, c.name AS client_name,
  (SELECT COUNT(*) FROM request_items i WHERE i.request_id = r.id) AS total,
  (SELECT COUNT(*) FROM request_items i WHERE i.request_id = r.id AND i.status = 'approved') AS approved,
  (SELECT COUNT(*) FROM request_items i WHERE i.request_id = r.id AND i.status = 'uploaded') AS uploaded
  FROM requests r JOIN clients c ON c.id = r.client_id`;

function activeClientCount(deps: AppDeps, orgId: string): number {
  return one<{ n: number }>(deps.db, 'SELECT COUNT(*) AS n FROM clients WHERE org_id = ? AND archived_at IS NULL', orgId)!.n;
}

function getClient(deps: AppDeps, auth: Auth, id: string) {
  return one<ClientRow>(deps.db, 'SELECT * FROM clients WHERE id = ? AND org_id = ?', id, auth.org.id);
}

function getRequest(deps: AppDeps, auth: Auth, id: string) {
  return one<RequestRow & { client_name: string; client_email: string | null }>(deps.db,
    `SELECT r.*, c.name AS client_name, c.email AS client_email FROM requests r JOIN clients c ON c.id = r.client_id
     WHERE r.id = ? AND r.org_id = ?`, id, auth.org.id);
}

export function appRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const r = new Hono<Env>();
  const page = (c: C, active: string, title: string, body: SafeHtml, flash: Flash = takeFlash(c), status: 200 | 400 | 409 = 200) =>
    htmlResponse(c, appPage(viewer(mustAuth(c)), active, title, body, flash), status);
  const form = async (c: C) => (await c.req.parseBody({ all: true })) as Record<string, unknown>;

  // ---------- Panel ----------
  r.get('/', (c) => {
    const auth = mustAuth(c);
    const today = todayISO();
    const stats = one<any>(db, `SELECT
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status = 'open' AND due_date < ? THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN status = 'completed' AND completed_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) AS done30
      FROM requests WHERE org_id = ?`, today, auth.org.id);
    const toReview = all<RequestListRow>(db, `${LIST_SQL} WHERE r.org_id = ? AND r.status = 'open'
      AND EXISTS (SELECT 1 FROM request_items i WHERE i.request_id = r.id AND i.status = 'uploaded') ORDER BY r.due_date LIMIT 10`, auth.org.id);
    const overdue = all<RequestListRow>(db, `${LIST_SQL} WHERE r.org_id = ? AND r.status = 'open' AND r.due_date < ? ORDER BY r.due_date LIMIT 10`, auth.org.id, today);
    const upcoming = all<RequestListRow>(db, `${LIST_SQL} WHERE r.org_id = ? AND r.status = 'open' AND r.due_date >= ? AND r.due_date <= ? ORDER BY r.due_date LIMIT 10`, auth.org.id, today, addDays(today, 14));
    const clients = activeClientCount(deps, auth.org.id);
    const pendingReviewItems = one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM request_items i JOIN requests r ON r.id = i.request_id WHERE r.org_id = ? AND i.status = 'uploaded' AND r.status = 'open'`, auth.org.id)!.n;

    const onboarding = clients === 0 || (stats.open ?? 0) + (stats.done30 ?? 0) === 0;
    return page(c, 'dashboard', 'Inicio', h`
<div class="page-head"><h1>Hola, ${auth.user.name.split(' ')[0]}</h1><a class="btn" href="/app/requests/new">Nueva petición</a></div>
${onboarding ? h`<div class="card onboarding"><h2>Primeros pasos</h2><ol class="checklist">
  <li class="${clients > 0 ? 'done' : ''}"><a href="/app/clients#nuevo">Añade un cliente</a> con su email.</li>
  <li class="${(stats.open ?? 0) > 0 ? 'done' : ''}"><a href="/app/requests/new">Crea una petición</a> a partir de una plantilla.</li>
  <li>Tu cliente recibirá el enlace y los recordatorios automáticamente.</li></ol></div>` : ''}
<div class="stats">
  <a class="stat" href="/app/requests?status=open"><span class="stat-n">${stats.open ?? 0}</span><span>Abiertas</span></a>
  <a class="stat ${pendingReviewItems ? 'stat-warn' : ''}" href="/app/requests?status=review"><span class="stat-n">${pendingReviewItems}</span><span>Documentos por revisar</span></a>
  <a class="stat ${stats.overdue ? 'stat-danger' : ''}" href="/app/requests?status=overdue"><span class="stat-n">${stats.overdue ?? 0}</span><span>Vencidas</span></a>
  <a class="stat" href="/app/requests?status=completed"><span class="stat-n">${stats.done30 ?? 0}</span><span>Completadas (30 d)</span></a>
</div>
<section><h2>Por revisar</h2>${toReview.length ? requestTable(toReview) : h`<p class="muted">Nada pendiente de revisión.</p>`}</section>
<section><h2>Vencidas</h2>${overdue.length ? requestTable(overdue) : h`<p class="muted">Ninguna petición vencida. 👏</p>`}</section>
<section><h2>Vencen en los próximos 14 días</h2>${upcoming.length ? requestTable(upcoming) : h`<p class="muted">Sin vencimientos próximos.</p>`}</section>`);
  });

  // ---------- Clientes ----------
  const clientForm = (cl: Partial<ClientRow>, action: string, submit: string, csrf: string) => h`
<form method="post" action="${action}" class="grid-form">
  ${csrfField(csrf)}
  <label>Nombre o razón social *<input name="name" required maxlength="150" value="${cl.name ?? ''}"></label>
  <label>Email<input type="email" name="email" maxlength="254" value="${cl.email ?? ''}"></label>
  <label>Teléfono<input name="phone" maxlength="30" value="${cl.phone ?? ''}"></label>
  <label>NIF/CIF<input name="tax_id" maxlength="20" value="${cl.tax_id ?? ''}"></label>
  <label class="span2">Notas internas<textarea name="notes" rows="2" maxlength="2000">${cl.notes ?? ''}</textarea></label>
  <div class="span2"><button class="btn" type="submit">${submit}</button></div>
</form>`;

  const readClient = (body: Record<string, unknown>) => ({
    name: str(body, 'name', 150), email: str(body, 'email', 254).toLowerCase() || null,
    phone: str(body, 'phone', 30) || null, tax_id: str(body, 'tax_id', 20).toUpperCase() || null, notes: str(body, 'notes', 2000) || null,
  });

  const clientsPage = (c: C, flash: Flash, values: Partial<ClientRow> = {}, status: 200 | 400 | 409 = 200) => {
    const auth = mustAuth(c);
    const showArchived = c.req.query('archived') === '1';
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    const rows = all<ClientRow & { open: number }>(db, `SELECT c.*, (SELECT COUNT(*) FROM requests r WHERE r.client_id = c.id AND r.status = 'open') AS open
      FROM clients c WHERE c.org_id = ? AND (c.archived_at IS ${showArchived ? 'NOT ' : ''}NULL)
      AND (? = '' OR c.name LIKE ? OR c.email LIKE ? OR c.tax_id LIKE ?) ORDER BY c.name COLLATE NOCASE LIMIT 500`,
      auth.org.id, q, `%${q}%`, `%${q}%`, `%${q}%`);
    const count = activeClientCount(deps, auth.org.id);
    return page(c, 'clients', 'Clientes', h`
<div class="page-head"><h1>Clientes</h1><span class="muted">${count} de ${auth.plan.maxClients} activos (plan ${auth.plan.name})</span></div>
<form class="toolbar" method="get" action="/app/clients">
  <input type="search" name="q" placeholder="Buscar por nombre, email o NIF" value="${q}">
  ${showArchived ? h`<input type="hidden" name="archived" value="1">` : ''}
  <button class="btn btn-secondary" type="submit">Buscar</button>
  <a class="small" href="/app/clients${showArchived ? '' : '?archived=1'}">${showArchived ? 'Ver activos' : 'Ver archivados'}</a>
</form>
${rows.length ? h`<div class="table-wrap"><table class="table"><thead><tr><th>Cliente</th><th>Email</th><th>NIF</th><th>Abiertas</th></tr></thead><tbody>
${rows.map((cl) => h`<tr><td><a href="/app/clients/${cl.id}">${cl.name}</a></td><td>${cl.email ?? h`<span class="muted">Sin email</span>`}</td><td>${cl.tax_id ?? ''}</td><td>${cl.open}</td></tr>`)}
</tbody></table></div>` : emptyState(q ? 'Sin resultados' : 'Aún no hay clientes', q ? 'Prueba con otra búsqueda.' : 'Añade tu primer cliente con el formulario de abajo.')}
${showArchived ? '' : h`<section class="card" id="nuevo"><h2>Nuevo cliente</h2>${clientForm(values, '/app/clients', 'Añadir cliente', auth.csrf)}</section>`}`, flash, status);
  };

  r.get('/clients', (c) => clientsPage(c, takeFlash(c)));

  r.post('/clients', async (c) => {
    const auth = mustAuth(c);
    const v = readClient(await form(c));
    if (!v.name) return clientsPage(c, { type: 'error', text: 'El nombre es obligatorio.' }, v, 400);
    if (v.email && !isValidEmail(v.email)) return clientsPage(c, { type: 'error', text: 'El email no es válido.' }, v, 400);
    if (activeClientCount(deps, auth.org.id) >= auth.plan.maxClients) {
      return clientsPage(c, { type: 'error', text: `Has alcanzado el límite de ${auth.plan.maxClients} clientes activos del plan ${auth.plan.name}. Mejora tu plan o archiva clientes.` }, v, 409);
    }
    const id = newId();
    run(db, 'INSERT INTO clients (id, org_id, name, email, phone, tax_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, auth.org.id, v.name, v.email, v.phone, v.tax_id, v.notes);
    audit(db, auth.org.id, auth.user.id, 'client.created', id);
    return redirectWith(c, `/app/clients/${id}`, 'ok', 'Cliente creado.');
  });

  r.get('/clients/:id', (c) => {
    const auth = mustAuth(c);
    const cl = getClient(deps, auth, c.req.param('id'));
    if (!cl) return c.notFound();
    const reqs = all<RequestListRow>(db, `${LIST_SQL} WHERE r.org_id = ? AND r.client_id = ? ORDER BY r.created_at DESC`, auth.org.id, cl.id);
    return page(c, 'clients', cl.name, h`
<p class="crumbs"><a href="/app/clients">Clientes</a> /</p>
<div class="page-head"><h1>${cl.name} ${cl.archived_at ? statusBadge('cancelled') : ''}</h1>
  ${cl.archived_at ? '' : h`<a class="btn" href="/app/requests/new?client=${cl.id}">Nueva petición</a>`}</div>
<section><h2>Peticiones</h2>${reqs.length ? requestTable(reqs, false) : h`<p class="muted">Sin peticiones todavía.</p>`}</section>
<section class="card"><h2>Datos del cliente</h2>${clientForm(cl, `/app/clients/${cl.id}`, 'Guardar cambios', auth.csrf)}</section>
<section class="card danger-zone"><h2>Archivar o eliminar</h2>
  <p class="muted">Archivar detiene sus recordatorios y libera una plaza de tu plan, conservando el historial. Eliminar borra el cliente, sus peticiones y archivos de forma permanente.</p>
  <div class="row">
  <form method="post" action="/app/clients/${cl.id}/${cl.archived_at ? 'unarchive' : 'archive'}">${csrfField(auth.csrf)}<button class="btn btn-secondary" type="submit">${cl.archived_at ? 'Reactivar' : 'Archivar'}</button></form>
  ${auth.role === 'owner' ? h`<form method="post" action="/app/clients/${cl.id}/delete" data-confirm="¿Eliminar definitivamente a ${cl.name} y todos sus documentos? No se puede deshacer.">${csrfField(auth.csrf)}<button class="btn btn-danger" type="submit">Eliminar</button></form>` : ''}
  </div>
</section>`);
  });

  r.post('/clients/:id', async (c) => {
    const auth = mustAuth(c);
    const cl = getClient(deps, auth, c.req.param('id'));
    if (!cl) return c.notFound();
    const v = readClient(await form(c));
    if (!v.name || (v.email && !isValidEmail(v.email))) return redirectWith(c, `/app/clients/${cl.id}`, 'error', 'Revisa el nombre y el email.');
    run(db, 'UPDATE clients SET name = ?, email = ?, phone = ?, tax_id = ?, notes = ? WHERE id = ? AND org_id = ?',
      v.name, v.email, v.phone, v.tax_id, v.notes, cl.id, auth.org.id);
    audit(db, auth.org.id, auth.user.id, 'client.updated', cl.id);
    return redirectWith(c, `/app/clients/${cl.id}`, 'ok', 'Cambios guardados.');
  });

  r.post('/clients/:id/archive', (c) => {
    const auth = mustAuth(c);
    const cl = getClient(deps, auth, c.req.param('id'));
    if (!cl) return c.notFound();
    run(db, `UPDATE clients SET archived_at = datetime('now') WHERE id = ? AND org_id = ?`, cl.id, auth.org.id);
    audit(db, auth.org.id, auth.user.id, 'client.archived', cl.id);
    return redirectWith(c, `/app/clients/${cl.id}`, 'ok', 'Cliente archivado. Sus recordatorios se han detenido.');
  });

  r.post('/clients/:id/unarchive', (c) => {
    const auth = mustAuth(c);
    const cl = getClient(deps, auth, c.req.param('id'));
    if (!cl) return c.notFound();
    if (activeClientCount(deps, auth.org.id) >= auth.plan.maxClients) {
      return redirectWith(c, `/app/clients/${cl.id}`, 'error', 'Has alcanzado el límite de clientes activos de tu plan.');
    }
    run(db, 'UPDATE clients SET archived_at = NULL WHERE id = ? AND org_id = ?', cl.id, auth.org.id);
    return redirectWith(c, `/app/clients/${cl.id}`, 'ok', 'Cliente reactivado.');
  });

  r.post('/clients/:id/delete', async (c) => {
    const auth = mustAuth(c);
    if (auth.role !== 'owner') return c.text('Sólo el titular puede eliminar clientes', 403);
    const cl = getClient(deps, auth, c.req.param('id'));
    if (!cl) return c.notFound();
    const files = all<{ id: string }>(db, `SELECT f.id FROM files f JOIN request_items i ON i.id = f.item_id JOIN requests r ON r.id = i.request_id WHERE r.client_id = ?`, cl.id);
    run(db, 'DELETE FROM clients WHERE id = ? AND org_id = ?', cl.id, auth.org.id);
    for (const f of files) await deps.storage.remove(auth.org.id, f.id);
    audit(db, auth.org.id, auth.user.id, 'client.deleted', cl.id, { files: files.length });
    return redirectWith(c, '/app/clients', 'ok', `Cliente eliminado junto con ${files.length} archivo(s).`);
  });

  // ---------- Peticiones ----------
  r.get('/requests', (c) => {
    const auth = mustAuth(c);
    const status = c.req.query('status') ?? 'open';
    const today = todayISO();
    const filters: Record<string, [string, string, any[]]> = {
      open: ['Abiertas', `r.status = 'open'`, []],
      review: ['Por revisar', `r.status = 'open' AND EXISTS (SELECT 1 FROM request_items i WHERE i.request_id = r.id AND i.status = 'uploaded')`, []],
      overdue: ['Vencidas', `r.status = 'open' AND r.due_date < ?`, [today]],
      completed: ['Completadas', `r.status = 'completed'`, []],
      cancelled: ['Canceladas', `r.status = 'cancelled'`, []],
    };
    const [, where, params] = filters[status] ?? filters.open;
    const rows = all<RequestListRow>(db, `${LIST_SQL} WHERE r.org_id = ? AND ${where} ORDER BY ${status === 'completed' ? 'r.completed_at DESC' : 'r.due_date'} LIMIT 300`, auth.org.id, ...params);
    return page(c, 'requests', 'Peticiones', h`
<div class="page-head"><h1>Peticiones</h1><a class="btn" href="/app/requests/new">Nueva petición</a></div>
<nav class="tabs">${Object.entries(filters).map(([k, [label]]) => h`<a href="/app/requests?status=${k}" class="${k === status ? 'active' : ''}">${label}</a>`)}</nav>
${rows.length ? requestTable(rows) : emptyState('No hay peticiones aquí', 'Crea una petición para empezar a recibir documentos.', h`<a class="btn" href="/app/requests/new">Nueva petición</a>`)}`);
  });

  const newRequestPage = (c: C, flash: Flash, values: Record<string, string> = {}, status: 200 | 400 | 409 = 200) => {
    const auth = mustAuth(c);
    const clients = all<ClientRow>(db, 'SELECT * FROM clients WHERE org_id = ? AND archived_at IS NULL ORDER BY name COLLATE NOCASE', auth.org.id);
    const templates = all<TemplateRow>(db, 'SELECT * FROM templates WHERE org_id = ? ORDER BY name', auth.org.id);
    const tplId = values.template ?? c.req.query('template') ?? '';
    const tpl = templates.find((t) => t.id === tplId);
    const clientId = values.client_id ?? c.req.query('client') ?? '';
    const canRecur = auth.plan.id !== 'free';
    if (clients.length === 0) {
      return page(c, 'requests', 'Nueva petición', h`<h1>Nueva petición</h1>${emptyState('Primero añade un cliente', 'Las peticiones se envían a un cliente.', h`<a class="btn" href="/app/clients#nuevo">Añadir cliente</a>`)}`, flash, status);
    }
    return page(c, 'requests', 'Nueva petición', h`
<p class="crumbs"><a href="/app/requests">Peticiones</a> /</p>
<h1>Nueva petición</h1>
<form method="get" action="/app/requests/new" class="toolbar" data-autosubmit>
  <label class="inline">Partir de plantilla
    <select name="template"><option value="">— En blanco —</option>${templates.map((t) => h`<option value="${t.id}" ${t.id === tplId ? 'selected' : ''}>${t.name}</option>`)}</select></label>
  ${clientId ? h`<input type="hidden" name="client" value="${clientId}">` : ''}
  <button class="btn btn-secondary btn-sm js-hide" type="submit">Cargar</button>
</form>
<form method="post" action="/app/requests" class="card grid-form">
  ${csrfField(auth.csrf)}
  <label>Cliente *<select name="client_id" required><option value="">Selecciona…</option>
    ${clients.map((cl) => h`<option value="${cl.id}" ${cl.id === clientId ? 'selected' : ''}>${cl.name}${cl.email ? '' : ' (sin email)'}</option>`)}</select></label>
  <label>Fecha límite *<input type="date" name="due_date" required min="${todayISO()}" value="${values.due_date ?? addDays(todayISO(), 10)}"></label>
  <label class="span2">Título *<input name="title" required maxlength="150" value="${values.title ?? (tpl ? tpl.name : '')}" placeholder="p. ej. IVA 4T 2026"></label>
  <label class="span2">Mensaje para el cliente<textarea name="message" rows="3" maxlength="2000">${values.message ?? tpl?.message ?? ''}</textarea></label>
  <label class="span2">Documentos que necesitas *<textarea name="items" rows="7" required maxlength="6000" placeholder="Un documento por línea. Añade (opcional) al final si no es obligatorio.">${values.items ?? (tpl ? itemsToText(JSON.parse(tpl.items_json)) : '')}</textarea>
    <span class="hint">Un documento por línea. Escribe <code>(opcional)</code> al final para los no obligatorios.</span></label>
  <label>Repetición<select name="recurrence" ${canRecur ? '' : 'disabled'}>${(Object.keys(RECURRENCES) as Recurrence[]).map((k) => h`<option value="${k}" ${values.recurrence === k ? 'selected' : ''}>${RECURRENCES[k]}</option>`)}</select>
    ${canRecur ? h`<span class="hint">Se creará automáticamente la del siguiente periodo al llegar la fecha límite.</span>` : h`<span class="hint">Las peticiones recurrentes están disponibles en el plan Profesional. <a href="/app/billing">Mejorar</a></span>`}</label>
  <label class="check"><input type="checkbox" name="reminders" value="1" ${values.reminders === '0' ? '' : 'checked'}> Enviar recordatorios automáticos (7 y 2 días antes, el día del vencimiento y después)</label>
  <label class="check span2"><input type="checkbox" name="send_now" value="1" checked> Enviar ya el email al cliente con el enlace</label>
  <div class="span2"><button class="btn" type="submit">Crear petición</button></div>
</form>`, flash, status);
  };

  r.get('/requests/new', (c) => newRequestPage(c, takeFlash(c)));

  r.post('/requests', async (c) => {
    const auth = mustAuth(c);
    const body = await form(c);
    const values = {
      client_id: str(body, 'client_id', 40), title: str(body, 'title', 150), message: str(body, 'message', 2000),
      items: str(body, 'items', 6000), due_date: str(body, 'due_date', 10), recurrence: str(body, 'recurrence', 20) || 'none',
      reminders: body.reminders === '1' ? '1' : '0',
    };
    const fail = (text: string) => newRequestPage(c, { type: 'error', text }, values, 400);
    const client = getClient(deps, auth, values.client_id);
    if (!client || client.archived_at) return fail('Selecciona un cliente válido.');
    if (!values.title) return fail('El título es obligatorio.');
    if (!isISODate(values.due_date)) return fail('La fecha límite no es válida.');
    if (!(values.recurrence in RECURRENCES)) return fail('Repetición no válida.');
    if (values.recurrence !== 'none' && auth.plan.id === 'free') return fail('Las peticiones recurrentes requieren el plan Profesional.');
    const items = parseItemsText(values.items);
    if (items.length === 0) return fail('Añade al menos un documento.');
    const id = createRequest(deps, {
      orgId: auth.org.id, clientId: client.id, title: values.title, message: values.message || null, dueDate: values.due_date,
      recurrence: values.recurrence as Recurrence, items, createdBy: auth.user.id, remindersEnabled: values.reminders === '1',
    });
    audit(db, auth.org.id, auth.user.id, 'request.created', id);
    let msg = 'Petición creada.';
    if (body.send_now === '1') {
      msg = (await sendRequestEmail(deps, id, 'request'))
        ? `Petición creada y enviada a ${client.email}.`
        : 'Petición creada. El cliente no tiene email: copia el enlace y envíaselo tú.';
    }
    return redirectWith(c, `/app/requests/${id}`, 'ok', msg);
  });

  r.get('/requests/:id', (c) => {
    const auth = mustAuth(c);
    const req = getRequest(deps, auth, c.req.param('id'));
    if (!req) return c.notFound();
    const items = all<ItemRow>(db, 'SELECT * FROM request_items WHERE request_id = ? ORDER BY position', req.id);
    const files = all<{ id: string; item_id: string; original_name: string; size: number; uploaded_at: string }>(db,
      `SELECT f.id, f.item_id, f.original_name, f.size, f.uploaded_at FROM files f JOIN request_items i ON i.id = f.item_id
       WHERE i.request_id = ? AND f.org_id = ? ORDER BY f.uploaded_at`, req.id, auth.org.id);
    const emails = all<{ kind: string; created_at: string; status: string }>(db,
      'SELECT kind, created_at, status FROM emails WHERE request_id = ? AND org_id = ? ORDER BY created_at DESC LIMIT 20', req.id, auth.org.id);
    const link = portalUrl(config, req);
    const isOpen = req.status === 'open';
    return page(c, 'requests', req.title, h`
<p class="crumbs"><a href="/app/requests">Peticiones</a> / <a href="/app/clients/${req.client_id}">${req.client_name}</a> /</p>
<div class="page-head"><h1>${req.title} ${statusBadge(requestState(req))}</h1></div>
<div class="meta-grid">
  <div><span class="muted small">Vence</span><div>${dueLabel(req)}</div></div>
  <div><span class="muted small">Repetición</span><div>${RECURRENCES[req.recurrence]}</div></div>
  <div><span class="muted small">Recordatorios</span><div>${req.reminders_enabled ? `${req.reminders_sent} enviados` : 'Desactivados'}</div></div>
  <div><span class="muted small">Cliente</span><div>${req.client_email ?? 'Sin email'}</div></div>
</div>
${isOpen ? h`<div class="card link-box">
  <label for="portal-link">Enlace seguro para el cliente</label>
  <div class="copy-row"><input id="portal-link" readonly value="${link}"><button class="btn btn-secondary" type="button" data-copy="#portal-link">Copiar</button></div>
  <div class="row">
    <form method="post" action="/app/requests/${req.id}/remind">${csrfField(auth.csrf)}<button class="btn btn-sm" type="submit" ${req.client_email ? '' : 'disabled'}>Enviar recordatorio ahora</button></form>
    <form method="post" action="/app/requests/${req.id}/regenerate-link" data-confirm="El enlace actual dejará de funcionar. ¿Continuar?">${csrfField(auth.csrf)}<button class="btn btn-sm btn-secondary" type="submit">Revocar y generar nuevo enlace</button></form>
  </div>
</div>` : ''}
${req.message ? h`<p class="message-quote">${req.message}</p>` : ''}
<section><h2>Documentos</h2>
<ul class="items">
${items.map((it) => {
  const itFiles = files.filter((f) => f.item_id === it.id);
  return h`<li class="item item-${it.status}">
  <div class="item-head"><div><strong>${it.label}</strong> ${it.required ? '' : h`<span class="tag">opcional</span>`}</div>${statusBadge(it.status)}</div>
  ${it.status === 'rejected' && it.reject_reason ? h`<p class="small danger-text">Motivo: ${it.reject_reason}</p>` : ''}
  ${itFiles.length ? h`<ul class="files">${itFiles.map((f) => h`<li><a href="/app/files/${f.id}">${f.original_name}</a> <span class="muted small">${formatBytes(f.size)} · ${f.uploaded_at.slice(0, 16)}</span></li>`)}</ul>` : h`<p class="muted small">Sin archivos.</p>`}
  ${isOpen && (it.status === 'uploaded' || it.status === 'approved' || it.status === 'rejected') ? h`<div class="row review">
    ${it.status !== 'approved' && itFiles.length ? h`<form method="post" action="/app/requests/${req.id}/items/${it.id}/review">${csrfField(auth.csrf)}<input type="hidden" name="action" value="approve"><button class="btn btn-sm btn-success" type="submit">Aprobar</button></form>` : ''}
    ${it.status !== 'rejected' ? h`<form method="post" action="/app/requests/${req.id}/items/${it.id}/review" class="reject-form">${csrfField(auth.csrf)}<input type="hidden" name="action" value="reject"><input name="reason" maxlength="300" placeholder="Motivo (p. ej. foto ilegible)" required><button class="btn btn-sm btn-danger" type="submit">Pedir de nuevo</button></form>` : ''}
  </div>` : ''}
  ${isOpen && it.status === 'pending' ? h`<form method="post" action="/app/requests/${req.id}/items/${it.id}/review" class="row">${csrfField(auth.csrf)}<input type="hidden" name="action" value="approve"><button class="link-btn small" type="submit">Marcar como recibido por otra vía</button></form>` : ''}
</li>`;
})}
</ul></section>
<section class="row">
  ${isOpen ? h`<form method="post" action="/app/requests/${req.id}/cancel" data-confirm="¿Cancelar la petición? Se detendrán los recordatorios${req.recurrence !== 'none' ? ' y la repetición' : ''}.">${csrfField(auth.csrf)}<button class="btn btn-secondary" type="submit">Cancelar petición</button></form>` : ''}
  ${req.status === 'cancelled' ? h`<form method="post" action="/app/requests/${req.id}/reopen">${csrfField(auth.csrf)}<button class="btn btn-secondary" type="submit">Reabrir</button></form>` : ''}
</section>
<section><h2>Historial de envíos</h2>${emails.length ? h`<ul class="timeline">${emails.map((e) => h`<li>${e.kind === 'request' ? 'Solicitud enviada' : e.kind === 'reminder' ? 'Recordatorio enviado' : e.kind} · ${e.created_at.slice(0, 16)} ${e.status === 'failed' ? h`<span class="badge badge-danger">fallo</span>` : ''}</li>`)}</ul>` : h`<p class="muted small">No se ha enviado ningún email.</p>`}</section>`);
  });

  r.post('/requests/:id/items/:itemId/review', async (c) => {
    const auth = mustAuth(c);
    const req = getRequest(deps, auth, c.req.param('id'));
    if (!req) return c.notFound();
    const item = one<ItemRow>(db, 'SELECT * FROM request_items WHERE id = ? AND request_id = ?', c.req.param('itemId'), req.id);
    if (!item) return c.notFound();
    const body = await form(c);
    const action = str(body, 'action', 10);
    if (action === 'approve') {
      run(db, `UPDATE request_items SET status = 'approved', reject_reason = NULL, updated_at = datetime('now') WHERE id = ?`, item.id);
    } else if (action === 'reject') {
      const reason = str(body, 'reason', 300) || 'Documento no válido';
      run(db, `UPDATE request_items SET status = 'rejected', reject_reason = ?, updated_at = datetime('now') WHERE id = ?`, reason, item.id);
    } else return c.text('Acción no válida', 400);
    refreshRequestStatus(db, req.id);
    audit(db, auth.org.id, auth.user.id, `item.${action}`, item.id);
    const updated = getRequest(deps, auth, req.id)!;
    if (action === 'reject' && req.client_email) await sendRequestEmail(deps, req.id, 'reminder');
    return redirectWith(c, `/app/requests/${req.id}`, 'ok',
      updated.status === 'completed' ? '¡Petición completada! Todos los documentos obligatorios están aprobados.'
        : action === 'approve' ? 'Documento aprobado.' : 'Documento rechazado. Hemos avisado al cliente.');
  });

  r.post('/requests/:id/remind', async (c) => {
    const auth = mustAuth(c);
    const req = getRequest(deps, auth, c.req.param('id'));
    if (!req) return c.notFound();
    const sent = await sendRequestEmail(deps, req.id, 'reminder');
    if (sent) {
      run(db, 'UPDATE requests SET last_reminder_at = ? WHERE id = ?', new Date().toISOString(), req.id);
      audit(db, auth.org.id, auth.user.id, 'request.manual_reminder', req.id);
    }
    return redirectWith(c, `/app/requests/${req.id}`, sent ? 'ok' : 'error', sent ? 'Recordatorio enviado.' : 'No hay nada pendiente o el cliente no tiene email.');
  });

  r.post('/requests/:id/regenerate-link', (c) => {
    const auth = mustAuth(c);
    const req = getRequest(deps, auth, c.req.param('id'));
    if (!req) return c.notFound();
    run(db, 'UPDATE requests SET link_nonce = ? WHERE id = ?', randomToken(12), req.id);
    audit(db, auth.org.id, auth.user.id, 'request.link_rotated', req.id);
    return redirectWith(c, `/app/requests/${req.id}`, 'ok', 'Enlace regenerado. El anterior ya no funciona.');
  });

  r.post('/requests/:id/cancel', (c) => {
    const auth = mustAuth(c);
    const req = getRequest(deps, auth, c.req.param('id'));
    if (!req) return c.notFound();
    run(db, `UPDATE requests SET status = 'cancelled' WHERE id = ?`, req.id);
    audit(db, auth.org.id, auth.user.id, 'request.cancelled', req.id);
    return redirectWith(c, `/app/requests/${req.id}`, 'ok', 'Petición cancelada.');
  });

  r.post('/requests/:id/reopen', (c) => {
    const auth = mustAuth(c);
    const req = getRequest(deps, auth, c.req.param('id'));
    if (!req) return c.notFound();
    run(db, `UPDATE requests SET status = 'open' WHERE id = ?`, req.id);
    refreshRequestStatus(db, req.id);
    return redirectWith(c, `/app/requests/${req.id}`, 'ok', 'Petición reabierta.');
  });

  r.get('/files/:id', async (c) => {
    const auth = mustAuth(c);
    const f = one<{ id: string; original_name: string; mime: string }>(db, 'SELECT id, original_name, mime FROM files WHERE id = ? AND org_id = ?', c.req.param('id'), auth.org.id);
    if (!f) return c.notFound();
    const data = await deps.storage.get(auth.org.id, f.id);
    audit(db, auth.org.id, auth.user.id, 'file.downloaded', f.id);
    const ascii = f.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': f.mime,
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.original_name)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  });

  // ---------- Plantillas ----------
  r.get('/templates', (c) => {
    const auth = mustAuth(c);
    const rows = all<TemplateRow>(db, 'SELECT * FROM templates WHERE org_id = ? ORDER BY name', auth.org.id);
    return page(c, 'templates', 'Plantillas', h`
<div class="page-head"><h1>Plantillas</h1><a class="btn" href="/app/templates/new">Nueva plantilla</a></div>
<p class="muted">Listas de documentos reutilizables para crear peticiones en segundos.</p>
${rows.length ? h`<div class="grid3">${rows.map((t) => {
  const items = JSON.parse(t.items_json) as ItemInput[];
  return h`<div class="card"><h3><a href="/app/templates/${t.id}">${t.name}</a></h3><p class="muted small">${items.length} documentos</p>
  <a class="small" href="/app/requests/new?template=${t.id}">Usar plantilla →</a></div>`;
})}</div>` : emptyState('Sin plantillas', 'Crea una plantilla para tus peticiones habituales.')}`);
  });

  const templateForm = (c: C, t: Partial<TemplateRow> & { itemsText?: string }, flash: Flash, status: 200 | 400 = 200) => {
    const auth = mustAuth(c);
    const isNew = !t.id;
    return page(c, 'templates', isNew ? 'Nueva plantilla' : t.name!, h`
<p class="crumbs"><a href="/app/templates">Plantillas</a> /</p>
<h1>${isNew ? 'Nueva plantilla' : t.name}</h1>
<form method="post" action="${isNew ? '/app/templates' : `/app/templates/${t.id}`}" class="card grid-form">
  ${csrfField(auth.csrf)}
  <label class="span2">Nombre *<input name="name" required maxlength="120" value="${t.name ?? ''}"></label>
  <label class="span2">Mensaje por defecto<textarea name="message" rows="3" maxlength="2000">${t.message ?? ''}</textarea></label>
  <label class="span2">Documentos *<textarea name="items" rows="8" required maxlength="6000">${t.itemsText ?? (t.items_json ? itemsToText(JSON.parse(t.items_json)) : '')}</textarea>
  <span class="hint">Un documento por línea. Añade <code>(opcional)</code> al final si no es obligatorio.</span></label>
  <div class="span2"><button class="btn" type="submit">Guardar</button></div>
</form>
${isNew ? '' : h`<form method="post" action="/app/templates/${t.id}/delete" data-confirm="¿Eliminar esta plantilla?">${csrfField(auth.csrf)}<button class="btn btn-secondary" type="submit">Eliminar plantilla</button></form>`}`, flash, status);
  };

  const readTemplate = async (c: C) => {
    const body = await form(c);
    return { name: str(body, 'name', 120), message: str(body, 'message', 2000), itemsText: str(body, 'items', 6000) };
  };

  r.get('/templates/new', (c) => templateForm(c, {}, takeFlash(c)));
  r.post('/templates', async (c) => {
    const auth = mustAuth(c);
    const v = await readTemplate(c);
    const items = parseItemsText(v.itemsText);
    if (!v.name || items.length === 0) return templateForm(c, v, { type: 'error', text: 'Indica nombre y al menos un documento.' }, 400);
    if (auth.plan.id === 'free' && one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM templates WHERE org_id = ?', auth.org.id)!.n >= 6) {
      return templateForm(c, v, { type: 'error', text: 'El plan Gratis permite hasta 6 plantillas. Mejora a Profesional para tener ilimitadas.' }, 400);
    }
    run(db, 'INSERT INTO templates (id, org_id, name, message, items_json) VALUES (?, ?, ?, ?, ?)', newId(), auth.org.id, v.name, v.message || null, JSON.stringify(items));
    return redirectWith(c, '/app/templates', 'ok', 'Plantilla creada.');
  });
  r.get('/templates/:id', (c) => {
    const auth = mustAuth(c);
    const t = one<TemplateRow>(db, 'SELECT * FROM templates WHERE id = ? AND org_id = ?', c.req.param('id'), auth.org.id);
    return t ? templateForm(c, t, takeFlash(c)) : c.notFound();
  });
  r.post('/templates/:id', async (c) => {
    const auth = mustAuth(c);
    const t = one<TemplateRow>(db, 'SELECT * FROM templates WHERE id = ? AND org_id = ?', c.req.param('id'), auth.org.id);
    if (!t) return c.notFound();
    const v = await readTemplate(c);
    const items = parseItemsText(v.itemsText);
    if (!v.name || items.length === 0) return templateForm(c, { ...t, ...v }, { type: 'error', text: 'Indica nombre y al menos un documento.' }, 400);
    run(db, 'UPDATE templates SET name = ?, message = ?, items_json = ? WHERE id = ? AND org_id = ?', v.name, v.message || null, JSON.stringify(items), t.id, auth.org.id);
    return redirectWith(c, '/app/templates', 'ok', 'Plantilla guardada.');
  });
  r.post('/templates/:id/delete', (c) => {
    const auth = mustAuth(c);
    run(db, 'DELETE FROM templates WHERE id = ? AND org_id = ?', c.req.param('id'), auth.org.id);
    return redirectWith(c, '/app/templates', 'ok', 'Plantilla eliminada.');
  });

  // ---------- Ajustes, equipo y RGPD ----------
  r.get('/settings', (c) => {
    const auth = mustAuth(c);
    const members = all<{ id: string; name: string; email: string; role: string }>(db,
      'SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.created_at', auth.org.id);
    const invites = all<{ id: string; email: string; expires_at: string }>(db,
      'SELECT id, email, expires_at FROM invitations WHERE org_id = ? AND accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC', auth.org.id, new Date().toISOString());
    const isOwner = auth.role === 'owner';
    return page(c, 'settings', 'Ajustes', h`
<h1>Ajustes</h1>
<section class="card"><h2>Despacho</h2>
<form method="post" action="/app/settings" class="grid-form">${csrfField(auth.csrf)}
  <label>Nombre visible para tus clientes<input name="name" required maxlength="120" value="${auth.org.name}" ${isOwner ? '' : 'disabled'}></label>
  <label>Email de respuesta (reply-to)<input type="email" name="reply_to" maxlength="254" value="${auth.org.reply_to ?? ''}" ${isOwner ? '' : 'disabled'}></label>
  ${isOwner ? h`<div class="span2"><button class="btn" type="submit">Guardar</button></div>` : ''}
</form></section>
<section class="card"><h2>Equipo</h2><p class="muted small">${members.length} de ${auth.plan.maxMembers} usuarios del plan ${auth.plan.name}.</p>
<ul class="members">${members.map((m) => h`<li><span><strong>${m.name}</strong> · ${m.email} <span class="tag">${m.role === 'owner' ? 'Titular' : 'Miembro'}</span></span>
  ${isOwner && m.role !== 'owner' ? h`<form method="post" action="/app/settings/members/${m.id}/remove" data-confirm="¿Quitar a ${m.name} del despacho?">${csrfField(auth.csrf)}<button class="link-btn small danger-text" type="submit">Quitar</button></form>` : ''}</li>`)}
  ${invites.map((i) => h`<li><span>${i.email} <span class="tag">Invitación pendiente</span></span></li>`)}</ul>
${isOwner ? h`<form method="post" action="/app/settings/invite" class="toolbar">${csrfField(auth.csrf)}<input type="email" name="email" required placeholder="email@despacho.es"><button class="btn btn-secondary" type="submit">Invitar</button></form>` : ''}
</section>
<section class="card"><h2>Tus datos (RGPD)</h2>
<p class="muted small">Descarga una copia de todos los datos del despacho en JSON (clientes, peticiones, registro de actividad). Los archivos se descargan desde cada petición.</p>
<a class="btn btn-secondary" href="/app/settings/export">Exportar datos</a></section>
${isOwner ? h`<section class="card danger-zone"><h2>Eliminar cuenta</h2>
<p class="muted small">Borra el despacho, todos sus clientes, peticiones y archivos de forma permanente. Si tienes una suscripción, cancélala antes en Plan y pagos.</p>
<form method="post" action="/app/settings/delete" class="toolbar" data-confirm="Esta acción es irreversible. ¿Eliminar todo?">${csrfField(auth.csrf)}
  <input name="confirm" required placeholder="Escribe el nombre del despacho"><button class="btn btn-danger" type="submit">Eliminar todo</button></form></section>` : ''}`);
  });

  r.post('/settings', async (c) => {
    const auth = mustAuth(c);
    if (auth.role !== 'owner') return c.text('Sólo el titular puede cambiar los ajustes', 403);
    const body = await form(c);
    const name = str(body, 'name', 120);
    const replyTo = str(body, 'reply_to', 254).toLowerCase();
    if (!name || (replyTo && !isValidEmail(replyTo))) return redirectWith(c, '/app/settings', 'error', 'Revisa el nombre y el email.');
    run(db, 'UPDATE organizations SET name = ?, reply_to = ? WHERE id = ?', name, replyTo || null, auth.org.id);
    return redirectWith(c, '/app/settings', 'ok', 'Ajustes guardados.');
  });

  r.post('/settings/invite', async (c) => {
    const auth = mustAuth(c);
    if (auth.role !== 'owner') return c.text('Sólo el titular puede invitar', 403);
    const email = str(await form(c), 'email', 254).toLowerCase();
    if (!isValidEmail(email)) return redirectWith(c, '/app/settings', 'error', 'Email no válido.');
    const members = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?', auth.org.id)!.n;
    if (members >= auth.plan.maxMembers) return redirectWith(c, '/app/settings', 'error', `Tu plan ${auth.plan.name} permite ${auth.plan.maxMembers} usuario(s). Mejora tu plan para invitar a más.`);
    if (one(db, 'SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ?', auth.org.id, email)) {
      return redirectWith(c, '/app/settings', 'error', 'Esa persona ya forma parte del despacho.');
    }
    const token = randomToken(32);
    run(db, 'INSERT INTO invitations (id, org_id, email, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      newId(), auth.org.id, email, sha256(token), auth.user.id, new Date(Date.now() + 7 * 86400000).toISOString());
    await deps.mailer.send({
      to: email, kind: 'invite', orgId: auth.org.id,
      subject: `${auth.user.name} te invita a ${auth.org.name} en Papelo`,
      text: `Hola,\n\n${auth.user.name} te ha invitado a unirte a ${auth.org.name} en Papelo.\n\nAcepta la invitación (válida 7 días):\n${config.appUrl}/invite/${token}\n`,
    });
    audit(db, auth.org.id, auth.user.id, 'member.invited', null, { email });
    return redirectWith(c, '/app/settings', 'ok', `Invitación enviada a ${email}.`);
  });

  r.post('/settings/members/:userId/remove', (c) => {
    const auth = mustAuth(c);
    if (auth.role !== 'owner') return c.text('Sólo el titular puede quitar miembros', 403);
    const userId = c.req.param('userId');
    run(db, `DELETE FROM memberships WHERE org_id = ? AND user_id = ? AND role != 'owner'`, auth.org.id, userId);
    run(db, 'DELETE FROM sessions WHERE org_id = ? AND user_id = ?', auth.org.id, userId);
    audit(db, auth.org.id, auth.user.id, 'member.removed', userId);
    return redirectWith(c, '/app/settings', 'ok', 'Miembro eliminado del despacho.');
  });

  r.get('/settings/export', (c) => {
    const auth = mustAuth(c);
    const id = auth.org.id;
    const data = {
      exported_at: new Date().toISOString(),
      organization: one(db, 'SELECT id, name, reply_to, plan, created_at FROM organizations WHERE id = ?', id),
      members: all(db, 'SELECT u.name, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?', id),
      clients: all(db, 'SELECT * FROM clients WHERE org_id = ?', id),
      templates: all(db, 'SELECT * FROM templates WHERE org_id = ?', id),
      requests: all(db, 'SELECT id, client_id, title, message, due_date, status, recurrence, reminders_sent, created_at, completed_at FROM requests WHERE org_id = ?', id),
      items: all(db, 'SELECT i.* FROM request_items i JOIN requests r ON r.id = i.request_id WHERE r.org_id = ?', id),
      files: all(db, 'SELECT id, item_id, original_name, mime, size, sha256, uploaded_at FROM files WHERE org_id = ?', id),
      audit_log: all(db, 'SELECT actor, action, entity_id, meta, created_at FROM audit_log WHERE org_id = ? ORDER BY id', id),
    };
    audit(db, id, auth.user.id, 'org.exported');
    c.header('Content-Disposition', `attachment; filename="papelo-export-${todayISO()}.json"`);
    return c.json(data);
  });

  r.post('/settings/delete', async (c) => {
    const auth = mustAuth(c);
    if (auth.role !== 'owner') return c.text('Sólo el titular puede eliminar la cuenta', 403);
    if (str(await form(c), 'confirm', 120) !== auth.org.name) return redirectWith(c, '/app/settings', 'error', 'El nombre no coincide.');
    if (auth.org.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(auth.org.subscription_status ?? '')) {
      return redirectWith(c, '/app/settings', 'error', 'Cancela primero tu suscripción en Plan y pagos.');
    }
    tx(db, () => {
      // Usuarios que sólo pertenecían a este despacho se eliminan también.
      const soloUsers = all<{ user_id: string }>(db, `SELECT user_id FROM memberships WHERE org_id = ? AND user_id NOT IN
        (SELECT user_id FROM memberships WHERE org_id != ?)`, auth.org.id, auth.org.id);
      run(db, 'DELETE FROM organizations WHERE id = ?', auth.org.id);
      for (const u of soloUsers) run(db, 'DELETE FROM users WHERE id = ?', u.user_id);
    });
    await deps.storage.removeOrg(auth.org.id);
    return c.redirect('/', 303);
  });

  return r;
}
