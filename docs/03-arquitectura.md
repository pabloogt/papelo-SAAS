# 3. Arquitectura técnica

## Principios

- **Un solo proceso, una sola base de datos, cero servicios obligatorios.** Funciona en local sin claves; email y Stripe se activan con variables de entorno.
- **Pocas dependencias:** `hono` y `@hono/node-server`. SQLite, criptografía, tests y la ejecución de TypeScript vienen incluidos en Node 24.
- **Renderizado en servidor con mejora progresiva.** Todo funciona sin JavaScript; `public/app.js` sólo añade comodidad. No hay paso de build.
- **Fácil de evolucionar:** el almacenamiento, el email y los pagos están detrás de interfaces, para cambiar a S3 o Postgres sin tocar las rutas.

## Stack

| Capa | Elección | Motivo |
|---|---|---|
| Runtime | Node.js 24 (TypeScript nativo por *type stripping*) | Sin compilación; un solo binario |
| HTTP | Hono 4 | Ligero, basado en estándares web y testeable con `app.request()` sin abrir puertos |
| Base de datos | SQLite (`node:sqlite`) en modo WAL | Rendimiento de sobra para miles de despachos; copia de seguridad con un fichero |
| Vistas | Plantillas con escape automático (`src/lib/html.ts`) | Seguras frente a XSS por defecto |
| Ficheros | Disco local (volumen) con la interfaz `Storage` | Pasar a S3/R2 es implementar 4 métodos |
| Email | Resend vía HTTP; sin clave, bandeja `/dev/mail` | Un proveedor barato y sin SDK |
| Pagos | Stripe Checkout, Billing Portal y webhooks (API REST, sin SDK) | Stripe gestiona tarjetas, facturas e IVA |
| Tareas programadas | Bucle en proceso cada 15 min | Recordatorios y peticiones recurrentes sin un servicio aparte |
| Tests | `node:test` | Sin dependencias |

## Diagrama

```
 Despacho (navegador)          Cliente final (móvil)
        │  cookie de sesión            │  /p/:id/:token (sin cuenta)
        ▼                              ▼
 ┌──────────────────────── Hono (Node 24) ─────────────────────────┐
 │ middleware: cabeceras de seguridad · Origin · sesión · CSRF      │
 │ rutas: auth · app (panel, clientes, peticiones, plantillas,      │
 │        ajustes, facturación) · portal · webhooks/stripe          │
 │ servicios: requests (recordatorios, recurrencia) · email ·       │
 │            storage · stripe · plans                              │
 │ programador (setInterval): runScheduledJobs()                    │
 └───────┬───────────────────┬──────────────────┬───────────────────┘
         ▼                   ▼                  ▼
   SQLite (/data)     Archivos (/data/uploads)  Resend · Stripe
```

## Modelo de datos

```
users ─┬─< memberships >─┬─ organizations ──< clients ──< requests ──< request_items ──< files
       │                 │        │                         │
       └─< sessions >────┘        ├─< templates              └─< emails (registro de envíos)
                                  ├─< invitations
                                  └─< audit_log
webhook_events (idempotencia de Stripe)
```

| Tabla | Claves |
|---|---|
| `organizations` | Plan, `stripe_customer_id`, `subscription_status`, `current_period_end`. El **tenant** |
| `memberships` | Rol `owner` o `member` por organización |
| `sessions` | `id_hash` = SHA-256 del token de la cookie (el token nunca se guarda) y `csrf_token` |
| `clients` | `archived_at` para liberar plaza sin perder el historial |
| `requests` | `due_date`, `status`, `recurrence`, `link_nonce` (rota el enlace), `reminders_sent`, `last_reminder_at` |
| `request_items` | `status`: pending → uploaded → approved / rejected (con `reject_reason`) |
| `files` | Metadatos y SHA-256 del contenido; el binario va en el almacenamiento con un nombre opaco (UUID) |

Todas las claves son UUID v4, que no se pueden enumerar. Las migraciones son incrementales y van versionadas con `PRAGMA user_version` (`src/db.ts`).

## Autenticación y autorización

- **Contraseñas:** scrypt (N=2^15, r=8, p=1) con sal aleatoria y comparación en tiempo constante. Si el usuario no existe se calcula igualmente un hash ficticio, para no revelar qué emails están registrados.
- **Sesiones:** token aleatorio de 256 bits en una cookie `HttpOnly`, `SameSite=Lax`, `Secure` y con prefijo `__Host-` en producción; caduca a los 30 días. Cerrar sesión y quitar a un miembro revocan sus sesiones en la base de datos.
- **Multi-tenant:** todas las consultas privadas filtran por `org_id` de la sesión. Los recursos de otro despacho devuelven **404**, no 403, para no confirmar que existen. Está cubierto por un test específico.
- **Roles:** sólo el titular cambia ajustes, invita, borra clientes, contrata planes y elimina la cuenta.
- **Portal del cliente:** enlace `/p/{requestId}/{token}`, donde `token = HMAC-SHA256(APP_SECRET, requestId:nonce)`. No se almacena, así que una fuga de la base de datos no expone enlaces válidos. Al rotar el nonce se revoca el enlace.

## Seguridad (OWASP Top 10 aplicado)

| Riesgo | Medida |
|---|---|
| Inyección SQL | Consultas siempre parametrizadas (`?`) |
| XSS | Escape automático en plantillas; CSP `script-src 'self'` sin inline; `style-src 'self'` |
| CSRF | Dos capas: comprobación de `Origin` en toda petición que modifica estado, más token sincronizado por sesión en la zona privada |
| Clickjacking | `frame-ancestors 'none'` y `X-Frame-Options: DENY` |
| Fuga del enlace del portal | `Referrer-Policy: same-origin`, `Cache-Control: no-store`, `X-Robots-Tag: noindex` |
| Fuerza bruta | Límite de 10 intentos/15 min por IP y por email en el login; límites en registro, invitaciones y subidas |
| Subidas maliciosas | Lista blanca de extensiones, comprobación de la firma binaria (PDF, PNG, JPG, ZIP/OOXML), tamaño máximo, nombre en disco opaco y descarga siempre como `attachment` con CSP `sandbox` |
| Path traversal | Los IDs de almacenamiento se validan con una regex de UUID antes de construir rutas |
| Redirección abierta | `next` sólo acepta rutas `/app…` |
| Webhooks falsos | Firma `Stripe-Signature` (HMAC-SHA256, tolerancia de 5 min) y eventos idempotentes |
| Transporte | HSTS en producción y `force_https` en Fly |
| Auditoría | `audit_log` registra login, creación y borrado, descargas, subidas, recordatorios y cambios de plan |
| RGPD | Exportación JSON, borrado total (base de datos y archivos), datos en la UE (región `mad`) y plantilla de encargo de tratamiento |

**Pendiente antes de escalar:** escaneo antivirus de las subidas, cifrado de ficheros a nivel de aplicación, 2FA (TOTP) para despachos, recuperación de contraseña por email, y copias cifradas fuera del servidor con Litestream a R2/S3.

## Pagos (Stripe)

1. El titular pulsa "Contratar" y el servidor crea una **Checkout Session** (`mode=subscription`, `client_reference_id=org_id`, recogida de NIF y dirección). Después redirige con 303 a Stripe.
2. Stripe envía webhooks a `/webhooks/stripe`:
   - `checkout.session.completed` guarda `stripe_customer_id`.
   - `customer.subscription.created|updated` asigna el plan según el `price.id`, el estado y el fin de periodo.
   - `customer.subscription.deleted` vuelve al plan Gratis.
3. Los cambios de plan, la cancelación, las facturas y la tarjeta se gestionan en el **Customer Portal** de Stripe, sin construir UI propia.
4. **El webhook es la única fuente de verdad.** `effectivePlan()` sólo concede el plan de pago con el estado `active`, `trialing` o `past_due` (periodo de gracia mientras Stripe reintenta el cobro).
5. IVA: activa Stripe Tax o configura tasas fijas (21 % en España; inversión del sujeto pasivo con NIF-IVA intracomunitario).

Configuración: crea 2 productos con precios mensuales y apunta el endpoint del webhook con esos 4 eventos. Después define `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO` y `STRIPE_PRICE_DESPACHO`. Para desarrollo: `stripe listen --forward-to localhost:3000/webhooks/stripe`.

## Recordatorios y recurrencia

- `isReminderDue()` es una función pura y testeada. El calendario es `[-7, -2, 0, +3, +7, +14]` días respecto al vencimiento. Se envía un aviso si hay un hito ≤ hoy posterior al último contacto. Si el servidor estuvo parado sólo envía **un** aviso de recuperación, nunca una ráfaga. Como máximo hay 6 recordatorios.
- El contador se marca antes de enviar: es preferible perder un aviso a duplicarlo.
- Cuando una petición recurrente llega a su fecha límite se crea la del siguiente periodo (mes, trimestre o año, ajustando a fin de mes) y se envía al cliente.
- Si se rechaza un documento, el cliente recibe en el acto un aviso con el motivo.

## Tests

```bash
npm test
```

- **Unitarios:** hash de contraseñas, token del portal, escape HTML, fechas, política de recordatorios, firma de Stripe, plan efectivo, validación de subidas, parser de documentos y limitador de peticiones.
- **Integración** (app completa en memoria, con cookies y CSRF reales): registro, login y logout; CSRF; flujo completo petición → email → portal → subida → rechazo → aprobación → completada; revocación de enlaces; aislamiento multi-tenant; límites del plan; recordatorios y recurrencia con reloj simulado; checkout y webhooks idempotentes de Stripe; invitaciones y roles; exportación y borrado RGPD; cabeceras y XSS.

## Despliegue

**Opción recomendada: Fly.io (Madrid), unos 5–10 €/mes**

```bash
fly launch --no-deploy            # usa fly.toml
fly volumes create papelo_data --region mad --size 10
fly secrets set APP_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
  RESEND_API_KEY=re_xxx STRIPE_SECRET_KEY=sk_live_xxx STRIPE_WEBHOOK_SECRET=whsec_xxx \
  STRIPE_PRICE_PRO=price_xxx STRIPE_PRICE_DESPACHO=price_xxx
fly deploy
```

**Alternativa:** un VPS (Hetzner CX22, ~4 €/mes) con Docker y Caddy para TLS automático. La misma imagen funciona sin cambios.

**Copias de seguridad:** Litestream replicando el fichero SQLite a Cloudflare R2 (céntimos al mes), más copia diaria de `/data/uploads` con `rclone`.

**Límite de escala conocido:** el diseño asume **una sola instancia** por SQLite, el programador en proceso y el rate limit en memoria. Esto aguanta con holgura miles de despachos. Para escalar horizontalmente:

1. SQLite → Postgres; las consultas son SQL estándar.
2. Disco → S3/R2.
3. Programador → cron externo o un bloqueo en la base de datos.
4. Rate limit → Redis o la base de datos.

**Observabilidad mínima:** `/healthz`, logs estructurados en stdout (Fly los conserva), alertas de Stripe por email y un monitor externo gratuito (UptimeRobot o BetterStack).
