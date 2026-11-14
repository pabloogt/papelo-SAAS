# 2. Producto y modelo de negocio: Papelo

## Cliente ideal (ICP)

- **Principal:** gestoría o asesoría fiscal-contable de 1 a 10 personas, con 50–300 clientes (autónomos y pymes). Hoy trabaja con email, WhatsApp y Excel, o tiene un ERP cuyo portal no usa.
- **Secundario:** abogados de extranjería y laboralistas, brokers hipotecarios, administradores de fincas, inmobiliarias, arquitectos (licencias) y RR. HH. (altas de empleados).
- **Usuario final:** el cliente del despacho. No paga y no se registra; sólo sube archivos desde el móvil.

## Propuesta de valor

| Antes | Con Papelo |
|---|---|
| 3–6 h por trimestre persiguiendo papeles | Recordatorios automáticos: 7 y 2 días antes, el día del vencimiento y 3, 7 y 14 días después |
| "¿Qué te falta?" y el cliente no lo sabe | El cliente ve una lista clara con su estado |
| Documentos dispersos por WhatsApp y email | Todo dentro de la petición, con registro de quién subió qué y cuándo |
| Rehacer las peticiones cada trimestre | Peticiones recurrentes que se crean solas |

## Monetización

Suscripción mensual por despacho, sin coste por cliente final y sin permanencia. Precios sin IVA.

| Plan | Precio | Límites | Para quién |
|---|---|---|---|
| Gratis | 0 € | 5 clientes activos, 1 usuario, 500 MB, 6 plantillas, sin recurrencia | Probar y uso puntual: motor de adquisición |
| **Profesional** | **29 €/mes** | 150 clientes, 3 usuarios, 25 GB, recurrencia, plantillas ilimitadas | El despacho típico |
| Despacho | 79 €/mes | 1.000 clientes, 10 usuarios, 150 GB, soporte prioritario | Despachos medianos |

- **Pago anual con 2 meses gratis** (290 € y 790 €). Se configura como otro precio en Stripe.
- **Métrica de valor:** clientes activos. Archivar un cliente libera su plaza, lo que reduce la fricción al bajar de plan.
- **Ingresos futuros:** marca blanca (subdominio y logo, +20 €/mes), recordatorios por SMS o WhatsApp como extra de pago por uso y un programa de partners con asociaciones de asesores.

## Economía unitaria (estimada)

| Concepto | Valor |
|---|---|
| Infraestructura (Fly.io con 1 VM y volumen de 10–50 GB, o un VPS de Hetzner) | 5–15 €/mes en total |
| Email (Resend) | Gratis hasta 3.000/mes; luego ~20 $/mes por 50.000 |
| Stripe | 1,5 % + 0,25 € por cobro en tarjetas UE (~0,69 € sobre 29 €) |
| Margen bruto | > 90 % |
| Punto de equilibrio con infraestructura y herramientas (~60 €/mes) | 3 clientes Profesional |
| Objetivo a 12 meses | 100 despachos de pago → ~3.500 € MRR |
| Objetivo a 24 meses | 300 despachos → ~10.000 € MRR |

## Captación (go-to-market)

1. **SEO de intención fiscal:** "plantilla para pedir documentación IVA trimestral", "cómo reclamar documentos a clientes gestoría", "checklist documentación Renta 2026". Son páginas útiles que enlazan a las plantillas del producto.
2. **Bucle viral incorporado:** cada portal del cliente final muestra "Envío seguro con Papelo". Muchos clientes de gestorías son a su vez autónomos que contratan a otros profesionales.
3. **Asociaciones y colegios** (gestores administrativos, asesores fiscales): webinars antes de cada cierre trimestral (abril, julio, octubre, enero) y de la campaña de Renta.
4. **Venta directa:** 20 llamadas por semana a despachos de 1–5 personas, ofreciendo importar sus clientes por ellos.
5. **Estacionalidad como palanca:** las campañas de captación se lanzan 3 semanas antes de cada trimestre fiscal.

## Riesgos y mitigación

| Riesgo | Mitigación |
|---|---|
| Competidores españoles (CopilotGestoria) y las suites de los ERP | Precio bajo, simplicidad, sin ataduras a un ERP, multiprofesión y gran experiencia móvil para el cliente final |
| Clientes que no usan el enlace | Recordatorios insistentes pero educados y opción "Marcar como recibido por otra vía" |
| RGPD (documentos con DNI y datos bancarios) | Encargo de tratamiento, alojamiento en la UE, cifrado en tránsito y en reposo (volumen), registro de auditoría, exportación y borrado |
| Entregabilidad del email | Dominio propio con SPF, DKIM y DMARC; reply-to al despacho |
| Churn estacional | Plan anual, recurrencia automática y peticiones de alta de cliente todo el año |

## Hoja de ruta tras el MVP

1. **v1.1:** importar clientes desde CSV, descargar todos los archivos de una petición en un ZIP y un resumen semanal por email.
2. **v1.2:** almacenamiento en S3/R2 con URLs prefirmadas, antivirus (ClamAV) y marca blanca.
3. **v1.3:** recordatorios por SMS/WhatsApp de pago, firma de documentos (encargo profesional) y API/Zapier.
4. **v2:** clasificación automática de documentos con IA (factura, extracto, DNI) y detección de "foto ilegible".
