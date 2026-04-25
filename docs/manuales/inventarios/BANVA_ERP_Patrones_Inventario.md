# Patrones de inventario de ERPs profesionales para tu WMS en PostgreSQL

**Los cuatro ERPs analizados convergen en un patrón arquitectónico universal: ledger de movimientos append-only + ubicaciones virtuales con partida doble + tabla de saldos cacheados, combinados con reservaciones explícitas y stock proyectado calculado.** Este patrón es directamente implementable en Supabase/PostgreSQL y resuelve los problemas críticos de un e-commerce textil multicanal: prevención de sobreventa, trazabilidad completa y sincronización con marketplaces como MercadoLibre. La diferencia principal entre los ERPs radica en *dónde* vive la partida doble (en el stock mismo en Odoo y SAP, versus en la contabilidad general en ERPNext y NetSuite) y en cómo persisten el estado actual (tabla mutable vs cálculo desde ledger). Para una escala de 500-2000 SKUs con 1-3 bodegas, la recomendación es un **modelo híbrido**: ledger append-only como fuente de verdad + tabla de saldos actualizada transaccionalmente + reservaciones con `SELECT FOR UPDATE` para concurrencia.

---

## BLOQUE 1 — El modelo de datos que sustenta todo

### Representación de ubicaciones: el árbol de locaciones

Los cuatro ERPs modelan ubicaciones como **árboles jerárquicos** con un campo `tipo` que distingue ubicaciones físicas de virtuales.

**SAP S/4HANA** tiene la jerarquía más profunda: **Mandante → Sociedad → Centro (Plant) → Almacén (Storage Location)**, y cuando se activa EWM: **Warehouse Number → Storage Type → Storage Section → Storage Bin**. El centro es la unidad central para MRP y valoración. Un par centro+almacén se asigna a un warehouse number para activar gestión a nivel de bin.

**Odoo** usa un modelo elegante de ubicaciones auto-referenciales (`stock.location`) con el campo `usage` como pieza clave:

```
usage: 'internal'   → Ubicación física (dentro de bodega, cuenta como stock)
       'supplier'   → Virtual: proveedores (origen en recepciones)
       'customer'   → Virtual: clientes (destino en despachos)
       'inventory'  → Virtual: pérdidas/ajustes/merma
       'production' → Virtual: manufactura
       'transit'    → Tránsito inter-bodega
       'view'       → Agrupador jerárquico (no almacena)
```

La jerarquía típica de Odoo:

```
Physical Locations (view)
├── Mi Empresa (view)
│   └── Bodega Santiago (view)
│       ├── Stock (internal)
│       ├── Input (internal)
│       └── Output (internal)
├── Tránsito Inter-bodega (transit)
Partner Locations (view)
├── Proveedores (supplier)
└── Clientes (customer)
Virtual Locations (view)
├── Ajuste de Inventario (inventory)
├── Merma (inventory, scrap_location=True)
└── Producción (production)
```

**ERPNext** usa el **Nested Set Model** (columnas `lft`/`rgt`) para su jerarquía de warehouses. Cada warehouse pertenece a una empresa y puede ser grupo (`is_group=True`) o hoja. **No tiene concepto nativo de bin/zona** — se simulan creando warehouses hijos. Desde v15 ofrece **Inventory Dimensions** para agregar dimensiones de tracking personalizadas (rack, estante).

**NetSuite** trata ubicaciones como **clasificaciones** (junto a departamentos y clases). Soporta sublocalidades (parent-child), y el **Bin Management** se activa por ubicación con el flag `useBins`. El campo `locationType` distingue entre Store, Warehouse y Undefined.

**Patrón universal**: Todas usan un árbol de locaciones con tipo/uso. Las ubicaciones virtuales son fundamentales — actúan como contrapartes en movimientos que de otra forma no tendrían "otro lado" (recepción, despacho, merma).

**Recomendación para sistema propio:**

```sql
CREATE TABLE locations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id   UUID REFERENCES locations(id),
    name        TEXT NOT NULL,
    full_path   TEXT,  -- calculado: "Bodega Santiago / Rack A / Bin 1"
    usage       TEXT NOT NULL CHECK (usage IN (
        'internal','supplier','customer','inventory',
        'transit','production','view'
    )),
    warehouse_id UUID REFERENCES warehouses(id),
    is_scrap    BOOLEAN DEFAULT FALSE,
    is_return   BOOLEAN DEFAULT FALSE,
    barcode     TEXT UNIQUE,
    active      BOOLEAN DEFAULT TRUE
);
```

### Representación de stock actual: quants vs ledger vs híbrido

**Esta es la decisión arquitectónica más importante.** Los ERPs usan tres enfoques distintos:

| ERP | Enfoque | Tabla de saldos | Fuente de verdad |
|-----|---------|----------------|-------------------|
| **SAP S/4HANA** | Ledger puro | MARD/MARC son **vistas CDS** que calculan desde MATDOC | MATDOC (append-only) |
| **Odoo** | Quants mutables | `stock.quant` actualizado cuando moves llegan a "done" | Combinación quants + moves |
| **ERPNext** | Híbrido ledger+caché | `Bin` (tabla mutable cacheada) | `Stock Ledger Entry` (append-only) |
| **NetSuite** | Saldos en ítem | Campos en `InventoryItem` + location sublist | Transacciones como audit trail |

**SAP S/4HANA (MATDOC)** es el más radical: en S/4HANA las tablas clásicas MARD/MARC/MCHB son **vistas CDS** que calculan stock en tiempo real sumando todas las entradas de MATDOC. Para performance usa MATDOC_EXTRACT (versión pre-compactada). Este enfoque es viable gracias a SAP HANA (columnar, in-memory). **INSERT-only, cero contención por locks de UPDATE.**

**Odoo (stock.quant)** mantiene un registro mutable por combinación única de **product + location + lot + package + owner**:

```python
# Campos clave de stock.quant
quantity          = Float  # Total on-hand
reserved_quantity = Float  # Reservado para moves
# available = quantity - reserved_quantity (calculado)
in_date           = Datetime  # Para FIFO
```

El available **no se almacena, se calcula**: `available = quantity - reserved_quantity`. Los quants se actualizan cuando un `stock.move` pasa a estado `done`.

**ERPNext (SLE + Bin)** es el patrón más replicable en PostgreSQL. Cada transacción inserta un `Stock Ledger Entry` append-only con `actual_qty` (delta) y `qty_after_transaction` (balance corrido). La tabla `Bin` es un caché materializado por `(item_code, warehouse)`:

```python
# Campos del Bin (caché de saldos)
actual_qty                    # Stock físico actual
reserved_qty                  # Reservado por Sales Orders
ordered_qty                   # En órdenes de compra pendientes
planned_qty                   # Planificado por Work Orders
projected_qty                 # Fórmula: actual + planned + ordered - reserved - ...
```

**NetSuite** almacena `quantityOnHand`, `quantityAvailable`, `quantityCommitted`, `quantityOnOrder` directamente en el registro del ítem, actualizados por cada transacción.

**Recomendación**: Adoptar el patrón ERPNext/pgledger — **ledger append-only + tabla de saldos cacheada actualizada transaccionalmente**:

```sql
-- Ledger: fuente de verdad, inmutable
CREATE TABLE stock_moves (
    id              BIGSERIAL PRIMARY KEY,
    sku_id          UUID NOT NULL REFERENCES products(id),
    src_location_id UUID NOT NULL REFERENCES locations(id),
    dst_location_id UUID NOT NULL REFERENCES locations(id),
    quantity        NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
    movement_type   TEXT NOT NULL,  -- 'receipt','delivery','transfer','adjustment','return','scrap'
    state           TEXT NOT NULL DEFAULT 'draft',
    reference_type  TEXT,
    reference_id    UUID,
    operation_id    UUID REFERENCES stock_operations(id),
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT now(),
    confirmed_at    TIMESTAMPTZ
);

-- Saldos: caché mutable, actualizado atómicamente con cada move
CREATE TABLE stock_quants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku_id          UUID NOT NULL REFERENCES products(id),
    location_id     UUID NOT NULL REFERENCES locations(id),
    on_hand_qty     NUMERIC(12,3) NOT NULL DEFAULT 0,
    reserved_qty    NUMERIC(12,3) NOT NULL DEFAULT 0,
    version         INTEGER NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE(sku_id, location_id),
    CHECK (on_hand_qty >= 0),
    CHECK (reserved_qty >= 0),
    CHECK (reserved_qty <= on_hand_qty)
);
```

### Movimientos de stock y partida doble

**Odoo y SAP implementan partida doble a nivel de inventario.** Todo movimiento tiene origen y destino. ERPNext y NetSuite logran la partida doble solo a nivel contable (GL).

En **Odoo**, cada `stock.move` tiene `location_id` (origen) y `location_dest_id` (destino). Operaciones comunes mapeadas:

| Operación | Origen (usage) | Destino (usage) |
|-----------|---------------|-----------------|
| Recepción de proveedor | `supplier` | `internal` |
| Despacho a cliente | `internal` | `customer` |
| Transferencia interna | `internal` (bodega A) | `internal` (bodega B) |
| Merma/scrap | `internal` | `inventory` (scrap=True) |
| Ajuste positivo | `inventory` | `internal` |
| Ajuste negativo | `internal` | `inventory` |

En **SAP**, los **movement types** (3 dígitos) son la pieza clave: 101=GR contra OC, 201=salida a centro de costo, 301=transferencia entre centros, 561=entrada inicial. Cada movement type tiene determinación automática de cuentas contables vía OBYC, generando asientos dobles simultáneamente en MATDOC + ACDOCA.

En **ERPNext**, el SLE es single-entry: cada entrada registra un delta en UN warehouse. Una transferencia crea **dos SLEs**: uno negativo (origen) y uno positivo (destino). La partida doble se logra en el General Ledger cuando perpetual inventory está activo.

**Los moves en estado "done" son inmutables en todos los ERPs.** Las correcciones se hacen con movimientos de reversa, nunca editando el original. Esto es fundamental para la auditoría.

**Recomendación**: Implementar partida doble a nivel de stock (estilo Odoo). Todo move tiene `src_location_id` y `dst_location_id`. Las ubicaciones virtuales (`supplier`, `customer`, `inventory`) actúan como contrapartes. Beneficio: el sistema se auto-verifica — la suma de todo el stock en ubicaciones internas + lo que salió a clientes debe igualar lo que entró de proveedores.

---

## BLOQUE 2 — Reservaciones que previenen la sobreventa

### Cuándo y cómo se reserva stock

**SAP** crea reservaciones como documentos separados (tabla RKPF/RESB) que reducen el ATP sin mover stock. Las reservaciones pueden ser manuales (MB21) o automáticas (desde órdenes de producción, mantenimiento). Las ventas usan un mecanismo diferente: schedule lines en SD (tabla VBBE). La reserva es siempre a nivel de centro/almacén.

**Odoo** reserva en el método `_action_assign()` del `stock.move`: busca quants disponibles con `_gather()`, ordena por `in_date` (FIFO), incrementa `reserved_quantity` en cada quant, y crea `stock.move.line` detallando qué lote/paquete específico se reservó. La reserva es a **nivel de ubicación+lote+paquete específico** (hard allocation). El timing es configurable por picking type: `at_confirm`, `manual`, o `by_date`.

**ERPNext** distingue dos eras. Antes de v15: solo `reserved_qty` agregado en el `Bin` (soft). Desde v15: **Stock Reservation Entry** explícito por orden de venta, con `reserved_qty`, `delivered_qty` y `status`. Se activa con "Enable Stock Reservation" en Stock Settings.

**NetSuite** ofrece dos modos vía la preferencia "Perform Item Commitment After Transaction Entry": **commit al guardar la orden** (default) — automáticamente compromete stock disponible, o **commit diferido** — un batch job procesa compromisos según prioridad. Cada línea de SO tiene un campo `Commit`: Available Quantity, Complete Quantity, o Do Not Commit.

### Tabla de reservaciones y prevención de sobreventa

**Patrón universal**: Las reservaciones son registros separados que, en conjunto, disminuyen el stock disponible. La fórmula es consistente:

```
available = on_hand - reserved
```

**Concurrencia en Odoo** — usa `SELECT FOR UPDATE NOWAIT` y `FOR NO KEY UPDATE SKIP LOCKED` en PostgreSQL:

```python
# stock_quant.py - reservación con lock de fila
self._cr.execute(
    "SELECT 1 FROM stock_quant WHERE id = %s FOR UPDATE NOWAIT",
    [quant.id])

# v16+: skip locked para mejor throughput
self._cr.execute(
    "SELECT id FROM stock_quant WHERE id IN %s "
    "ORDER BY lot_id LIMIT 1 FOR NO KEY UPDATE SKIP LOCKED",
    [tuple(quants.ids)])
```

Odoo opera en **REPEATABLE READ** isolation level. Los fallos de serialización se reintentan automáticamente (hasta 5 veces con backoff exponencial).

### Soft reservation vs hard allocation

Los ERPs manejan esta distinción de formas distintas:

- **Soft reservation** (SAP: reservación manual, ERPNext pre-v15: `reserved_qty` en Bin, NetSuite: "Do Not Commit"): Indica demanda planificada, afecta ATP/projected qty, pero no bloquea stock físico específico. No tiene granularidad de ubicación/lote.
- **Hard allocation** (Odoo: `_action_assign()`, ERPNext v15+: Stock Reservation Entry, NetSuite: committed qty, SAP: goods issue contra reserva): Compromete unidades específicas de stock. Reduce `reserved_quantity` en el quant/bin concreto.

**Transición soft → hard**: Típicamente ocurre al confirmar pago (e-commerce), al confirmar orden (B2B), o al ejecutar el picking. En Odoo es explícito: el move pasa de `confirmed` (demanda sin reserva) a `assigned` (stock reservado específicamente).

**Recomendación para sistema propio — implementar ambos niveles:**

```sql
CREATE TABLE reservations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id),
    order_line_id   UUID REFERENCES order_lines(id),
    sku_id          UUID NOT NULL REFERENCES products(id),
    location_id     UUID NOT NULL REFERENCES locations(id),
    quantity        NUMERIC(12,3) NOT NULL,
    type            TEXT NOT NULL CHECK (type IN ('soft','hard')),
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','fulfilled','released','expired')),
    expires_at      TIMESTAMPTZ,  -- NULL para hard reservations
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Función atómica de reservación con SELECT FOR UPDATE
CREATE OR REPLACE FUNCTION reserve_stock(
    p_order_id UUID, p_sku_id UUID, p_location_id UUID,
    p_qty NUMERIC, p_type TEXT DEFAULT 'hard',
    p_expires_minutes INT DEFAULT NULL
) RETURNS BOOLEAN AS $$
DECLARE v_available NUMERIC;
BEGIN
    -- Lock pessimista en la fila del quant
    SELECT on_hand_qty - reserved_qty INTO v_available
    FROM stock_quants
    WHERE sku_id = p_sku_id AND location_id = p_location_id
    FOR UPDATE;

    IF v_available IS NULL OR v_available < p_qty THEN
        RETURN FALSE;
    END IF;

    UPDATE stock_quants
    SET reserved_qty = reserved_qty + p_qty,
        updated_at = now()
    WHERE sku_id = p_sku_id AND location_id = p_location_id;

    INSERT INTO reservations (order_id, sku_id, location_id,
        quantity, type, expires_at)
    VALUES (p_order_id, p_sku_id, p_location_id, p_qty, p_type,
        CASE WHEN p_expires_minutes IS NOT NULL
             THEN now() + (p_expires_minutes || ' minutes')::INTERVAL
             ELSE NULL END);

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
```

### Expiración y limpieza de reservaciones

Todos los ERPs requieren mecanismos de limpieza. Odoo tiene "Correct inconsistencies for reservation" como acción del servidor. ERPNext tiene el Stock Reservation Entry con estados de lifecycle. NetSuite de-commite automáticamente cuando cambian las transacciones fuente.

**Para Supabase, usar pg_cron:**

```sql
-- Ejecutar cada 5 minutos: liberar reservas soft expiradas
SELECT cron.schedule('cleanup-reservations', '*/5 * * * *', $$
    WITH expired AS (
        UPDATE reservations
        SET status = 'expired', updated_at = now()
        WHERE type = 'soft' AND status = 'active' AND expires_at < now()
        RETURNING sku_id, location_id, quantity
    )
    UPDATE stock_quants q
    SET reserved_qty = reserved_qty - e.total_qty, updated_at = now()
    FROM (SELECT sku_id, location_id, SUM(quantity) AS total_qty
          FROM expired GROUP BY sku_id, location_id) e
    WHERE q.sku_id = e.sku_id AND q.location_id = e.location_id;
$$);
```

---

## BLOQUE 3 — Stock en tránsito y reposición inteligente

### Representación de stock pedido no recibido

**SAP** distingue entre **stock en transferencia** (`MARC.UMLMC`, de transfer postings 303/305) y **stock en tránsito** (`MARC.TRAME`, de Stock Transport Orders). Los transfers de dos pasos usan movement types 303 (salida) → 305 (entrada), con el stock intermedio visible en MMBE.

**Odoo** usa **ubicaciones de tránsito** (`usage='transit'`). Una transferencia inter-bodega genera una cadena de moves: Bodega A/Stock → Transit → Bodega B/Stock. El stock en tránsito "existe" físicamente en la ubicación virtual de tránsito.

**ERPNext** soporta transfers de 2 pasos desde v13: Stock Entry tipo "Add to Transit" (origen → bodega tránsito) + "End Transit" (tránsito → destino). El campo `warehouse_type = 'Transit'` identifica bodegas de tránsito.

**NetSuite** usa **Transfer Orders** con flujo multi-paso: Pending Fulfillment → Item Fulfillment (sale de origen, `quantityInTransit` aumenta) → Pending Receipt → Item Receipt (entra en destino). El GL registra: Débito Inventory in Transit / Crédito Inventory Asset (origen) al fulfillment, y lo inverso al receipt.

**Recomendación**: Crear ubicaciones virtuales de tránsito (estilo Odoo) y modelar el tránsito como un par de moves encadenados. Esto mantiene la integridad del modelo de partida doble.

### Stock proyectado: la fórmula de cada ERP

| ERP | Fórmula |
|-----|---------|
| **SAP (ATP)** | Unrestricted Stock + Planned Receipts (OCs, OPs, Planned Orders) − Planned Issues (SO, Deliveries, Reservations) |
| **Odoo** | `virtual_available = qty_available + incoming_qty − outgoing_qty` |
| **ERPNext** | `projected = actual + planned + requested + ordered − reserved − reserved_production − reserved_subcontract` |
| **NetSuite** | `Available = On Hand − Committed` (simple); con Supply Planning: On Hand + On Order − Committed − Backorder |

**ERPNext tiene la fórmula más completa** porque desagrega cada componente. Para un e-commerce textil, la fórmula práctica sería:

```sql
-- Vista de stock proyectado
CREATE VIEW v_projected_stock AS
SELECT
    q.sku_id,
    q.location_id,
    q.on_hand_qty,
    q.reserved_qty,
    q.on_hand_qty - q.reserved_qty AS available_qty,
    COALESCE(po.pending_qty, 0) AS on_order_qty,
    q.on_hand_qty - q.reserved_qty + COALESCE(po.pending_qty, 0) AS projected_qty
FROM stock_quants q
LEFT JOIN (
    SELECT sku_id, destination_location_id AS location_id,
           SUM(ordered_qty - received_qty) AS pending_qty
    FROM purchase_order_lines
    WHERE status IN ('confirmed','shipped','in_transit')
    GROUP BY sku_id, destination_location_id
) po ON po.sku_id = q.sku_id AND po.location_id = q.location_id
WHERE q.location_id IN (SELECT id FROM locations WHERE usage = 'internal');
```

### Reglas de reposición

Los cuatro ERPs implementan **reorder points** con parámetros similares:

| Parámetro | SAP | Odoo | ERPNext | NetSuite |
|-----------|-----|------|---------|----------|
| Min qty / reorder point | MRP view en material master | `product_min_qty` en orderpoint | `warehouse_reorder_level` en Item Reorder | `reorderPoint` en item |
| Max qty / preferred level | Lot size "HB" (min/max) | `product_max_qty` | `warehouse_reorder_qty` | `preferredStockLevel` |
| Safety stock | MRP view campo EISBE | Via `product_min_qty` | Implícito en reorder level | `safetyStockLevel` |
| Lead time | Info record + scheduling | `lead_days_date` | Campo en Item | `leadTime` (auto-calculable) |
| Por ubicación | Sí (MRP area) | Sí (por location) | Sí (por warehouse) | Sí (con MLI) |
| Auto-cálculo | MRP run (MD01) | Scheduler diario | Scheduled job | Auto-calculate flags |

**La fórmula de safety stock para textiles importados en Chile** (lead times altos y variables):

```
Safety Stock = Z × √(LT × σ_demand² + D_avg² × σ_LT²)

Donde:
  Z = 1.96 (97.5% service level)
  LT = lead time promedio (60-90 días para importación textil)
  σ_demand = desv. estándar demanda diaria
  σ_LT = desv. estándar del lead time (aduana es variable)
  D_avg = demanda diaria promedio
```

---

## BLOQUE 4 — El desafío multicanal y multi-bodega

### Pool compartido con buffers por canal

**NetSuite** y **Odoo** usan un pool compartido de inventario. NetSuite tiene flags por ubicación (`makeInventoryAvailable`, `makeInventoryAvailableStore`) que controlan qué ubicaciones alimentan cada canal. No tiene partición nativa por canal.

**SAP** permite "ring-fencing" mediante special stocks (stock por orden de venta, stock por proyecto) y aATP con allocations por grupo de clientes/canal.

**La estrategia óptima para MercadoLibre Chile + canales adicionales** es **pool compartido con safety buffer por canal:**

```
published_qty_ML = MAX(0, available_qty − safety_buffer_ML)
published_qty_web = MAX(0, available_qty − safety_buffer_web)
```

Esto maximiza el sell-through mientras absorbe la latencia de sincronización. Con **500-2000 SKUs y buffer de 1-2 unidades por canal**, el impacto en inventario inmovilizado es mínimo.

### Sincronización con MercadoLibre

**API de actualización de stock de MercadoLibre:**

```bash
# Item sin variaciones
PUT https://api.mercadolibre.com/items/{ITEM_ID}
{"available_quantity": 8}

# Item con variaciones
PUT https://api.mercadolibre.com/items/{ITEM_ID}
{"variations": [
    {"id": 60819719795, "available_quantity": 50},
    {"id": 60819719802, "available_quantity": 30}
]}
```

Comportamientos clave: setting `available_quantity = 0` pausa automáticamente el listing con substatus `out_of_stock`. Restablecer > 0 lo reactiva. Rate limit: **1500 requests/minuto por vendedor**. Puede ocurrir error 409 "optimistic locking" — reintentar.

**Para webhooks**, ML soporta notificaciones push en los topics `orders_v2`, `items`, `payments`, `shipments`. **Requisito crítico**: responder HTTP 200 en < 500ms o ML desactiva el topic. Patrón: acknowledge inmediato → procesar en background.

**Arquitectura de sincronización recomendada:**

```
INBOUND (ML → tu sistema):
  1. Webhook orders_v2 → /api/webhooks/ml
  2. Return 200 inmediato
  3. Enqueue procesamiento (o inline para bajo volumen)
  4. GET detalles de orden desde ML API
  5. Crear orden + reserve_stock() (hard, órdenes ML ya están pagadas)
  6. Recalcular available → push a todos los canales

OUTBOUND (tu sistema → ML):
  Trigger: cualquier cambio de inventario (venta, recepción, ajuste)
  1. Calcular published_qty = MAX(0, available - buffer)
  2. PUT a ML con available_quantity
  3. Reconciliación periódica cada 15-30 min como safety net
```

### Routing de órdenes multi-bodega

**Odoo** usa routes con push/pull rules que encadenan moves automáticamente. **SAP** usa ATP avanzado (aATP) con sourcing alternativo. **NetSuite** tiene `defaultAllocationPriority` en Location para priorizar bodegas.

**Para 1-3 bodegas**, implementar un algoritmo simple:

```
1. ¿Puede una bodega fulfillear la orden completa?
   → Sí: asignar a la bodega con mayor prioridad que tenga stock
   → No: ¿Permitir split shipment?
     → Sí: dividir entre bodegas
     → No: backorder parcial
```

---

## BLOQUE 5 — Operaciones agrupadas y trazabilidad total

### Agrupación de movimientos: la operación como documento

**SAP** agrupa líneas en un **Material Document** (MATDOC): un documento con número, año, y N líneas de ítems. Una OC con 15 productos → 1 goods receipt document con 15 líneas, cada una generando su entrada en MATDOC.

**Odoo** usa **Pickings** (`stock.picking`): una operación agrupa múltiples `stock.move`. Tipos de picking: `incoming` (recepción), `outgoing` (despacho), `internal` (transferencia). Un picking con 15 líneas = 15 stock.moves. Si se procesa parcialmente, Odoo crea automáticamente un **backorder** con las líneas pendientes.

**ERPNext** usa **Stock Entry** como documento agrupador: un Stock Entry tipo "Material Receipt" con 15 ítems genera 15 Stock Ledger Entries. El `voucher_type` y `voucher_no` en cada SLE referencia al documento origen.

**NetSuite** usa transacciones (Item Receipt, Item Fulfillment) con sublistas de líneas. Cada transacción es el "documento" agrupador.

**Recomendación — tabla de operaciones agrupando moves:**

```sql
CREATE TABLE stock_operations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_type  TEXT NOT NULL,  -- 'receipt','delivery','transfer','adjustment','return'
    reference_type  TEXT,           -- 'purchase_order','sales_order','transfer_order'
    reference_id    UUID,
    state           TEXT NOT NULL DEFAULT 'draft',
    source_location_id  UUID REFERENCES locations(id),
    dest_location_id    UUID REFERENCES locations(id),
    scheduled_date  TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);
-- Cada stock_move referencia a su operation_id
```

### Audit trail: inmutabilidad y reversa

**Regla universal en los 4 ERPs: los movimientos confirmados/completados nunca se editan ni eliminan.**

- **SAP**: Material documents son INSERT-only en MATDOC. Cancelaciones crean un nuevo document con movement type de reversa (102 revierte 101, 202 revierte 201).
- **Odoo**: Moves en estado `done` son inmutables. Returns crean **nuevos moves inversos** (cliente → stock). El método `_do_unreserve()` lanza error si el move está done.
- **ERPNext**: Cancelar un documento inserta un **SLE de reversa** con `is_cancelled=1` y `actual_qty` opuesto. Los SLEs futuros se reposteen.
- **NetSuite**: Transactions pueden voidarse (creates a reversing transaction) pero no editarse una vez posted.

**Para reconstruir estado histórico**: con un ledger append-only, el stock a cualquier fecha = `SUM(quantity) WHERE event_at <= fecha`. SAP S/4HANA hace exactamente esto con sus vistas CDS como `C_MaterialStockByKeyDate`.

### Ajustes de inventario

Todos los ERPs tratan ajustes como **movimientos especiales**, no como ediciones directas:

- **SAP**: Movement types 701/702 (physical inventory differences), posting a cuenta de diferencias de inventario (INV en OBYC)
- **Odoo**: Move desde/hacia ubicación virtual `inventory`. Ajuste positivo = `inventory → internal`. Negativo = `internal → inventory`
- **ERPNext**: `Stock Reconciliation` doctype que calcula `actual_qty = desired_qty - current_qty` y crea un SLE corrector
- **NetSuite**: `Inventory Adjustment` transaction; `Inventory Worksheet` para conteo físico con varianza calculada

**Patrón**: nunca sobreescribir stock directamente. Siempre crear un movimiento de tipo `adjustment` con la diferencia, manteniendo la trazabilidad completa.

---

## BLOQUE 6 — PostgreSQL como motor de inventario

### Append-only vs mutable: el compromiso correcto

La decisión fundamental:

| Enfoque | Pros | Contras | Quién lo usa |
|---------|------|---------|--------------|
| **Ledger puro** (solo SUMs) | Inmutable, perfecto audit trail, sin conflictos de UPDATE | Performance degrada con volumen, O(n) por consulta de saldo | SAP S/4HANA (con HANA columnar) |
| **Saldos mutables** (solo UPDATEs) | O(1) lectura, simple | Sin history nativa, pierde audit trail, conflictos de concurrencia | NetSuite (parcialmente) |
| **Híbrido** (ledger + caché) | Lo mejor de ambos mundos | Complejidad de mantener consistencia | ERPNext (SLE + Bin), pgledger |

**Para Supabase/PostgreSQL, el híbrido es la elección correcta.** El proyecto **pgledger** (github.com/pgr0ss/pgledger) valida este patrón con **10,600+ transacciones/segundo** en PostgreSQL estándar, usando:

- `pgledger_entries`: append-only, con `account_previous_balance` y `account_current_balance` (running balance)
- `pgledger_accounts`: saldo cacheado + `version` para optimistic locking
- `pgledger_transfers`: agrupa entries (partida doble, suman a cero)
- Todo el acceso via funciones PL/pgSQL que mantienen consistencia

**La consistencia se garantiza con transacciones DB**. El INSERT del move y el UPDATE del quant deben estar en la misma transacción:

```sql
CREATE OR REPLACE FUNCTION confirm_stock_move(p_move_id BIGINT)
RETURNS VOID AS $$
DECLARE
    v_move stock_moves%ROWTYPE;
BEGIN
    SELECT * INTO v_move FROM stock_moves WHERE id = p_move_id AND state = 'draft';
    IF NOT FOUND THEN RAISE EXCEPTION 'Move not found or not in draft'; END IF;

    -- Lock quants involucrados (orden consistente para evitar deadlocks)
    PERFORM 1 FROM stock_quants
    WHERE (sku_id = v_move.sku_id AND location_id = v_move.src_location_id)
       OR (sku_id = v_move.sku_id AND location_id = v_move.dst_location_id)
    ORDER BY location_id
    FOR UPDATE;

    -- Decrementar origen (si es ubicación interna)
    UPDATE stock_quants
    SET on_hand_qty = on_hand_qty - v_move.quantity, updated_at = now()
    WHERE sku_id = v_move.sku_id AND location_id = v_move.src_location_id
      AND location_id IN (SELECT id FROM locations WHERE usage = 'internal');

    -- Incrementar destino (si es ubicación interna)
    INSERT INTO stock_quants (sku_id, location_id, on_hand_qty)
    VALUES (v_move.sku_id, v_move.dst_location_id, v_move.quantity)
    ON CONFLICT (sku_id, location_id) DO UPDATE
    SET on_hand_qty = stock_quants.on_hand_qty + v_move.quantity,
        updated_at = now()
    WHERE v_move.dst_location_id IN (SELECT id FROM locations WHERE usage = 'internal');

    -- Marcar move como done
    UPDATE stock_moves SET state = 'done', confirmed_at = now() WHERE id = p_move_id;
END;
$$ LANGUAGE plpgsql;
```

### Concurrencia: escenario "dos ventas simultáneas, últimas 3 unidades"

Este es el escenario crítico. Cuatro patrones en PostgreSQL, ordenados por recomendación:

**1. SELECT FOR UPDATE (recomendado para tu escala):**

```sql
-- Transacción A (quiere 2 unidades)
BEGIN;
SELECT on_hand_qty - reserved_qty AS available
FROM stock_quants WHERE sku_id = $1 AND location_id = $2
FOR UPDATE;                          -- BLOQUEA la fila
-- available = 3, ok para 2
UPDATE stock_quants SET reserved_qty = reserved_qty + 2 ...;
COMMIT;                              -- stock: 3 on_hand, 2 reserved, 1 available

-- Transacción B (quiere 2 unidades, concurrente)
BEGIN;
SELECT ... FOR UPDATE;               -- ESPERA hasta que A haga commit
-- Ahora ve: available = 1
-- 1 < 2 → RECHAZAR, stock insuficiente
ROLLBACK;
```

**2. UPDATE atómico con condición (alternativa más simple):**

```sql
UPDATE stock_quants
SET reserved_qty = reserved_qty + 2, updated_at = now()
WHERE sku_id = $1 AND location_id = $2
  AND (on_hand_qty - reserved_qty) >= 2
RETURNING *;
-- Si 0 rows affected → stock insuficiente
```

Este patrón es atómico por definición en PostgreSQL. **Es la opción más simple y suficiente para 500-2000 SKUs.**

**3. Advisory locks (para ledger append-only sin fila que lockear):**

```sql
SELECT pg_advisory_xact_lock(hashtext('sku:' || $sku_id));
-- Serializa todo acceso a ese SKU dentro de la transacción
```

**4. SERIALIZABLE isolation (más pesado, maneja invariantes complejas):**

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;
-- PostgreSQL SSI detecta conflictos read-write automáticamente
-- Una transacción gana, la otra recibe ERROR 40001 y debe reintentar
```

**Para Supabase + Next.js con 500-2000 SKUs**: usar **UPDATE atómico con condición** como primera línea de defensa + **CHECK constraint** como safety net. Solo escalar a `SELECT FOR UPDATE` si necesitas lógica compleja entre el read y el write.

### JSONB para metadata extensible

Usar JSONB para datos que varían por marketplace o categoría, manteniendo columnas fijas para lo que se consulta frecuentemente:

```sql
CREATE TABLE products (
    id          UUID PRIMARY KEY,
    sku         TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    price       NUMERIC(12,2) NOT NULL,     -- fija: se filtra/ordena
    weight_kg   NUMERIC(8,3),               -- fija: cálculo de envío
    category_id UUID,                        -- fija: FK

    -- JSONB para lo flexible
    attributes      JSONB DEFAULT '{}',      -- {"color":"rojo","material":"algodón"}
    marketplace_meta JSONB DEFAULT '{}',     -- {"mercadolibre":{"item_id":"MLC123","category_id":"MLC1234"}}
    variant_attrs   JSONB DEFAULT '{}'       -- {"talla":"XL","color":"azul"}
);

-- GIN index para queries de containment
CREATE INDEX idx_products_attrs ON products USING GIN (attributes jsonb_path_ops);
-- B-tree expression index para hot keys
CREATE INDEX idx_products_color ON products ((attributes->>'color'));
```

**Regla práctica**: si un campo JSONB se usa en WHERE/JOIN más de 3 veces por segundo, promoverlo a columna fija. PostgreSQL 12+ soporta **generated columns** para la transición suave.

### Vistas materializadas para métricas

```sql
-- Stock por ubicación (refrescar cada 5 min)
CREATE MATERIALIZED VIEW mv_stock_summary AS
SELECT q.sku_id, p.sku, p.name, q.location_id, l.name AS location_name,
       q.on_hand_qty, q.reserved_qty,
       q.on_hand_qty - q.reserved_qty AS available_qty
FROM stock_quants q
JOIN products p ON p.id = q.sku_id
JOIN locations l ON l.id = q.location_id
WHERE l.usage = 'internal';

CREATE UNIQUE INDEX ON mv_stock_summary(sku_id, location_id);

-- Refrescar concurrently vía pg_cron (no bloquea reads)
SELECT cron.schedule('refresh-stock-summary', '*/5 * * * *',
    'REFRESH MATERIALIZED VIEW CONCURRENTLY mv_stock_summary');
```

Para **500-2000 SKUs × 1-3 bodegas = máximo 6000 filas** en la vista materializada. A esta escala, incluso un `REFRESH` completo toma milisegundos. Las MVs son más valiosas para dashboards y reportes; las queries operacionales (reservación, despacho) deben ir directo a `stock_quants`.

---

## Esquema PostgreSQL recomendado para tu WMS

```sql
-- === CORE ENTITIES ===
-- products, locations (con jerarquía y usage), warehouses, channels

-- === INVENTARIO ===
-- stock_quants: saldos actuales (sku × location), mutable
-- stock_moves: ledger de movimientos, append-only cuando state='done'
-- stock_operations: agrupa moves (equivalente a pickings/material documents)
-- reservations: soft y hard, con expiración

-- === COMERCIAL ===
-- purchase_orders + lines: OCs con estado y qty recibida
-- orders + lines: ventas de todos los canales
-- channel_config: buffer de seguridad y config de sync por canal
-- channel_listings: mapeo sku → listing de marketplace

-- === INTEGRACIONES ===
-- sync_log: registro de sincronizaciones con marketplaces
-- webhook_events: raw payloads de ML para debugging
```

**Verificación de integridad (ejecutar periódicamente):**

```sql
-- Verificar que saldos coincidan con ledger
SELECT q.sku_id, q.location_id, q.on_hand_qty AS cached,
       COALESCE(SUM(CASE
           WHEN m.dst_location_id = q.location_id THEN m.quantity
           WHEN m.src_location_id = q.location_id THEN -m.quantity
       END), 0) AS from_ledger,
       q.on_hand_qty - COALESCE(SUM(...), 0) AS discrepancy
FROM stock_quants q
LEFT JOIN stock_moves m ON m.state = 'done'
    AND (m.src_location_id = q.location_id OR m.dst_location_id = q.location_id)
    AND m.sku_id = q.sku_id
WHERE q.location_id IN (SELECT id FROM locations WHERE usage = 'internal')
GROUP BY q.sku_id, q.location_id, q.on_hand_qty
HAVING q.on_hand_qty != COALESCE(SUM(...), 0);
-- Debe retornar 0 filas
```

---

## Lo que ningún tutorial dice

Tres insights que emergen solo al comparar los cuatro ERPs:

**La partida doble en inventario no es opcional, es la base de la integridad.** SAP y Odoo la implementan a nivel de stock; ERPNext y NetSuite la delegan al GL. Para un sistema propio sin módulo contable integrado, implementarla a nivel de stock (estilo Odoo) brinda auto-verificación gratuita: la suma de stock en ubicaciones internas + virtuales siempre debe ser cero relativo al inicio.

**SAP S/4HANA eliminó las tablas de saldos** (MARD/MARC son vistas CDS sobre MATDOC). Este es el movimiento más audaz en diseño de inventario empresarial reciente. Demuestra que el ledger append-only es suficiente como fuente única de verdad — pero solo funciona bien con un motor columnar in-memory. En PostgreSQL row-store, el patrón híbrido (ERPNext/pgledger) es más pragmático.

**La sobreventa multicanal es un problema de latencia, no de software.** Ningún ERP lo resuelve perfectamente porque la raíz es que los marketplaces no ofrecen APIs de reservación — solo actualizaciones de stock eventual. El safety buffer (publicar `available - N`) es la mitigación universal. Configurar N=1 para SKUs con alta rotación y N=2-3 para SKUs con bajo stock es el equilibrio pragmático entre maximizar ventas y minimizar cancelaciones. La métrica clave es el **oversell rate**: apuntar a < 0.1% de órdenes canceladas por falta de stock.