# Procedimiento recepción OC-005 (Idetex)

**Emitida:** 2026-04-20 · **Esperada:** 2026-04-23
**Proveedor:** Idetex · **Neto:** $7.097.896 · **Bruto:** $8.446.496
**49 SKUs · 663 unidades**

---

## Parte A — Manual para bodega (1 hoja para imprimir)

**TIEMPO TOTAL: ~3 horas.** Factura 5 min · Bodega 2-3 h · Vincular 1 min.

### Paso 1 — Registrar la factura (5 min)

1. App **Factura a Etiquetas** en celular/tablet.
2. Foto a la factura física.
3. Verificar que los SKUs y cantidades leídos coincidan con la factura.
4. Apretar **Enviar recepción al WMS**.
5. Imprimir las etiquetas que salen.

> En este paso el stock **no** sube todavía. Sólo quedó anotada la factura.

### Paso 2 — Contar, etiquetar, ubicar (2-3 h)

Entrar al celular a **banvabodega.vercel.app → Operador → PIN → Recepciones**.

Por cada SKU de la lista:

a. **Contar** la cantidad que bajó del camión.
b. **Pegar la etiqueta** en cada unidad.
c. **Escanear la posición** de bodega donde se guarda (B-5, A-3, etc.).

Al terminar el último SKU, la recepción queda **COMPLETADA** y el stock queda sumado en bodega.

### Paso 3 — Vincular la recepción a la OC-005 (30 segundos, NUEVO)

Desde el computador de la oficina:

1. **banvabodega.vercel.app/admin** → PIN admin → pestaña **Compras**.
2. Click sobre la fila **OC-005** (Idetex).
3. Botón azul arriba a la derecha: **Vincular recepción**.
4. Seleccionar la recepción recién cerrada (folio de la factura).
5. Confirmar.

### Paso 4 — Cerrar la OC

**Checklist antes de cerrar:**
- [ ] ¿Llegó **toda** la mercadería de OC-005 (las 663 uds)?
- [ ] Si sí → apretar **Cerrar OC** → confirmar.
- [ ] Si no, y todavía vienen más camiones → **NO cerrar**. Dejar la OC en `RECIBIDA_PARCIAL`. Cuando llegue la siguiente factura: repetir Paso 1, 2, 3 con esa factura nueva.

**Decisión final:**

> ¿Esta es la última recepción? → **Cerrar OC**
> ¿Falta stock por llegar? → **NO cerrar todavía**

---

### Recepciones parciales (si OC-005 llega en 2+ camiones)

Es muy probable que Idetex mande las 663 unidades en 2 o 3 despachos separados (distintos días/camiones). Procedimiento:

1. **Cada camión = su propia factura = su propia recepción en la app Etiquetas.** Hacer Pasos 1-3 completos para cada uno por separado.
2. Al vincular la primera recepción, OC-005 pasa automáticamente a `RECIBIDA_PARCIAL`.
3. **NO cerrar la OC** hasta que llegue el último camión.
4. Cuando llegue el último y se vincule, el sistema pasará la OC a `RECIBIDA`. Ahí sí se aprieta **Cerrar OC**.

**Limitación conocida (2026-04-21):** durante el período que la OC está en `RECIBIDA_PARCIAL`, el motor **sigue creyendo** que las 663 vienen en camino, aunque ya haya llegado la mitad. Esto puede llevar a recomendaciones erróneas si se miran reportes de inteligencia antes del cierre. **Avisar a Vicente** cuando se vincule la primera recepción parcial — él correrá manualmente el script de ajuste (doc Parte B.3) para que el motor vea la realidad intermedia.

Ver bug completo: `docs/banva-bodega-bug-cantidad-recibida-no-persiste.md`.

---

### Dato crítico — por qué el botón "Vincular" es importante

Mientras no aprietes **Vincular recepción**, el sistema sigue creyendo que las 663 unidades vienen en camino. Aunque estén físicamente en bodega, el motor puede recomendar pedir otra vez lo mismo a Idetex. Es el único paso que "le avisa" al sistema que ya llegó.

Es normal que durante las 2-3 horas del Paso 2 el sistema aún muestre las 663 en tránsito. No hay que alarmarse. El tránsito se limpia cuando se completa el Paso 3 **y se cierra la OC** (o cuando Vicente corre el ajuste manual en caso de parciales).

---

### Si algo falla

- **La app no lee bien la factura:** corregir los números a mano en la app antes de enviar al WMS.
- **El botón "Vincular recepción" no muestra la recepción:** verificar el nombre exacto del proveedor en la recepción ("Idetex" vs "IDETEX S.A."). Si no aparece igual → llamar a Vicente.
- **El botón da error:** no tocar nada más. El stock físico ya está sumado si se completó el Paso 2. Llamar a Vicente.
- **Llegó de más:** en el Paso 2 ingresar la cantidad real. El sistema registra el exceso.
- **Llegó incompleto:** cerrar igual el Paso 2 con lo que llegó. No cerrar la OC (Paso 4). Cuando venga el resto, repetir Paso 1-3 con la factura nueva.

**Contacto de emergencia:** Vicente — `{VICENTE_CELULAR}`.

---

## Parte B — Scripts SQL (solo Vicente)

**Dos casos de uso:**

- **B.1-B.2 emergencia:** si el botón "Vincular recepción" falla.
- **B.3 OBLIGATORIO en recepciones parciales:** tras cada vinculación si OC-005 llega en 2+ camiones, hasta que se aplique el fix del bug estructural. Sin este paso, el motor sigue viendo las 663 en tránsito aunque ya haya llegado parte (ver `docs/banva-bodega-bug-cantidad-recibida-no-persiste.md`).
- **B.4 opcional:** para cerrar la OC via SQL si el botón de UI falla.
- **B.5 opcional:** para disparar el recálculo del motor inmediatamente.

Ejecutar en Supabase SQL Editor.

### B.1 — Identificar la recepción a vincular

```sql
SELECT
  r.id,
  r.folio,
  r.created_at::timestamp(0) AS creada,
  r.proveedor,
  r.costo_bruto,
  r.estado,
  COUNT(rl.id) AS lineas,
  SUM(rl.qty_factura) AS uds_factura,
  SUM(rl.qty_recibida) AS uds_recibidas
FROM recepciones r
LEFT JOIN recepcion_lineas rl ON rl.recepcion_id = r.id
WHERE r.proveedor ILIKE '%idetex%'
  AND r.orden_compra_id IS NULL
  AND r.created_at >= now() - interval '7 days'
GROUP BY r.id, r.folio, r.created_at, r.proveedor, r.costo_bruto, r.estado
ORDER BY r.created_at DESC;
```

Anotar el `id` → `<REC_ID>`.

### B.2 — Vincular recepción a OC-005

```sql
UPDATE recepciones
SET orden_compra_id = '34abb464-2dbf-4edb-bd88-8214da237192'
WHERE id = '<REC_ID>';
```

### B.3 — Rellenar `cantidad_recibida` en las líneas de OC-005

```sql
UPDATE ordenes_compra_lineas ocl
SET cantidad_recibida = COALESCE(rec.qty, 0)
FROM (
  SELECT rl.sku, SUM(rl.qty_recibida) AS qty
  FROM recepcion_lineas rl
  JOIN recepciones r ON r.id = rl.recepcion_id
  WHERE r.orden_compra_id = '34abb464-2dbf-4edb-bd88-8214da237192'
  GROUP BY rl.sku
) rec
WHERE ocl.orden_id = '34abb464-2dbf-4edb-bd88-8214da237192'
  AND UPPER(ocl.sku_origen) = rec.sku;
```

### B.4 — Cambiar estado de OC-005 y calcular métricas

Si llegó **todo** lo pedido:

```sql
UPDATE ordenes_compra
SET
  estado = 'CERRADA',
  fecha_recepcion = CURRENT_DATE,
  lead_time_real = (CURRENT_DATE - fecha_emision),
  total_recibido = (
    SELECT COALESCE(SUM(cantidad_recibida), 0)
    FROM ordenes_compra_lineas
    WHERE orden_id = '34abb464-2dbf-4edb-bd88-8214da237192'
  ),
  pct_cumplimiento = (
    SELECT ROUND(
      SUM(cantidad_recibida)::numeric * 100 / NULLIF(SUM(cantidad_pedida), 0),
      1
    )
    FROM ordenes_compra_lineas
    WHERE orden_id = '34abb464-2dbf-4edb-bd88-8214da237192'
  )
WHERE id = '34abb464-2dbf-4edb-bd88-8214da237192';
```

Si llegó **parcial**:

```sql
UPDATE ordenes_compra
SET estado = 'RECIBIDA_PARCIAL'
WHERE id = '34abb464-2dbf-4edb-bd88-8214da237192';
```

### B.5 — Disparar recálculo del motor

```bash
curl -X POST https://banvabodega.vercel.app/api/intelligence/recalcular
```

Toma ~2 minutos.

---

## Parte C — Verificación post-recepción

### C.1 — Estado de la OC cambió

```sql
SELECT
  numero, estado, fecha_emision, fecha_recepcion, lead_time_real,
  total_recibido, pct_cumplimiento
FROM ordenes_compra
WHERE id = '34abb464-2dbf-4edb-bd88-8214da237192';
```

**Esperado:** `estado` = `CERRADA` o `RECIBIDA_PARCIAL`. `fecha_recepcion` = hoy. `lead_time_real` ≈ 3 (si llega 2026-04-23). `pct_cumplimiento` = 100 si completo.

### C.2 — Cumplimiento por SKU

```sql
SELECT
  sku_origen,
  nombre,
  cantidad_pedida,
  cantidad_recibida,
  (cantidad_pedida - cantidad_recibida) AS faltante,
  ROUND(cantidad_recibida::numeric * 100 / NULLIF(cantidad_pedida, 0), 1) AS pct
FROM ordenes_compra_lineas
WHERE orden_id = '34abb464-2dbf-4edb-bd88-8214da237192'
ORDER BY faltante DESC, cantidad_pedida DESC;
```

**Esperado:** todos `faltante = 0` si completo; si parcial identifica qué faltó.

### C.3 — Motor recalculó `stock_en_transito` a 0

```sql
SELECT
  sku_origen, nombre,
  stock_bodega, stock_full, stock_total,
  stock_en_transito, accion
FROM sku_intelligence
WHERE sku_origen IN (
  SELECT sku_origen FROM ordenes_compra_lineas
  WHERE orden_id = '34abb464-2dbf-4edb-bd88-8214da237192'
)
ORDER BY stock_en_transito DESC, sku_origen;
```

**Esperado:** `stock_en_transito = 0` en todos. `stock_bodega` aumentó. `accion` ya no es `EN_TRANSITO`.

### C.4 — Velocidad se mantiene (la velocidad se calcula con ventas, no con stock)

```sql
SELECT
  sku_origen, vel_ponderada, vel_pre_quiebre,
  clase_abc, xyz, datos_hasta
FROM sku_intelligence
WHERE sku_origen IN (
  SELECT sku_origen FROM ordenes_compra_lineas
  WHERE orden_id = '34abb464-2dbf-4edb-bd88-8214da237192'
)
ORDER BY vel_ponderada DESC;
```

**Esperado:** `datos_hasta` = hoy. `vel_ponderada` similar a pre-recepción.

### C.5 — Recepción quedó vinculada

```sql
SELECT id, folio, proveedor, estado, orden_compra_id, created_at
FROM recepciones
WHERE orden_compra_id = '34abb464-2dbf-4edb-bd88-8214da237192';
```

**Esperado:** una (o varias si parcial) filas con `orden_compra_id` seteado.

---

## Resumen ejecutivo

| Fase | Responsable | Tiempo | Herramienta |
|---|---|---|---|
| 1. Registrar factura | Joaquín | 5 min | App Etiquetas |
| 2. Ciclo bodega (49 SKUs) | Joaquín | 2-3 h | `/operador/recepciones` móvil |
| 3. Vincular a OC-005 | Vicho / Vicente | 30 seg | `/admin/compras` botón |
| 4. Cerrar OC | Vicente | 30 seg | `/admin/compras` botón |
| 5. Verificar (C.1-C.5) | Vicente | 5 min | Supabase SQL Editor |

**Total:** 2.5 a 4 horas, casi todo es el ciclo físico de bodega. La parte administrativa toma 1 minuto.

---

## Mensaje WhatsApp preview para Joaquín

Para enviar el martes 22 o miércoles 23 en la mañana:

```
Joa, el jueves 23 llega OC-005 de Idetex. Son 663 unidades
de 49 SKUs distintos.

Te paso mañana el procedimiento impreso. Lo clave:
cuando termines de contar + etiquetar + ubicar todo,
hay que entrar a banvabodega.vercel.app/admin → pestaña
Compras → abrir OC-005 → botón azul "Vincular recepción".
30 segundos.

Ese botón es nuevo, antes no se hacía. Si no lo apretás,
el sistema sigue creyendo que la mercadería no llegó y
puede pedir el mismo stock de nuevo.

Te lo explico bien mañana con el papel. Cualquier duda,
me escribís.
```

---

## Cómo imprimir

Abrir este archivo en VS Code (preview Markdown) o en el viewer de GitHub → `Cmd+P` → **Save as PDF** o imprimir directo. La Parte A cabe en una hoja A4.
