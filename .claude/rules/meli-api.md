# MercadoLibre API — Integración

## Overview

Integración con MercadoLibre Chile (MLC). Server-side en `src/lib/ml.ts`, API routes en `src/app/api/ml/`.

## Estado actual

### Implementado
- **OAuth 2.0:** Flujo completo — `getOAuthUrl()` genera URL de autorización, callback en `/api/ml/auth` intercambia code por tokens
- **Token management:** Auto-refresh con `getValidToken()`, almacena en tabla `ml_config`
- **Webhook:** `/api/ml/webhook` procesa notificaciones `orders_v2` y `shipments`
- **Sync de órdenes:** `/api/ml/sync` hace polling de órdenes recientes y las procesa
- **Sync de envíos:** Modelo shipment-centric — procesa shipments con items, guarda en `ml_shipments` + `ml_shipment_items`
- **Stock sync:** `/api/ml/stock-sync` sincroniza stock a ML via API distribuida (user_product_id)
- **Etiquetas:** `/api/ml/labels` descarga etiquetas de envío (ZPL → PDF)
- **Flex management:** `/api/ml/flex` consulta servicios Flex disponibles
- **Setup tables:** `/api/ml/setup-tables` crea tablas ML via SQL

### Modelo dual de pedidos
1. **Legacy (`pedidos_flex`):** Un registro por order+sku_venta, con fecha_armado y estado simple
2. **Nuevo (`ml_shipments` + `ml_shipment_items`):** Shipment-centric, guarda status/substatus/logistic_type/handling_limit del shipment real

### Pendiente / Roadmap
- Migración completa al modelo shipment-centric (eliminar pedidos_flex legacy)
- Sync bidireccional de stock (actualmente solo push WMS → ML)
- Notificaciones push cuando llegan pedidos urgentes
- Manejo de cancelaciones/devoluciones automáticas

## Arquitectura

```
src/lib/ml.ts           → Toda la lógica ML (server-side only)
src/app/api/ml/auth/    → OAuth callback
src/app/api/ml/webhook/ → Receptor de notificaciones ML
src/app/api/ml/sync/    → Polling manual de órdenes
src/app/api/ml/stock-sync/ → Push stock a ML
src/app/api/ml/labels/  → Descarga etiquetas de envío
src/app/api/ml/flex/    → Servicios Flex
src/app/api/ml/verify/  → Verificación de conexión
src/app/api/ml/setup-tables/ → Setup DB
```

## Patrones clave

### API calls
```typescript
// Helper genérico con auto-refresh de token
async function mlGet<T>(path: string): Promise<T | null>
async function mlPost<T>(path: string, body: unknown): Promise<T | null>
async function mlPut<T>(path: string, body: unknown): Promise<T | null>
```

### Token refresh
- Tokens se guardan en `ml_config` (tabla singleton con `id='main'`)
- `getValidToken()` verifica expiración y hace refresh automático si necesario
- Refresh usa `ML_AUTH/oauth/token` con grant_type `refresh_token`

### Procesamiento de shipments
```typescript
// processShipment: fetch shipment data, fetch items, upsert en DB
async function processShipment(shipmentId: number, orderIds: number[]): Promise<{items: number}>
```

### Cutoff logic (Flex)
- Hora de corte configurable: L-V `hora_corte_lv` (default 14), Sáb `hora_corte_sab` (default 11)
- Domingos no operativos
- `calcFechaArmado()` determina cuándo se debe armar un pedido basado en handling_limit

### Stock sync (distribuido)
- Usa `user_product_id` del catálogo ML para mapear SKU → item ML
- Cola en `stock_sync_queue` para retry
- El tipo de depósito es **explícito en la URL**:

```
PUT /user-products/{userProductId}/stock/type/{TIPO_DEPOSITO}
Header: x-version: {version}
Body: { "quantity": N }
```

#### Tipos de depósito
| Tipo | Quién controla | Descripción |
|---|---|---|
| `selling_address` | **WMS (nosotros)** | Bodega BANVA → stock Flex |
| `meli_facility` | **MercadoLibre** | Bodega Colina → stock Full (solo lectura para nosotros) |
| `seller_warehouse` | Vendedor | Multi-origen (no usado actualmente) |

#### Flujo de escritura (WMS → ML)
- `syncStockToML()` calcula `disponible = stock_bodega - comprometido`
- Hace `PUT .../stock/type/selling_address` con la cantidad disponible
- Usa optimistic locking: `GET` obtiene `x-version`, `PUT` lo envía en header
- Si hay version conflict (409), re-lee y reintenta una vez
- Safety block: si stock baja de >10 a 0, no sincroniza (requiere revisión manual)

#### Flujo de lectura (ML → WMS)
- `syncStockFull()` lee stock de `meli_facility` vía API fulfillment
- Guarda en `stock_full_cache` para visualización y cálculos de inteligencia
- **Nunca escribe** en `meli_facility` — ML lo gestiona internamente vía inbound

#### Coexistencia Full+Flex
Para un mismo `user_product_id` con ambos canales:
```json
GET /user-products/MLCU123456/stock → {
  "locations": [
    { "type": "selling_address", "quantity": 30 },  // Flex - tú lo controlas
    { "type": "meli_facility", "quantity": 15 }      // Full - ML lo controla
  ]
}
```
El comprador ve 45 unidades (30+15), pero cada canal se gestiona por separado.

## Constantes
```typescript
const ML_API = "https://api.mercadolibre.com";
const ML_AUTH = "https://auth.mercadolibre.cl"; // Chile
const SITE_ID = "MLC";
```
