import { Hono } from 'hono';
import type { AppDeps, Env } from '../context.ts';
import { htmlResponse, takeFlash } from '../context.ts';
import { all } from '../db.ts';
import { escapeHtml, h, raw } from '../lib/html.ts';

function linkify(text: string) {
  return raw(escapeHtml(text).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`));
}
import { PLANS } from '../services/plans.ts';
import { publicPage } from '../views/layout.ts';

export function pricingTable(current?: string) {
  return h`<div class="pricing">
  ${Object.values(PLANS).map((p) => h`
  <div class="price-card ${p.id === 'pro' ? 'featured' : ''}">
    ${p.id === 'pro' ? h`<span class="ribbon">Más elegido</span>` : ''}
    <h3>${p.name}</h3>
    <div class="price"><span class="amount">${p.priceEur} €</span><span class="per">/mes + IVA</span></div>
    <ul>${p.features.map((f) => h`<li>${f}</li>`)}</ul>
    ${current === undefined ? h`<a class="btn btn-block ${p.id === 'pro' ? '' : 'btn-secondary'}" href="/signup">${p.priceEur === 0 ? 'Empezar gratis' : 'Probar gratis'}</a>` : ''}
  </div>`)}
</div>`;
}

export function publicRoutes(deps: AppDeps) {
  const r = new Hono<Env>();

  r.get('/healthz', (c) => {
    all(deps.db, 'SELECT 1');
    return c.json({ ok: true });
  });

  r.get('/', (c) => htmlResponse(c, publicPage('Recoge la documentación de tus clientes sin perseguirles', h`
<section class="hero">
  <div>
    <p class="eyebrow">Para gestorías, asesorías y despachos</p>
    <h1>Deja de perseguir a tus clientes por los papeles.</h1>
    <p class="lead">Pide la documentación con una lista clara, tu cliente la sube desde el móvil con un enlace seguro (sin contraseñas) y Papelo le recuerda automáticamente lo que falta hasta que llega.</p>
    <div class="hero-cta"><a class="btn btn-lg" href="/signup">Empieza gratis</a><a class="btn btn-lg btn-secondary" href="#como-funciona">Cómo funciona</a></div>
    <p class="hint">Gratis hasta 5 clientes · Sin tarjeta · Datos alojados en la UE</p>
  </div>
  <div class="hero-visual" aria-hidden="true">
    <div class="mock">
      <div class="mock-row"><span>IVA 3T · Panadería Ruiz</span><span class="badge badge-warning">Por revisar</span></div>
      <div class="mock-row"><span>Renta 2025 · Laura Gómez</span><span class="badge badge-danger">Vencida</span></div>
      <div class="mock-row"><span>Alta cliente · Taller Norte SL</span><span class="badge badge-success">Completada</span></div>
      <div class="mock-row"><span>IVA 3T · Estudio Vela</span><span class="badge badge-neutral">Recordatorio enviado</span></div>
    </div>
  </div>
</section>

<section class="problems">
  <h2>El cuello de botella de cada trimestre no es el modelo 303. Es conseguir los papeles.</h2>
  <div class="grid3">
    <div class="card"><h3>Emails y WhatsApps perdidos</h3><p>Facturas por WhatsApp, fotos borrosas por email, extractos que nunca llegan. Nadie sabe qué falta.</p></div>
    <div class="card"><h3>Horas reclamando</h3><p>Llamar y escribir a decenas de clientes cada trimestre para pedir lo mismo una y otra vez.</p></div>
    <div class="card"><h3>Prisas al final del plazo</h3><p>Todo llega el día 18. Los errores y las horas extra, también.</p></div>
  </div>
</section>

<section id="como-funciona" class="steps">
  <h2>Cómo funciona</h2>
  <ol class="grid3">
    <li class="card"><strong>1. Crea la petición</strong><p>Elige cliente y plantilla (IVA trimestral, Renta, alta de cliente…). Puede repetirse sola cada trimestre.</p></li>
    <li class="card"><strong>2. Tu cliente sube los archivos</strong><p>Recibe un enlace seguro. Ve exactamente qué falta y lo sube desde el móvil, sin registrarse.</p></li>
    <li class="card"><strong>3. Papelo reclama por ti</strong><p>Recordatorios automáticos antes y después del plazo. Tú sólo revisas, apruebas o pides que lo repita.</p></li>
  </ol>
</section>

<section id="precios">
  <h2>Precios sencillos</h2>
  <p class="muted center">Por despacho, no por cliente. Cancela cuando quieras.</p>
  ${pricingTable()}
</section>

<section class="faq">
  <h2>Preguntas frecuentes</h2>
  <details><summary>¿Mis clientes tienen que crearse una cuenta?</summary><p>No. Reciben un enlace único y seguro por email. Puedes revocarlo en cualquier momento.</p></details>
  <details><summary>¿Sustituye a mi programa de contabilidad?</summary><p>No, lo complementa. Papelo se ocupa de conseguir la documentación; tu programa de siempre, de procesarla.</p></details>
  <details><summary>¿Y la protección de datos?</summary><p>Actuamos como encargado del tratamiento (art. 28 RGPD), con datos alojados en la UE, cifrado en tránsito y registro de accesos. Puedes exportar o borrar todos tus datos desde Ajustes.</p></details>
</section>
`, { flash: takeFlash(c) })));

  r.get('/legal/privacidad', (c) => htmlResponse(c, publicPage('Privacidad', h`<article class="card prose">
<h1>Política de privacidad</h1>
<p><em>Plantilla orientativa: revísala con un profesional antes de publicar.</em></p>
<p>Papelo trata los datos de las cuentas de los despachos (responsable) y, por cuenta de éstos, los datos y documentos de sus clientes (encargado del tratamiento, art. 28 RGPD).</p>
<ul><li>Finalidad: prestar el servicio de recogida de documentación.</li><li>Ubicación: servidores en la Unión Europea.</li><li>Conservación: mientras la cuenta esté activa; el despacho puede borrar sus datos en cualquier momento.</li><li>Subencargados: proveedor de hosting, envío de email (Resend) y pagos (Stripe).</li></ul>
</article>`, { narrow: true })));

  r.get('/legal/terminos', (c) => htmlResponse(c, publicPage('Términos', h`<article class="card prose">
<h1>Términos del servicio</h1>
<p><em>Plantilla orientativa: revísala con un profesional antes de publicar.</em></p>
<p>Suscripción mensual renovable, cancelable en cualquier momento desde el portal de facturación. Los precios no incluyen IVA. El despacho es responsable de la base legal para tratar los datos de sus clientes.</p>
</article>`, { narrow: true })));

  // Bandeja de correo de desarrollo: permite probar el flujo completo sin proveedor de email.
  if (deps.config.env !== 'production') {
    r.get('/dev/mail', (c) => {
      const mails = all<any>(deps.db, 'SELECT * FROM emails ORDER BY created_at DESC, rowid DESC LIMIT 30');
      return htmlResponse(c, publicPage('Bandeja de desarrollo', h`<h1>Correos enviados (desarrollo)</h1>
<p class="muted">Sólo disponible fuera de producción.</p>
${mails.length === 0 ? h`<p>No hay correos todavía.</p>` : mails.map((m) => h`<div class="card mail"><div class="mail-head"><strong>${m.subject}</strong><span class="muted">${m.to_email} · ${m.created_at} · ${m.kind} · ${m.status}</span></div><pre class="mail-body">${linkify(m.body_text)}</pre></div>`)}`));
    });
  }

  return r;
}
