# 1. Investigación de mercado y selección de idea

Fecha: noviembre de 2026 · Mercado objetivo: España (ampliable a LatAm hispanohablante)

## Criterios de selección

Cada idea se puntúa de 1 a 5 en:

| Criterio | Por qué importa a un fundador en solitario |
|---|---|
| Dolor recurrente y medible | Si el problema vuelve cada mes o trimestre, la suscripción se justifica sola |
| Disposición a pagar | Clientes B2B que ya pagan software |
| Construible por 1 persona | MVP en semanas, sin integraciones frágiles ni certificaciones |
| Coste operativo bajo | Sin APIs caras por uso (SMS, WhatsApp, IA) en el núcleo |
| Riesgo regulatorio | Mejor un producto que no dependa de una fecha del BOE |
| Distribución | Nicho fácil de encontrar (colegios profesionales, asociaciones, SEO) |

## Problemas detectados

1. **Gestorías y asesorías persiguiendo la documentación de sus clientes.** Cada trimestre (IVA, IRPF) y cada campaña de Renta hay que reclamar facturas, extractos y certificados a decenas o cientos de clientes por email, teléfono y WhatsApp. Los propios blogs del sector describen este cuello de botella al cerrar trimestres, junto con la falta de personal en los despachos.
2. **Registro horario digital para micropymes.** El real decreto que hará obligatorio el fichaje digital sigue sin publicarse (julio de 2026) y no tiene fecha cierta: se habla del 4T 2026 o del 1S 2027.
3. **Facturación Verifactu.** Es obligatorio desde el 1 de enero de 2027 para sociedades y desde el 1 de julio de 2027 para autónomos (RDL 15/2025). Es un mercado saturado: Holded, Billin, Quipu, Alegra, TeamSystem…
4. **Ausencias a citas en clínicas pequeñas** (fisioterapia, psicología, estética). Las ausencias cuestan hasta 7.500 €/mes a clínicas privadas, según una fuente del sector. Hay recordatorios incluidos en casi todo el software de agenda (AgendaPro, Clinic Cloud…). WhatsApp Business API añade un coste por mensaje.

## Competencia en recogida de documentación

| Competidor | Precio | Debilidad para el despacho pequeño español |
|---|---|---|
| TaxDome | ~800 €/licencia/año, pago anual por adelantado | Suite completa y compleja; caro para despachos de 1–3 personas |
| Content Snare | 29–179 $/mes | En inglés, en dólares y sin plantillas fiscales españolas |
| FileInvite | Desde ~829 $/mes (Capterra) | Orientado a enterprise o banca |
| Cegid Portal del Asesor, Wolters Kluwer, Sage | Incluido en sus suites | Sólo sirve si ya usas su ERP; atado al proveedor |
| CopilotGestoria | Sin precio público claro | Competidor directo español con portal, peticiones y reclamación automática. Valida el mercado y obliga a diferenciarse |
| Email + WhatsApp + Excel | "Gratis" | Es la alternativa real de la mayoría y la que hay que desplazar |

**Hueco desatendido:** una herramienta *standalone*, en español y barata (menos de 30 €/mes) que haga una sola cosa muy bien: conseguir los papeles. Debe funcionar sin cambiar de ERP, sin que el cliente final cree una cuenta y con plantillas fiscales españolas y peticiones recurrentes por trimestre.

## Las tres mejores ideas

| | Dolor | Pago | 1 persona | Coste op. | Regulación | Distribución | **Total** |
|---|---|---|---|---|---|---|---|
| **A. Papelo: recogida de documentación para despachos** | 5 | 4 | 5 | 5 | 5 | 4 | **28** |
| B. Fichaje digital ultrasencillo para micropymes | 4 | 3 | 4 | 5 | 2 | 3 | **21** |
| C. Confirmación de citas por WhatsApp para clínicas | 4 | 3 | 3 | 2 | 4 | 3 | **19** |

- **A. Papelo:** dolor que se repite cada trimestre, comprador profesional que ya paga software y MVP sin integraciones obligatorias. Su coste marginal es casi cero, porque usa email en lugar de SMS. Además se expande de forma natural a abogados, arquitectos, brokers hipotecarios, inmobiliarias y RR. HH.
- **B. Fichaje:** la demanda depende de una fecha del BOE que se ha retrasado varias veces. Hay muchos competidores financiados (Factorial, Sesame, Bizneo) y la inspección exige inmutabilidad y custodia de 4 años, lo que añade carga de cumplimiento.
- **C. Citas por WhatsApp:** cada mensaje cuesta dinero y la integración con Meta es frágil. Además compite con funciones que ya traen las agendas existentes y hay datos de salud de por medio (RGPD reforzado).

Descartada: facturación Verifactu. Exige homologación técnica, el mercado está saturado y los errores tienen responsabilidad fiscal.

## Ganadora: **Papelo**

> "Deja de perseguir a tus clientes por los papeles."

El despacho crea una petición con una lista de documentos, normalmente a partir de una plantilla (IVA trimestral, Renta, alta de cliente…). Su cliente recibe un enlace seguro, ve qué falta y lo sube desde el móvil sin registrarse. Papelo envía recordatorios automáticos antes y después del plazo hasta que todo llega. El despacho revisa, aprueba o pide que se repita un documento. Las peticiones pueden repetirse solas cada mes, trimestre o año.

## Fuentes

- Registro horario: [Holded](https://www.holded.com/es/blog/registro-horario-digital), [Law&Trends](https://www.lawandtrends.com/noticias/empresa/registro-horario-digital-obligatorio-en-2026-su-calendario-previsto-requisitos-y-guia-practica-para-pymes-y-autonomos-1.html), [CopilotGestoria: Consejo de Estado](https://copilotgestoria.com/blog/consejo-estado-rechaza-registro-horario-digital-2026-que-significa-empresas-gestorias)
- Verifactu: [Infoautónomos](https://www.infoautonomos.com/blog/verifactu-cuando-es-obligatorio-a-quien-afecta/), [Genbeta](https://www.genbeta.com/actualidad/gobierno-retrasa-pesadilla-para-empresas-autonomos-verifactu-no-sera-obligatorio-2027), [Billin](https://www.billin.net/blog/hacienda-retrasa-verifactu-a-2027/)
- Competencia: [TaxDome precios](https://taxdome.com/es-es/pricing), [Content Snare en Capterra](https://www.capterra.com/p/167019/Content-Snare/pricing/), [FileInvite en Capterra](https://www.capterra.com/p/138728/FileInvite/pricing/), [Comparativa de gestión documental para asesorías](https://hackceleration.com/es/labs/mejor/gestion-documental-asesorias), [CopilotGestoria: reclamar documentos](https://copilotgestoria.com/tutoriales/reclamar-documentos-pendientes), [Cegid conexión con clientes](https://www.cegid.com/ib/es/productos/software-programa-erp-asesorias-gestorias/conexion-clientes/)
- Sector: [Wolters Kluwer: Barómetro 2025](https://www.wolterskluwer.com/es-es/know/barometro-2025), [Merca2: falta de personal](https://www.merca2.es/2025/08/04/los-despachos-y-gestorias-se-quedan-sin-personal-crisis-en-el-sector-espanol-2219718/), [SuperContable: consolidación](https://www.supercontable.com/boletin/H/articulos/Compraventa_asesorias_se_dispara.html)
- Ausencias a citas: [Vozpópuli](https://www.vozpopuli.com/sanitatem/las-ausencias-a-citas-medicas-cuestan-hasta-7500-euros-al-mes-a-las-clinicas-privadas.html), [Upliora](https://www.upliora.es/blog/ia-para-fisioterapia-rehabilitacion-multilocales-2026)

> Nota: muchas cifras proceden de blogs de proveedores y comparadores. Antes de invertir en marketing, valida el precio y el dolor con 10–15 entrevistas a despachos.
