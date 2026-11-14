import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppDeps, C, Env } from '../context.ts';
import { clientIp, htmlResponse } from '../context.ts';
import { all, one, run } from '../db.ts';
import { formatBytes, formatDate, todayISO } from '../lib/dates.ts';
import { h } from '../lib/html.ts';
import { newId, RateLimiter, sha256, verifyPortalToken } from '../lib/security.ts';
import { effectivePlan } from '../services/plans.ts';
import { audit, type ItemRow, type RequestRow } from '../services/requests.ts';
import { sanitizeFilename, validateUpload } from '../services/storage.ts';
import { portalShell, statusBadge } from '../views/layout.ts';

const MAX_FILES_PER_UPLOAD = 10;

type PortalRequest = RequestRow & { client_name: string; org_name: string; org_plan: string; subscription_status: string | null; reply_to: string | null };

export function portalRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const r = new Hono<Env>();
  const limiter = new RateLimiter(120, 60 * 60 * 1000);
  const badTokenLimiter = new RateLimiter(30, 60 * 60 * 1000);

  const load = (c: C): PortalRequest | null => {
    const { id, token } = c.req.param() as { id: string; token: string };
    if (!/^[0-9a-f-]{36}$/.test(id) || !token || token.length > 64) return null;
    const req = one<PortalRequest>(db,
      `SELECT r.*, c.name AS client_name, o.name AS org_name, o.plan AS org_plan, o.subscription_status, o.reply_to
       FROM requests r JOIN clients c ON c.id = r.client_id JOIN organizations o ON o.id = r.org_id
       WHERE r.id = ? AND c.archived_at IS NULL`, id);
    if (!req || !verifyPortalToken(config.appSecret, req.id, req.link_nonce, token)) return null;
    return req;
  };

  const notFound = (c: C) => {
    badTokenLimiter.check(clientIp(c, config.trustProxy));
    return htmlResponse(c, portalShell('Enlace no válido', h`<div class="card center"><h1>Enlace no válido o caducado</h1>
<p>Este enlace ya no funciona. Pide a tu gestoría que te envíe uno nuevo.</p></div>`), 404);
  };

  const render = (c: C, req: PortalRequest, notice: { type: 'ok' | 'error'; text: string } | null = null, status: 200 | 400 | 413 = 200) => {
    const items = all<ItemRow>(db, 'SELECT * FROM request_items WHERE request_id = ? ORDER BY position', req.id);
    const files = all<{ item_id: string; original_name: string; size: number }>(db,
      `SELECT f.item_id, f.original_name, f.size FROM files f JOIN request_items i ON i.id = f.item_id WHERE i.request_id = ? ORDER BY f.uploaded_at`, req.id);
    const pending = items.filter((i) => i.status === 'pending' || i.status === 'rejected');
    const requiredPending = pending.filter((i) => i.required).length;
    const base = c.req.path.replace(/\/items\/.*$/, '');
    const closed = req.status !== 'open';
    return htmlResponse(c, portalShell(req.title, h`
<header class="portal-head">
  <p class="eyebrow">${req.org_name}</p>
  <h1>${req.title}</h1>
  <p>Hola ${req.client_name}. ${closed ? '' : h`Sube aquí los documentos que te pedimos. Fecha límite: <strong>${formatDate(req.due_date)}</strong>${req.due_date < todayISO() ? h` <span class="badge badge-danger">Vencida</span>` : ''}.`}</p>
  ${req.message && !closed ? h`<p class="message-quote">${req.message}</p>` : ''}
</header>
${notice ? h`<div class="flash flash-${notice.type}" role="status">${notice.text}</div>` : ''}
${closed ? h`<div class="card center"><h2>${req.status === 'completed' ? '¡Todo recibido, gracias!' : 'Esta solicitud está cerrada'}</h2><p class="muted">No tienes que hacer nada más.</p></div>` : h`
<div class="portal-progress ${requiredPending === 0 ? 'done' : ''}">${requiredPending === 0
  ? 'Ya has enviado todo lo obligatorio. Tu gestoría lo revisará y te avisará si falta algo.'
  : `Te faltan ${requiredPending} documento(s) obligatorio(s).`}</div>
<ul class="items portal-items">
${items.map((it) => {
  const itFiles = files.filter((f) => f.item_id === it.id);
  const canUpload = it.status !== 'approved';
  return h`<li class="item item-${it.status}" id="item-${it.id}">
  <div class="item-head"><div><strong>${it.label}</strong> ${it.required ? '' : h`<span class="tag">opcional</span>`}</div>${statusBadge(it.status === 'uploaded' ? 'uploaded-client' : it.status)}</div>
  ${it.status === 'rejected' ? h`<p class="small danger-text">Tu gestoría necesita que lo envíes de nuevo: ${it.reject_reason ?? ''}</p>` : ''}
  ${itFiles.length ? h`<ul class="files">${itFiles.map((f) => h`<li>✓ ${f.original_name} <span class="muted small">${formatBytes(f.size)}</span></li>`)}</ul>` : ''}
  ${canUpload ? h`<form method="post" action="${base}/items/${it.id}" enctype="multipart/form-data" class="upload-form">
    <label class="file-drop"><input type="file" name="files" multiple required accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.xlsx,.xls,.csv,.doc,.docx,.odt,.ods,.txt,.xml,.zip">
      <span>${itFiles.length ? 'Añadir más archivos' : 'Elegir archivos o hacer foto'}</span></label>
    <button class="btn btn-sm" type="submit">Subir</button>
  </form>` : ''}
</li>`;
})}
</ul>
<p class="muted small center">Máx. ${formatBytes(config.maxUploadBytes)} por archivo · PDF, imágenes, Excel, Word, CSV, XML o ZIP · Conexión cifrada${req.reply_to ? h` · ¿Dudas? <a href="mailto:${req.reply_to}">${req.reply_to}</a>` : ''}</p>`}`), status);
  };

  r.get('/p/:id/:token', (c) => {
    const req = load(c);
    if (!req) return notFound(c);
    c.header('Cache-Control', 'no-store');
    c.header('X-Robots-Tag', 'noindex');
    return render(c, req);
  });

  r.post('/p/:id/:token/items/:itemId',
    bodyLimit({ maxSize: config.maxUploadBytes * 3 + 1024 * 1024, onError: (c) => c.text('El envío es demasiado grande. Sube los archivos de uno en uno.', 413) }),
    async (c) => {
      const req = load(c);
      if (!req) return notFound(c);
      if (!limiter.check(`portal:${req.id}`) || !limiter.check(`ip:${clientIp(c, config.trustProxy)}`)) {
        return render(c, req, { type: 'error', text: 'Demasiadas subidas en poco tiempo. Inténtalo más tarde.' }, 400);
      }
      if (req.status !== 'open') return render(c, req, { type: 'error', text: 'Esta solicitud ya está cerrada.' }, 400);
      const item = one<ItemRow>(db, 'SELECT * FROM request_items WHERE id = ? AND request_id = ?', c.req.param('itemId'), req.id);
      if (!item) return notFound(c);
      if (item.status === 'approved') return render(c, req, { type: 'error', text: 'Este documento ya está aprobado.' }, 400);

      const body = await c.req.parseBody({ all: true });
      const raw = body.files;
      const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => typeof f !== 'string');
      if (list.length === 0) return render(c, req, { type: 'error', text: 'Selecciona al menos un archivo.' }, 400);
      if (list.length > MAX_FILES_PER_UPLOAD) return render(c, req, { type: 'error', text: `Máximo ${MAX_FILES_PER_UPLOAD} archivos por envío.` }, 400);

      const plan = effectivePlan({ plan: req.org_plan, subscription_status: req.subscription_status });
      const used = one<{ s: number | null }>(db, 'SELECT SUM(size) AS s FROM files WHERE org_id = ?', req.org_id)!.s ?? 0;
      const incoming = list.reduce((acc, f) => acc + f.size, 0);
      if (used + incoming > plan.maxStorageBytes) {
        return render(c, req, { type: 'error', text: 'Tu gestoría ha alcanzado su espacio de almacenamiento. Avísales para que puedan recibir tus archivos.' }, 413);
      }

      // Validar todo antes de guardar nada.
      const prepared: { name: string; data: Uint8Array; mime: string }[] = [];
      for (const f of list) {
        const name = sanitizeFilename(f.name);
        if (f.size > config.maxUploadBytes) return render(c, req, { type: 'error', text: `"${name}" supera el tamaño máximo de ${formatBytes(config.maxUploadBytes)}.` }, 413);
        const data = new Uint8Array(await f.arrayBuffer());
        const check = validateUpload(name, data);
        if (!check.ok) return render(c, req, { type: 'error', text: `"${name}": ${check.error}` }, 400);
        prepared.push({ name, data, mime: check.mime });
      }

      for (const p of prepared) {
        const fileId = newId();
        await deps.storage.put(req.org_id, fileId, p.data);
        run(db, 'INSERT INTO files (id, org_id, item_id, original_name, mime, size, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)',
          fileId, req.org_id, item.id, p.name, p.mime, p.data.length, sha256(Buffer.from(p.data)));
      }
      run(db, `UPDATE request_items SET status = 'uploaded', reject_reason = NULL, updated_at = datetime('now') WHERE id = ?`, item.id);
      audit(db, req.org_id, `client:${req.client_id}`, 'file.uploaded', item.id, { count: prepared.length });

      // Aviso al despacho (al creador de la petición o, si ya no existe, al titular).
      const recipient = one<{ email: string }>(db,
        `SELECT u.email FROM users u JOIN memberships m ON m.user_id = u.id AND m.org_id = ?
         WHERE u.id = ? OR m.role = 'owner' ORDER BY (u.id = ?) DESC LIMIT 1`, req.org_id, req.created_by, req.created_by);
      if (recipient) {
        await deps.mailer.send({
          to: recipient.email, kind: 'upload_notice', orgId: req.org_id, requestId: req.id,
          subject: `${req.client_name} ha subido documentos: ${item.label}`,
          text: `${req.client_name} ha subido ${prepared.length} archivo(s) para "${item.label}" en la petición "${req.title}".\n\nRevísalos: ${config.appUrl}/app/requests/${req.id}\n`,
        });
      }
      return render(c, req, { type: 'ok', text: `¡Recibido! ${prepared.length} archivo(s) subido(s) para "${item.label}".` });
    });

  return r;
}
