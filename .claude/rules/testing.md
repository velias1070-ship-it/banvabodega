# Testing — Estado Actual y Estrategia

## Estado actual

**No hay infraestructura de testing.** El proyecto no tiene:
- Framework de tests (no Jest, Vitest, Cypress, ni Playwright)
- Archivos de test (`*.test.ts`, `*.spec.ts`, `__tests__/`)
- Scripts de test en `package.json`
- Configuración de coverage
- Mocks o fixtures

## Scripts disponibles

```json
{
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "postinstall": "mkdir -p public/wasm && cp -r node_modules/scanbot-web-sdk/bundle/bin/barcode-scanner/* public/wasm/"
}
```

La única validación es `next build` (type-checking de TypeScript).

## Estrategia recomendada

Si se agregan tests, usar esta estructura acorde al proyecto:

### Framework
- **Vitest** (compatible con Next.js, más rápido que Jest, config mínima)

### Prioridades de testing

1. **`src/lib/ml.ts`** — Lógica crítica de negocio: procesamiento de órdenes, cálculo de fechas de armado, stock sync. Testeable con mocks de Supabase y fetch.

2. **`src/lib/db.ts`** — Funciones CRUD. Tests de integración contra Supabase local o mocks del cliente.

3. **`src/lib/store.ts`** — Bridge entre UI y DB. Lógica de composición de ventas, cálculo de stock total, detección de discrepancias.

4. **API Routes (`src/app/api/ml/`)** — Webhook handler, OAuth flow. Tests con requests mockeados.

### Qué NO testear (por ahora)
- Componentes UI (son archivos monolíticos de 1000+ líneas con mucho inline style)
- CSS/estilos
- Interacciones con BarcodeScanner (depende de hardware)

### Convención de archivos
```
src/lib/__tests__/ml.test.ts
src/lib/__tests__/db.test.ts
src/lib/__tests__/store.test.ts
src/app/api/ml/__tests__/webhook.test.ts
```
