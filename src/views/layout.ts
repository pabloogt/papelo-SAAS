import { h, type SafeHtml } from '../lib/html.ts';

export type Flash = { type: 'ok' | 'error'; text: string } | null;

export type Viewer = {
  user: { name: string; email: string };
  org: { name: string };
  planName: string;
  csrf: string;
};

export function csrfField(token: string): SafeHtml {
  return h`<input type="hidden" name="_csrf" value="${token}">`;
}

function flashBox(flash: Flash): SafeHtml {
  if (!flash) return h``;
  return h`<div class="flash flash-${flash.type}" role="${flash.type === 'error' ? 'alert' : 'status'}">${flash.text}</div>`;
}

function shell(title: string, bodyClass: string, content: SafeHtml): SafeHtml {
  return h`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Papelo</title>
<meta name="description" content="Recoge la documentación de tus clientes sin perseguirles: peticiones, enlace seguro y recordatorios automáticos.">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/styles.css">
<script src="/static/app.js" defer></script>
</head>
<body class="${bodyClass}">
${content}
</body>
</html>`;
}

export function publicPage(title: string, body: SafeHtml, opts: { flash?: Flash; narrow?: boolean } = {}): SafeHtml {
  return shell(title, 'public', h`
<header class="topbar">
  <a class="brand" href="/">${logo()}<span>Papelo</span></a>
  <nav class="topnav"><a href="/#precios">Precios</a><a href="/login">Entrar</a><a class="btn btn-sm" href="/signup">Empieza gratis</a></nav>
</header>
<main class="${opts.narrow ? 'narrow' : 'wide'}">
${flashBox(opts.flash ?? null)}
${body}
</main>
<footer class="footer"><span>© Papelo</span><a href="/legal/privacidad">Privacidad</a><a href="/legal/terminos">Términos</a></footer>`);
}

const NAV = [
  { key: 'dashboard', href: '/app', label: 'Inicio' },
  { key: 'requests', href: '/app/requests', label: 'Peticiones' },
  { key: 'clients', href: '/app/clients', label: 'Clientes' },
  { key: 'templates', href: '/app/templates', label: 'Plantillas' },
  { key: 'settings', href: '/app/settings', label: 'Ajustes' },
  { key: 'billing', href: '/app/billing', label: 'Plan y pagos' },
];

export function appPage(v: Viewer, active: string, title: string, body: SafeHtml, flash: Flash = null): SafeHtml {
  return shell(title, 'app', h`
<div class="layout">
  <aside class="sidebar">
    <a class="brand" href="/app">${logo()}<span>Papelo</span></a>
    <div class="org-name" title="${v.org.name}">${v.org.name}</div>
    <nav class="sidenav">
      ${NAV.map((n) => h`<a href="${n.href}" class="${n.key === active ? 'active' : ''}"${n.key === active ? h` aria-current="page"` : ''}>${n.label}</a>`)}
    </nav>
    <div class="sidebar-foot">
      <span class="plan-badge">Plan ${v.planName}</span>
      <div class="user-line">${v.user.name}</div>
      <form method="post" action="/logout">${csrfField(v.csrf)}<button class="link-btn" type="submit">Cerrar sesión</button></form>
    </div>
  </aside>
  <main class="content">
    ${flashBox(flash)}
    ${body}
  </main>
</div>`);
}

export function portalShell(title: string, body: SafeHtml): SafeHtml {
  return shell(title, 'portal', h`<main class="portal-main">${body}</main>
<footer class="footer"><span>Envío seguro con Papelo</span></footer>`);
}

export function logo(): SafeHtml {
  return h`<svg class="logo" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><rect x="4" y="2.5" width="14" height="18" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 8h6M8 12h6M8 16h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="18.5" cy="18.5" r="4" fill="var(--accent)"/><path d="m16.8 18.6 1.2 1.2 2.2-2.4" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export function statusBadge(kind: string): SafeHtml {
  const map: Record<string, [string, string]> = {
    open: ['Abierta', 'neutral'], overdue: ['Vencida', 'danger'], completed: ['Completada', 'success'], cancelled: ['Cancelada', 'muted'],
    pending: ['Pendiente', 'neutral'], uploaded: ['Por revisar', 'warning'], 'uploaded-client': ['Enviado', 'info'], approved: ['Aprobado', 'success'], rejected: ['Rechazado', 'danger'],
  };
  const [label, cls] = map[kind] ?? [kind, 'neutral'];
  return h`<span class="badge badge-${cls}">${label}</span>`;
}

export function emptyState(title: string, text: string, action?: SafeHtml): SafeHtml {
  return h`<div class="empty"><h3>${title}</h3><p>${text}</p>${action ?? ''}</div>`;
}
