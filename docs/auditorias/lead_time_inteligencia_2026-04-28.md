# Auditoría Lead Time en Inteligencia — 2026-04-28

Auditor: agente Claude (Mac, sesión `vicenteelias`).
Alcance: `src/lib/intelligence.ts`, `src/lib/intelligence-queries.ts`, `src/lib/rampup.ts`,
`src/lib/reposicion.ts`, `src/components/AdminCompras.tsx`, `src/components/AdminInteligencia.tsx`,
`src/app/api/intelligence/recalcular/route.ts`, `src/app/api/intelligence/actualizar-lead-times/route.ts`,
migraciones `supabase-v15-sku-intelligence.sql`, `supabase-v24-proveedor-catalogo.sql`,
`supabase-v72-proveedores-canonico.sql`, manuales `docs/manuales/inventarios/*.md`,
y datos reales en producción (Supabase, queries SELECT).

Solo lectura. Ningún archivo de código/datos fue modificado.

---

## Resumen ejecutivo

**Total hallazgos: 18** — 2 RIESGO_DATO, 4 DISONANCIA_NUMÉRICA, 4 DISONANCIA_CONCEPTUAL, 3 GAP, 2 HUÉRFANO, 3 DEUDA_OPERACIONAL.

**Estado real del campo `proveedores.lead_time_*` (queries SQL)**
- Total proveedores activos: **86 / 86**.
- `lead_time_fuente='oc_real'`: **0**.
- `lead_time_fuente='manual'`: **2** (Idetex, Container) — ambos `lead_time_dias=5`, `sigma=1.5`, `muestras=0`.
- `lead_time_fuente='fallback'`: **84** — 80 con `lead_time_dias=7`, 4 con `lead_time_dias=5`.
- Proveedores con `muestras >= 3`: **0**.
- OCs con `lead_time_real` poblado: **0 de 5** (4 ANULADA, 1 RECIBIDA_PARCIAL — ninguna llegó a estado CERRADA).
- `productos.lead_time_dias`: **511 / 511 = 7** (default, ningún SKU editado manual).
- `sku_intelligence.lead_time_fuente`: 507 manual_proveedor con `lead_time_usado_dias=5`, 2 manual_proveedor con `lead_time_usado_dias=7`. **0 con `oc_real`**, **0 con `manual_producto_legacy`**, **0 con `fallback_default`**.

**Top 3 hallazgos críticos**
1. **(RIESGO_DATO / DEUDA) La rama `oc_real` del motor nunca se ejecuta en producción.** El cron `/api/intelligence/actualizar-lead-times` corre semanal (lunes 12 UTC) pero `queryLeadTimeReal` filtra por `estado IN ('RECIBIDA','CERRADA')` con `fecha_recepcion NOT NULL` — y la única vía que pobla esos campos es `cerrarOC()` en `AdminCompras.tsx:491-530`, que el operador no usa (todas las 53 recepciones COMPLETADAS de Idetex llegaron por App Etiquetas escribiendo directo a `recepciones`, sin pasar por `ordenes_compra`).
2. **(RIESGO_DATO) No existe sincronización OC.lead_time_real → proveedores.lead_time_dias.** Confirmado por consulta a `information_schema.triggers` (10 triggers totales, ninguno toca `proveedores` ni `ordenes_compra` para LT). El cron es la única ruta y falla por (1). Aun si OCs se cerraran, `cerrarOC()` solo escribe `lead_time_real` a la cabecera de la OC, no notifica al proveedor canónico.
3. **(DISONANCIA_NUMÉRICA) Idetex, 78 % del catálogo (398/511 SKUs), tiene `lead_time_dias=5` con `muestras=0` y `fuente='manual'`** mientras los 4 manuales BANVA citan repetidamente "Idetex 30–45d" o "Idetex LT 5 semanas" como ejemplo canónico. El motor calcula SS y ROP de toda la operación con un LT 6× a 9× más corto que el del manual.

---

## 1. Mapa de tablas y columnas

| Tabla.columna | Tipo | Default | Rol | Escritor | Lector | Frecuencia escritura |
|---|---|---|---|---|---|---|
| `productos.lead_time_dias` | integer | **7** | LT por SKU (legacy, pre-Fase B). | UI: `AdminCompras.tsx:1029-1037` (input editable). Migración v15 ALTER. | `queryProductos` → `intelligence-queries.ts:165`; `intelligence.ts:934` (`prod?.lead_time_dias || 7`); `intelligence.ts:1817` (rama `manual_producto_legacy`). | Manual ad-hoc. |
| `proveedores.lead_time_dias` | numeric | **5** | LT canónico por proveedor (Fase B). | UI: `AdminCompras.tsx:170` (botón guardar). Cron: `actualizar-lead-times/route.ts:42`. | `queryProveedores` → `intelligence-queries.ts:511-512`; `resolverLeadTime` → `intelligence.ts:1810-1814`. | Cron lunes 12 UTC + UI manual. |
| `proveedores.lead_time_sigma_dias` | numeric | **1.5** | σ_LT canónica por proveedor. | Igual que arriba. | Igual que arriba. | Igual. |
| `proveedores.lead_time_fuente` | text | `'fallback'` | Etiqueta: `oc_real \| manual \| fallback`. | Igual. UI fija `"manual"` (`AdminCompras.tsx:173`); cron fija `"oc_real"` (`actualizar-lead-times/route.ts:44`). | Igual. | Igual. |
| `proveedores.lead_time_muestras` | integer | **0** | Cantidad de OCs reales que respaldan el LT. | Igual. | `resolverLeadTime` usa `>=3` como gate (1810). | Igual. |
| `proveedores.lead_time_updated_at` | timestamptz | `now()` | Auditoría. | Igual. | UI `AdminCompras.tsx:1050`. | Igual. |
| `ordenes_compra.lead_time_real` | integer | NULL | LT observado de UNA OC. | UI: `AdminCompras.tsx:515` (sólo en `cerrarOC`). | `queryLeadTimeReal` → `intelligence-queries.ts:541-553`. | Sólo al cerrar OC manualmente. |
| `sku_intelligence.lead_time_real_dias` | numeric | NULL | Cache: LT promedio observado, sólo si fuente=`oc_real`. | `recalcular/route.ts:516`. | UI `AdminInteligencia.tsx`. | Cron diario 11 UTC + ad-hoc. |
| `sku_intelligence.lead_time_real_sigma` | numeric | NULL | Cache: σ_LT real. | Igual. | Igual. | Igual. |
| `sku_intelligence.lead_time_usado_dias` | numeric | NULL | Cache: LT efectivo del cálculo. | Igual. | UI; `generarHistoryRows` (`intelligence.ts:2268`). | Igual. |
| `sku_intelligence.lead_time_fuente` | text | NULL | Cache: rama de cascada activada. | Igual. | UI badge (`AdminInteligencia.tsx:1668`). | Igual. |
| `sku_intelligence.lt_muestras` | integer | NULL | Cache: muestras del proveedor de origen. | Igual. | UI. | Igual. |
| `sku_intelligence_history.lead_time_usado_dias` | numeric | NULL | Histórico para auditoría. | `insertHistorySnapshots` vía `generarHistoryRows`. | Análisis manual. | Snapshot diario. |

**Tablas/columnas NO encontradas** que el manual sugeriría:
- No hay `lt_p95`, `lt_max_observado`, `lt_otif`, `cv_lt`, ni `lead_time_demand`. El manual Parte 2 §6.7 KPI #19 (“Idetex lead time CV”) no tiene columna correlativa.

**Triggers Postgres**: verificado contra `information_schema.triggers` — los 10 triggers existentes son sobre `ml_campaigns_daily_cache`, `ml_resumen_mensual`, `ml_snapshot_mensual`, `productos` (margin cache), `rcv_compras`, `stock`. **Ninguno toca LT ni propaga datos entre `ordenes_compra` / `proveedores` / `productos` / `sku_intelligence`.**

**RPCs**: verificado contra `information_schema.routines` — sólo `ultima_venta_por_sku_origen`. No hay RPC que toque LT.

**Migraciones SQL identificadas (grep `lead_time` en `supabase-v*.sql`)**:
- `supabase-v15-sku-intelligence.sql:253` — crea `productos.lead_time_dias integer DEFAULT 7`.
- `supabase-v24-proveedor-catalogo.sql:74` — crea `ordenes_compra.lead_time_real integer` (nullable).

**No se encontró migración SQL versionada** que agregue `lead_time_dias`/`lead_time_sigma_dias`/`lead_time_fuente`/`lead_time_muestras`/`lead_time_updated_at` a `proveedores`. La columna existe en producción pero no aparece en ningún `supabase-v*.sql`. Es **deuda de schema** (probablemente ALTER aplicado vía SQL editor sin guardar el archivo).

---

## 2. Cascada del motor (`resolverLeadTime`)

Citas literales — `intelligence.ts:1801-1820`:

```
1801  function resolverLeadTime(prodInput: ProductoInput | undefined): {…} {
1807    const provNombre = (prodInput?.proveedor || "").trim();
1808    const provData = provNombre ? proveedoresLT.get(provNombre) : undefined;
1809
1810    if (provData && provData.lead_time_fuente === "oc_real" && provData.lead_time_muestras >= 3) {
1811      return { dias: provData.lead_time_dias, sigma_dias: provData.lead_time_sigma_dias, fuente: "oc_real", muestras: provData.lead_time_muestras };
1812    }
1813    if (provData) {
1814      return { dias: provData.lead_time_dias, sigma_dias: provData.lead_time_sigma_dias, fuente: "manual_proveedor", muestras: provData.lead_time_muestras };
1815    }
1816    // Fallback a productos.lead_time_dias si difiere del default 7 (señal de que fue editado manual)
1817    if (prodInput?.lead_time_dias && prodInput.lead_time_dias !== 7) {
1818      return { dias: prodInput.lead_time_dias, sigma_dias: 0.30 * prodInput.lead_time_dias, fuente: "manual_producto_legacy", muestras: 0 };
1819    }
1820    return { dias: 5, sigma_dias: 1.5, fuente: "fallback_default", muestras: 0 };
1821  }
```

| Branch | Condición | Datos en producción |
|---|---|---|
| `oc_real` | `provData.lead_time_fuente='oc_real'` AND `muestras >= 3` | **0 SKUs** (0 proveedores cumplen el predicado). |
| `manual_proveedor` | `provData` existe (cae aquí TODO proveedor activo, sin importar fuente). | **509 SKUs** (todos los con sku_intelligence). |
| `manual_producto_legacy` | `prod.lead_time_dias != 7` | **0 SKUs** (los 511 productos están en 7 default). |
| `fallback_default` | proveedor no encontrado en mapa. | **0 SKUs** persistidos. |

**Observación**: el branch 2 `manual_proveedor` se traga el caso `fuente='fallback'` también — `provData` existe en `proveedoresLT` para los 84 proveedores fallback, así que `r.lead_time_fuente="manual_proveedor"` aunque la realidad es que **vienen del default `lead_time_dias=5/7` con `muestras=0`**. La etiqueta "manual_proveedor" miente: en 84 casos no es manual, es fallback maquillado. El UI chip ⚠ LT no medido (`AdminInteligencia.tsx:1668`) sólo cuenta `lead_time_fuente === "fallback_default"` y nunca dispara — los 509 SKUs están "verdes" en LT por etiqueta, pero σ_LT real desconocida.

---

## 3. En qué afecta el LT

### 3.1 Safety stock simple — `intelligence.ts:1846`

```
1846  const ssSimple = round2(Z * sigmaD * Math.sqrt(ltSem));
1847  r.safety_stock_simple = ssSimple;
1848  r.stock_seguridad = ssSimple;          // se preserva el campo viejo
```

Fórmula: `Z × σ_D × √(LT/7)`. Sin σ_LT. Manual la admite como simplificación cuando σ_LT es 0 (BANVA_SPM_Benchmark_Plan.md:595).

### 3.2 Punto de reorden legacy — `intelligence.ts:1849`

```
1849  r.punto_reorden = round2((D * ltSem) + ssSimple);
```

Este `punto_reorden` es **además** la base de la alerta `urgente` (línea 2108):

```
2108  if (r.cob_full < r.punto_reorden && r.cob_full < 999) alertas.push("urgente");
```

donde `cob_full` es **días** y `punto_reorden` es **unidades** — comparación con unidades distintas (`cob_full` viene de `calcularCobertura`, devuelve días, `intelligence.ts:1943`). Es un bug latente, no del LT puro, pero si LT cambia, `punto_reorden` cambia y la alerta se mueve.

### 3.3 Safety stock completo — `intelligence.ts:1853-1856`

```
1853  if (sigmaD > 0 || sigmaLtSem > 0) {
1854    const ssCompleto = round2(Z * Math.sqrt(ltSem * sigmaD * sigmaD + D * D * sigmaLtSem * sigmaLtSem));
1855    r.safety_stock_completo = ssCompleto;
1856    r.safety_stock_fuente = "formula_completa";
```

Fórmula: `Z × √(LT × σ_D² + D² × σ_LT²)`. Idéntica a Manual_Inventarios_Parte1.md:507 y BANVA_ERP_Patrones_Inventario.md:357. **509 / 509 SKUs vivos terminan con `safety_stock_fuente='formula_completa'`**. Es la fórmula prescrita por todos los manuales.

### 3.4 ROP nuevo — `intelligence.ts:1862`

```
1862  r.rop_calculado = round2((D * ltSem) + r.safety_stock_completo);
```

Idéntico a Manual_Inventarios_Parte1.md:557 (`ROP = D × LT + SS`).

### 3.5 `necesita_pedir` — `intelligence.ts:1868-1869`

```
1868  const stockTotal = r.stock_full + r.stock_bodega + r.stock_en_transito;
1869  r.necesita_pedir = stockTotal <= r.rop_calculado && D > 0;
```

Dispara la alerta `necesita_pedir` (`intelligence.ts:2094`) y el chip "📦 Pedir ya" (`AdminInteligencia.tsx:1691`). En producción: 36 SKUs vivos.

### 3.6 `cantidad_objetivo` y `pedir_proveedor` — `intelligence.ts:1935-1939`

```
1935  const demandaCicloUds = velParaPedir * r.target_dias_full / 7;
1936  const cantidadObjetivo = demandaCicloUds + r.safety_stock_completo;
1938  r.pedir_proveedor = Math.max(0, Math.ceil(cantidadObjetivo - stockTotalR));
```

`cantidadObjetivo` mezcla `target_dias_full` (40/28/14 según ABC, `intelligence.ts:384-389`) con `safety_stock_completo` (que sí depende de LT). Si LT real fuera 30d y el motor usa 5d, **safety_stock_completo está subestimado en proporción a `√(LT_real × σ_D² + D² × σ_LT_real²)/√(LT_modelo × σ_D² + 0²)`** — del orden de 4× a 8× para Idetex bajo el supuesto manual.

### 3.7 `mandar_full` — `flex-full.ts` vía `intelligence.ts:1913-1925`

`calcularEstadoFlexFull` recibe `target_dias_full`, no `lead_time_usado_dias`. **`mandar_full` NO usa LT** directamente. Confirma: el LT no afecta la decisión de despacho a Full (sólo afecta `pedir_proveedor`).

### 3.8 Rampup post-quiebre — `rampup.ts`

`calcularFactorRampup(diasEnQuiebre, esQuiebreProveedor)` — input es `dias_en_quiebre`, no LT. **Rampup NO usa LT**. Lo que sí pasa es que `pedir_proveedor` (que sí depende de LT) se multiplica por `factor_rampup_aplicado` después (`intelligence.ts:1994`). LT y rampup son ortogonales.

### 3.9 Alertas `urgente` y `agotado_pedir` — `intelligence.ts:2108`, búsqueda

```
2108  if (r.cob_full < r.punto_reorden && r.cob_full < 999) alertas.push("urgente");
```

Sí usa el `punto_reorden` legacy (3.2). Como ese se calcula con LT cascada (1849), LT afecta la alerta `urgente`. Datos prod: 11 SKUs.

### 3.10 Cobertura, GMROI, DIO, target_dias

Todo ese conjunto **NO depende de LT**. Sólo lee `cob_full = stock/vel × 7` y similares.

### 3.11 Trabajo desperdiciado — `intelligence.ts:1241-1246`

```
934   const leadTimeDias = prod?.lead_time_dias || 7;
1241  const leadTimeSemanas = leadTimeDias / 7;
1244  const Z = zScore(nivelServicio);   // 0.95 hardcoded
1245  const stockSeguridad = Z * stdSemanal * Math.sqrt(leadTimeSemanas);
1246  const puntoReorden = (velPonderada * leadTimeSemanas) + stockSeguridad;
…
1559  stock_seguridad: round2(stockSeguridad),
1560  punto_reorden: round2(puntoReorden),
```

Estos `stockSeguridad` y `puntoReorden` se calculan por SKU **antes** del paso 12 con el LT crudo de productos (siempre 7 hoy) y nivel de servicio fijo 0.95. Luego en `intelligence.ts:1846-1849` se sobrescriben con la cascada y el Z por ABC. **Las líneas 1241-1246 son código muerto/redundante** — el resultado siempre se reemplaza, pero la asignación inicial dispara el `round2` y va al objeto SkuIntelRow con un valor que nunca se usa. Es cleanup de paso 12 pendiente desde la migración Fase B.

---

## 4. Sincronización entre tablas

Diagrama de flujo real (verificado):

```
                                              ┌──────────────┐
                                              │ App Etiquetas│ (banva1, escritura directa)
                                              └──────┬───────┘
                                                     │ INSERT recepciones (53 cerradas)
                                                     ▼
                                            ┌────────────────┐
                                            │  recepciones   │ (sin orden_compra_id en la mayoría)
                                            └────────┬───────┘
                                                     │ vincular manual UI?
                                                     ▼
                                            ┌────────────────┐
   UI manual (AdminCompras.tsx:170)─────────▶│   ordenes_     │
   ─────────────────────────────────────────▶│    compra      │
   AdminCompras.tsx:491-530 cerrarOC():       │  +.lead_time_  │
     calcula (ultima_recep − fecha_emision)   │   real        │
     escribe lead_time_real a la cabecera.    └────────┬───────┘
   En producción: 0 OCs CERRADA.                       │
                                                       │ cron lunes 12 UTC
                                                       ▼
                                       queryLeadTimeReal() agrupa por proveedor
                                            │ filtra estado IN ('RECIBIDA','CERRADA')
                                            │ ya muestras<3 → skip
                                            │ ya muestras>=3 → upsert
                                                       ▼
                                            ┌─────────────────┐
   UI manual (AdminCompras.tsx:170)─────────▶│   proveedores  │
   ─────────────────────────────────────────▶│  +.lead_time_  │
                                            │  *_dias/sigma/  │
                                            │  fuente/muestras│
                                            └────────┬───────┘
                                                     │ queryProveedores (cron diario 11 UTC + manual)
                                                     ▼
                                            ┌────────────────┐
                                            │ proveedoresLT  │ (Map en memoria del recalc)
                                            └────────┬───────┘
                                                     │ resolverLeadTime → cascada
                                                     ▼
                                            ┌────────────────┐
                                            │ sku_           │
                                            │  intelligence  │
                                            │  +.lead_time_* │
                                            └────────────────┘
                                                     │ snapshot diario
                                                     ▼
                                            sku_intelligence_history
                                            (lead_time_usado_dias)
```

**Sincronizaciones ausentes (verificadas)**:
1. `recepciones → ordenes_compra` salvo vinculación manual UI (`AdminCompras.tsx:480-489`).
2. `ordenes_compra.lead_time_real → proveedores.lead_time_dias` salvo cron semanal con gate `muestras>=3`.
3. `productos.lead_time_dias` no se actualiza desde nada — sólo input UI manual. Hoy 511/511 = 7 (ningún SKU editado).
4. **No hay backflow `proveedores → productos`** — si algún día Idetex se mide en 30 días, los 398 productos de Idetex seguirían diciendo 7 hasta edición manual.
5. **Triggers Postgres**: 0 sobre LT. RPCs Postgres LT: 0. Confirmado contra `information_schema.triggers` y `information_schema.routines`.

---

## 5. Hallazgos detallados

### H01 — [CRÍTICO] [DEUDA_OPERACIONAL] Rama `oc_real` nunca se ejecuta

- **Código**: `intelligence-queries.ts:541-545`:
  ```
  const { data } = await sb.from("ordenes_compra")
    .select("proveedor, fecha_emision, fecha_recepcion")
    .in("estado", ["RECIBIDA", "CERRADA"])
    .not("fecha_recepcion", "is", null)
    .not("fecha_emision", "is", null);
  ```
  y `actualizar-lead-times/route.ts:26`: `if (stats.muestras < 3) skipped.push(...)`.
- **Datos**: 0 OCs CERRADA, 0 con `fecha_recepcion`, 0 con `lead_time_real`.
- **Manual**: BANVA_SPM_Benchmark_Plan.md:720 “Refrescar `sku_economics.lt_dias_avg` cada vez que llegue un OC midiendo días reales.”
- **Diferencia**: el sistema sí prevé esto, pero requiere que el operador cierre OCs en UI. App Etiquetas (banva1) inserta en `recepciones` directo sin pasar por `ordenes_compra`. Resultado: la única vía operativa para alimentar `lead_time_real` está apagada.
- **Impacto**: 509/509 SKUs corren con LT manual/fallback, σ_LT=1.5 fija. La promesa “fórmula completa con σ_LT real” se cumple sólo en la fórmula, no en los datos.
- **Fix sugerido**: o bien (a) automatizar en banva1 la apertura de OC al recibir factura y cierre al `COMPLETADA`, o (b) reemplazar `queryLeadTimeReal` para inferir LT desde `recepciones` (gap entre creación de OC más reciente y `recepciones.created_at` por proveedor) si la entrada de OCs sigue siendo manual.

### H02 — [CRÍTICO] [RIESGO_DATO] No existe sincronización OC.lead_time_real → proveedores

- **Código**: `cerrarOC` en `AdminCompras.tsx:491-530` actualiza sólo la fila de `ordenes_compra` (línea 512-518). No llama a ningún update sobre `proveedores`.
- **Datos**: confirmado vía `information_schema.triggers` — 0 triggers tocan `proveedores` cuando se actualiza `ordenes_compra`.
- **Manual**: inventory-policy.md Regla 5: “fuente única canónica + lecturas derivadas”. Si la fuente única es OC.lead_time_real, debería derivarse `proveedores` como vista o mantenerse sync explícita y testeada. Hoy son dos campos paralelos sin sync.
- **Diferencia**: aún si H01 se resolviera y OCs se cerraran, `proveedores.lead_time_dias` sólo se mueve por el cron semanal (`actualizar-lead-times/route.ts:42`), no por escritura directa de OC. Una OC cerrada el martes 12:01 UTC tarda hasta 6 días en propagar al motor.
- **Impacto**: latencia de 0–6 días entre cerrar OC y que `sku_intelligence` lo vea, durante la cual `safety_stock_completo` está calculado con LT obsoleto.
- **Fix sugerido**: en `cerrarOC` (después de línea 518), invocar el endpoint cron o disparar un recalculo del LT del proveedor afectado. O mejor, mover la cascada a una vista materializada con `REFRESH` post-cierre.

### H03 — [CRÍTICO] [DISONANCIA_NUMÉRICA] Idetex LT=5d vs manual 30–45d / 5 semanas

- **Código**: `proveedores.lead_time_dias=5, sigma=1.5, fuente='manual', muestras=0` (verificado por SELECT).
- **Manual**: BANVA_Manual_Inventarios_Parte1.md:51 “Idetex tarda 30–45 días en entregar un quilt”; Parte 1 línea 561 “LT promedio Idetex = 5 semanas”; Parte 1 línea 516 “Para Idetex (lead time 30–45 días), σ_LT no es despreciable”.
- **Diferencia**: 6× a 9× más bajo que el rango canónico del manual. Idetex cubre 398/511 = 78 % del catálogo.
- **Impacto numérico** (estimado con la fórmula del manual P1.4.4.1):
  - Si LT real = 35d (5 semanas) y σ_LT real = 7d: `safety_stock_completo` aumentaría a `Z × √(35/7 × σ_D² + D² × (7/7)²)` = `Z × √(5σ_D² + D²)`. Vs el modelo actual `Z × √(5/7 × σ_D² + 0)` = `Z × σ_D × 0.85`.
  - Para LICAAFVIS5746 (top de la lista por ROP): D=25.8/sem, σ_D=15.2/sem. SS actual=26.26. SS con LT=5sem y σ_LT=1sem: `1.65 × √(5×231 + 666×1)` = `1.65 × √1821` = 70.4 unidades. Drift estimado: **+170 % en SS, +200 % en ROP** para el top SKU.
  - Extrapolado a 110 SKUs con `pedir_proveedor>0`: subestimación agregada de orden 4× a 8× en cantidades de pedido inicial (sin contar rampup).
- **Manual cruza**: BANVA_SPM_Benchmark_Plan.md:602 “Domestic CL genérico: 7-21 días, σ_LT 2-5”. Aún el escenario optimista (Idetex doméstico, no importado) es 7–21d, no 5d.
- **Fix sugerido**: Vicente decide. Si Idetex real es <5d (compra Just-in-Time documentada, no en manuales), el código está OK y el manual desactualizado — actualizar manual. Si Idetex real es 30–45d, actualizar `proveedores.lead_time_dias` para Idetex (manual ad-hoc), y registrar `lead_time_sigma_dias` con muestras de las 53 recepciones reales.

### H04 — [ALTO] [RIESGO_DATO] El branch `manual_proveedor` se traga a los 84 fallback

- **Código**: `intelligence.ts:1813-1814`:
  ```
  if (provData) {
    return { dias: provData.lead_time_dias, sigma_dias: provData.lead_time_sigma_dias, fuente: "manual_proveedor", muestras: provData.lead_time_muestras };
  }
  ```
- **Datos**: 84 / 86 proveedores tienen `lead_time_fuente='fallback'` en la tabla `proveedores`, pero `sku_intelligence` los registra todos como `lead_time_fuente='manual_proveedor'` (507/509 + 2/509 con LT=7 — todos `manual_proveedor`). El UI chip ⚠ LT no medido (`AdminInteligencia.tsx:1668`) sólo cuenta `fuente === "fallback_default"` y nunca dispara.
- **Manual**: inventory-policy.md Regla 1 (no centinelas) y Regla 5 (fuente única). La etiqueta `manual_proveedor` miente al UI: oculta que el dato es default.
- **Diferencia**: el motor pierde la distinción entre “proveedor con LT manualmente calibrado por Vicente” y “proveedor con default 7d que nadie tocó”.
- **Impacto**: Vicente cree que tiene 509 SKUs con LT calibrado manual y 0 sin medir. Realidad: 2 manuales, 507 con LT default `fallback`.
- **Fix sugerido**: en `resolverLeadTime`, propagar `provData.lead_time_fuente` literal cuando no es `oc_real`, en vez de re-etiquetar todo como `manual_proveedor`. La cascada quedaría: `oc_real` (con muestras≥3) → `manual` (literal del proveedor) → `fallback` (literal del proveedor) → `manual_producto_legacy` → `fallback_default`.

### H05 — [ALTO] [DISONANCIA_NUMÉRICA] Default 7 (productos) vs default 5 (resto)

- **Código**: 4 defaults distintos para el mismo concepto:
  - `productos.lead_time_dias` DEFAULT **7** (`supabase-v15-sku-intelligence.sql:253`).
  - `proveedores.lead_time_dias` DEFAULT **5** (no encontrado en migraciones; verificado contra `information_schema.columns`).
  - `intelligence-queries.ts:165`: `(p.lead_time_dias as number) || 7` — fallback 7.
  - `intelligence-queries.ts:523`: `row.lead_time_dias || 5` — fallback 5.
  - `intelligence.ts:934`: `prod?.lead_time_dias || 7` — fallback 7.
  - `intelligence.ts:1820`: `return { dias: 5, sigma_dias: 1.5, fuente: "fallback_default", muestras: 0 }` — fallback 5.
- **Manual**: Regla 1 inventory-policy (no múltiples valores mágicos para el mismo concepto).
- **Diferencia**: el sistema lee 7 desde productos, 5 desde proveedores, y el branch legacy en 1817 sólo dispara si productos≠7 — gate cosmético (la migración v15 puso default 7). El branch que cae al fallback 5 (1820) nunca dispara hoy porque el query trae los 86 proveedores en el Map.
- **Impacto**: latente. Si un día se cambia el default DDL o se agrega proveedor nuevo, el motor podría girar entre 5 y 7 según ruta de carga.
- **Fix sugerido**: declarar default canónico (5 o 7), aplicar UPDATE masivo, y dropear el fallback `|| 7` en `queryProductos`.

### H06 — [ALTO] [DISONANCIA_CONCEPTUAL] σ_LT default constante 1.5 contradice manual

- **Código**: `proveedores.lead_time_sigma_dias` DEFAULT 1.5; `intelligence.ts:1820` usa σ=1.5 en fallback; `intelligence.ts:1818` deriva σ=`0.30 × LT` (CV=0.30) en la rama legacy.
- **Manual**: BANVA_Manual_Inventarios_Parte2.md:350 “CV del lead time = σ_LT / LT promedio. … Si CV > 0,3, tu proveedor es inestable y necesitas más safety stock”. Idetex está en 5d con σ=1.5d → CV=**0.30**, exactamente el umbral. Si LT real fuera 35d con σ=1.5d (default) → CV=0.043 (muy estable, irreal). Si σ real fuera 7d → CV=0.20.
- **Diferencia**: el default σ=1.5 es razonable cuando LT≈5d, pero pierde sentido cuando LT cambia. La rama legacy `0.30 × LT` mantiene CV constante 0.30 — al menos coherente.
- **Impacto**: si H03 se corrige a Idetex LT=35d sin tocar σ, σ_LT=1.5d será absurdamente bajo, y `safety_stock_completo` quedará subestimado.
- **Fix sugerido**: σ_LT default debe escalar con LT (CV constante hasta tener muestras). Reemplazar default DDL por trigger que setee σ=0.25×LT al insertar.

### H07 — [ALTO] [GAP] Manual prescribe CV_LT como métrica reportable, código no la calcula ni almacena

- **Manual**: BANVA_Manual_Inventarios_Parte2.md:378 KPI #19 “Idetex lead time CV — Frecuencia mensual — Owner Vicente — Benchmark CM 0.15 — Mínimo OK 0.4 — BANVA target 12m 0.25”.
- **Código**: ninguna columna `cv_lt` en `proveedores` ni en `sku_intelligence`. Ninguna función calcula `σ_LT / LT`.
- **Diferencia**: el manual la lista como KPI #19 de los 25 KPIs del dashboard único. Implementación cero.
- **Fix sugerido**: añadir vista `v_proveedor_kpis` con `cv_lt = lead_time_sigma_dias / lead_time_dias` y exponerla en `AdminCompras` (tabla de proveedores ya tiene la columna `lead_time_muestras`, sólo falta el ratio). Sin código nuevo backend, sólo SQL view + render.

### H08 — [ALTO] [GAP] Manual prescribe diferenciar OTIF de LT, código no lo hace

- **Manual**: BANVA_Manual_Inventarios_Parte2.md:377 KPI #18 “Idetex OTIF — Mensual — target 90 %”. Parte 3 línea 275 “Medición de OTIF y σ_LT de Idetex con OCs históricas”.
- **Código**: ninguna columna ni función calcula OTIF. `pct_cumplimiento` (en `ordenes_compra` v24:76) mide cumplimiento de cantidad, no de fecha. `lead_time_real` es la única métrica temporal y se mide como `recepcion − emision` plana, sin tolerancia.
- **Fix sugerido**: agregar `fecha_esperada` ya existe (`ordenes_compra.fecha_esperada` v24, verificado con SELECT). Calcular OTIF = OCs cerradas con `fecha_recepcion <= fecha_esperada AND pct_cumplimiento >= 100`. Persistir como columna en `proveedores`.

### H09 — [MEDIO] [DISONANCIA_CONCEPTUAL] Doctrina AZ del manual no se implementa en el motor

- **Manual**: BANVA_SPM_Benchmark_Plan.md:267 “Lokad/Thieuleux warning crítico: AZ NO debe ir a z=2.33. Carrying cost es prohibitivo. Atacar con respuesta (LT corto), no con buffer.” Tabla 9-cell líneas 258-259, 586-595.
- **Código**: `intelligence.ts:1825-1828`:
  ```
  let ns = 0.95;
  if (r.abc === "A") ns = 0.97;
  else if (r.abc === "C") ns = 0.90;
  ```
  Sólo dimensión ABC. **No usa XYZ** para nivel de servicio. AZ y AX terminan con el mismo Z=1.88.
- **Diferencia**: manual prescribe matriz 9-cell ABC×XYZ con NS distinto por celda y “LT corto” como herramienta para AZ. Código no respeta la matriz ni penaliza/promueve LT.
- **Impacto**: SKUs AZ heredan el mismo SS que AX, pero con σ_D más alto, así que `safety_stock_completo` ya es mayor — no es bug, es subóptimo. La parte “atacar con LT corto” no se ejecuta porque el motor no tiene mecanismo para sugerir cambio de proveedor.
- **Fix sugerido**: extender `nivel_servicio` a leer XYZ (`intelligence.ts:1828` agregar branches por cuadrante). Es DEUDA conocida documentada en `inteligencia_vs_manuales_2026-04-28.md`.

### H10 — [MEDIO] [DISONANCIA_NUMÉRICA] zScore tabla de servicio truncada vs manual

- **Código**: `intelligence.ts:536-539`:
  ```
  if (nivel >= 0.97) return 1.88;
  if (nivel >= 0.95) return 1.65;
  return 1.28;
  ```
- **Manual**: BANVA_Manual_Inventarios_Parte1.md:529-538 lista 7 niveles (90, 95, 97, 98, 99, 99.5, 99.9).
- **Diferencia**: el código clipea a tres niveles. NS=0.99 prescrito por el manual para AX (línea 545) **no es alcanzable** con la función `zScore` actual — devuelve 1.88 cuando el manual quiere 2.33.
- **Fix sugerido**: ampliar la tabla. Trivial, una línea por nivel.

### H11 — [MEDIO] [HUÉRFANO] Cálculo de SS y ROP en líneas 1241-1246 es código muerto

- **Código**: `intelligence.ts:1241-1246` calcula `stockSeguridad` y `puntoReorden` con `leadTimeDias = prod?.lead_time_dias || 7` y `nivelServicio = 0.95` hardcoded; el resultado se asigna en `intelligence.ts:1559-1560`. **Pero** en `intelligence.ts:1846-1849` (paso 12 SS por ABC) los mismos campos `r.stock_seguridad` y `r.punto_reorden` son sobrescritos con `ssSimple` (que usa `lt.dias` de la cascada y Z por ABC).
- **Diferencia**: el cómputo de 1241-1246 es desperdiciado siempre. Si la cascada falla por algún motivo, la fila quedaría con valores intermedios distintos a los del recálculo final.
- **Impacto**: bajo (CPU desperdiciado por SKU × SKUs). Pero confunde lectura del código y arrastra el centinela `7` en una ruta que ya no manda.
- **Fix sugerido**: borrar líneas 1244-1246 (preservar 1241 si se reusa `leadTimeSemanas`); inicializar `stock_seguridad` y `punto_reorden` en 0 en el constructor del row, dejar que paso 12 los rellene.

### H12 — [MEDIO] [DEUDA_OPERACIONAL] Cron actualizar-lead-times no reporta health

- **Código**: `actualizar-lead-times/route.ts:53-59` retorna `{ ok: true, …, actualizados: aplicados }`. No actualiza `ml_sync_health` (a diferencia de `recalcular/route.ts:76-89` que sí).
- **Manual**: `inventory-policy.md` Regla 4 “Endpoints con branches deben ser observables”. Aquí hay branches (`muestras<3 → skip` vs `>=3 → update`) y el endpoint los expone, pero la TABLA de health no.
- **Impacto**: si el cron falla 6 lunes consecutivos (red, error sb), nadie se entera. Hoy el cron retorna 200 con `actualizados: 0` siempre y eso es indistinguible de funcional.
- **Fix sugerido**: instrumentar `ml_sync_health.actualizar_lead_times` con `last_success_at`, `consecutive_failures`, `actualizados_last_run`.

### H13 — [MEDIO] [HUÉRFANO] Migración SQL de `proveedores.lead_time_*` no existe

- **Código**: `proveedores.lead_time_dias / sigma / fuente / muestras / updated_at` existen en producción (verificado vía `information_schema.columns`). Pero `grep "lead_time" supabase-v*.sql` solo trae v15 (productos) y v24 (ordenes_compra). v72 (`proveedores-canonico`) tiene `ALTER TABLE proveedores` para nombre/aliases, no para LT.
- **Manual**: `CLAUDE.md` líneas 50-58 “107 archivos `supabase-v*.sql` … migraciones manuales, ejecutadas en SQL Editor”. La regla implícita: toda columna en producción debe tener migración versionada.
- **Diferencia**: schema drift entre prod y repo. Si alguien recrea la base desde cero, las columnas LT del proveedor no aparecerían.
- **Fix sugerido**: crear `supabase-v91-proveedores-lt-fields.sql` con los `ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS …` reales. No cambia prod (IF NOT EXISTS), sólo deja registro.

### H14 — [BAJO] [DISONANCIA_CONCEPTUAL] LT entrada al motor es por proveedor, no por SKU

- **Código**: `resolverLeadTime` recibe sólo `prodInput`, lee `prodInput.proveedor` y de ahí va al Map. No considera que un SKU puede tener LT distinto al de su proveedor "principal" (e.g. ítem importado vs nacional, mismo proveedor pero distinto SKU).
- **Manual**: `BANVA_SPM_Benchmark_Plan.md:712` “Proveedor Idetex, LT=10 días, σ_LT=2” — el manual sí trata LT por proveedor, pero también referencia `sku_economics.lt_dias_avg` (línea 720), implicando granularidad por SKU.
- **Diferencia**: motor está a nivel proveedor; manual sugiere granularidad SKU para casos especiales (importaciones).
- **Fix sugerido**: cuando `productos.lead_time_dias != 7` (señal de override por SKU), respetarlo. Hoy el branch `manual_producto_legacy` en `intelligence.ts:1817` ya hace eso, pero llega después de `manual_proveedor`. Reordenar: SKU manual override → proveedor.

### H15 — [BAJO] [GAP] No hay alerta de proveedor con CV_LT > 0.3

- **Manual**: BANVA_Manual_Inventarios_Parte2.md:350 “Si CV > 0,3, tu proveedor es inestable y necesitas más safety stock”.
- **Código**: ninguna alerta en `intelligence.ts:2076-2156` chequea CV_LT.
- **Fix sugerido**: agregar alerta `proveedor_lt_inestable` cuando `(provData.lead_time_sigma_dias / provData.lead_time_dias) > 0.3 AND provData.lead_time_muestras >= 5`.

### H16 — [BAJO] [DEUDA_OPERACIONAL] LT del proveedor se muta sin auditoría histórica

- **Código**: el cron `actualizar-lead-times/route.ts:42-49` hace UPDATE in place. UI (`AdminCompras.tsx:170`) también UPDATE in place. No hay tabla `proveedores_history` ni columnas `prev_lead_time_dias` / `cambio_motivo`.
- **Manual**: BANVA_Manual_Inventarios_Parte3.md:241 “Fórmula completa de safety stock implementada como función SQL” + Parte 2 §6.7 “Owner explícito, frecuencia clara”.
- **Diferencia**: si LT salta de 5 a 30 (porque se cierran 3 OCs cerca y el promedio salta), no hay evidencia. Vicente vería SS sextuplicarse de un día a otro sin explicación.
- **Fix sugerido**: tabla `proveedores_lt_history(proveedor_id, fecha, lead_time_dias_anterior, lead_time_dias_nuevo, sigma_anterior, sigma_nuevo, muestras, fuente)` con INSERT en cada UPDATE.

### H17 — [BAJO] [HUÉRFANO] Branch `manual_producto_legacy` solo se activa si `lead_time_dias != 7`

- **Código**: `intelligence.ts:1817`: `if (prodInput?.lead_time_dias && prodInput.lead_time_dias !== 7)`.
- **Datos**: 511 / 511 productos están en 7. La rama nunca dispara.
- **Diferencia**: la lógica está pero está apagada por construcción del default.
- **Fix sugerido**: cambiar la condición a “lead_time fue editado manualmente” usando `productos.updated_at` o un flag explícito `lead_time_manual=true`.

### H18 — [BAJO] [DISONANCIA_NUMÉRICA] `targetDias` hardcodeado 40/28/14 vs manual

- **Código**: `intelligence.ts:384-389`:
  ```
  cobObjetivo: 40,
  cobMaxima: 60,
  targetDiasA: 42,
  targetDiasB: 28,
  targetDiasC: 14,
  ```
- **Manual**: BANVA_SPM_Benchmark_Plan.md:631 “pre-posicionar 30-60 días de cobertura en Full”. Parte 1 línea 568 ejemplo Idetex usa LT=5 sem=35d, sin override de target.
- **Diferencia**: target_dias es independiente de LT en el motor. Si Idetex pasa a LT=35d y target_dias_A=42d, `cantidadObjetivo = velFull × 42/7 + SS` apenas cubre 1 ciclo de LT — operación al filo, sin colchón de revisión.
- **Fix sugerido**: target_dias debería ser ≥ 1.5 × LT (regla práctica: cubrir LT más medio ciclo de revisión).

---

## 6. Datos reales verificados

Queries ejecutadas (resumen). Todas con `SELECT`, sin escritura.

### 6.1 Distribución de fuentes en `proveedores`

```sql
SELECT lead_time_dias, lead_time_fuente, COUNT(*) FROM proveedores GROUP BY 1,2;
```
| `lead_time_dias` | `lead_time_fuente` | count |
|---|---|---|
| 7 | fallback | 80 |
| 5 | fallback | 4 |
| 5 | manual | **2** (Idetex, Container) |

### 6.2 OCs con LT real

```sql
SELECT estado, COUNT(*), COUNT(lead_time_real) FROM ordenes_compra GROUP BY estado;
```
| estado | count | con `lead_time_real` |
|---|---|---|
| ANULADA | 4 | 0 |
| RECIBIDA_PARCIAL | 1 | 0 |
| **CERRADA** | **0** | **0** |

### 6.3 Productos con LT por bucket

```sql
SELECT lead_time_dias, COUNT(*) FROM productos GROUP BY 1;
```
| `lead_time_dias` | count |
|---|---|
| 7 | **511** (100 %) |

### 6.4 sku_intelligence por fuente y LT efectivo

```sql
SELECT lead_time_fuente, lead_time_usado_dias, COUNT(*) FROM sku_intelligence GROUP BY 1,2;
```
| `lead_time_fuente` | `lead_time_usado_dias` | count |
|---|---|---|
| manual_proveedor | 5 | 507 |
| manual_proveedor | 7 | 2 |

`lead_time_real_dias` IS NULL en 509 / 509 — **0 SKUs en `oc_real`**.

### 6.5 Distribución de proveedor por SKUs físicos y su LT

```sql
SELECT p.proveedor, p2.lead_time_dias, p2.lead_time_fuente, p2.lead_time_muestras, COUNT(*) AS skus
FROM productos p LEFT JOIN proveedores p2 ON p.proveedor=p2.nombre
GROUP BY p.proveedor, p2.lead_time_dias, p2.lead_time_fuente, p2.lead_time_muestras
ORDER BY skus DESC;
```
| Proveedor | LT días | fuente | muestras | SKUs | % catálogo |
|---|---|---|---|---|---|
| Idetex | 5 | manual | 0 | 398 | 78 % |
| Otro | 5 | fallback | 0 | 87 | 17 % |
| Verbo Divino | 5 | fallback | 0 | 13 | 2.5 % |
| Materos | 5 | fallback | 0 | 6 | 1.2 % |
| Container | 5 | manual | 0 | 4 | 0.8 % |
| LG | 5 | fallback | 0 | 1 | — |
| EMP. PERIODISTICA | 7 | fallback | 0 | 1 | — |
| Textiles VJ | 7 | fallback | 0 | 1 | — |

### 6.6 Recepciones reales (App Etiquetas) por proveedor

```sql
SELECT proveedor, COUNT(DISTINCT recepciones.id), MIN(created_at::date), MAX(created_at::date)
FROM productos JOIN recepcion_lineas USING(sku) JOIN recepciones ON recepciones.id = recepcion_lineas.recepcion_id
GROUP BY proveedor;
```
| Proveedor | Recepciones | Primera | Última |
|---|---|---|---|
| Idetex | 63 | 2026-02-26 | 2026-04-27 |
| Verbo Divino | 3 | 2026-02-26 | 2026-04-16 |
| Materos | 4 | 2026-03-06 | 2026-04-28 |
| Container | 0 | — | — |

### 6.7 Gap entre recepciones de Idetex (proxy de frecuencia, NO de LT)

```sql
WITH r AS (SELECT created_at::date AS f FROM recepciones WHERE proveedor='Idetex'),
g AS (SELECT f - LAG(f) OVER (ORDER BY f) AS gap FROM r)
SELECT COUNT(*), MIN(gap), MAX(gap), AVG(gap), STDDEV(gap), PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY gap)
FROM g WHERE gap IS NOT NULL;
```
- N = 61 gaps. min=0d, max=7d, avg=0.92d, σ=1.80d, p50=0d, p95=6d.
- **Atención**: estos son gaps entre _recepciones_, no LT (emisión OC → recepción). Sirven como cota inferior — Vicente recibe de Idetex casi a diario, lo que sugiere que el LT real es relativamente corto (no 35d como dice el manual). Pero requiere validar qué fracción de esas recepciones es entrega completa vs reposición parcial.

### 6.8 KPIs del motor afectados por LT

```sql
SELECT COUNT(*) FILTER(WHERE accion='URGENTE') AS urg, COUNT(*) FILTER(WHERE accion='AGOTADO_PEDIR') AS ago,
       COUNT(*) FILTER(WHERE necesita_pedir) AS np, COUNT(*) FILTER(WHERE pedir_proveedor>0) AS pp,
       AVG(safety_stock_completo), AVG(rop_calculado), AVG(punto_reorden)
FROM sku_intelligence WHERE vel_ponderada > 0;
```
| URGENTE | AGOTADO_PEDIR | necesita_pedir | pedir_proveedor>0 | SS_avg | ROP_avg | ROP_legacy_avg |
|---|---|---|---|---|---|---|
| 11 | 7 | 36 | 110 | 2.85 | 4.62 | 4.40 |

---

## 7. Mapa de cobertura manual → código

| Concepto del manual | Cita | Implementado | Cómo |
|---|---|---|---|
| SS = z × σ_D × √LT (simple) | Manual P1.4.4.1 / SPM 595 | ✅ | `intelligence.ts:1846` |
| SS = z × √(LT × σ_D² + D² × σ_LT²) (completo) | Manual P1.4.4.1 / ERP 357 | ✅ | `intelligence.ts:1854` |
| ROP = D × LT + SS | Manual P1.4.4.5 | ✅ | `intelligence.ts:1862` |
| z table 90/95/97/98/99/99.5/99.9 | Manual P1.4.4.3 | ⚠ parcial | sólo 90/95/97 (`intelligence.ts:536-539`) |
| Service level por cuadrante ABC×XYZ | Manual P1.4.4.4 / SPM 258 | ⚠ parcial | sólo ABC (`intelligence.ts:1825-1828`) |
| Doctrina “AZ → atacar con LT corto, no buffer” | SPM 267, 586 | ❌ | sin mecanismo |
| Medir σ_LT con OCs últimos 12m | Manual P3 #275 | ⚠ implementado, sin datos | `queryLeadTimeReal` |
| OTIF mensual | Manual P2 #18 | ❌ | sin columna ni función |
| CV_LT mensual | Manual P2 #19 | ❌ | sin columna ni vista |
| Min/max dinámico (recalcular diario) | Manual P1.4.7 | ✅ | cron diario `recalcular?full=true&snapshot=true` |
| Refresh `lt_dias_avg` cada vez que llega OC | SPM 720 | ⚠ parcial | sólo via cron semanal |
| Multi-echelon (cycle stock en Full, SS en bodega) | Manual P1.4.5 / SPM 631 | ⚠ no como tal | `mandar_full` sí pero no MEIO formal |
| Política (s, Q) o (s, S) para A | Manual P1.4.3 | ✅ implícita | `pedir_proveedor` recalcula objetivo |
| Lead time CV alerta | Manual P2:350 | ❌ | sin alerta |
| Backorder rate | Manual P2.6.5.3 | n/a | MELI no tiene backorder |

---

## 8. Pendientes que requieren al usuario

1. **Decisión H03 (Idetex 5d vs manual 30–45d)**: ¿el LT operativo de Idetex realmente es ~5d (compra spot en Santiago) y el manual está desactualizado, o es 30–45d para el ciclo de fabricación-entrega? Sin esa respuesta no se puede recalibrar `proveedores.lead_time_dias`.
2. **Decisión H02 (sync OC→proveedor)**: ¿se acepta latencia de hasta 6 días vía cron semanal, o se quiere update inmediato al cerrar OC? Define cuán urgente es invertir en backflow.
3. **Decisión H01 / banva1**: ¿Vicente quiere cerrar OCs en UI (flujo actual no usado) o reemplazar el origen de LT por las recepciones reales (App Etiquetas)? Define si `queryLeadTimeReal` debe leer de `recepciones` en vez de `ordenes_compra`.
4. **Decisión H09 (matriz 9-cell)**: ¿Vicente quiere implementar NS por XYZ (extender `intelligence.ts:1825-1828` con la matriz BANVA_SPM 586-595), o el motor sigue con NS sólo por ABC?
5. **Decisión H07 / H08 / H15**: ¿se quieren implementar los KPIs #18 (OTIF) y #19 (CV_LT) del manual P2? Es trabajo SQL+UI, ~4-6h.
6. **Decisión H05 (default 5 vs 7)**: cuál fijar como canónico para proveedores nuevos. Hoy hay drift entre productos (7) y proveedores (5).
7. **Decisión H13 (migración SQL faltante)**: ¿generar `supabase-v91-proveedores-lt-fields.sql` retroactivo? No cambia prod, solo deja registro.

---

## Notas finales

Crons relevantes (`vercel.json`):
- `0 12 * * 1` → `/api/intelligence/actualizar-lead-times` (semanal, lunes 9 AM Chile).
- `0 11 * * *` → `/api/intelligence/recalcular?full=true&snapshot=true` (diario, 8 AM Chile). Lee `proveedoresLT` ya recalculado.

UI relevante:
- `AdminCompras.tsx:1029-1050` — tabla editable de LT por proveedor (input number + sigma + fuente badge).
- `AdminCompras.tsx:615-619` — muestra `lead_time_real` de OC seleccionada cuando está cerrada.
- `AdminInteligencia.tsx:1668, 1696` — chip “⚠ LT no medido” (cuenta `fallback_default`, hoy nunca dispara por H04).

Archivos NO modificados durante la auditoría. Solo Read + SELECT.
