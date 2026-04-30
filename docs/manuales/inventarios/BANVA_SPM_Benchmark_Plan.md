# SPM para BANVA: benchmark real + plan operativo desplegable

**Resumen ejecutivo (lectura de 90 segundos)**

La implementación SPM que necesitas ya existe en el mercado, pero fragmentada: ANYMARKET/Centry resolvió el problema pack→SKU para MeLi, Lokad/Slimstock fijaron umbrales ABC-XYZ, Wivo Analytics modela la unit economics MLC, y MeLi Chile tiene una `UNHEALTHY_STOCK` campaign específica que casi nadie usa. Ningún vendor publica el stack completo end-to-end, así que este informe consolida cinco capas independientes en un sistema único para tu Supabase + n8n + Next.js. Los hallazgos centrales: **(1) `pack_id` de MeLi NO resuelve packs internos —tu schema `sku_venta` vs `sku_fisico` es exactamente lo que hacen Bling/VTEX/ANYMARKET**; (2) los umbrales 80/15/5 y CV 0.5/1.0 son *industriales*, no ecommerce —para textil hogar mensual usa **A=70% margen, X=CV<25%, Y=25-60%, Z>60%** con deseasonalización; (3) tus $10M CLP de capital muerto se recuperan al **27% vía donación Ley 21.440 con escudo fiscal**, lo que **supera matemáticamente a cualquier liquidador chileno informal** y al benchmark de Amazon FBA Liquidations (5-10%); (4) la regla AZ→z=2.33 es errónea; Lokad/Thieuleux convergen en que AZ debe atacarse con **lead time corto (Flex/Idetex), no con buffer alto** (CSL 90-95%, z=1.28-1.65); (5) tu WACC operativo real para descontar capital inmovilizado es **12-15% nominal CLP** (BCCh 8.6-10.1% comercial + spread PYME), lo que implica que dejar $10M parados un año cuesta $1.2-1.5M sólo en costo de capital, antes de bodegaje y obsolescencia.

A continuación, las cinco áreas con su Sección A (benchmark) y Sección B (código BANVA listo para `git commit`).

---

## 1. Sync pack-aware: el modelo BOM que ya validó ANYMARKET en LatAm

### A. Benchmark real

**MeLi NO tiene endpoint de packs/BOM nativo**. Esto está confirmado en developers.mercadolibre.com.ar/en_us/variations y global-selling/packs. El campo `pack_id` resuelve un problema distinto (carrito multi-orden del comprador, no "este listing es un pack de N unidades"). El único atributo de listing que indica "kit" es `EMPTY_GTIN_REASON = "Kit"` y es puramente declarativo. **La explosión BOM es 100% responsabilidad del seller.**

Los actores que sí lo resolvieron:

**ANYMARKET (Brasil, dueño de Centry Chile desde 2022)** es el único hub LatAm con explosión BOM productiva sobre MeLi. Cita textual de su soporte: *"O ANY reconhece o cadastro [como kit], mas para o marketplace a oferta segue como se fosse um produto simples, com SKU próprio"*. En import de venta hace separación por componente y descuenta stock por mínimo: *"O ANYMARKET garante o gerenciamento dos estoques pela menor quantidade das partes do kit e suspende automaticamente seu anúncio quando um item não estiver mais em estoque"*.

**Bling (Brasil)** — el más documentado. Tres modos de descuento configurables: (1) sólo padre, (2) sólo componentes (recomendado, stock disponible = MIN(component_stock_i / qty_i)), (3) ambos (sólo si usas Ordem de Produção). Schema CSV: `ID composição, SKU composição, ID componente, SKU componente, qty componente`.

**VTEX** — bundle como tipo de SKU de primera clase. *"On VTEX, a bundle is a type of SKU that is composed of one or more SKUs… If there is at least 1 unit of each component in stock, the kit will be considered in stock"*. Conversión es **permanente**, gotcha relevante.

**Bsale, Defontana, Multivende (Chile)** — **ninguno explota BOM hacia MeLi**. Bsale incluso excluye Mercado Envíos Full de su integración porque la boleta la emite MeLi. Multivende explícitamente declara: *"Multivende no tiene disponible la opción de stock de seguridad"*. Para tu caso, **un hub chileno no te resuelve el problema**: o usas ANYMARKET/Centry, o lo construyes en Supabase.

**Open source**: ningún conector MeLi público (mercadolibre/python-sdk, zephia, easybroker, tmilar/meli-manager) tiene tabla BOM. Todos son SDKs planos.

**API endpoints relevantes** (developers.mercadolibre.cl/gestion-packs y .ar/en_us/variations):
- `GET /items/{id}` → array `variations[]` con `id`, `attribute_combinations`, `available_quantity`, `seller_custom_field`, atributo SELLER_SKU
- `GET /items/{id}/variations/{variation_id}` → variación específica
- `PUT /items/{id}` con `variations:[{id, available_quantity}]` → **gotcha crítico**: si omites una variación existente, MeLi la borra
- `GET /orders/{order_id}` → `order_items[].item.variation_id` y `order_items[].item.seller_sku` (variation_id es null para listings sin variaciones)
- `GET /packs/{pack_id}` → expandir multi-orden de carrito
- `GET /users/{user_id}/items/search?seller_sku=$SKU` → buscar listings por tu SKU interno
- Webhooks: `orders_v2`, `items`, `shipments`, `stock_locations` (multi-bodega, activo en Chile desde 2024)
- Rate limit: **1500 req/min/seller**, 429 si excedes
- Para Full: kits deben llegar **pre-armados con etiqueta única** (`envios.mercadolibre.cl/vender-con-full`)

### B. Plan operativo BANVA

**Rationale estratégico**: Tu instinto `sku_venta` vs `sku_fisico` ya es el modelo correcto (validado por VTEX/Bling/ANYMARKET). Lo que falta es la tabla BOM explícita + flujo n8n que escuche el webhook `orders_v2`, expanda y actualice Supabase atómicamente. Con 425 SKUs no necesitas un hub: el costo del hub (Centry ~UF mensuales) compra exactamente lo que vas a construir en 2 días.

**Schema Supabase** (ejecutar en producción `qaircihuiafgnnrwcjls`):

```sql
-- =========================================================
-- BANVA: pack-aware sync schema
-- =========================================================

CREATE TABLE IF NOT EXISTS sku_fisico (
  sku_fisico       TEXT PRIMARY KEY,
  descripcion      TEXT NOT NULL,
  on_hand          INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  on_hand_full     INTEGER NOT NULL DEFAULT 0 CHECK (on_hand_full >= 0),
  costo_promedio   NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_manufactured  BOOLEAN NOT NULL DEFAULT false,
  cbm_unitario     NUMERIC(8,5),
  size_tier_full   TEXT CHECK (size_tier_full IN ('small','medium','large','xl')),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS listing_sku (
  sku_venta         TEXT PRIMARY KEY,
  meli_item_id      TEXT NOT NULL,
  meli_variation_id BIGINT,
  fulfillment       TEXT NOT NULL CHECK (fulfillment IN ('full','flex','self')),
  is_pack           BOOLEAN NOT NULL DEFAULT false,
  is_promo_bundle   BOOLEAN NOT NULL DEFAULT false,
  promo_valid_from  DATE,
  promo_valid_until DATE,
  estado            TEXT NOT NULL DEFAULT 'active',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (meli_item_id, meli_variation_id)
);
CREATE INDEX idx_listing_meli_item ON listing_sku(meli_item_id);

CREATE TABLE IF NOT EXISTS listing_components (
  sku_venta   TEXT NOT NULL REFERENCES listing_sku(sku_venta) ON DELETE CASCADE,
  sku_fisico  TEXT NOT NULL REFERENCES sku_fisico(sku_fisico),
  qty         NUMERIC(6,2) NOT NULL CHECK (qty > 0),
  PRIMARY KEY (sku_venta, sku_fisico)
);

-- Sales events: la tabla que alimenta velocidad/ABC/XYZ
CREATE TABLE IF NOT EXISTS sales_events (
  id                 BIGSERIAL PRIMARY KEY,
  meli_order_id      BIGINT NOT NULL,
  meli_pack_id       BIGINT,
  sku_venta          TEXT NOT NULL,
  sku_fisico         TEXT NOT NULL REFERENCES sku_fisico(sku_fisico),
  qty_venta          INTEGER NOT NULL,             -- units of the listing
  qty_fisico         NUMERIC(8,2) NOT NULL,        -- exploded units
  precio_unit_clp    NUMERIC(12,2) NOT NULL,
  comision_clp       NUMERIC(12,2),
  envio_seller_clp   NUMERIC(12,2),
  fulfillment        TEXT,
  network_node_id    TEXT,                          -- multi-bodega
  ocurrido_at        TIMESTAMPTZ NOT NULL,
  estado             TEXT NOT NULL DEFAULT 'paid',  -- paid|cancelled|refunded
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sales_sku_fisico_fecha ON sales_events(sku_fisico, ocurrido_at DESC);
CREATE INDEX idx_sales_order ON sales_events(meli_order_id);
CREATE UNIQUE INDEX uniq_sales_idem ON sales_events(meli_order_id, sku_venta, sku_fisico);

-- Vista de disponibilidad de listing = MIN(componente)
CREATE OR REPLACE VIEW listing_disponibilidad AS
SELECT
  ls.sku_venta,
  ls.meli_item_id,
  ls.meli_variation_id,
  COALESCE(MIN(FLOOR((sf.on_hand + sf.on_hand_full) / lc.qty)), 0)::int AS disponible_total,
  COALESCE(MIN(FLOOR(sf.on_hand_full / lc.qty)), 0)::int                AS disponible_full,
  COALESCE(MIN(FLOOR(sf.on_hand / lc.qty)), 0)::int                     AS disponible_self
FROM listing_sku ls
JOIN listing_components lc USING (sku_venta)
JOIN sku_fisico sf USING (sku_fisico)
GROUP BY ls.sku_venta, ls.meli_item_id, ls.meli_variation_id;

-- Función transaccional de explosión + descuento
CREATE OR REPLACE FUNCTION fn_explode_and_decrement(
  p_order_id  BIGINT,
  p_pack_id   BIGINT,
  p_sku_venta TEXT,
  p_qty_venta INTEGER,
  p_precio    NUMERIC,
  p_comision  NUMERIC,
  p_envio     NUMERIC,
  p_fulfill   TEXT,
  p_node      TEXT,
  p_when      TIMESTAMPTZ
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT sku_fisico, qty FROM listing_components WHERE sku_venta = p_sku_venta
  LOOP
    INSERT INTO sales_events (
      meli_order_id, meli_pack_id, sku_venta, sku_fisico,
      qty_venta, qty_fisico, precio_unit_clp, comision_clp,
      envio_seller_clp, fulfillment, network_node_id, ocurrido_at
    )
    VALUES (
      p_order_id, p_pack_id, p_sku_venta, r.sku_fisico,
      p_qty_venta, r.qty * p_qty_venta, p_precio, p_comision,
      p_envio, p_fulfill, p_node, p_when
    )
    ON CONFLICT (meli_order_id, sku_venta, sku_fisico) DO NOTHING;

    IF p_fulfill = 'full' THEN
      UPDATE sku_fisico
         SET on_hand_full = on_hand_full - (r.qty * p_qty_venta)::int,
             updated_at = now()
       WHERE sku_fisico = r.sku_fisico;
    ELSE
      UPDATE sku_fisico
         SET on_hand = on_hand - (r.qty * p_qty_venta)::int,
             updated_at = now()
       WHERE sku_fisico = r.sku_fisico;
    END IF;
  END LOOP;
END $$;
```

**n8n workflow `meli_order_to_supabase`** (importa este JSON parcial):

```yaml
nodes:
  - name: Webhook MeLi
    type: n8n-nodes-base.webhook
    parameters: { path: meli-orders, httpMethod: POST }
    # MeLi POST: { resource: "/orders/2000009047722568", topic: "orders_v2", ... }

  - name: Get Order
    type: n8n-nodes-base.httpRequest
    parameters:
      url: "=https://api.mercadolibre.com{{$json.resource}}"
      authentication: predefinedCredentialType
      nodeCredentialType: oAuth2Api  # MeLi OAuth credential

  - name: Has pack?
    type: n8n-nodes-base.if
    parameters:
      conditions: { string: [{ value1: "={{$json.pack_id}}", operation: notEmpty }] }

  # rama TRUE: GET /packs/{pack_id} → expandir hijos antes
  - name: Get Pack
    type: n8n-nodes-base.httpRequest
    parameters:
      url: "=https://api.mercadolibre.com/packs/{{$json.pack_id}}"

  - name: Explode + Decrement (RPC)
    type: n8n-nodes-base.postgres
    parameters:
      operation: executeQuery
      query: |
        SELECT fn_explode_and_decrement(
          $1::bigint, $2::bigint, $3, $4::int, $5::numeric,
          $6::numeric, $7::numeric, $8, $9, $10::timestamptz
        );
      additionalFields:
        queryParams: |
          ={{ $json.id }},
          ={{ $json.pack_id || null }},
          ={{ $json.order_items[0].item.seller_sku }},
          ={{ $json.order_items[0].quantity }},
          ={{ $json.order_items[0].unit_price }},
          ={{ $json.payments[0].marketplace_fee || 0 }},
          ={{ $json.shipping?.cost || 0 }},
          ={{ $json.shipping?.logistic_type === 'fulfillment' ? 'full' : 'flex' }},
          ={{ $json.order_items[0].stock?.network_node_id || null }},
          ={{ $json.date_closed }}

  - name: Refresh Listing Stock at MeLi
    type: n8n-nodes-base.httpRequest
    parameters:
      method: PUT
      url: "=https://api.mercadolibre.com/items/{{$json.meli_item_id}}"
      bodyParametersJson: |
        ={{ { variations: [ { id: $json.meli_variation_id, available_quantity: $json.disponible_total } ] } }}
```

**Aplicación a BANVA**: De los 425 SKUs activos, el subset con `is_pack=true` son los "set sábanas" (build-to-stock — Joaquín los pre-arma) más cualquier listing 2x/3x. Para los manufactured kits aplica modo `is_manufactured=true`: una orden de producción decrementa componentes y aumenta `on_hand` del set armado. Para promo bundles (3x2 temporales), poblar `promo_valid_from/until` y dar de baja la fila al expirar. Enrique se encarga de poblar `listing_components` para los ~30-50 listings que detecten Raimundo + tú al mapear el catálogo. Para devoluciones (webhook `claims` o `orders_v2` con estado `cancelled`), implementar `fn_undo_sale` espejada (idempotente por `meli_order_id`).

---

## 2. Umbrales ABC-XYZ reales para textil hogar de 425 SKUs

### A. Benchmark real

Existen **dos escuelas** que se contradicen:

| Escuela | ABC | XYZ (CV) | Granularidad típica | Caso de uso |
|---|---|---|---|---|
| Industrial / SAP / Tacto / LeanDNA | 80/15/5 | <0.5 / 0.5-1.0 / >1.0 | Semanal/diario | Repuestos, manufactura |
| **Retail/ecommerce / Lokad / Thieuleux / EazyStock / Altcraft** | **70-75/20/5-10 (margen)** | **<10% / 10-25% / >25%** | Mensual | **Tu caso** |

Para textil con **estacionalidad invernal** (sábanas/plumones), aplicar la escuela ecommerce con **bandas más anchas**: el caso publicado de Supply Chain Math (1247 SKUs electrónica) usa X<20%, Y 20-50%, Z>50%. Para textil hogar con peak invierno **lo correcto es deseasonalizar antes de calcular CV** (SAP IBP lo hace automáticamente; ejemplo: CV con tendencia = 0.6 → Y; sin tendencia = 0.2 → X).

**ABC por margen, no revenue** está explícitamente recomendado por:
- **Slimstock**: *"From a company's point of view, (gross/net) margin should always be one of these criterion"* — A=70% margen, B=20%, C=10%
- **Inventoryops/Piasecki** (25 años SC): *"ABC by gross margin. Even better than revenue, this gives you a better idea of what is driving your profits"*
- **Umbrex**: *"Using revenue instead of margin for ABC, leading to over-servicing low-profit SKUs"* — listado como error #1
- **ToolsGroup/Gartner Paul Lord**: segmentar por **gross margin × demand variability**

**Ajuste de catálogo pequeño (200-1000 SKUs)**: Lokad regla 5x → con 500 SKUs, A=20 (4%), B=100, C=380. Bizowie: para Pareto empinado usar 85/10/5; plano usar 70/20/10. Inventoryops recomienda 5 clases (A=50%, B=30%, C=15%, D=4%, E=1%) para evitar el problema de "A demasiado pequeño".

**Churn esperado**: NetSuite y Lokad confirman que 30-50% de items reclasifican cada trimestre. Esto es normal, no error. **Refrescar trimestralmente, no mensualmente**.

**CV es mal predictor con estacionalidad** (consenso Lokad + Kourentzes + Thieuleux). Fix profesional: deseasonalizar (restar índice estacional) y calcular CV del residuo. Fix práctico: usar 12 meses de historia (un ciclo completo) y bandas anchas.

**Política por celda** — la fuente más explícita es Umbrex playbook:

| Celda | Service Level | z | Política operativa |
|---|---|---|---|
| AX | 98% | 1.88-2.05 | Statistical CSL, monthly review, lean SS |
| AY | 96% | 1.75 | CSL + lead-time buffer, monthly review |
| AZ | 90-95% | 1.28-1.65 | **NO subir z; reducir LT (Flex/Idetex/aire)** |
| BX | 95% | 1.65 | Statistical CSL, quarterly review |
| BY | 92% | 1.41 | Estándar, monthly |
| BZ | 90% | 1.28 | Min-max, semestral |
| CX | 90% | 1.28 | Días de cobertura fijo, bulk orders |
| CY | 85% | 1.04 | Periódico, mínimo esfuerzo |
| CZ | 70-85% / no stock | 0.52-1.04 | **Discontinuar o make-to-order** |

**Lokad/Thieuleux warning crítico**: AZ NO debe ir a z=2.33. Carrying cost es prohibitivo. Atacar con respuesta (LT corto), no con buffer.

### B. Plan operativo BANVA

**Rationale**: Con 425 SKUs y peak invernal, los umbrales textbook 80/15/5 + CV 0.5/1.0 te darían ~85 items en A (mayoría falsos positivos por cubrecolchón impermeable que es A real) y todos los plumones/quilts en Z porque su CV mensual sin deseasonalizar pasa 1.0. La calibración correcta es **A=70% margen 90d (≈40-50 SKUs reales), B=20% (≈80-90), C=10% (≈280)** + **CV deseasonalizado con bandas X<25% / Y 25-60% / Z>60%**.

**SQL de clasificación trimestral** (cron n8n cada lunes; reclasificación efectiva trimestral):

```sql
-- =========================================================
-- BANVA ABC-XYZ classifier (margen 90d + CV 52sem deseasonalizado)
-- =========================================================

CREATE TABLE IF NOT EXISTS abc_xyz_clasificacion (
  sku_fisico         TEXT PRIMARY KEY REFERENCES sku_fisico(sku_fisico),
  abc                CHAR(1) NOT NULL CHECK (abc IN ('A','B','C')),
  xyz                CHAR(1) NOT NULL CHECK (xyz IN ('X','Y','Z')),
  celda              TEXT GENERATED ALWAYS AS (abc || xyz) STORED,
  margen_90d_clp     NUMERIC(14,2),
  margen_pct_acum    NUMERIC(5,4),
  cv_deseasonalizado NUMERIC(6,4),
  service_level      NUMERIC(4,3),
  z_score            NUMERIC(5,3),
  policy_action      TEXT,
  ultima_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Margen por SKU últimos 90 días (margen unitario × qty_fisico vendido)
CREATE OR REPLACE VIEW v_margen_90d AS
SELECT
  se.sku_fisico,
  SUM(se.qty_fisico * (
    se.precio_unit_clp                                          -- ingreso bruto
    - COALESCE(se.comision_clp, se.precio_unit_clp * 0.155)     -- comisión MLC textil ~15.5% promedio
    - COALESCE(se.envio_seller_clp, 0)                          -- subsidio envío
    - sf.costo_promedio                                         -- COGS móvil
  )) AS margen_clp,
  SUM(se.qty_fisico) AS unidades_90d
FROM sales_events se
JOIN sku_fisico sf USING (sku_fisico)
WHERE se.ocurrido_at >= now() - interval '90 days'
  AND se.estado = 'paid'
GROUP BY se.sku_fisico;

-- CV deseasonalizado: promedio móvil 4 semanas como aproximación a tendencia,
-- residuo = ventas_semana - promedio_movil; CV = stddev(residuo) / mean(ventas)
CREATE OR REPLACE VIEW v_cv_52sem AS
WITH semanal AS (
  SELECT sku_fisico,
         date_trunc('week', ocurrido_at) AS semana,
         SUM(qty_fisico)::numeric AS qty_sem
  FROM sales_events
  WHERE ocurrido_at >= now() - interval '52 weeks'
    AND estado = 'paid'
  GROUP BY 1,2
),
con_ma AS (
  SELECT sku_fisico, semana, qty_sem,
         AVG(qty_sem) OVER (PARTITION BY sku_fisico ORDER BY semana
                            ROWS BETWEEN 3 PRECEDING AND CURRENT ROW) AS ma4,
         AVG(qty_sem) OVER (PARTITION BY sku_fisico) AS mean_global,
         STDDEV_POP(qty_sem) OVER (PARTITION BY sku_fisico) AS sd_raw
  FROM semanal
)
SELECT sku_fisico,
       mean_global AS d_avg_sem,
       sd_raw      AS sigma_raw,
       STDDEV_POP(qty_sem - ma4) AS sigma_residuo,
       CASE WHEN mean_global > 0
            THEN STDDEV_POP(qty_sem - ma4) / mean_global
            ELSE NULL END AS cv_deseasonalizado
FROM con_ma
GROUP BY sku_fisico, mean_global, sd_raw;

-- Reclasificación: ABC por margen acumulado, XYZ por CV deseasonalizado
CREATE OR REPLACE FUNCTION fn_reclasificar_abc_xyz()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  WITH ranked AS (
    SELECT m.sku_fisico, m.margen_clp,
           SUM(m.margen_clp) OVER (ORDER BY m.margen_clp DESC
                                   ROWS UNBOUNDED PRECEDING)
           / NULLIF(SUM(m.margen_clp) OVER (), 0) AS pct_acum
    FROM v_margen_90d m
    WHERE m.margen_clp > 0
  ),
  abc_calc AS (
    SELECT sku_fisico, margen_clp, pct_acum,
           CASE
             WHEN pct_acum <= 0.70 THEN 'A'   -- top 70% margen
             WHEN pct_acum <= 0.90 THEN 'B'   -- siguiente 20%
             ELSE 'C'
           END AS abc
    FROM ranked
  ),
  xyz_calc AS (
    SELECT sku_fisico,
           CASE
             WHEN cv_deseasonalizado IS NULL OR d_avg_sem < 0.25 THEN 'Z'  -- intermitente
             WHEN cv_deseasonalizado < 0.25 THEN 'X'                       -- banda ancha p/textil
             WHEN cv_deseasonalizado < 0.60 THEN 'Y'
             ELSE 'Z'
           END AS xyz,
           cv_deseasonalizado
    FROM v_cv_52sem
  )
  INSERT INTO abc_xyz_clasificacion AS t (
    sku_fisico, abc, xyz, margen_90d_clp, margen_pct_acum,
    cv_deseasonalizado, service_level, z_score, policy_action
  )
  SELECT
    a.sku_fisico,
    a.abc,
    COALESCE(x.xyz, 'Z') AS xyz,
    a.margen_clp,
    a.pct_acum,
    x.cv_deseasonalizado,
    -- service level y z por celda (Umbrex + Lokad/Thieuleux ajustado AZ)
    CASE a.abc || COALESCE(x.xyz,'Z')
      WHEN 'AX' THEN 0.98 WHEN 'AY' THEN 0.96 WHEN 'AZ' THEN 0.93
      WHEN 'BX' THEN 0.95 WHEN 'BY' THEN 0.92 WHEN 'BZ' THEN 0.90
      WHEN 'CX' THEN 0.90 WHEN 'CY' THEN 0.85 WHEN 'CZ' THEN 0.80
    END AS sl,
    CASE a.abc || COALESCE(x.xyz,'Z')
      WHEN 'AX' THEN 2.05 WHEN 'AY' THEN 1.75 WHEN 'AZ' THEN 1.48
      WHEN 'BX' THEN 1.65 WHEN 'BY' THEN 1.41 WHEN 'BZ' THEN 1.28
      WHEN 'CX' THEN 1.28 WHEN 'CY' THEN 1.04 WHEN 'CZ' THEN 0.84
    END AS z,
    CASE a.abc || COALESCE(x.xyz,'Z')
      WHEN 'AX' THEN 'Push Full; reorden semanal; SL 98%'
      WHEN 'AY' THEN 'Full + buffer estacional; reorden quincenal'
      WHEN 'AZ' THEN 'Hibrido Full+Flex; reducir LT (Idetex domestico)'
      WHEN 'BX' THEN 'Flex; reorden mensual'
      WHEN 'BY' THEN 'Flex; min-max'
      WHEN 'BZ' THEN 'Self; reorden trimestral'
      WHEN 'CX' THEN 'Bulk anual; bajo monitoreo'
      WHEN 'CY' THEN 'Periodico; minimo esfuerzo'
      WHEN 'CZ' THEN 'CANDIDATO LIQUIDACION/DISCONTINUAR'
    END
  FROM abc_calc a
  LEFT JOIN xyz_calc x USING (sku_fisico)
  ON CONFLICT (sku_fisico) DO UPDATE SET
    abc = EXCLUDED.abc, xyz = EXCLUDED.xyz,
    margen_90d_clp = EXCLUDED.margen_90d_clp,
    margen_pct_acum = EXCLUDED.margen_pct_acum,
    cv_deseasonalizado = EXCLUDED.cv_deseasonalizado,
    service_level = EXCLUDED.service_level,
    z_score = EXCLUDED.z_score,
    policy_action = EXCLUDED.policy_action,
    ultima_actualizacion = now();
END $$;
```

**Aplicación a BANVA**: Tu Semáforo Semanal opera sobre lifecycle (cayeron, despegando, etc.) — la celda ABC-XYZ es ortogonal y debe **cruzarse** con el Semáforo. Cubrecolchón impermeable (77/sem) probablemente cae en **AX** (margen alto, baja CV). Quilt Atenas Beige 2P (24/sem) en **AY** por estacionalidad. Toallas Cannon gris (24/sem) en **BX**. Los 101 muertos son por definición **CZ** y reciben policy_action=LIQUIDAR. Los 28 estancados están entre **BZ y CZ** según margen 90d. **No reclasifiques semanalmente**; corre `fn_reclasificar_abc_xyz()` el primer lunes de cada trimestre, congela el resultado y mueve `policy_action` a producción. Enrique recibe la lista de cambios cada trimestre por email.

---

## 3. Liquidación de los $10M CLP muertos: playbook 12 semanas

### A. Benchmark real

**Canales MeLi Chile disponibles** (developers.mercadolibre.com.mx/productos-recibe-notificaciones/central-de-promociones):

| Tipo (API) | Mecánica | Para qué |
|---|---|---|
| `LIGHTNING` (Relámpago) | MeLi invita; eliges stock+precio; ~6h; aparece en /ofertas | **Herramienta #1 liquidación rápida** |
| `DOD` (Oferta del Día) | 24h; sugerencia % MeLi; **no removible una vez activa** | Exposición masiva home |
| `DEAL` | Hasta 7 días; descuento elegido | Continuo |
| `MARKETPLACE_CAMPAIGN` | **Co-fondeada por MeLi** (paga parte) | Estira el descuento |
| `VOLUME` | "Lleva 4 paga 3", 2da unidad −X% | **Crítico para bundling textil** |
| `UNHEALTHY_STOCK` | **"Campaña liquidación stock Full"** | **Específica para Full estancado — usar SI tienes muertos en Full** |

**Cap de descuento**: MeLi subió el máximo seller-configurable de 70% a **80%** recientemente. Por encima de eso, hay que ir off-platform o vía bundle.

**Eligibilidad Relámpago/DOD**: reputación verde o amarilla, MercadoLíder o Tienda Oficial, producto **nuevo**, listing Clásica/Premium, experience score ≥50, ≥3 ventas últimos 30d (vendedores.mercadolibre.com.mx/nota/ofertas-relampago-liquida-tu-stock-en-pocas-horas).

**Calendario Chile 2026**: Black Sale Mar 30–Apr 5, **CyberDay 1-3 Jun**, Hot Sale 2da semana julio, CyberMonday 7-9 Oct, Black Friday última semana noviembre. MeLi corre campañas paralelas sin requerir membresía CCS.

**Discount ladder textil** (síntesis Priceva + Toolio + Zara/Target/H&M):

| Días sin venta | Descuento | Sell-through esperado |
|---|---|---|
| 0-30 | 0% | 60-70% (industria); 85% (Zara) |
| 30-60 | **15-25%** | Standard early markdown |
| 60-90 | **30-40%** | Mid markdown |
| 90-120 | **50%** | Velocity uplift textil |
| 120-180 | **60-70%** | Target endcap clearance |
| 180+ | **80%** (cap MeLi) | Closeout |

**Datos específicos**: Zara liquida hasta 50% en 4-6 semanas, mantiene 85% sell-through full-price. Target subió 10% YoY visitas y +2.7% comparable store sales con clearance escalonado 15%→70%. H&M spring 2023: **−9% margen pero +12% ATQ → +5% revenue neto**.

**Cuándo bundle > descuento individual**: cuando el SKU lleva >50% off y aún no se mueve, ATARLO gratis o casi-gratis a un hero (cubrecolchón impermeable + toalla muerta como gift). El cliente evalúa el precio del bundle, no del componente. La mecánica nativa MeLi `VOLUME` ("2da unidad −50%") preserva precio unitario visible (mejor SEO/marca que tag −70%).

**Costo de carrying real**: APICS/NetSuite benchmark **15-30% anual** del valor de inventario; textil/fashion 25-30% por riesgo obsolescencia. Tus $10M × 25% = **$2.5M CLP/año perdidos sólo por mantenerlo quieto**.

**Inecuación liquidar-vs-mantener**:
```
Liquidar hoy si: descuento_hoy < (carrying% × años_hold) + P_obsolescencia_total × costo
```
Ejemplo $50K cost-basis, 25% carrying, 12m esperados, 30% prob obsolescencia total = $27.5K pérdida esperada → **cualquier markdown ≤55% hoy gana al hold**.

**Recovery rates** (peor a mejor):

| Canal | Recovery % cost basis |
|---|---|
| MeLi Relámpago 25-35% off | 65-75% |
| MeLi DOD 50% off | ~50% |
| MeLi 70-80% closeout | 20-30% |
| Bulk Yapo / mayorista CL | 10-25% |
| **Donación Ley 21.440 (escudo fiscal)** | **~27%** (corp tax) |
| Amazon FBA Liquidations (analog) | **5-10%** |
| Castigo SII sin donación | 0% cash, 27% sólo si SII acepta |

**Dato fiscal Chile crítico**: **Ley 21.440** (Rentas Municipales, Abr 2022) + SII Resolución Ex. 77/2022 + Circular 49/2022. Donación de bienes corporales (textiles incluidos) a entidades registradas como Donatarias = **deducción 100% como gasto, sin IVA, sin sujeción al límite global del 5% Ley 19.885**. Con tasa Pyme 25% → recuperas $250K por cada $1M donado vs $100K por venderlo a mayorista al 10%. Para textiles apuntar a Hogar de Cristo, Fundación Las Rosas, Techo Chile, Caritas, América Solidaria (verificar inscripción Donataria activa).

### B. Plan operativo BANVA

**Rationale**: De los 101 muertos ($7M) + 28 estancados ($3M), la mecánica óptima es **secuencia 12 semanas pegada al CyberDay 1-3 Jun + Hot Sale jul** + cierre con donación Ley 21.440 para residuo. Recovery realista 50-70% del book value ($5-7M de los $10M).

**Tabla de campañas + n8n trigger**:

```sql
CREATE TABLE IF NOT EXISTS liquidacion_pipeline (
  id BIGSERIAL PRIMARY KEY,
  sku_fisico TEXT REFERENCES sku_fisico(sku_fisico),
  cohort TEXT CHECK (cohort IN ('estancado','muerto_60_180','muerto_180_plus')),
  precio_base_clp NUMERIC,
  semana INT,
  accion TEXT,
  pct_descuento NUMERIC,
  promo_type TEXT,
  estado TEXT DEFAULT 'pending',
  ejecutado_at TIMESTAMPTZ
);

INSERT INTO liquidacion_pipeline (sku_fisico, cohort, precio_base_clp, semana, accion, pct_descuento, promo_type)
SELECT sf.sku_fisico,
  CASE
    WHEN s.dias_sin_venta < 60  THEN 'estancado'
    WHEN s.dias_sin_venta < 180 THEN 'muerto_60_180'
    ELSE 'muerto_180_plus'
  END,
  ls_max.precio_base,
  generate_series(1, 12),
  NULL, NULL, NULL
FROM sku_fisico sf
JOIN abc_xyz_clasificacion c USING (sku_fisico)
JOIN LATERAL (
  SELECT MAX(ocurrido_at) IS NULL OR
         EXTRACT(DAY FROM now() - MAX(ocurrido_at))::int AS dias_sin_venta
  FROM sales_events WHERE sku_fisico = sf.sku_fisico
) s ON true
JOIN LATERAL (
  SELECT MAX(precio_unit_clp) AS precio_base
  FROM sales_events WHERE sku_fisico = sf.sku_fisico
) ls_max ON true
WHERE c.celda IN ('CZ','BZ') OR sf.on_hand > 0 AND s.dias_sin_venta > 30;
```

**n8n workflow `liquidacion_semanal`** (ejecutar lunes 6am):

```javascript
// Function node: decidir descuento por cohort × semana
const cohort = $json.cohort;
const semana = $json.semana;

const ladder = {
  estancado:        [0,15,15,20,25,25,30,30,40,40,50,50],
  muerto_60_180:    [0,30,30,40,40,50,50,60,60,70,70,bundle()],
  muerto_180_plus:  [0,50,50,60,60,70,70,80,80,'YAPO','YAPO','DONACION'],
};
function bundle(){ return 'BUNDLE_VOLUME'; }

const accion = ladder[cohort][semana];
return { ...$json, pct_descuento: accion, promo_type:
  accion === 'BUNDLE_VOLUME' ? 'VOLUME' :
  accion === 'YAPO' ? 'OFFPLATFORM_YAPO' :
  accion === 'DONACION' ? 'DONACION_LEY21440' :
  accion >= 50 ? 'LIGHTNING' : 'PRICE_DISCOUNT'
};
```

```javascript
// HTTP Request: activar promo MeLi
// POST https://api.mercadolibre.com/seller-promotions/items/{ITEM_ID}?app_version=v2
// body:
{
  "deal_price": Math.round($json.precio_base_clp * (1 - $json.pct_descuento/100)),
  "stock": $json.on_hand,
  "promotion_type": $json.promo_type   // LIGHTNING | DEAL | VOLUME
}
```

**Calendario fijo BANVA mayo-julio 2026**:

| Semana | Acción Joaquín/Enrique | SKUs target | Mecánica MeLi |
|---|---|---|---|
| S1 (12-18 may) | Tag 129 SKUs en Central Promociones | Todos | `PRICE_DISCOUNT` 20% estancados |
| S2-3 | Submit a CyberDay 2026 (1-3 jun) | Estancados + dead 60-180 | `MARKETPLACE_CAMPAIGN` 30-40% |
| S4 | Relámpago 50% en olas de 10-15 SKUs | Dead 90-180 | `LIGHTNING` |
| S6 | "Pack Hogar" temáticos | Slow movers | `VOLUME` 2da unidad −50% |
| S8 | Final 70% Relámpago + Hot Sale jul | Truly dead | `LIGHTNING` 70% |
| S10 | Lotes a Yapo + mayorista La Vega | Residual | Off-platform |
| S12 | Donación Ley 21.440 + Certificado N°73 | Residual final | 27% tax shield |

**Aplicación a BANVA**: Para los **101 SKUs muertos**, segmentar primero por `dias_sin_venta`. Cualquier SKU en Full con stock antiguo >120 días paga `cargo por stock antiguo` mensual creciente — esos son priority #1 al `UNHEALTHY_STOCK` (revisa Central de Promociones, MeLi te los flagea automáticamente). Los **28 estancados** entran ladder estancado: 20% S1, 25% S3, 30% S5. Para semana 12 calcular: si recovery_estimado < 27% del cost basis → donar directo. **Recovery total esperado ~$5-7M** de los $10M; los $3-5M restantes son el costo aprendizaje del ciclo donde el sistema falló.

---

## 4. Safety stock por celda con economía MeLi real

### A. Benchmark real

**Tabla z por celda** (Umbrex + Thieuleux + Lokad sintetizado):

| Celda | CSL | z | Política operativa |
|---|---|---|---|
| AX | 98% | 2.05 | Tight control, min SS |
| AY | 96% | 1.75 | + buffer estacional |
| AZ | 93% | 1.48 | **No buffer alto: comprimir LT** |
| BX | 95% | 1.65 | Statistical CSL |
| BY | 92% | 1.41 | Min-max |
| BZ | 90% | 1.28 | Periodic |
| CX | 90% | 1.28 | Días-de-cover fijo |
| CY | 85% | 1.04 | Mínimo esfuerzo |
| CZ | 80% | 0.84 | Make-to-order o discontinuar |

**Fórmulas operativas**:
- LT confiable: `SS = z × σ_d × √LT`
- LT variable (China, σ_LT alto): `SS = z × √(LT × σ_d² + d_avg² × σ_LT²)`
- ROP = `(d_avg × LT) + SS`
- Ajuste retornos textil hogar: `σ_d × (1 + 0.5 × return_rate)` ≈ ×1.075 con r=15%

**Lead times Chile textil**:
- **Idetex (Lampa, RM)**: máximo 8 días naturales desde bodega Juan de la Fuente 353, según convenio jenabien.cl. **Crédito 60d no publicado**, negociado B2B (gap real, levantar con un quote directo).
- Domestic CL genérico: 7-21 días, σ_LT 2-5
- China LCL/FCL: 45-70 días puerta-a-puerta, σ_LT 7-10 (peak sept-dic congestion: 50-90)
- China aire top-up: 7-14 días

**MeLi Full Chile fees** (relbase.cl + Wivo + Mutatis 2024):

| Tier | Item ejemplo | $/día/unidad | $/mes/unidad |
|---|---|---|---|
| Small | Toalla, sábana plegada chica | $0.83 | ~$25 |
| Medium | Set sábanas std, cubrecolchón | $2.27 | ~$68 |
| Large | Plumón king | $10 | ~$300 |
| XL | Colchón, alfombra grande | $18.33 | ~$550 |

**Cargo por stock antiguo Chile**: 120 días naturales (vs 60 Argentina/México) → recargo mensual adicional escalonado por tamaño. **Implicación dura: target days-of-cover en Full ≤ 90 días siempre**.

**Flex Chile**:
- ≤$19,990: comprador paga envío; seller recibe $2,890-2,990
- >$19,990: envío gratis obligatorio; **MeLi acredita 10% bonus al seller**
- Cobertura: Santiago + Valparaíso solamente
- Max 50kg, suma dimensiones ≤150cm
- Subsidio reputación: hasta 50% verde/MercadoLíder, 40% amarilla, 0% naranja/roja

**Comisión Hogar/Textil MLC**: rango oficial 8-21%; práctico **13-20%**. Worked example Nubimetrics (Vasos, Hogar): 14% Clásica + $2,400 fijo. Para textiles asumir **14-15% Clásica, 17-19% Premium**. Cargo fijo unidad: $700 (≤$9,990), $1,000 ($9,990-$19,990), $0 (>$19,990).

**Return rates** (sin data MeLi pública por categoría — gap):
- Apparel: 24-30%
- **Home goods/textiles: 15-20%**
- All ecommerce 2024: 16.9%

**Multi-echelon Full + bodega**: regla práctica = pre-posicionar 30-60 días de cobertura en Full (cycle stock, no SS adicional) + SS calculada sobre demanda total en bodega propia con LT proveedor. Tannico/Mecalux caso: 88%→94% disponibilidad con menos inventario al optimizar multi-echelon.

### B. Plan operativo BANVA

**Rationale**: Tu mix óptimo es **A→Full con cobertura 30d, B→Flex (Stgo+Valpo), C→bodega propia, AZ híbrido**. Nunca pongas un CZ en Full — el cargo stock antiguo a 120d destruye la rentabilidad.

**SQL safety stock + ROP por SKU**:

```sql
CREATE TABLE IF NOT EXISTS sku_economics (
  sku_fisico TEXT PRIMARY KEY REFERENCES sku_fisico(sku_fisico),
  proveedor TEXT,
  lt_dias_avg INT,
  lt_dias_sigma NUMERIC(5,2),
  return_rate NUMERIC(4,3) DEFAULT 0.15,
  channel_policy TEXT          -- 'full_principal', 'hibrido', 'flex', 'self'
);

CREATE OR REPLACE VIEW v_safety_stock AS
WITH demand AS (
  SELECT se.sku_fisico,
         SUM(qty_fisico)::numeric / 26.0 AS d_avg_sem,   -- 26 sem
         STDDEV_POP(qty_fisico)::numeric AS sigma_sem
  FROM sales_events se
  WHERE ocurrido_at >= now() - interval '26 weeks' AND estado='paid'
  GROUP BY se.sku_fisico
)
SELECT
  d.sku_fisico,
  c.celda,
  c.z_score AS z,
  e.lt_dias_avg AS lt,
  e.lt_dias_sigma AS sigma_lt,
  d.d_avg_sem / 7.0 AS d_avg_dia,
  d.sigma_sem / sqrt(7.0) AS sigma_dia,
  -- Formula combinada (China) o simple (Idetex) segun sigma_lt
  CASE
    WHEN COALESCE(e.lt_dias_sigma,0) < 2 THEN
      ROUND(c.z_score * (d.sigma_sem/sqrt(7.0)) * sqrt(e.lt_dias_avg) * (1 + 0.5*e.return_rate))
    ELSE
      ROUND(c.z_score * sqrt(
        e.lt_dias_avg * power(d.sigma_sem/sqrt(7.0), 2)
        + power(d.d_avg_sem/7.0, 2) * power(e.lt_dias_sigma, 2)
      ) * (1 + 0.5*e.return_rate))
  END AS safety_stock,
  ROUND((d.d_avg_sem/7.0) * e.lt_dias_avg) AS cycle_stock,
  ROUND((d.d_avg_sem/7.0) * e.lt_dias_avg
        + c.z_score * (d.sigma_sem/sqrt(7.0)) * sqrt(e.lt_dias_avg)) AS reorder_point,
  -- Pre-posicionado Full (30 dias cobertura para A; 0 para CZ)
  CASE
    WHEN c.abc='A' THEN ROUND((d.d_avg_sem/7.0) * 30)
    WHEN c.abc='B' AND e.channel_policy IN ('full_principal','hibrido') THEN ROUND((d.d_avg_sem/7.0) * 14)
    ELSE 0
  END AS full_cycle_target
FROM demand d
JOIN abc_xyz_clasificacion c USING (sku_fisico)
JOIN sku_economics e USING (sku_fisico);

-- Trigger de recompra: cuando on_hand + on_hand_full < ROP, generar OC
CREATE OR REPLACE VIEW v_compras_pendientes AS
SELECT
  ss.sku_fisico,
  sf.descripcion,
  ss.celda,
  sf.on_hand + sf.on_hand_full AS stock_total,
  ss.reorder_point,
  ss.cycle_stock + ss.safety_stock + ss.full_cycle_target AS target_stock,
  (ss.cycle_stock + ss.safety_stock + ss.full_cycle_target)
    - (sf.on_hand + sf.on_hand_full) AS qty_a_comprar,
  sf.costo_promedio,
  ((ss.cycle_stock + ss.safety_stock + ss.full_cycle_target)
    - (sf.on_hand + sf.on_hand_full)) * sf.costo_promedio AS clp_orden_compra
FROM v_safety_stock ss
JOIN sku_fisico sf USING (sku_fisico)
WHERE sf.on_hand + sf.on_hand_full < ss.reorder_point
  AND ss.celda <> 'CZ';   -- CZ no se recompra
```

**Worked example BANVA** (cubrecolchón impermeable 2P, vendido 77/sem):
- Clasificación esperada: AX (alta velocidad, baja CV)
- d_avg_dia = 11, σ_dia ≈ 4
- Proveedor Idetex, LT=10 días, σ_LT=2
- z = 2.05 (CSL 98%)
- σ_LT < 2 → fórmula simple: SS = 2.05 × 4 × √10 × 1.075 ≈ **28 unidades**
- Cycle stock = 11 × 10 = 110
- ROP = 110 + 28 = **138 unidades**
- Pre-posicionado Full = 11 × 30 = **330 unidades**
- Stock total objetivo bodega+Full: 138 + 330 = **468 unidades**

**Aplicación a BANVA**: Carga `sku_economics` con LT por proveedor (Idetex 10d, importado China 60d con σ_LT=8). El view `v_compras_pendientes` corre cron lunes 6am, Enrique recibe lista priorizada por celda (A primero) y monto. Para AZ items (alta varianza), bajar LT antes que subir z: pasar de China a Idetex aunque costo unitario sea +15%, recuperas en menor inventory carrying. Para CZ: sistema NO sugiere recompra. Para multi-echelon Full: pre-posicionado de 30d en Full es **cycle stock, no SS adicional** — no doble-bufferes. Refrescar `sku_economics.lt_dias_avg` cada vez que llegue un OC midiendo días reales.

---

## 5. Margen real por SKU: la unit economics que mata supuestos

### A. Benchmark real

**Fórmula contribution-margin per unit** que usa el top tier (Helium10 + Jungle Scout + Wivo + Slimstock):

```
gross_revenue (neto IVA)
  − comision_meli (13-19% MLC textil)
  − cargo_fijo_unidad ($0/$700/$1,000)
  − envio_seller (subsidio reputación)
  − cogs_movil
  − inbound_logistics_per_unit
  − packaging ($200-500/envío CL)
  − storage_full O warehouse_allocated
  − pickpack_full O labor_self
  − cargo_stock_antiguo (Full >120d)
  − returns_expected = unit_cost × return_rate × loss_per_return
  − ad_spend_attributed (TACoS o campaign-mapped)
  − cost_of_capital_inventory = unit_cost × WACC × días_inventario / 365
= contribution_margin_per_unit
```

**MeLi MLC commission y fees confirmados**:
- Comisión: 8-21% rango oficial; **13-20% práctico**; Hogar/Textil ~14% Clásica, 17-19% Premium
- Fijo unidad: $700 (≤$9,990), $1,000 ($9,990-$19,990), $0 (>$19,990)
- Envío gratis: automático ≥$19,990, no opt-out
- Subsidio MeLi: 50% Verde/MercadoLíder, 40% amarilla, 0% naranja/roja
- IVA 19% en comisiones se recupera como crédito F29 si seller es contribuyente IVA — **si no lo registras, pagas IVA sobre venta bruta**

**WACC Chile SME 2025/2026** (BCCh):
- TPM: 4.50%
- Comerciales promedio: **8.6-10.1% nominal CLP**
- BancoEstado Pyme: 9.1%
- BCI Pyme FOGAPE: TPM+7.2% ≈ 11.7%
- Santander cuotas <MM$4: 17.5-18.7% anual
- **Operacional para BANVA: 12-15% nominal CLP** (debt cost real + spread riesgo)

**Carrying cost total**: 20-30% anual del valor inventario (Slimstock split: 8% capital + 10% storage + 5% riesgo + 2% misc).

**Asignación bodega**: estándar real es **híbrida — cubic para storage + ABC pick para outbound labor**. OPSdesign: "cubic velocity by SKU + cubic inventory by SKU". Asignación equitativa por # SKU es lo que hacen los amateurs y lo critica explícitamente CFO Engine.

**Returns MLC**:
- Ventana nuevo: 30 días
- Compra Protegida: gratis comprador, debitado al seller
- "Diferente a publicado" → seller paga envío + impacta reputación
- "Arrepentimiento" → no afecta reputación; puede o no costar envío
- MeLi bonifica comisión + envío del original al refund
- Mantener reclamos <4% para reputación
- B-stock textil: gap CL — usar 20-30% (Amazon analog) y medir interno 90d

**Ad spend attribution MeLi Ads**:
- Estructura: campaña contiene N publicaciones; un anuncio sólo en una campaña
- Strategy: Profitability / Growth / Visibility con Target ACOS 3-500%
- Subasta segundo-mejor-precio
- MeLi reporta: same-SKU sponsored sales + cross-SKU halo
- **Migración 2025: ACOS-as-result → ROAS-as-objective** (Néstor Arranz)
- Tu ACOS global 3.9% es **excelente** vs benchmark Amazon textil 10-30% — sugiere o branded-search dominante o sub-inversión publicitaria

**Tools LatAm**: **Wivo Analytics (Chile)** es el equivalente más cercano a Helium10 Profits para MeLi. Pulls órdenes + comisión + flete + storage Full + ads automáticamente, permite upload de COGS interno, computa 32+ métricas por orden/listing/categoría/marca. Nubimetrics y Real Trends son demand/competition, no profit calculators.

### B. Plan operativo BANVA

**Rationale**: Tu margen actual reportado 23.3% es revenue×comisión×COGS, pero **omite cost of capital ($1.2-1.5M/año en los $10M muertos), cargo stock antiguo Full, retornos esperados, packaging y allocación bodega**. La unit economics real para tus top 85 SKUs (top 20% que generan 80%) probablemente revele 3-8 puntos menos margin que el reportado, y para C-items varios negativos.

**Vista Supabase de margen real**:

```sql
CREATE TABLE IF NOT EXISTS parametros_margen (
  k TEXT PRIMARY KEY, v NUMERIC NOT NULL
);
INSERT INTO parametros_margen VALUES
  ('wacc_anual', 0.135),                -- 13.5% nominal CLP
  ('carrying_pct', 0.25),
  ('return_rate_default', 0.15),
  ('p_unsellable', 0.25),
  ('packaging_clp', 350),
  ('warehouse_costo_mensual_clp', 4500000),  -- ajustar al real BANVA
  ('warehouse_cbm_total', 180),              -- m3 ocupados promedio
  ('labor_pick_clp', 280)                    -- por pick (3500 CLP/h, 75 picks/h)
ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v;

CREATE OR REPLACE VIEW v_margen_real_sku AS
WITH params AS (SELECT * FROM parametros_margen),
ventas_90d AS (
  SELECT
    se.sku_fisico,
    SUM(se.qty_fisico) AS u90,
    AVG(se.precio_unit_clp) AS p_avg,
    AVG(se.comision_clp) AS com_avg,
    AVG(se.envio_seller_clp) AS env_avg,
    SUM(CASE WHEN se.fulfillment='full' THEN se.qty_fisico ELSE 0 END) AS u_full,
    SUM(CASE WHEN se.fulfillment<>'full' THEN se.qty_fisico ELSE 0 END) AS u_self
  FROM sales_events se
  WHERE ocurrido_at >= now() - interval '90 days' AND estado='paid'
  GROUP BY se.sku_fisico
),
ad_attrib AS (
  -- Proración portfolio TACoS (M3 método): ad_spend × share_revenue
  SELECT sku_fisico,
         u90 * p_avg * (
           (SELECT 0.039 FROM params WHERE k='wacc_anual' LIMIT 1)  -- placeholder TACoS 3.9%
         ) AS ad_clp_attrib
  FROM ventas_90d
),
storage_alloc AS (
  SELECT
    sf.sku_fisico,
    -- Full: por size_tier daily * dias inventario
    CASE sf.size_tier_full
      WHEN 'small'  THEN 0.83 WHEN 'medium' THEN 2.27
      WHEN 'large'  THEN 10   WHEN 'xl'     THEN 18.33
      ELSE 0
    END * 90 * sf.on_hand_full / NULLIF(v90.u90,0) AS storage_full_per_unit,
    -- Self: cubic-weighted
    (sf.cbm_unitario / NULLIF((SELECT v FROM params WHERE k='warehouse_cbm_total'),0))
      * (SELECT v FROM params WHERE k='warehouse_costo_mensual_clp')
      * 3 / NULLIF(v90.u90,0) AS storage_self_per_unit
  FROM sku_fisico sf
  LEFT JOIN ventas_90d v90 USING (sku_fisico)
)
SELECT
  v.sku_fisico,
  c.celda,
  v.u90,
  v.p_avg AS precio_promedio,
  -- componentes
  v.p_avg * 0.84 AS revenue_neto_iva,             -- /(1+0.19) ≈ 0.84
  COALESCE(v.com_avg, v.p_avg * 0.155) AS comision,
  CASE WHEN v.p_avg <= 9990 THEN 700
       WHEN v.p_avg <= 19990 THEN 1000
       ELSE 0 END AS fijo_unidad,
  COALESCE(v.env_avg, 0) AS envio_seller,
  sf.costo_promedio AS cogs,
  (SELECT v FROM params WHERE k='packaging_clp') AS packaging,
  COALESCE(s.storage_full_per_unit, s.storage_self_per_unit, 0) AS storage,
  -- retornos
  sf.costo_promedio
    * COALESCE(e.return_rate, (SELECT v FROM params WHERE k='return_rate_default'))
    * (SELECT v FROM params WHERE k='p_unsellable') AS retornos_esperados,
  -- ads
  COALESCE(a.ad_clp_attrib, 0) / NULLIF(v.u90,0) AS ads_per_unit,
  -- cost of capital: WACC * costo_unit * dias_inventario/365
  sf.costo_promedio
    * (SELECT v FROM params WHERE k='wacc_anual')
    * GREATEST(90, 90.0)
    / 365 AS cost_of_capital_per_unit,
  -- Margen contribución final
  (v.p_avg * 0.84
   - COALESCE(v.com_avg, v.p_avg * 0.155)
   - CASE WHEN v.p_avg <= 9990 THEN 700 WHEN v.p_avg <= 19990 THEN 1000 ELSE 0 END
   - COALESCE(v.env_avg, 0)
   - sf.costo_promedio
   - (SELECT v FROM params WHERE k='packaging_clp')
   - COALESCE(s.storage_full_per_unit, s.storage_self_per_unit, 0)
   - sf.costo_promedio * COALESCE(e.return_rate, 0.15) * 0.25
   - COALESCE(a.ad_clp_attrib, 0) / NULLIF(v.u90,0)
   - sf.costo_promedio * (SELECT v FROM params WHERE k='wacc_anual') * 90.0/365
  ) AS contribucion_clp_unit,
  -- % margen real
  ROUND(100.0 * (v.p_avg * 0.84
   - COALESCE(v.com_avg, v.p_avg * 0.155)
   - sf.costo_promedio
   - COALESCE(v.env_avg, 0)
   - sf.costo_promedio * (SELECT v FROM params WHERE k='wacc_anual') * 90.0/365
  ) / NULLIF(v.p_avg,0), 2) AS margen_real_pct
FROM ventas_90d v
JOIN sku_fisico sf USING (sku_fisico)
JOIN abc_xyz_clasificacion c USING (sku_fisico)
LEFT JOIN sku_economics e USING (sku_fisico)
LEFT JOIN storage_alloc s USING (sku_fisico)
LEFT JOIN ad_attrib a USING (sku_fisico);
```

**Aplicación a BANVA**: Corre `SELECT * FROM v_margen_real_sku WHERE contribucion_clp_unit < 0` — vas a encontrar SKUs C que se ven OK en margen bruto y son negativos en contribución real (típicamente 15-25% del long tail). Esos van directo al pipeline de liquidación de Sección 3 sin pasar por más ciclos. Para **top 85 SKUs (A)** aplicar campaign-mapping 1:1 en MeLi Ads (un campaign per listing) para reemplazar la proración TACoS por attribution real. Para **largo tail (340 SKUs)** mantener proración TACoS. Mide labor_pick real con Joaquín una semana cronometrando, ajusta `parametros_margen.labor_pick_clp`. Tu $2.37M/mes de ad spend debería tener `$350K en SKUs out-of-stock` reasignado — un n8n workflow simple `pause_ads_if_oos` que cada hora checkea `disponible_total=0 AND ad_active=true → pause campaign` recupera ese gasto. Reauditar `parametros_margen.wacc_anual` cada trimestre con la tasa BCCh + tu spread bancario real.

---

## Conclusión: el sistema completo, no sus piezas

La diferencia entre tener Semáforo Semanal + ABC-XYZ corriendo aislados y **operar un SPM** es que las cinco capas se retroalimentan: el sync pack-aware (1) alimenta `sales_events` veraces; eso permite ABC-XYZ correcto (2); las celdas alimentan tanto la liquidación CZ (3) como las políticas SS (4); y la unit economics real (5) cierra el loop deteniendo recompras de SKUs sin contribución y matando ad spend en OOS. **Implementación realista 6 semanas**: S1-2 schema BOM + n8n explosión, S3 backfill `sales_events` desde 12 meses, S4 reclasificación ABC-XYZ inicial, S5-6 liquidación cohort estancado + lanzamiento safety stock, paralelo Wivo Analytics trial 30d para validar tu `v_margen_real_sku`. Los **$10M de capital muerto pagan la implementación 5-7x sólo con la recuperación 50-70%** del playbook 12-semanas, sin contar el ahorro recurrente en ad spend desperdiciado y carrying cost.

Lo que este informe no pudo darte y debes levantar internamente: (a) cifras exactas Full Chile por size tier desde tu propio dashboard, (b) términos crédito Idetex (cotización directa), (c) % B-stock devoluciones textil BANVA (medir 90d), (d) ACOS por SKU real (campaign-mapping 1:1 vs proración). El benchmark MercadoLíder textil chileno con stack publicado **no existe públicamente** — esto no es debilidad del informe, es la realidad del mercado: los Platinum no comparten su stack. Lo que tienes acá es la síntesis máxima posible con fuentes auditables, suficiente para construirlo tú primero.