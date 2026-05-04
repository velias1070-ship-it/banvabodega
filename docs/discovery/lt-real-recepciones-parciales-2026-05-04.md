---
discovery: lt-real-recepciones-parciales
date: 2026-05-04 PM
owner: Vicente Elías
mode: read-only
tags: [discovery] [lt-real] [recepciones-parciales]
related:
  - project_banva_lt_real_gap (memoria)
  - reference_factura_etiquetas_app (memoria)
  - .claude/rules/app-etiquetas.md
  - .claude/rules/inventory-policy.md (Regla 5 — caso v93 cantidad_recibida)
---

# Discovery — Modelado de recepciones parciales y LT real por SKU

## TL;DR

1. **El universo de OCs en banvabodega es 6 (4 anuladas + 2 RECIBIDA_PARCIAL).** No es que el LT esté "vacío" — es que el modelo de OC está **estructuralmente sub-utilizado**. La planilla de OCs vive afuera (Sheets / informal) y solo OC-005/006 entraron al sistema.
2. **Las recepciones SÍ tienen granularidad evento-a-nivel-SKU**: `recepcion_lineas.ts_conteo` (timestamp por línea) + `recepciones.completed_at`. 686/855 líneas con `ts_conteo` pueblan ventana 2026-02-26 → 2026-05-04.
3. **El link OC↔recepción es casi inexistente**: 7/77 recepciones tienen `orden_compra_id`, **0/855 líneas tienen `orden_compra_linea_id`**. App Etiquetas no recibe info de OC al insertar (no es parte de su contrato actual).
4. **Backfill `lead_time_real` por OC global = correcto descartarlo.** El propio modelo de OCs es híbrido: cada línea puede recibirse en momentos distintos. La fórmula owner observó (`fecha_recepcion - fecha_emision`) colapsa parciales en un único punto y miente.
5. **Path correcto = LT real PER SKU PER OC**, calculado al nivel `(oc_id, sku_origen)` usando `MIN(rl.ts_conteo) - oc.fecha_emision`. El gap real son los datos faltantes, no la fórmula.
6. **Hoy con 2 OCs de muestra** (94 pares OC↔SKU reconstruibles) el LT promedio por SKU sería 2.9 días (rango 1.7-3.8). Demasiado poco universo para ningún cálculo robusto. Necesita más OCs antes de servir como dato.

---

## P1 — Schemas relevantes (estado real 2026-05-04)

### `ordenes_compra` (PK uuid)

Columnas relevantes:
- `id`, `numero` (texto: 'OC-001'..'OC-006')
- `fecha_emision` (date) — **2026-04-20** y **2026-04-28** las dos vivas.
- `fecha_esperada` (date) — set a mano por el owner.
- `fecha_recepcion` (date) — **NULL en las 2 RECIBIDA_PARCIAL**. Concebida como "fecha en que la OC quedó cerrada", pero al ser parciales nunca se completa.
- `lead_time_real` (numeric) — **NULL en TODAS** las 6 OCs. Nunca se popula desde código.
- `estado` (text) — `RECIBIDA_PARCIAL` (2), `ANULADA` (4). No hay OCs `CONFIRMADA`/`RECIBIDA`/`CERRADA` en prod.
- `proveedor` (text), `proveedor_id` (uuid FK)
- `recepcion_id` (uuid) — FK legacy a recepción única, **0/6 populated**.
- `total_recibido`, `pct_cumplimiento` — caches calculadas, no relevantes para LT.

### `ordenes_compra_lineas` (PK uuid)

- `id`, `orden_id` (FK), `sku_origen`
- `cantidad_pedida`, `cantidad_recibida` (cache mantenida por trigger v93 — no escribir desde app)
- `costo_unitario`, `abc`, `vel_ponderada`, `cob_total_al_pedir` (snapshot al emitir)
- `estado_linea` (text) — `'pendiente'` en las 80 líneas de OC-006, p.ej.

Total filas: 386 (de 6 OCs).

### `recepciones` (PK uuid)

- `id`, `folio`, `proveedor`, `proveedor_id`
- `imagen_url`, `factura_original` (jsonb, contiene OCR completo de Gemini)
- `estado` (text) — distribución vista: 58 COMPLETADA, 18 ANULADA, 1 EN_PROCESO.
- **`completed_at` (timestamptz)** — ventana 2026-03-05 → 2026-04-30. **58/77 con valor.**
- **`orden_compra_id` (uuid FK)** — **7/77 populated.** Solo set vía hand-off manual o algún flujo nuevo (no via App Etiquetas).
- `costo_neto`, `iva`, `bruto`, `notas`, `created_by` (= `'App Etiquetas'` casi siempre).

### `recepcion_lineas` (PK uuid)

- `id`, `recepcion_id` (FK), `sku` (uppercase), `codigo_ml`, `nombre`
- `qty_factura`, `qty_recibida`, `qty_etiquetada`, `qty_ubicada`
- **`ts_conteo` (timestamptz)** — momento físico del conteo línea-a-línea. **686/855 populated.** Earliest 2026-02-26, latest 2026-05-04.
- `estado` (text), `requiere_etiqueta`, `etiqueta_impresa`, `tiene_variantes`
- `sku_venta`, `costo_unitario`, `operario_*`
- **`orden_compra_linea_id` (uuid FK)** — **0/855 populated.** Columna existe pero ningún flujo la escribe.

### `movimientos` (fuente alternativa)

- `tipo='entrada'` con `motivo='recepcion'`: 709 movimientos, **689 con `recepcion_id`** (fuerte cobertura).
- Resto de motivos `entrada`: `transferencia_in` (319), `ajuste_entrada` (204), `carga_inicial` (204, todos 2026-02-26), `reasignacion_formato` (72), `devolucion` (33), `ajuste_conteo` (13), `ajuste` (3), `reversa_reset` (1).
- Ventana: 2026-02-26 → 2026-05-04.
- Útil como **fallback de timestamp** si `recepcion_lineas.ts_conteo` está NULL.

---

## P2 — Cómo se ve una OC parcial real (caso testigo OC-006)

OC-006:
- `numero=OC-006`, `proveedor=Idetex`, `proveedor_id=...`
- `fecha_emision=2026-04-28`, `fecha_esperada=2026-05-11`
- `fecha_recepcion=NULL`, `lead_time_real=NULL`
- `estado=RECIBIDA_PARCIAL`
- **80 líneas**, todas con `estado_linea='pendiente'`, `cantidad_recibida=0`.

JSAFAB422P20S específico (caso citado): `cantidad_pedida=8`, `cantidad_recibida=0`. **No tiene fila en `recepcion_lineas` linkeada todavía**. La OC se emitió pero nada del contenido llegó al sistema vía recepción aún.

OC-005 (idéntico patrón): `fecha_emision=2026-04-20`, `fecha_esperada=2026-04-23`, `fecha_recepcion=NULL`, `estado=RECIBIDA_PARCIAL`. Sí tiene 7 recepciones linkeadas vía `recepciones.orden_compra_id` (es la que aporta el universo de 94 pares).

**Lo que confirma el modelo "parcial real"**:
- Una sola OC tiene **N líneas → M recepciones**, cada una con fecha distinta (y a su vez la recepción tiene K líneas con `ts_conteo` distintos).
- `ordenes_compra.fecha_recepcion` está pensado como evento puntual y por eso se queda NULL para siempre cuando hay parciales.
- La unidad correcta de medición no es OC, es **(oc_id, sku_origen)**.

---

## P3 — Granularidad disponible

| Nivel | Campo | Tipo | Cobertura | Útil para |
|---|---|---|---|---|
| Recepción global | `recepciones.completed_at` | timestamptz | 58/77 (75%) | LT por recepción |
| Línea de recepción | `recepcion_lineas.ts_conteo` | timestamptz | 686/855 (80%) | **LT por SKU dentro de la recepción** |
| Movimiento físico | `movimientos.created_at` | timestamptz | 689/709 con `recepcion_id` | Fallback si `ts_conteo` NULL |
| OC (cabecera) | `ordenes_compra.fecha_emision` | date | 6/6 | Punto de partida del LT |
| OC (cabecera) | `ordenes_compra.fecha_recepcion` | date | 0/6 | **Inservible** (NULL en parciales) |

**Granularidad efectiva**: `recepcion_lineas.ts_conteo` resuelve por SKU+timestamp. Es lo bueno del modelo. Lo malo: no sabe a qué OC corresponde.

---

## P4 — `movimientos` como fuente alternativa

El stock real viene de `movimientos`. Para `entrada`:
- 709 con `motivo='recepcion'` y 689 con `recepcion_id` poblado → puede joinearse a `recepciones` y de ahí (si el FK existe) a `ordenes_compra`.
- No hay un `motivo='recepcion_oc'` discriminador. El motivo es siempre `'recepcion'`, indistinto de si vino vía App Etiquetas o flujo manual con OC.

**Conclusión**: `movimientos` no aporta información que `recepcion_lineas` no tenga. Usarlo solo como redundancia para verificar `qty_recibida` o cuando `ts_conteo` esté NULL.

---

## P5 — Coverage del link OC ↔ recepción

| Métrica | Valor | Comentario |
|---|---|---|
| Total OCs | 6 | 4 anuladas + 2 RECIBIDA_PARCIAL |
| OCs con `lead_time_real` | 0/6 | Nunca poblado |
| OCs con `fecha_recepcion` | 0/6 | NULL incluso post-parcial |
| OCs con al menos 1 recepción linkeada | 2/6 | OC-005, OC-006 |
| Recepciones totales | 77 | |
| Recepciones con `orden_compra_id` | **7/77 (9%)** | Resto sin link |
| Líneas de recepción totales | 855 | |
| Líneas con `orden_compra_linea_id` | **0/855 (0%)** | Columna inerte |
| Líneas con `ts_conteo` | 686/855 (80%) | Granularidad evento OK |
| SKUs con al menos 1 evento de recepción | 291/509 (57%) | Gran chunk del catálogo |
| SKUs con ≥2 eventos | 169/291 (58%) | Permitiría calcular LT promedio |
| SKUs con ≥3 eventos | 104/291 (36%) | Suficientes para outliers / mediana |
| Pairs (oc, sku) reconstruibles HOY | **94** | de 386 OC-líneas (24%) |

Por mes (recepciones):
- 2026-03: 30 recepciones, 0 con OC link, 30/30 con `proveedor_id`
- 2026-04: 28 recepciones, 7 con OC link (las 2 OCs vivas), 22/28 con `proveedor_id`

**Diagnóstico**: el modelo OC se empezó a usar en serio recién a fines de abril (OC-005, OC-006). Todo lo previo es estructuralmente huérfano.

---

## P6 — Propuesta de modelo correcto (no implementar — solo describir)

### Unidad canónica: `(oc_id, sku_origen)`

Cada línea de OC vive su propio LT. La cabecera no.

```sql
-- Concepto, no a ejecutar:
CREATE VIEW v_lt_real_sku_oc AS
SELECT
  oc.id AS oc_id,
  oc.numero,
  oc.fecha_emision,
  oc.proveedor_id,
  ocl.sku_origen,
  ocl.cantidad_pedida,
  ocl.cantidad_recibida,
  -- primera vez que hubo qty_recibida > 0 para este SKU dentro de las recepciones
  -- ligadas a la OC (sea via orden_compra_id directo o via match proveedor+SKU+ventana)
  MIN(rl.ts_conteo) AS first_recepcion_ts,
  -- LT primer-recepción
  EXTRACT(EPOCH FROM (MIN(rl.ts_conteo) - oc.fecha_emision::timestamptz))/86400 AS lt_first_dias,
  -- LT última-recepción (cierre real cuando hubo varios parciales)
  MAX(rl.ts_conteo) AS last_recepcion_ts,
  EXTRACT(EPOCH FROM (MAX(rl.ts_conteo) - oc.fecha_emision::timestamptz))/86400 AS lt_last_dias,
  COUNT(DISTINCT rl.recepcion_id) AS n_parciales,
  SUM(rl.qty_recibida) AS uds_recibidas
FROM ordenes_compra oc
JOIN ordenes_compra_lineas ocl ON ocl.orden_id = oc.id
LEFT JOIN recepciones r 
  ON r.orden_compra_id = oc.id  -- explicit link first
  OR (r.proveedor_id = oc.proveedor_id 
      AND r.completed_at::date BETWEEN oc.fecha_emision AND oc.fecha_emision + INTERVAL '90 days')
LEFT JOIN recepcion_lineas rl
  ON rl.recepcion_id = r.id
  AND UPPER(rl.sku) = UPPER(ocl.sku_origen)
  AND rl.qty_recibida > 0
GROUP BY oc.id, oc.numero, oc.fecha_emision, oc.proveedor_id, ocl.sku_origen, 
         ocl.cantidad_pedida, ocl.cantidad_recibida;
```

### Fallbacks ordenados (precedencia descendente)

1. **Explicit link**: `recepcion_lineas.orden_compra_linea_id IS NOT NULL` (futuro — hoy 0 cobertura).
2. **Recepción al OC**: `recepciones.orden_compra_id = oc.id` AND match SKU dentro de líneas.
3. **Heurística proveedor+SKU+ventana**: misma `proveedor_id`, mismo SKU, `completed_at` en `[fecha_emision, fecha_emision + 90d]`.

### Agregaciones derivadas (motor)

Una vez existe la vista (oc, sku):
- `lt_real_sku` = mediana de `lt_first_dias` por `sku_origen` (ignora outliers de OCs anuladas).
- `lt_real_p90_sku` = percentil 90 (para safety stock).
- `lt_proveedor` = mediana por `proveedor_id`.
- `lt_drift_status` = comparar `lt_real_sku` vs `productos.lead_time` declarado.

Esto reemplaza la columna inerte `ordenes_compra.lead_time_real` con datos derivados de líneas — fuente única canónica.

---

## P7 — Effort estimate y tradeoffs

### Lo que cuesta NADA implementar

- **Crear la vista `v_lt_real_sku_oc`** propuesta: ~30 min. Es read-only, sin schema change. Ya tiene la lógica clara.
- **Reportes SQL ad-hoc**: cero esfuerzo más allá de la vista.

### Lo que cuesta poco

- **Backfill `recepcion_lineas.orden_compra_linea_id`** matcheando por (recepcion.orden_compra_id, sku UPPER): ~1h SQL + dry-run. Solo aplica a las 7 recepciones con `orden_compra_id` poblado y los SKUs que matchean (~94 líneas potenciales). Idempotente.
- **Migración App Etiquetas (banva1)** para llamar `/api/oc/find-open` con `(proveedor_id, sku_factura[])` antes del insert: ~3h en `banva1/index.html` + endpoint nuevo en banvabodega. Pero **owner-flag**: requiere coordinar con la app externa (memoria `feedback_banvabodega_autonomy` no cubre repo hermano).

### Lo que NO se puede arreglar con SQL

- **Recepciones huérfanas históricas** (~70 recepciones pre-OC-005). Sin OC creada en sistema, no hay desde-cuándo medir. Esos eventos quedan como "gaps eternos" hasta que el modelo de OC se popule en serio.
- **Datos de marzo/abril temprano**: solo sirven para velocidad de venta (que ya las usa), no para LT.

### Tradeoffs operativos

- **Empezar a usar OCs en serio en banvabodega** > backfillear el pasado. El sistema aprende LT real desde el momento que las OCs entran. Forzar OC-creation en cada compra (vía UI admin) es prerequisito.
- **Heurística proveedor+SKU+ventana** funciona PERO genera falsos positivos cuando un SKU se compra a 2 proveedores distintos en ventanas solapadas. Filtrar por `proveedor_catalogo` (precio pactado) puede mitigar.
- **Datos de OCs anuladas no deben contar** para LT (nunca se recibieron). Filtrar `oc.estado != 'ANULADA'`.

### LT muestra actual (94 pares reconstruibles)

| Stat | Valor |
|---|---|
| Pares OC↔SKU reconstruibles | 94 |
| OCs únicas | 2 |
| SKUs únicos | 78 |
| LT promedio (días) | 2.9 |
| LT mediano | 2.9 |
| LT min | 1.7 |
| LT max | 3.8 |

Demasiado pocos datos para ningún cálculo robusto. **El cuello de botella es uso del módulo de OCs, no la fórmula.**

---

## Lo que NO se debe hacer (descartado explícitamente)

1. ❌ **Backfill global**: `UPDATE ordenes_compra SET fecha_recepcion = ..., lead_time_real = fecha_recepcion - fecha_emision`. Owner observó correctamente que distorsiona — el día de "fecha_recepcion" es la última parcial, no representativo.
2. ❌ **Promedios por proveedor sin desagregación SKU**: SKUs distintos del mismo proveedor llegan en momentos distintos. Promediar oculta el patrón.
3. ❌ **Inferir LT de productos sin evento histórico**: 218 SKUs (509 - 291) no tienen ninguna recepción registrada. No hay dato. Mantener `productos.lead_time` declarado para estos.
4. ❌ **Usar `productos.lead_time` declarado** como ground truth para validación. Es lo que el motor declaraba, no lo que pasó. Es justamente lo que queremos auditar.

---

## Próximos pasos sugeridos (no auto-ejecutables)

1. **Crear `v_lt_real_sku_oc`** (read-only, no schema change). Sirve para reportes inmediatos.
2. **Corre la vista** y mira distribución por proveedor cuando haya >5 OCs en sistema.
3. **Decidir si abrir UI banvabodega para OC-creation** (hoy depende de proceso manual). Sin esto el universo no crece.
4. **Coordinar banva1 → POST `/api/oc/find-open`** para autopoblar `recepcion_lineas.orden_compra_linea_id` en futuras recepciones (solo cuando exista una OC abierta del proveedor con el SKU de la factura).
5. **NO tocar `ordenes_compra.lead_time_real`** desde código nuevo. Marcar como **deprecada** en el schema y derivar todo de la vista.

---

## Lo que esto cierra del backlog

- Memoria `project_banva_lt_real_gap` se actualiza con el modelo correcto: el gap no es "lead_time_real está vacío", es "el modelo de OC está sub-utilizado **y** la columna de cabecera no es la unidad correcta".
- Sprint 4.2 expone el problema (vistas mostraban `lt_drift_status='sin_data'`); este discovery especifica el camino correcto sin proponer fix prematuro.

---

*Discovery ejecutado por Claude Opus 4.7 (1M context) el 2026-05-04 PM bajo
`feedback_banvabodega_autonomy`. Read-only — cero modificaciones a schema, datos
o código.*
