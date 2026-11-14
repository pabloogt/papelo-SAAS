# Papelo

Recoge la documentación de tus clientes sin perseguirles. Es un SaaS para gestorías, asesorías y despachos:

- el despacho crea peticiones de documentos;
- el cliente las sube desde un enlace seguro, sin cuenta;
- Papelo envía recordatorios automáticos hasta que todo llega.

## Documentación

1. [Investigación de mercado y selección de idea](docs/01-investigacion.md)
2. [Producto, monetización y go-to-market](docs/02-producto-y-negocio.md)
3. [Arquitectura, base de datos, seguridad, pagos, tests y despliegue](docs/03-arquitectura.md)

## Requisitos

- Node.js 24 o superior. No hace falta nada más: SQLite viene incluido en Node.

## Arranque en local

```bash
npm install
```

```bash
npm run seed
```

```bash
npm run dev
```

- Abre http://localhost:3000 y entra con la cuenta demo: `demo@papelo.local` / `demo-papelo-2026`. Si prefieres, crea una cuenta nueva.
- Sin `RESEND_API_KEY`, los emails no se envían: se guardan en la base de datos y se ven en http://localhost:3000/dev/mail, con los enlaces del portal clicables.
- Sin claves de Stripe, la página "Plan y pagos" funciona pero los botones de contratar están desactivados. Para probar los pagos usa claves `sk_test_` y `stripe listen --forward-to localhost:3000/webhooks/stripe`.
- Copia `.env.example` a `.env` para configurar el entorno.

## Tests

```bash
npm test
```

21 tests: 10 unitarios y 11 de integración de extremo a extremo.

## Estructura

```
src/
  server.ts          arranque, programador de recordatorios, apagado ordenado
  app.ts             middleware de seguridad, sesión, CSRF y montaje de rutas
  config.ts          variables de entorno
  db.ts              SQLite + migraciones
  context.ts         tipos compartidos y helpers de petición
  lib/               seguridad (scrypt, tokens, rate limit), HTML con escape, fechas
  services/          requests (recordatorios, recurrencia), email, storage, stripe, plans
  routes/            public, auth, app (panel), portal (cliente final), billing (+ webhook)
  views/layout.ts    layout y componentes
public/              CSS y JS de mejora progresiva
test/                node:test (unit + integración)
scripts/seed.ts      datos de demostración
Dockerfile, fly.toml despliegue
```
