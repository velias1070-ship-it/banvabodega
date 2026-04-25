# Fase 5 — Integraciones externas

> Cada integración detallada con: archivos del cliente, endpoints, env vars, rate limits/webhooks, y estado.

## 1. MercadoLibre (MLC — Chile)

**Propósito**: única integración crítica del WMS. Sync de órdenes, push de stock Flex, lectura de stock Full, gestión de ítems, ads, billing, OAuth.

**Archivos cliente**:
- `src/lib/ml.ts` (~2300 LOC) — Toda la lógica server-side. Helpers `mlGet/mlPost/mlPut`, refresh de tokens, procesamiento de shipments, stock sync distribuido.
- `src/lib/ml-metrics.ts`, `src/lib/ml-shipping.ts` — submódulos.
- `src/app/api/ml/*` (~50 endpoints).

**Endpoints principales** (constantes):
```
ML_API   = https://api.mercadolibre.com
ML_AUTH  = https://auth.mercadolibre.cl
SITE_ID  = MLC
```

Métodos invocados (extraídos del código):
- `GET/POST /oauth/token` — refresh tokens.
- `GET /items/{id}` — detalles ítem.
- `GET /seller-promotions/items/{id}?app_version=v2` — promos por ítem.
- `GET /users/{seller_id}/items/search`, `/items/{id}/variations`, `/items/{id}/description`.
- `GET /orders/{id}`, `/shipments/{id}`, `/shipments/{id}/items`.
- `PUT /user-products/{userProductId}/stock/type/{TIPO_DEPOSITO}` con header `x-version`.
- `GET /sites/MLC/categories`, `/categories/{id}/attributes`.
- `GET/POST /seller-promotions/...` — auto-postular.
- `/billing/...` — facturación CFWA (rate limit 5/min — ver memoria `project_ml_billing_api`).
- `/orders/search` — backfill.

**Variables de entorno**: `ML_SYNC_SECRET` (auth de crons internos). Tokens OAuth + client_id/secret se guardan en tabla `ml_config` (NO en env).

**Webhooks**: `POST /api/ml/webhook` recibe `orders_v2`, `shipments`, `claims`, `stock-locations`, `fbm_stock_operations`, `marketplace_fbm_stock`, `items`, `items_prices`. Cada hit se loguea en `ml_webhook_log`. **No verifica firma** (campo en `ml_config` existe pero no se valida — riesgo en Fase 8).

**Rate limits**:
- 429 con backoff: `retry-after` header respetado, max 5s espera, hasta 3 reintentos (`src/lib/ml.ts`).
- Billing API: 5 req/min (memoria del owner).

**Documentación**:
- Reglas internas: `.claude/rules/meli-api.md`.
- Referencia: https://developers.mercadolibre.cl
- MCP server para queries (memoria `reference_ml_mcp`).

**Estado**: **Activa, crítica**. Modelo dual de pedidos en transición (`pedidos_flex` legacy → `ml_shipments + ml_shipment_items`).

---

## 2. MercadoPago

**Propósito**: sync de transacciones MP → `movimientos_banco` para conciliación financiera.

**Archivos cliente**:
- `src/app/api/mp/sync/route.ts`
- `src/app/api/mp/sync-live/route.ts`
- `src/app/api/mp/request-report/route.ts`
- `src/app/api/mp/check-report/route.ts`
- `src/app/api/mp/cleanup-live/route.ts`

**Endpoint base**: `https://api.mercadopago.com`

Métodos detectados: solicitud de reportes (request-report → check-report cuando está listo → descarga), sync live de cuentas/empresas vinculadas.

**Variables de entorno**: `MP_ACCESS_TOKEN` (access token).

**Webhooks**: no se reciben (todo es polling outbound).

**Documentación**: memoria `reference_mp_api_docs`.

**Estado**: **Activa**. Memoria `feedback_mp_sync` indica: no auto-generar reportes en sync; usar los del panel; retiros = transferencias a banco.

---

## 3. ProfitGuard

**Propósito**: análisis de rentabilidad por orden. SaaS chileno externo.

**Archivos cliente**:
- `src/app/api/profitguard/sync/route.ts` — cron cada 5 min.
- `src/app/api/profitguard/orders/route.ts` — query.
- `src/components/AdminVentasML.tsx`, `src/components/AdminReposicion.tsx` — UI consumer.

**Endpoint base**: `https://app.profitguard.cl`

**Variables de entorno**: `PROFITGUARD_API_KEY`.

**Webhooks**: ninguno.

**Estado**: **Activa**. Caché en tabla `profitguard_cache`.

---

## 4. SII Chile (Servicio de Impuestos Internos)

**Propósito**: descarga de Boletas de Honorarios Electrónicas (BHE) y Registro de Compras/Ventas (RCV) para conciliación tributaria.

**Arquitectura híbrida** — dos paths:

### 4a. Acceso directo al SII
- `src/app/api/sii/rcv/route.ts` — usa endpoints SII directos:
  - `https://herculesr.sii.cl/cgi_AUT2000/CAutInWor498.cgi` (auth con RUT+clave).
  - `https://www4.sii.cl/conaborrcvinternetui/services/data/facadeService` (RCV).

### 4b. Microservicio proxy (Railway)
- `src/app/api/sii/bhe/route.ts` y `bhe-rec/route.ts` — delegan a un proxy externo:
  - Default: `https://rcv-sii-server-production.up.railway.app`
  - Override: `SII_SERVER_URL` (en local apunta a `http://localhost:8080`).
- Auth con `SII_API_KEY` (default `banva-rcv-2026`).

**Variables de entorno**: `SII_SERVER_URL`, `SII_API_KEY`. Las credenciales SII del usuario (RUT + clave) viven en el cliente (sessionStorage `SII_CREDS_KEY` en `src/app/conciliacion/page.tsx`).

**Webhooks**: ninguno.

**Estado**: **Activa**. El microservicio Railway es repo separado fuera del scope (TODO: confirmar URL del repo con el owner).

---

## 5. Anthropic (Claude API)

**Propósito**: motor del sistema multi-agente IA del WMS — chat orquestador, generación de insights, clasificación de feedback.

**Archivos cliente**:
- `src/app/api/agents/chat/route.ts`
- `src/app/api/agents/feedback/route.ts`
- `src/app/api/agents/run/route.ts`

**Endpoint**: `POST https://api.anthropic.com/v1/messages`

**Modelo**: `claude-sonnet-4-20250514` (o lo configurado en tabla `agent_config`).

> Memoria del cutoff: el modelo más actual hoy es **Sonnet 4.6** (`claude-sonnet-4-6`). El default hardcodeado está desactualizado — sugerir migración en Fase 8.

**Variables de entorno**: `ANTHROPIC_API_KEY`.

**Webhooks**: ninguno (request/response sincrónico).

**Estado**: **Activa**. Reglas y memoria persistida en tablas `agent_*`.

---

## 6. Google Sheets

**Propósito**: lectura/escritura de la planilla maestra de costos. Importa columnas de costos hacia `productos`.

**Archivos cliente**:
- `src/app/api/sheet/update-cost/route.ts`
- `src/app/api/admin/sync-diccionario-final/route.ts` (lee CSV publicado de Google Sheets — `docs.google.com`).

**Endpoints**:
- `https://oauth2.googleapis.com/token` — auth con service account.
- `https://www.googleapis.com/...` — APIs de Sheets.
- `https://docs.google.com/spreadsheets/.../export?format=csv` (publicación pública).

**Variables de entorno**:
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_SHEET_ID`
- `GOOGLE_SHEET_NAME`
- `GOOGLE_COST_COLUMN`

**Webhooks**: ninguno.

**Estado**: **Activa**.

---

## 7. App Etiquetas (`banva1`) — repo hermano, no es API externa pero crítico

**Propósito**: app HTML estática + Supabase JS que escanea facturas con Gemini OCR, imprime etiquetas con códigos de barras, y **escribe directo al mismo Supabase** que banvabodega.

**Path local**: `/Users/vicenteelias/banva1/`
**Repo**: https://github.com/velias1070-ship-it/banva1

**Contrato** (de `.claude/rules/app-etiquetas.md`):
1. Sube imagen de factura a `storage.banva` bucket → `facturas/{folio}_{ts}.jpg`.
2. INSERT directo en `recepciones` con `created_by='App Etiquetas'`.
3. INSERT en `recepcion_lineas` (una por SKU, `estado='PENDIENTE'`).

**Acoplamiento**: vía **schema de Supabase**, no via API REST. Cualquier cambio de schema en banvabodega afecta App Etiquetas.

**Endpoint banvabodega que va a empezar a consumir**: `POST /api/proveedores/resolve` para canonizar proveedores antes del INSERT (cambio pendiente documentado).

**Estado**: **Activa, fuente única de recepciones en producción** desde 2026-03-05.

---

## 8. Vercel (deploy + crons)

**Propósito**: hosting de la app + ejecución de 19 cron jobs.

**Configuración**: `vercel.json` (no `vercel.ts` aún).

**Variables runtime auto-inyectadas**: `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL`.

**Webhooks de despliegue**: ninguno detectado en el repo.

**Estado**: **Activa**. Estructura cron documentada en Fase 3.

---

## 9. Scanbot Web SDK + pdfjs-dist (no son APIs, son SDKs cliente)

- **Scanbot**: lectura de barcodes con la cámara. WASM en `public/wasm/`.
- **pdfjs-dist**: render de PDFs. Worker en `public/pdf.worker.min.js`.
- Ambos se preparan en `postinstall`.

**Estado**: **Activa**.

---

## 10. WhatsApp (canal externo, gestionado por el agente Viki)

> No es una integración del repo banvabodega per se — vive en el droplet DigitalOcean (`146.190.55.201`). El agente "Viki" usa el plugin Baileys para enviar/recibir mensajes.

**Cómo se acopla con banvabodega**: Viki ejecuta scripts (`~/banva-alertas/`) que consultan Supabase y empujan resúmenes/alertas al canal. No hay endpoint en banvabodega para esto.

**Reglas**: `.claude/rules/whatsapp.md` (UX) y `.claude/rules/agents.md` (infra multi-máquina).

**Estado**: **Activa**, fuera del repo.

---

## Hallazgos transversales

- **Manejo de tokens ML**: tokens OAuth se guardan en tabla `ml_config` con RLS permisivo. Cualquier cliente con la anon key puede leerlos. Documentado como riesgo en `.claude/rules/security.md`.
- **Modelo Anthropic desactualizado**: hardcodeado `claude-sonnet-4-20250514`; el más reciente es `claude-sonnet-4-6` (cutoff actual).
- **SII via Railway**: dependencia oculta de un microservicio externo cuyo repo no está en este árbol. TODO: documentar URL del repo y owner.
- **MP rate limit / sync**: política definida en memoria `feedback_mp_sync` — no usar auto-reportes en sync.
- **Sin webhooks signature**: ML webhook no valida firma; tampoco hay otros webhooks.
