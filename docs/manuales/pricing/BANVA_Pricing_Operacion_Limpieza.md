# Operación Limpieza — Markdown Cadence Spec para BANVA

> Manual operacional ejecutable. Stack: Supabase + Next.js + n8n. Tiempo de implementación: 2 sprints. Calibración: 60-90 días en modo semi-auto antes de transición a auto.

---

## 1. Reglas de markdown (la tabla)

### 1.1 Cadencia base — escalones, ventanas y depth

La cadencia de BANVA combina **trigger por sell-through** (literatura Increff/Smith-Achabal/Caro-Gallien) con **escalones discretos** alineados al inventario operativo de MercadoLibre Chile (Central de Promociones). Cuatro escalones, ventana de evaluación de 4 semanas entre ellos.

| Escalón | Depth (% off precio base) | Activación (trigger) | Ventana mínima en escalón | Herramienta MLC |
|---|---|---|---|---|
| **E1 — Soft nudge** | −10 a −15% | edad ≥ 6 sem AND sell-through < 30% del plan | 4 sem | Descuento por porcentaje (Central de Promociones) |
| **E2 — Aceleración** | −25 a −30% | edad ≥ 10 sem AND sell-through < 50% del plan; o E1 sin reaccionar (lift < 1.5×) | 4 sem | Descuento por porcentaje + Oferta del Día (24h, 1 vez/sem) |
| **E3 — Liquidación** | −40 a −50% | edad ≥ 14 sem AND sell-through < 65% del plan; o E2 sin lift suficiente | 3-4 sem | Oferta Relámpago (6h) recurrente; depth alineado a banda observada en MLC categoría hogar (34-58%) |
| **E4 — Clearance final** | −60 a −70% (cap absoluto −70%) | edad ≥ 20 sem AND stock > 0; SKU declarado "muerto" en Semáforo | hasta stock = 0 o 8 sem (lo que ocurra primero) | Oferta Relámpago profundo + Descuentos por cantidad (combos 2×1) |

**Justificación numérica de cada escalón:**
- −15% en E1: alineado con Toolio ("phased markdowns: start with 10–20%") y Pricefx (10% inicial). En categorías donde margen base BANVA es 23.3%, un escalón mayor en E1 destruye contribución sin testear elasticidad.
- −30% en E2: punto medio del rango Impact Analytics "tracking on plan" (40%) ajustado abajo porque BANVA tiene margen menor que apparel. Equivalente a depth típico de Oferta del Día observado en MLC hogar.
- −50% en E3: techo del rango Onramp Funds (30–70% para liquidar seasonal stock); centro de la banda de Oferta Relámpago observada en MLC hogar México (34, 36, 42, 52, 58, 66%).
- −70% cap en E4: Target retail tope estándar ("70% antes de donar"); JCPenney corporate cap; Onramp Funds upper bound. Pasar de −70% requiere [DECISIÓN VICENTE] explícita por SKU.

### 1.2 Tabla maestra: edad × sell-through × velocidad → escalón

Esta es la tabla que el Agente Pricing consulta para generar recomendación. Las celdas son la regla operativa.

| Edad SKU \ Velocidad | **A — Fast (≥1 ud/sem)** | **B — Medium (0.3–1 ud/sem)** | **C — Slow (<0.3 ud/sem)** |
|---|---|---|---|
| **0–5 sem** | sin markdown | sin markdown | sin markdown (ventana de aprendizaje) |
| **6–9 sem** | sin markdown | E1 si STR<30% del plan | **E1 (−15%)** |
| **10–13 sem** | E1 si STR<40% | **E2 (−30%)** | **E2 (−30%)** |
| **14–19 sem** | E2 si STR<55% | E2→E3 si lift<1.5× | **E3 (−50%)** |
| **20–25 sem** | E3 si STR<65% | **E3 (−50%)** | **E4 (−70%)** + flag exit |
| **≥26 sem** | E3 + flag exit | **E4 (−70%)** + flag exit | **E4 + EXIT en 8 sem** |

**Definición operativa de A/B/C** (calibración inicial; revisar mes 3):
- A: velocidad ponderada ≥ 1.0 ud/sem en últimas 8 sem.
- B: 0.3–1.0 ud/sem.
- C: < 0.3 ud/sem (incluye SKUs con cero ventas en últimas 8 sem).

**Definición operativa de "% del plan"** (sell-through esperado vs realizado):

| Sub-categoría | STR target 30d | 60d | 90d | 120d | Base |
|---|---|---|---|---|---|
| Sábanas / fundas (evergreen, bajo ticket) | 25% | 45% | 60% | 75% | Shopify home improvement curve + KISSmetrics core |
| Cobertores / quilts (estacional) | 40% | 60% | 75% | 85% | StyleMatrix seasonal proxy |
| Toallas / bath linen (evergreen) | 22% | 40% | 60% | 70% | Coresight 60% non-grocery + Accelerated Analytics apparel curve |
| Decorativos estacionales / nicho | 45% | 65% | 85% | 90%+ | KISSmetrics seasonal 80–95% |

> **Nota crítica**: estos targets son síntesis de proxies. **No existe benchmark público específico de home textiles 30/60/90/120 día de sell-through.** Calibrar contra histórico BANVA en mes 2 y ajustar.

### 1.3 Reglas de margen alto vs bajo (modificadores sobre la tabla)

- SKU con **margen base > 35%** (segmento private label, 5% del catálogo): puede tolerar E1 más profundo (−20%) y mantener contribución. Activar bandera `tolera_descuento_alto = true`.
- SKU con **margen base < 18%** (commodity reseller Idetex, sábanas básicas): E1 se reduce a −5 a −10%; depender más de Oferta Compartida (ML co-fondea %) y bonificación de envío Full antes de profundizar markdown propio.
- SKU con **margen actual negativo** (ej: cubrecolchón cuna ACOS 77%, alfombra choapino entrada margen −6%): salta directamente a E3 + flag exit, no pasa por E1/E2. Discount no resuelve estos casos; el problema es ACOS y elegibilidad para Full.

---

## 2. Schema Supabase

> Asumir estructura razonable de tabla `skus` con: `sku`, `costo`, `precio_actual`, `velocidad_ponderada`, `dias_sin_venta`, `stock_actual`, `categoria`, `fecha_primera_venta`, `fecha_ultima_venta`, `estrategia_ads`. **Validar contra schema real antes de ejecutar.**

### 2.1 Tabla nueva: `markdown_schedule`

```sql
-- VALIDAR contra schema real BANVA antes de ejecutar
CREATE TABLE markdown_schedule (
  id                BIGSERIAL PRIMARY KEY,
  sku               TEXT NOT NULL REFERENCES skus(sku) ON DELETE CASCADE,
  escalon_actual    SMALLINT NOT NULL CHECK (escalon_actual BETWEEN 0 AND 4),
  -- 0 = sin markdown, 1=E1 -15%, 2=E2 -30%, 3=E3 -50%, 4=E4 -70%
  depth_pct         NUMERIC(5,2) NOT NULL CHECK (depth_pct BETWEEN 0 AND 80),
  precio_base       NUMERIC(12,2) NOT NULL,         -- precio "full" pre-markdown
  precio_markdown   NUMERIC(12,2) NOT NULL,         -- precio aplicado
  fecha_inicio      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fecha_fin_prevista TIMESTAMPTZ,                   -- inicio + 4 sem
  herramienta_ml    TEXT CHECK (herramienta_ml IN
                      ('descuento_porcentaje','oferta_dia','oferta_relampago',
                       'oferta_compartida','descuento_cantidad','manual')),
  estado            TEXT NOT NULL DEFAULT 'propuesto'
                      CHECK (estado IN ('propuesto','aprobado','activo',
                                        'completado','revertido','rechazado')),
  aprobado_por      TEXT,                           -- vicente | auto
  aprobado_at       TIMESTAMPTZ,
  motivo_trigger    TEXT,                           -- "edad>14 + STR<40%"
  velocidad_pre     NUMERIC(8,3),                   -- uds/sem antes
  velocidad_post    NUMERIC(8,3),                   -- uds/sem 14 días después
  lift_observado    NUMERIC(6,2),                   -- post/pre
  recovered_capital NUMERIC(12,2),                  -- ingresos liquidación
  notas             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_md_sku_estado     ON markdown_schedule(sku, estado);
CREATE INDEX idx_md_estado_fecha   ON markdown_schedule(estado, fecha_inicio DESC);
CREATE INDEX idx_md_escalon_activo ON markdown_schedule(escalon_actual)
  WHERE estado = 'activo';
```

### 2.2 ALTER TABLE skus — campos adicionales

```sql
ALTER TABLE skus ADD COLUMN IF NOT EXISTS clasificacion_velocidad CHAR(1)
  CHECK (clasificacion_velocidad IN ('A','B','C'));
ALTER TABLE skus ADD COLUMN IF NOT EXISTS sub_categoria_textil TEXT
  CHECK (sub_categoria_textil IN ('sabanas','quilts','toallas','decorativos','otros'));
ALTER TABLE skus ADD COLUMN IF NOT EXISTS tolera_descuento_alto BOOLEAN DEFAULT FALSE;
ALTER TABLE skus ADD COLUMN IF NOT EXISTS markdown_escalon_actual SMALLINT DEFAULT 0;
ALTER TABLE skus ADD COLUMN IF NOT EXISTS markdown_locked_until TIMESTAMPTZ; -- safeguard frecuencia
ALTER TABLE skus ADD COLUMN IF NOT EXISTS exit_flag BOOLEAN DEFAULT FALSE;
ALTER TABLE skus ADD COLUMN IF NOT EXISTS exit_etapa TEXT
  CHECK (exit_etapa IN (NULL,'liquidacion','pause','archive','deleted'));
ALTER TABLE skus ADD COLUMN IF NOT EXISTS sell_through_30d  NUMERIC(5,2);
ALTER TABLE skus ADD COLUMN IF NOT EXISTS sell_through_60d  NUMERIC(5,2);
ALTER TABLE skus ADD COLUMN IF NOT EXISTS sell_through_90d  NUMERIC(5,2);
ALTER TABLE skus ADD COLUMN IF NOT EXISTS sell_through_target NUMERIC(5,2); -- según sub_categoria

CREATE INDEX IF NOT EXISTS idx_skus_md_escalon ON skus(markdown_escalon_actual)
  WHERE markdown_escalon_actual > 0;
CREATE INDEX IF NOT EXISTS idx_skus_exit ON skus(exit_flag) WHERE exit_flag = TRUE;
```

### 2.3 Funciones SQL

```sql
-- Calcula escalón recomendado a partir de la matriz §1.2
-- VALIDAR nombres de columnas reales en tabla skus
CREATE OR REPLACE FUNCTION calcular_escalon_recomendado(p_sku TEXT)
RETURNS TABLE (
  escalon SMALLINT,
  depth_pct NUMERIC,
  motivo TEXT
) LANGUAGE plpgsql AS $$
DECLARE
  v_edad_sem  INT;
  v_vel       CHAR(1);
  v_str_60    NUMERIC;
  v_str_target NUMERIC;
  v_str_pct_plan NUMERIC;
  v_margen_neg BOOLEAN;
  v_tolera_alto BOOLEAN;
BEGIN
  SELECT
    GREATEST(1, EXTRACT(EPOCH FROM (NOW() - fecha_primera_venta))/604800)::INT,
    clasificacion_velocidad,
    sell_through_60d,
    sell_through_target,
    (precio_actual - costo)/NULLIF(precio_actual,0) < 0,
    tolera_descuento_alto
  INTO v_edad_sem, v_vel, v_str_60, v_str_target, v_margen_neg, v_tolera_alto
  FROM skus WHERE sku = p_sku;

  v_str_pct_plan := COALESCE(v_str_60 / NULLIF(v_str_target,0), 0);

  -- Bypass: SKU con margen negativo va directo a E3 + exit
  IF v_margen_neg THEN
    RETURN QUERY SELECT 3::SMALLINT, 50.0::NUMERIC,
      'margen_negativo_bypass'::TEXT;
    RETURN;
  END IF;

  -- Lookup matriz §1.2
  IF v_edad_sem < 6 THEN
    RETURN QUERY SELECT 0::SMALLINT, 0.0::NUMERIC, 'ventana_aprendizaje'::TEXT;
  ELSIF v_edad_sem < 10 THEN
    IF v_vel = 'C' THEN
      RETURN QUERY SELECT 1::SMALLINT,
        CASE WHEN v_tolera_alto THEN 20.0 ELSE 15.0 END,
        format('edad=%s vel=C', v_edad_sem);
    ELSIF v_vel = 'B' AND v_str_pct_plan < 0.3 THEN
      RETURN QUERY SELECT 1::SMALLINT, 15.0::NUMERIC,
        format('edad=%s vel=B str_pct=%s', v_edad_sem, v_str_pct_plan);
    ELSE
      RETURN QUERY SELECT 0::SMALLINT, 0.0::NUMERIC, 'sin_trigger'::TEXT;
    END IF;
  ELSIF v_edad_sem < 14 THEN
    IF v_vel = 'A' AND v_str_pct_plan < 0.4 THEN
      RETURN QUERY SELECT 1::SMALLINT, 15.0::NUMERIC, 'A_str_bajo'::TEXT;
    ELSE
      RETURN QUERY SELECT 2::SMALLINT, 30.0::NUMERIC,
        format('edad=%s vel=%s', v_edad_sem, v_vel);
    END IF;
  ELSIF v_edad_sem < 20 THEN
    RETURN QUERY SELECT
      CASE v_vel WHEN 'C' THEN 3::SMALLINT ELSE 2::SMALLINT END,
      CASE v_vel WHEN 'C' THEN 50.0::NUMERIC ELSE 30.0::NUMERIC END,
      format('edad=%s vel=%s', v_edad_sem, v_vel);
  ELSIF v_edad_sem < 26 THEN
    RETURN QUERY SELECT
      CASE v_vel WHEN 'A' THEN 3::SMALLINT WHEN 'B' THEN 3::SMALLINT
                 ELSE 4::SMALLINT END,
      CASE v_vel WHEN 'A' THEN 50.0::NUMERIC WHEN 'B' THEN 50.0::NUMERIC
                 ELSE 70.0::NUMERIC END,
      format('edad=%s vel=%s', v_edad_sem, v_vel);
  ELSE
    RETURN QUERY SELECT 4::SMALLINT, 70.0::NUMERIC,
      format('edad=%s vel=%s exit_candidate', v_edad_sem, v_vel);
  END IF;
END $$;

-- Aplica markdown: registra en markdown_schedule + actualiza skus
CREATE OR REPLACE FUNCTION aplicar_markdown(
  p_sku           TEXT,
  p_escalon       SMALLINT,
  p_depth_pct     NUMERIC,
  p_herramienta   TEXT,
  p_aprobado_por  TEXT,
  p_motivo        TEXT
) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_id BIGINT;
  v_precio_base    NUMERIC(12,2);
  v_precio_md      NUMERIC(12,2);
  v_costo          NUMERIC(12,2);
  v_floor          NUMERIC(12,2);
  v_locked_until   TIMESTAMPTZ;
BEGIN
  SELECT precio_actual, costo, markdown_locked_until
  INTO v_precio_base, v_costo, v_locked_until
  FROM skus WHERE sku = p_sku FOR UPDATE;

  -- Safeguard 1: frecuencia mínima entre cambios
  IF v_locked_until IS NOT NULL AND v_locked_until > NOW() THEN
    RAISE EXCEPTION 'SKU % bloqueado hasta % (frecuencia mínima)', p_sku, v_locked_until;
  END IF;

  v_precio_md := ROUND(v_precio_base * (1 - p_depth_pct/100), 0);

  -- Safeguard 2: cost floor (costo + 14.5% comisión MLC + envío estimado + 5% buffer)
  v_floor := ROUND(v_costo * 1.205 + 1500, 0);  -- 1500 CLP envío estimado, ajustar
  IF v_precio_md < v_floor THEN
    RAISE EXCEPTION 'precio_markdown=% bajo cost_floor=% para SKU %',
      v_precio_md, v_floor, p_sku;
  END IF;

  -- Safeguard 3: cap absoluto -70%
  IF p_depth_pct > 70 AND p_aprobado_por != 'vicente_override' THEN
    RAISE EXCEPTION 'depth=%%% excede cap 70%% (requiere vicente_override)', p_depth_pct;
  END IF;

  INSERT INTO markdown_schedule (
    sku, escalon_actual, depth_pct, precio_base, precio_markdown,
    fecha_fin_prevista, herramienta_ml, estado,
    aprobado_por, aprobado_at, motivo_trigger, velocidad_pre
  )
  SELECT p_sku, p_escalon, p_depth_pct, v_precio_base, v_precio_md,
         NOW() + INTERVAL '4 weeks', p_herramienta, 'aprobado',
         p_aprobado_por, NOW(), p_motivo, velocidad_ponderada
  FROM skus WHERE sku = p_sku
  RETURNING id INTO v_id;

  UPDATE skus SET
    markdown_escalon_actual = p_escalon,
    markdown_locked_until   = NOW() + INTERVAL '7 days',  -- safeguard frecuencia
    updated_at = NOW()
  WHERE sku = p_sku;

  RETURN v_id;
END $$;

-- Reversa un markdown (subir precio post-discount). Uso restrictivo.
CREATE OR REPLACE FUNCTION revertir_markdown(
  p_sku TEXT,
  p_motivo TEXT,
  p_aprobado_por TEXT
) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_id_actual BIGINT;
  v_dias_desde_md INT;
BEGIN
  SELECT id, EXTRACT(DAY FROM NOW() - fecha_inicio)::INT
  INTO v_id_actual, v_dias_desde_md
  FROM markdown_schedule
  WHERE sku = p_sku AND estado = 'activo'
  ORDER BY fecha_inicio DESC LIMIT 1;

  IF v_id_actual IS NULL THEN
    RAISE EXCEPTION 'No hay markdown activo en SKU %', p_sku;
  END IF;

  -- Safeguard MLC: NO revertir durante promo activa (te saca)
  -- Esperar a vencimiento natural si herramienta_ml es promo activa
  IF v_dias_desde_md < 30 THEN
    RAISE EXCEPTION
      'Reversal bloqueado: %s días desde markdown (mínimo 30 por regla credibilidad MLC)',
      v_dias_desde_md;
  END IF;

  UPDATE markdown_schedule
  SET estado = 'revertido', notas = p_motivo, aprobado_por = p_aprobado_por
  WHERE id = v_id_actual;

  UPDATE skus SET
    markdown_escalon_actual = 0,
    markdown_locked_until = NOW() + INTERVAL '7 days'
  WHERE sku = p_sku;

  RETURN v_id_actual;
END $$;

-- Evalúa si SKU debe entrar a EXIT
CREATE OR REPLACE FUNCTION evaluar_exit(p_sku TEXT)
RETURNS TABLE (debe_exit BOOLEAN, etapa TEXT, motivo TEXT)
LANGUAGE plpgsql AS $$
DECLARE
  v_edad INT;
  v_stock INT;
  v_dias_sin_venta INT;
  v_escalon SMALLINT;
  v_precio NUMERIC;
  v_costo NUMERIC;
BEGIN
  SELECT
    EXTRACT(EPOCH FROM (NOW() - fecha_primera_venta))/604800,
    stock_actual, dias_sin_venta, markdown_escalon_actual,
    precio_actual, costo
  INTO v_edad, v_stock, v_dias_sin_venta, v_escalon, v_precio, v_costo
  FROM skus WHERE sku = p_sku;

  -- Etapa 1: liquidacion (E4 hace 8 sem y aún hay stock)
  IF v_escalon = 4 AND v_edad >= 28 AND v_stock > 0 THEN
    RETURN QUERY SELECT TRUE, 'liquidacion'::TEXT,
      'E4_8sem_stock_pendiente'::TEXT;
  -- Etapa 2: pause (stock=0 pero listing activo, sin venta 90d)
  ELSIF v_stock = 0 AND v_dias_sin_venta >= 90 THEN
    RETURN QUERY SELECT TRUE, 'pause'::TEXT, 'sin_stock_90d'::TEXT;
  -- Etapa 3: archive (paused 30d)
  -- (este chequeo lo hace n8n leyendo exit_etapa + timestamps)
  -- Caso: pocas unidades + costo de carry > valor liquidación
  ELSIF v_stock <= 5 AND v_stock * v_precio < (v_costo * v_stock * 0.02 * 12) THEN
    RETURN QUERY SELECT TRUE, 'liquidacion'::TEXT,
      'unit_value_below_carry_cost'::TEXT;
  ELSE
    RETURN QUERY SELECT FALSE, NULL::TEXT, NULL::TEXT;
  END IF;
END $$;
```

---

## 3. Integración con Agente Pricing

### 3.1 Conexión con `pricing_rules` existente

Asumir que `pricing_rules` (existente, schema interno a validar) acepta filas con: `regla_tipo`, `condicion_sql`, `accion_json`, `prioridad`, `activa`. **Validar contra schema real.** Cargar las reglas de markdown como filas en esa tabla:

```sql
-- VALIDAR schema de pricing_rules antes de ejecutar
INSERT INTO pricing_rules (regla_tipo, condicion_sql, accion_json, prioridad, activa)
VALUES
  ('markdown_E1', 'edad_sem >= 6 AND clasificacion_velocidad = ''C''',
   '{"escalon":1,"depth_pct":15,"herramienta":"descuento_porcentaje"}'::jsonb, 50, TRUE),
  ('markdown_E2', 'edad_sem >= 10 AND str_pct_plan < 0.5',
   '{"escalon":2,"depth_pct":30,"herramienta":"oferta_dia"}'::jsonb, 60, TRUE),
  ('markdown_E3', 'edad_sem >= 14 AND str_pct_plan < 0.65',
   '{"escalon":3,"depth_pct":50,"herramienta":"oferta_relampago"}'::jsonb, 70, TRUE),
  ('markdown_E4', 'edad_sem >= 20 AND clasificacion_velocidad = ''C''',
   '{"escalon":4,"depth_pct":70,"herramienta":"oferta_relampago"}'::jsonb, 80, TRUE),
  ('exit_flag',   'edad_sem >= 26 AND clasificacion_velocidad = ''C''',
   '{"action":"flag_exit"}'::jsonb, 90, TRUE),
  ('margen_negativo_bypass', '(precio_actual - costo)/precio_actual < 0',
   '{"escalon":3,"depth_pct":50,"flag_exit":true}'::jsonb, 100, TRUE);
```

Prioridad mayor = se evalúa primero. `margen_negativo_bypass` (P=100) gana sobre todas las demás.

### 3.2 Flujo de evento (pseudo-código n8n)

**Workflow `markdown_weekly_evaluation` (cron: Lunes 06:00 CLT):**

```
1. Trigger: cron Lunes 06:00 CLT
2. Node Supabase Query:
     SELECT sku, calcular_escalon_recomendado(sku) FROM skus
     WHERE estado_listing = 'activo' AND stock_actual > 0
3. Filter: WHERE escalon_recomendado != markdown_escalon_actual
4. Loop por SKU:
     a. Insert en markdown_schedule con estado='propuesto'
     b. Acumula en batch
5. Node Slack/Email a Vicente (Martes 09:00 CLT vía workflow separado):
     - Asunto: "Markdown batch semana N — X SKUs proponiendo cambio"
     - Adjunto: link a página /markdown/batch en BANVA Bodega
6. Espera aprobación humana (estado pasa a 'aprobado' o 'rechazado')
7. Workflow `markdown_apply` (Miércoles 10:00 CLT):
     - Lee markdown_schedule WHERE estado='aprobado'
     - Para cada uno: invoca aplicar_markdown() → ejecuta safeguards SQL
     - Si pasa: llamada API MercadoLibre /promotions/v2 según herramienta_ml
     - Actualiza estado='activo'
     - Si MLC API falla: estado='aprobado' + retry (max 3) + alerta Slack
```

**Eventos que gatillan re-cálculo fuera del cron:**
| Evento | Acción |
|---|---|
| Semáforo Semanal reclasifica SKU a "muerto" | Forzar `calcular_escalon_recomendado` ese SKU + flag_exit |
| Semáforo reclasifica a "despegando" | Bloquear nuevo escalón; evaluar `revertir_markdown` (sólo si días_desde_md ≥ 30) |
| Velocidad pondera ≥ 2× post-markdown | Webhook → marcar `lift_observado`; pausar profundización |
| Stock_actual = 0 | Cerrar markdown_schedule activo, estado='completado' |
| `dias_sin_venta` ≥ 90 con stock > 0 | Forzar evaluación E4 + exit |

---

## 4. Cadencia operativa semanal

| Día | Hora CLT | Quién | Qué corre / Qué se hace |
|---|---|---|---|
| **Lunes** | 06:00 | n8n auto | Cron `markdown_weekly_evaluation`. Recalcula `calcular_escalon_recomendado` para los 425 SKUs. Inserta propuestas en `markdown_schedule` con estado='propuesto'. |
| **Lunes** | 09:00 | Raimundo | Revisa logs n8n. Si hubo errores SQL/API, fix. Confirma que batch está completo. |
| **Lunes** | 10:00–13:00 | Enrique | Revisa SKUs propuestos en página `/markdown/batch` de BANVA Bodega. Marca outliers (ej: SKU con foto rota, descripción mala) para corrección antes que markdown. Anota en `notas`. |
| **Martes** | 09:00 | n8n auto | Email/Slack a Vicente con resumen del batch: # SKUs por escalón, $ depth total, top 10 cambios por impacto $. Link directo a aprobación. |
| **Martes** | 09:00–12:00 | Vicente | Revisa batch en `/markdown/batch`. Aprobación bulk por escalón o SKU-por-SKU. Outliers/[DECISIÓN VICENTE] requeridos: depth >50%, exit flags, reversal. Estado pasa a 'aprobado' o 'rechazado'. |
| **Miércoles** | 10:00 | n8n auto | Cron `markdown_apply`. Ejecuta `aplicar_markdown()` SKU por SKU. Llama API MLC `/promotions/v2`. Estado pasa a 'activo'. Notifica Enrique para validación visual. |
| **Miércoles** | 11:00–13:00 | Enrique | Validación visual en MLC: precio mostrado correcto, badge de descuento aparece, listing no se cayó. Reporta cualquier anomalía a Raimundo. |
| **Jueves** | 06:00 | n8n auto | Webhook ML diario: actualiza `velocidad_post` para SKUs con markdown activo ≥7 días. Calcula `lift_observado`. |
| **Jueves** | 14:00 | Raimundo + Enrique | Stand-up 30 min: revisar lift por SKU. Profundizaciones de emergencia (lift <1×) o reversiones (lift >5× sospechoso) se proponen aquí. |
| **Viernes** | 06:00 | n8n auto | Cron `kpi_dashboard_refresh`: recalcula los 5 KPIs §7 para semana cerrada. |
| **Viernes** | 12:00 | Vicente | Revisa dashboard KPIs. Si `recovered_capital_%` < 35% acumulado → ajustar reglas Lunes siguiente. |
| **Viernes** | 14:00 | Joaquín | Recibe lista de SKUs en E4 + exit_flag con stock_actual ≤ 5. Plan de bodega: consolidar en zona de salida, prep para envío Full final. |

**RACI por persona:**
- **Vicente (Owner)**: Aprueba batch semanal (Mar). Decide overrides E4>−70%. Aprueba reversiones. Revisa KPIs (Vie).
- **Raimundo (Ingeniero)**: Mantiene n8n, Supabase, integración MLC API. Atiende incidentes técnicos. Sprint planning de mejoras al motor.
- **Enrique (Operaciones)**: Triage de outliers (Lun). Validación visual MLC (Mié). Stand-up jueves.
- **Joaquín (Warehouse)**: Recibe lista E4 + exit (Vie). Ejecuta consolidación física. Reporta destrucción/donación si aplica.

---

## 5. Decisión de exit definitivo

### 5.1 Criterios numéricos para descontinuar

Un SKU entra a EXIT si cumple **al menos uno** de los siguientes:

| Trigger | Threshold | Justificación |
|---|---|---|
| **WOS extremo** | WOS > 26 sem (≈ stock_actual/velocidad_ponderada > 26) | Paralelo a Storage Utilization Surcharge Amazon FBA (>26 sem) |
| **Sin venta prolongada** | `dias_sin_venta` ≥ 90 con stock > 0 | Definición operativa de "estancado severo"; alineado con corte de 90 días estándar Amazon FBA |
| **Dead stock contable** | `dias_sin_venta` ≥ 365 | Definición contable estándar (Qoblex, NetSuite) |
| **Stock irrelevante + carry-cost** | stock_actual ≤ 5 AND (stock × precio_liquidación) < (costo × stock × 24%) | Si valor liquidación es menor que 12 meses de carry cost (20-25% anual NetSuite), no vale gestionar |
| **E4 sin reaccionar** | escalón_actual = 4 hace ≥ 8 sem AND stock > 0 | E4 sin movimiento = mercado dijo "no a ningún precio" |
| **Margen permanentemente negativo** | margen actual < 0 hace ≥ 60 días Y `estrategia_ads = rentabilidad` no ayuda | Casos cubrecolchón cuna / alfombra choapino entrada |

**Cap operativo**: BANVA debe purgar 20–30% del catálogo activo anualmente (consenso McKinsey/Finale/Toolio). En 425 SKUs = 85–130 SKUs/año candidatos a evaluar para exit. Hoy ya hay 129 marcados (estancados+muertos) ⇒ el universo está alineado.

### 5.2 Proceso de exit en 4 etapas

| Etapa | Duración | Acción | Estado en `skus.exit_etapa` |
|---|---|---|---|
| **1. Liquidación** | hasta 8 sem o stock=0 | E4 (−70%) + Oferta Relámpago semanal + Descuentos por cantidad (combos 2×1 si aplica). Joaquín consolida físicamente para envío Full express. | `liquidacion` |
| **2. Pause** | 30 días | Listing en MLC pausado (no eliminado). Permite resucitar si llega comprador inesperado. Sin restock. Sin nuevo gasto Ads. | `pause` |
| **3. Archive** | indefinido | Listing archivado, removido del catálogo activo. Datos históricos retenidos en `skus` con `estado_listing='archivado'`. | `archive` |
| **4. Delete** | tras 12 meses en archive | Hard delete del listing MLC. SKU permanece en Supabase para auditoría. | `deleted` |

**Decisión de stock residual al pasar a Pause:**
- Stock ≤ 5 unidades: Joaquín ofrece a empleados a costo (1 vez), o donación benéfica (deducible tributariamente — [DECISIÓN VICENTE] sobre ONG receptora).
- Stock 6–20 unidades: 1 ronda más de E4 con Oferta Relámpago intensiva (4 semanas) antes de pausar.
- Stock > 20 unidades: [DECISIÓN VICENTE] — vender a liquidador externo (recovery típico 5–20% del costo según Liquidonate) o seguir en E4.

---

## 6. Modo semi-auto vs auto

### 6.1 Modo semi-auto (días 0–90, calibración)

**Definición exacta:**
- El motor (`calcular_escalon_recomendado` + n8n) genera propuestas semanalmente.
- Vicente aprueba batch los Martes. Sin aprobación → no se ejecuta.
- Aprobación es **bulk-default acepta-todo** con override individual.
- Cualquier reversal o exit es decisión humana.
- Ningún cambio se ejecuta sin trazabilidad: cada fila en `markdown_schedule` debe tener `aprobado_por != 'auto'`.

### 6.2 Criterios de transición a auto (graduación)

El sistema "se gradúa" cuando se cumplen **todos los siguientes** medidos sobre últimos 30 días:

| Criterio | Threshold | Por qué |
|---|---|---|
| Tasa de aprobación bulk | ≥ 90% de propuestas aprobadas sin edición | Indica que las reglas ya predicen lo que Vicente haría |
| Recovered capital acumulado | ≥ 35% del costo de SKUs en programa | Dentro del rango proactive (35–55%) Spoiler Alert |
| Lift promedio post-markdown | ≥ 1.5× (mediana SKUs en programa) | Elasticidad efectiva — el markdown está moviendo aguja |
| Errores operativos | 0 incidentes de cost-floor breach o cap >70% breach | Safeguards funcionan |
| Cobertura | ≥ 50% del universo en programa fue evaluado al menos una vez | Volumen suficiente de datos calibración |

Cumplir estos 5 ⇒ Vicente aprueba paso a auto. **Si uno falla en un mes posterior, se vuelve a semi-auto automáticamente** (rollback automático).

### 6.3 Safeguards en modo auto (lista exhaustiva)

Implementar como CHECKs en `aplicar_markdown()` y validaciones n8n previas a llamada MLC API:

1. **Cost floor duro**: `precio_markdown ≥ costo × 1.205 + envío_estimado`. Hard-coded. Si falla → exception, no se ejecuta.
2. **Cap absoluto −70%**: `depth_pct ≤ 70`. Para >70 requiere `aprobado_por='vicente_override'` explícito.
3. **Frecuencia mínima por SKU**: `markdown_locked_until` enforce ≥ 7 días entre cambios del mismo SKU. Excepción Black Friday/Cyber: hasta 2/semana con aprobación previa Vicente.
4. **Ventana credibilidad MLC (regla oficial ML)**: subir precio post-markdown bloqueado durante ≤ 30 días desde `fecha_inicio` del markdown. Justificación: regla "credibilidad de descuentos" de MLC valida histórico 30 días; subir antes invalida tachado.
5. **Sanity de orden de magnitud**: `precio_markdown` debe estar dentro de ±50% del precio promedio últimos 30 días. Fuera → bloqueo + alerta. Previene Best Buy/$23M-glitch.
6. **Cambio brusco single-op**: si `|precio_markdown - precio_actual|/precio_actual > 0.20` → pausa SKU + alerta Slack a Vicente. Si > 0.30 → bloqueo automático.
7. **Anti-oscillation**: si SKU registra ≥ 3 cambios en 7 días → auto-pause + alerta. Previene loops repricer (lección Amazon $23M).
8. **Daily reconciliation**: cron 06:00 diario compara `precio_actual` en Supabase vs precio vivo MLC API. Discrepancia → alerta. Previene drift silencioso.
9. **Threshold revisión humana en auto**: descuentos en `escalon=4` (−70%) siempre requieren `aprobado_por != 'auto'`. Auto solo aplica E1-E3.
10. **No subir precio durante promo activa MLC**: si `markdown_schedule.estado='activo'` y herramienta es oferta_dia/relampago/compartida, bloquear cualquier UPDATE precio hasta `fecha_fin_prevista`. Razón: regla MLC oficial — subir saca de la promo y regla credibilidad invalida tachado.
11. **Promo overlap prevention**: un SKU no puede tener 2 filas en `markdown_schedule` con `estado='activo'` simultáneamente.
12. **Kill switch global**: tabla `system_flags` con flag `markdown_auto_enabled BOOLEAN`. Si FALSE, toda ejecución n8n se pausa. 1-click recovery por Raimundo o Vicente.
13. **Exclusión de top sellers**: SKUs con `velocidad_ponderada` en top-decil del catálogo nunca entran a markdown automático (cubrecolchón impermeable, quilts Atenas Beige 2P, toallas Cannon gris). Se protegen del motor — markdown sobre estos requiere aprobación Vicente explícita.
14. **Margen mínimo aceptable post-MD**: si `(precio_markdown - costo)/precio_markdown < 0.05` → require revisión humana incluso en auto.
15. **Logging completo**: cada operación del motor escribe a tabla `markdown_audit_log` con timestamp, SKU, before/after, motivo, aprobado_por. Inmutable, append-only.

---

## 7. KPIs de seguimiento

### 7.1 Tabla maestra de KPIs

| # | KPI | Fórmula exacta (SQL-ready) | Target inicial | Frecuencia |
|---|---|---|---|---|
| **1** | Recovered Capital % | `SUM(units_sold × precio_markdown) / SUM(units_in_program × costo)` por cohorte | ≥ 40% (mes 3) → ≥ 55% (mes 6) | Mensual + por cohorte |
| **2** | Days to Clear (mediana / P90) | `percentile_cont(0.5) WITHIN GROUP (ORDER BY (fecha_stock_zero - fecha_inicio_md))` | mediana ≤ 60 días | Por cohorte |
| **3** | Sell-through 14d / 30d post-markdown | `units_sold_post / units_in_stock_at_md_start` | 14d ≥ 25% / 30d ≥ 50% | Semanal |
| **4** | Velocity Lift | `velocidad_post_14d / velocidad_pre_14d` | ≥ 1.5× (mediana cohorte) | Semanal post-MD |
| **5** | Cannibalization Rate | `1 - (revenue_full_price_familia_post / revenue_full_price_familia_pre)` corregido por trend baseline; método holdout-pareado dentro de sub_categoria_textil | ≤ 25% | Por evento promocional |
| **6** | Margin Erosion $ | `SUM((precio_base - precio_markdown) × units_sold)` | reportar valor absoluto; meta = no exceder 30% del recovered capital | Mensual |
| **7** | Markdown Velocity ($) | `SUM(precio_markdown × units_sold) / N_semanas` | aspiracional: liquidar $10M en ≤ 12 semanas = $833k CLP/sem | Semanal |
| **8** | GMROI por SKU sobreviviente | `gross_margin_$_ttm / avg_inventory_at_cost` | ≥ 2.0 (Shopify benchmark home goods) | Trimestral |
| **9** | Tasa de aprobación bulk Vicente | `count(estado='aprobado') / count(estado IN ('aprobado','rechazado'))` | ≥ 90% para graduar a auto | Semanal |
| **10** | Errores de safeguard | `count(*) FROM markdown_audit_log WHERE evento='safeguard_blocked'` | 0 incidentes críticos (cost floor / cap >70%) | Diario |

### 7.2 Vista materializada para dashboard

```sql
CREATE MATERIALIZED VIEW kpi_markdown_weekly AS
SELECT
  date_trunc('week', m.fecha_inicio) AS semana,
  count(*) AS skus_en_programa,
  SUM(m.precio_markdown * COALESCE(s.stock_actual, 0)) AS capital_expuesto,
  SUM(m.precio_markdown * (m.velocidad_post * 14)) AS recovered_capital_14d_proxy,
  AVG(m.lift_observado) AS lift_promedio,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY m.depth_pct) AS depth_mediana,
  count(*) FILTER (WHERE m.escalon_actual = 4) AS skus_en_E4
FROM markdown_schedule m
JOIN skus s ON s.sku = m.sku
WHERE m.estado IN ('activo','completado')
GROUP BY 1;

CREATE UNIQUE INDEX ON kpi_markdown_weekly(semana);
-- refresh con cron viernes 06:00:
-- REFRESH MATERIALIZED VIEW CONCURRENTLY kpi_markdown_weekly;
```

### 7.3 Frecuencia de revisión

- **Diario** (auto, dashboard BANVA Bodega): KPI #10 (errores safeguard).
- **Semanal** (Viernes, Vicente): KPIs #3, #4, #7, #9.
- **Mensual** (primer Viernes mes, Vicente + Raimundo): KPIs #1, #2, #6.
- **Trimestral** (sprint planning Q): KPI #8 + revisión de thresholds de §1.2.

---

## 8. Aplicación a los 129 SKUs actuales

### 8.1 Plan de asignación inicial (semana 0)

**28 SKUs estancados ($3.0M CLP):** asumir edad ≥ 14 sem y velocidad B/C. Asignación:

| Bucket | # SKUs estimado | Escalón inicial | Herramienta MLC |
|---|---|---|---|
| Margen base ≥ 25% + vel B | ~12 | E2 (−30%) | Descuento por porcentaje + 1 Oferta del Día |
| Margen 15–25% + vel C | ~10 | E2 (−30%) con Oferta Compartida (ML co-fondea) | Oferta Compartida → menor sacrificio propio |
| Margen < 15% o ACOS > 30% | ~6 | E3 (−50%) directo | Oferta Relámpago |

**101 SKUs muertos ($7.0M CLP):** asumir edad ≥ 20 sem y velocidad C. Asignación:

| Bucket | # SKUs estimado | Escalón inicial | Acción adicional |
|---|---|---|---|
| Stock ≥ 20 uds + margen aún positivo | ~50 | E3 (−50%) | Oferta Relámpago semanal por 4 sem |
| Stock 6–19 uds | ~35 | E4 (−70%) | Oferta Relámpago + Descuentos por cantidad combos 2×1 |
| Stock ≤ 5 uds | ~10 | E4 (−70%) + flag exit inmediato | Liquidar 4 sem y luego pausar |
| Margen ya negativo (incluye cubrecolchón cuna, alfombra choapino) | ~6 | E3 directo + flag exit | Si E3 no mueve en 4 sem → pausa, no E4 (no profundizar pérdida) |

### 8.2 Cronograma 8 semanas

| Sem | Acciones operativas | Hito esperado |
|---|---|---|
| **1** | Implementar schema (§2). Cargar 129 SKUs en `markdown_schedule` con escalones de §8.1. Vicente aprueba el batch inicial completo. | 100% SKUs asignados |
| **2** | Activar promociones MLC vía API. Validación visual Enrique. Configurar Slack/email Vicente. | 129 listings con badge descuento |
| **3** | Primera medición lift 14d. Identificar early winners (lift > 2×) y early losers (lift < 1×). | Tabla lift por SKU |
| **4** | Profundizar SKUs sin lift: E1→E2, E2→E3 según matriz. Reportar `recovered_capital` semana 1-3 a Vicente. | Recovered capital ≥ 5% del expuesto |
| **5** | Aplicar Oferta Relámpago a top-30 SKUs por stock × depth. Joaquín consolida físicamente E4+exit candidates. | $1.5M CLP liquidados acumulado |
| **6** | Evaluar exit-flag: SKUs con E4 + 4 sem sin venta → pausar. Esperar Hot Sale CL / CyberDay si está en ventana. | ~10 SKUs pasan a `exit_etapa='pause'` |
| **7** | Segunda profundización masiva. Revisar cannibalization en sub_categoria. Si > 25% en sábanas básicas, reducir overlap. | $3.0M CLP liquidados acumulado |
| **8** | KPI checkpoint mensual. Decidir continuación, ajuste de thresholds, o transición a modo auto si criterios §6.2 cumplen. | Recovered capital ≥ 35%; mediana days-to-clear estimada |

**Meta agresiva 8 sem**: liquidar $4M CLP de los $10M expuestos (40%) y dejar el resto en E3/E4 trayectoria clara hacia exit.
**Meta conservadora 16 sem**: liquidar $7M CLP (70%) y purgar ~50 SKUs definitivamente.

---

## 9. Riesgos y mitigaciones

**Top 5 cosas que pueden salir mal y plan de respuesta:**

1. **Penalización algorítmica MLC por subir precio post-markdown.** Riesgo: SKU pierde sección Ofertas, conversion cae ~23% (dato oficial ML inverso). Mitigación: bloqueo SQL en `revertir_markdown` si `dias_desde_md < 30` (regla credibilidad MLC). Reversiones se programan al fin de promo natural, no manual mid-promo. Si SKU debe subir, hacerlo en escalones de ≤10% espaciados 7 días (heurística cross-marketplace).

2. **Cost-floor breach por bug de cálculo o data sucia.** Riesgo: vender bajo costo, pérdida directa. Mitigación: triple check en `aplicar_markdown` (CHECK SQL) + n8n pre-validation + reconciliation diaria 06:00 vs API MLC. En primer breach: kill switch global, auditoría en <24h, reanudar solo con sign-off Vicente. Lección Amazon $23M: cap absoluto SIEMPRE en Max Y Min.

3. **Cannibalization > 25% sobre SKUs full-price comparables.** Riesgo: el markdown roba ventas a SKUs sanos de la misma sub_categoria, no genera demanda incremental. Mitigación: KPI #5 monitoreado semanal. Si supera threshold en una sub_categoria, pausar markdowns nuevos en esa sub_categoria 14 días y rehacer baseline. Para BANVA con SKUs reseller Idetex, esto es probable en sábanas básicas (alta sustituibilidad). Mitigar con holdout: dejar 20% de SKUs slow-movers en sub_categoria sin markdown como control.

4. **Vicente bottleneck en aprobación batch (Mar).** Riesgo: si Vicente no aprueba a tiempo, semana de markdown se pierde, $10M sigue inmovilizado más tiempo. Mitigación: regla de auto-aprobación post-72h para escalones E1-E2 que cumplan TODOS los safeguards (no para E3-E4). Backup: Raimundo tiene permiso de aprobación delegado para E1-E2 si Vicente está fuera ≥ 48h (registrado en `aprobado_por='raimundo_delegate'`).

5. **Top sellers (cubrecolchón impermeable, quilts Atenas, toallas Cannon) entran al motor por error y reciben markdown innecesario.** Riesgo: regalar margen sobre los 3 SKUs que generan caja. Mitigación: Safeguard #13 — exclusión hard-coded de top decil de velocidad. Lista whitelist en `system_flags.markdown_excluded_skus` revisada mensualmente. Auditoría: cualquier markdown sobre SKU whitelist requiere `aprobado_por='vicente_explicit'`.

**Riesgos secundarios documentados pero no en top 5:**
- Sobre-rotación de cambios de precio puede afectar reputación; mitigado con `markdown_locked_until` (7 días).
- Liquidador externo da recovery 5–10% (dato Liquidonate); usar solo como último recurso post-pause.
- MLC API rate limits / cambios de schema / depreciación: monitor cron de health-check API + alerta Slack si fallo > 2 ejecuciones consecutivas.

---

## Anexo A: Fuentes citadas

1. Increff — Guide to Markdown Optimization. https://www.increff.com/blog/a-guide-to-markdown-optimization-for-retailers
2. Increff — Markdown Optimization solution. https://www.increff.com/solution/markdown-optimization
3. Increff — Calculated ideal store-level discounts case. https://www.increff.com/blog/casestudy/calculated-ideal-store-level-discounts-to-reduce-sales-loss-and-maximize-margins/
4. Toolio — Sell-Through Rate strategies. https://www.toolio.com/post/sell-through-rate-how-to-calculate-and-5-strategies-to-optimize
5. Toolio — Markdowns vs Discounts. https://landing.toolio.com/post/markdowns-vs-discounts-strategy-timing-and-margin-impact
6. Toolio — Retail Math Formulas. https://www.toolio.com/post/fundamental-retail-math-formulas
7. Toolio — Case Studies (Weezie, Magnolia, Stio). https://www.toolio.com/case-studies
8. Toolio — SKU Rationalization. https://www.toolio.com/post/sku-rationalization-what-it-is-and-how-to-optimize-it
9. Toolio — GMROI guide. https://www.toolio.com/post/the-complete-guide-to-gmroi-for-retail-brands
10. Impact Analytics — Markdown Optimization Part 3. https://www.impactanalytics.ai/blog/markdown-optimization-part-3-how-to-succeed-if-youre-not-using-pricing-software
11. Pricefx — Markdown Depth for Retailers. https://www.pricefx.com/learning-center/markdown-depth-for-retailers-the-key-determining-factors
12. ClearDemand — Fundamentals of Retail Science Markdown. https://cleardemand.com/fundamentals-of-retail-science-episode-v-markdown-in-retail/
13. Smith & Achabal 1998 — Clearance Pricing. https://pubsonline.informs.org/doi/abs/10.1287/mnsc.44.3.285
14. Caro & Gallien 2012 — Zara field experiment. http://personal.anderson.ucla.edu/felipe.caro/papers/pdf_FC15.pdf
15. Smith & Agrawal — Markdown Optimization. https://www.linkedin.com/pulse/markdown-optimization-retail-chains-problem-all-seasons-agrawal
16. Cotton Incorporated — Effective Markdown Techniques. https://cottonworks.com/en/topics/retail-marketing/retail-math/retail-math-effective-markdown-techniques-planning-markdowns/
17. Cottonworks — Calculating Markdowns PDF. https://www.cottonworks.com/wp-content/uploads/2017/10/4-5Calculating-Markdowns.pdf
18. Coresight Research 2018 — Hidden costs of inventory mgmt. https://coresight.com/research/us-retailer-survey-revealing-the-hidden-costs-of-poor-inventory-management-2/
19. PRNewswire/Coresight 2018. https://www.prnewswire.com/news-releases/study-finds-markdowns-cost-us-retailers-300-billion-in-revenues-in-2018-300790350.html
20. Accelerated Analytics — Calculating Sell-Through. https://www.acceleratedanalytics.com/blog/2019/01/30/calculating-sell-through/
21. Shopify — Sell-Through Rate. https://www.shopify.com/blog/sell-through-rate
22. Shopify — Retail Markdowns. https://www.shopify.com/blog/retail-markdowns
23. Shopify — GMROI. https://www.shopify.com/retail/gmroi
24. Lightspeed — Sell-Through Rate. https://www.lightspeedhq.com/blog/sell-through-rate
25. Lightspeed — Top Retail Markdown Strategies. https://www.lightspeedhq.com/blog/the-top-retail-markdown-strategies/
26. ISM Magazine 2024 — Sell-Through monthly metric. https://www.ismworld.org/supply-management-news-and-reports/news-publications/inside-supply-management-magazine/blog/2024/2024-10/the-monthly-metric-sell-through-rate/
27. KISSmetrics — Sell-Through glossary. https://www.kissmetrics.io/glossary/sell-through-rate
28. StyleMatrix benchmarks. https://stylematrix.io/stylematrix-sell-through-decoding-retail-sell-through-benchmarks-for-success/
29. Onramp Funds — Inventory Turnover Benchmarks 2025. https://www.onrampfunds.com/resources/inventory-turnover-benchmarks-by-industry-2025
30. Red Stag Fulfillment — Slow-moving inventory. https://redstagfulfillment.com/how-to-identify-slow-moving-inventory/
31. eBay Sale Event official. https://export.ebay.com/en/services-tools/discounts-manager/sale-event/
32. eBay UK Markdown Manager. https://www.ebay.co.uk/sellercentre/grow-your-sales/using-promotions-to-boost-your-sales/sale-event-markdown
33. Amazon Seller Central — Price Discounts. https://sellercentral.amazon.com/help/hub/reference/external/G7F8CQ4EJ5YA4272
34. Amazon Outlet — RepricerExpress. https://www.repricerexpress.com/amazon-outlet/
35. MercadoLibre Vendedores CL — Descuento por porcentaje. https://vendedores.mercadolibre.cl/nota/como-crear-un-descuento-por-porcentaje
36. MercadoLibre Vendedores CL — Oferta compartida. https://vendedores.mercadolibre.cl/nota/ofrece-un-descuento-y-nosotros-sumamos-un-porcentaje-extra
37. MercadoLibre Vendedores CL — Central de promociones. https://vendedores.mercadolibre.cl/nota/conoce-tu-central-de-promociones-y-ofrece-descuentos
38. MercadoLibre Ayuda CO — Condiciones descuento. https://www.mercadolibre.com.co/ayuda/3666
39. MercadoLibre Ayuda — Modificar precio publicación con descuento. https://www.mercadolibre.com.co/ayuda/Que-pasa-si-modifico-el-precio-de-una-publicacion-con-descuento_28710
40. MercadoLibre Vendedores UY — Credibilidad de descuentos. https://vendedores.mercadolibre.com.uy/nota/credibilidad-de-los-descuentos-que-es-y-como-cuidarla
41. MercadoLibre Vendedores AR — Ajustes automáticos de precio. https://vendedores.mercadolibre.com.ar/nota/vende-mas-con-ajustes-automaticos-de-precio
42. MercadoLibre Vendedores MX — Ofertas Relámpago. https://vendedores.mercadolibre.com.mx/nota/ofertas-relampago-liquida-tu-stock-en-pocas-horas
43. MercadoLibre Vendedores MX — Descuentos por cantidad. https://vendedores.mercadolibre.com.mx/nota/como-crear-descuentos-por-cantidad-para-liquidar-tu-stock
44. MercadoLibre Developers — API de precios. https://developers.mercadolibre.cl/es_ar/categorias-y-publicaciones/api-de-precios
45. MercadoLibre Developers — Reputación de vendedores. https://developers.mercadolibre.com.ar/reputacion-de-vendedores
46. MercadoLibre Developers — Calidad de publicaciones. https://developers.mercadolibre.com.ar/calidad-de-publicaciones
47. MercadoLibre Developers — Ofertas Relámpago API. https://developers.mercadolibre.com.ar/es_ar/ofertas-relampago
48. Nubimetrics Academia — Algoritmo MercadoLibre. https://academia.nubimetrics.com/algoritmo-mercado-libre
49. Nubimetrics — Estrategia de precios. https://academia.nubimetrics.com/estrategia-de-precios
50. Nubimetrics — Optimización precios IA. https://academia.nubimetrics.com/optimizacion-precios-inteligencia-artificial
51. Nubimetrics — Análisis datos. https://academia.nubimetrics.com/analisis-datos-mercado-libre
52. Nubimetrics — Productos ganadores. https://academia.nubimetrics.com/productos-ganadores
53. Real Trends — Cómo estar en primeras posiciones MLC. https://real-trends.medium.com/c%C3%B3mo-estar-en-las-primeras-posiciones-de-una-b%C3%BAsqueda-en-mercadolibre-6c8b1e6beed2
54. Real Trends — Reputación MercadoLibre. https://blog.real-trends.com/2020/09/07/ajustes-en-la-reputacion-de-mercado-libre/
55. Algoritmo Digital. https://algoritmodigital.com.ar/algoritmo-de-mercado-libre-2025-como-posicionar-tus-billeteras/
56. GF Marketing — Pricing MLC. https://gfmarketing.com.ar/pricing-en-mercado-libre/
57. SmartSelling — Precios dinámicos MLC. https://smartselling.com.ar/precios-dinamicos-maximizando-ganancias-en-mercado-libre/
58. Tiendanube — Mejorar publicaciones MLC. https://www.tiendanube.com/blog/mejorar-publicaciones-mercado-libre/
59. Heuritech — Sell-through fashion. https://heuritech.com/articles/sell-through-fashion/
60. Eagle Rock CFO — Retail margins. https://www.eaglerockcfo.com/blog/profitability-guide/gross-margins-retail
61. StoreRadar — Sell-through formula. https://www.storeradar.com/formulas/sell-through-rate/
62. Opensend — STR statistics 2025. https://www.opensend.com/post/sell-through-rate-statistics-ecommerce
63. Pimberly — Sell-Through glossary. https://pimberly.com/glossary/sell-through-rate/
64. Study.com — Retail markdowns. https://study.com/academy/lesson/retail-markdowns-calculation-strategy.html
65. Grocery Coupon Guide — Target sticker system. https://www.grocerycouponguide.com/articles/the-markdown-label-color-that-signals-the-deepest-discount/
66. All Things Target — Markdown schedule. https://allthingstarget.com/markdown-schedule/
67. KrazyCouponLady — Retailer Clearance. https://thekrazycouponlady.com/tips/store-hacks/retailer-clearance-markdown-cheatsheet
68. Amazon Seller Forum — Penalty box on price increases. https://sellercentral.amazon.com/seller-forums/discussions/t/35f6acb8-8701-4aab-b08c-8565a088afc2
69. Fortune — Amazon sellers losing Buy Box. https://fortune.com/article/amazon-sellers-losing-buy-box-price-increases-tariffs-trump-china/
70. First Insight — Markdown death spiral. https://www.firstinsight.com/blog/how-retailers-can-avoid-the-markdown-death-spiral
71. NetSuite — Dead stock + carrying cost. https://www.netsuite.com/portal/resource/articles/inventory-management/dead-stock.shtml
72. Manufacturing.net — Real cost of dead inventory. https://www.manufacturing.net/home/article/13117104/what-is-the-real-cost-of-dead-inventory
73. McKinsey — Mastering complexity. https://www.mckinsey.com/capabilities/operations/our-insights/mastering-complexity-with-the-consumer-first-product-portfolio
74. McKinsey — Harnessing simplicity. https://www.mckinsey.com/capabilities/growth-marketing-and-sales/our-insights/harnessing-the-power-of-simplicity-in-a-complex-consumer-product-environment
75. McKinsey — Dynamic pricing in retail. https://www.mckinsey.com/capabilities/growth-marketing-and-sales/our-insights/the-dos-and-donts-of-dynamic-pricing-in-retail
76. SellerApp — Amazon IPI. https://www.sellerapp.com/blog/amazon-inventory-performance-index-ipi/
77. eFulfillmentService — FBA 2025 updates. https://www.efulfillmentservice.com/2025/06/amazon-fba-updates-2025-navigating-new-capacity-limits-ipi-changes-prime-day-prep/
78. SCDigest — Walmart SKU rationalization reversal. https://www.scdigest.com/ontarget/11-04-14-2.php?cid=4438
79. RetailWire — Walmart reverses SKU cuts. https://retailwire.com/discussion/walmart-reverses-course-on-sku-rationalization/
80. Science.org — $23M textbook bug. https://www.science.org/content/article/23-million-textbook
81. Michael Eisen blog — Making of a Fly. https://www.michaeleisen.org/blog/?p=358
82. Retail Dive — Walmart 2013 glitch. https://www.retaildive.com/news/walmart-website-glitch-leads-to-insane-discounts-social-media-storm/191763/
83. Repricer.com — Min/Max prices. https://support.repricer.com/minimum-and-maximum-prices
84. Repricer.com — FBA Low-Price Profit Guard. https://support.repricer.com/fba-low-price-profit-guard
85. SellerVault — Repricing complete guide. https://sellervault.io/blog/how-to-reprice-on-amazon-complete-guide
86. Revionics — AI guardrails. https://revionics.com/blog/exploring-the-future-of-ai-revionics-vp-talks-genai-scalability-and-the-importance-of-guardrails
87. 42Signals — Price guardrails. https://www.42signals.com/blog/price-guardrails-for-reputation-management/
88. PriceShape — Dynamic pricing examples. https://priceshape.com/resources/blog/dynamic-pricing-examples-e-commerce
89. ToolsGroup — Long tail forecasting. https://www.toolsgroup.com/blog/forecasting-the-long-tail-and-intermittent-demand/
90. Spoiler Alert — 3 KPIs closeouts. https://blog.spoileralert.com/3-kpis-closeouts-program
91. Liquidate Products — Smart liquidation. https://liquidateproducts.com/blog/how-smart-businesses-use-liquidation-strategically/
92. Liquidonate — How much to liquidate excess. https://www.liquidonate.com/blog/how-much-cost-liquidate-company-excess-inventory
93. Priceva — Markdown pricing. https://priceva.com/blog/markdown-pricing
94. o9 Solutions — Effective markdown optimization. https://o9solutions.com/articles/effective-markdown-optimization
95. Parker Avery — Markdown optimization 800-store case. https://parkeravery.com/industry-experience/markdown-optimization-solution-vastly-improves-retailers-sell-through-and-margin/
96. Centric Software — Markdown optimization fashion. https://www.centricsoftware.com/blog/markdown-optimization-fashion-retailers/
97. Ashok Charan — Cannibalization measurement. https://www.ashokcharan.com/Marketing-Analytics/~pm-cannibalization.php
98. CrossCap — Promotion lift analysis. https://www.crosscap.com/guide-to-analyzing-the-overall-lift-of-a-retail-promotion/
99. Crisp — Product cannibalization. https://www.gocrisp.com/learning-center/marketing-finance-and-more/product-cannibalization-in-retail
100. Aalto thesis — Cannibalization in retail promotions. https://sal.aalto.fi/publications/pdf-files/ther18_public.pdf
101. Tredence — Promotion effectiveness. https://www.tredence.com/blog/decoding-the-metrics-a-deep-dive-into-calculating-promotion-effectiveness
102. invent.ai — Fashion + home goods case. https://www.invent.ai/case-study/powering-inventory-and-markdown-optimization-for-leading-fashion-home-goods-retailers-across-the-globe
103. Wair.ai — AI markdown promotional. https://wair.ai/ai-markdown-promotional-inventory-optimization/
104. Cleverence — Retail inventory turns. https://www.cleverence.com/articles/for-business/retail-inventory-turns-benchmark-4829/
105. Startup Financial Projection — Bedding store KPIs. https://startupfinancialprojection.com/blogs/kpis/bedding-store
106. Retalon — GMROI. https://retalon.com/blog/what-is-gmroi
107. Qoblex — Dead stock meaning. https://qoblex.com/blog/dead-stock-meaning-what-it-is-why-it-matters-and-how-to-prevent-it/
108. PitchBook — BBB Chapter 11 plan. https://pitchbook.com/news/articles/bed-bath-beyond-chapter-11-liquidation-plan-nets-confirmation
109. Sodimac CL — Liquidación Total Homy. https://sodimac.falabella.com/sodimac-cl/collection/nos-unimos
110. Cronista — Falabella ARG remate. https://www.cronista.com/negocios/remate-falabella-sodimac-donde-y-como-conseguir-los-ultimos-productos-con-50-de-descuento/
111. Achalay — Posicionar publicaciones MLC 2026. https://achalay.net/blog/como-posicionar-publicaciones-mercado-libre-guia-2026/

---

## Anexo B: Datos concretos de la categoría textiles hogar

### B.1 Sell-through targets sintetizados (no benchmark directo, ver §1.2)

| Sub-categoría | 30d | 60d | 90d | 120d | Proxy usado |
|---|---|---|---|---|---|
| Sábanas / fundas | 25% | 45% | 60% | 75% | Shopify home improvement (55%@8sem→90%@52sem) + KISSmetrics core 70-85% |
| Cobertores / quilts | 40% | 60% | 75% | 85% | StyleMatrix seasonal outerwear (40-60% mes 1, 80% fin temporada) |
| Toallas | 22% | 40% | 60% | 70% | Coresight 60% non-grocery + Accelerated Analytics apparel (35%@8sem→76%@52sem) |
| Decorativos estacionales | 45% | 65% | 85% | 90%+ | KISSmetrics seasonal 80–95% |

### B.2 Banda de descuentos observada — categoría hogar MLC LATAM

- Oferta Relámpago hogar MX (live Feb 2026): 34, 36, 42, 52, 58, 66%.
- Sodimac CL Liquidación Total: hasta −64% sábanas Homy.
- Falabella ARG cierre: hasta −50% sábanas/almohadones.
- Walmart Christmas pattern: −50% D+1, −75% D+7, −90% D+21 (fuera-categoría hogar pero ilustrativo de profundidad).
- Bed Bath & Beyond liquidación 2023: −10% D-1 → −20% → −50/80% → −90%.

### B.3 Inventory turnover home goods

- Furniture/home furnishings: 2.0–4.0 turns/año (DIO 91–182 días).
- Healthy ecomm/wholesale general: 2.0–3.5+.
- GMROI home goods/furniture target: ≥ 2.0 (Shopify benchmark).

### B.4 Recovery rates publicados (proxy)

- Apparel store sector chapter-11 mediana: 44% (book value).
- Liquidación proactiva (6-8 sem antes de cerrar ventana): 35-55% recovery.
- Liquidación reactiva (3-4 meses tarde): 10-20%.
- Amazon return-to-liquidator: 5-10% del ASP; clothing 1.4%; appliances 19.2% mediana.
- BBB liquidación 2023: ~$718M en inventory sales totales, recovery a unsecured creditors 0-2.5%.

### B.5 Dato BANVA — ancla numérica para calibración

- 425 SKUs activos.
- 129 SKUs problemáticos (28 estancados $3.0M + 101 muertos $7.0M = $10M CLP) ≈ 30% del catálogo en problema, alineado con corte McKinsey/Toolio "purgar 20-30% anual".
- Margen histórico 23.3% — banda media; soporta E1 −15% sin agresivo daño contributivo; E3 −50% destruye margen pero recupera capital.
- ACOS 3.9% — saludable; problemas concentrados en SKUs específicos (cubrecolchón cuna ACOS 77%, alfombra choapino 36%) que deben ir a margen_negativo_bypass directamente.
- Conversion 2.97% — ligeramente bajo benchmark Brooklinen home (3.5-4%) pero razonable. Markdown debería mover esto al alza en SKUs intervenidos.
- Top sellers (cubrecolchón impermeable 77 ud/sem, quilts Atenas Beige 2P 24 ud/sem, toallas Cannon gris 24 ud/sem) → whitelist de exclusión markdown automático (Safeguard #13).

---

**[DECISIÓN VICENTE]** items que quedan abiertos para resolución antes de Sprint 1:

1. **Override de cap −70%**: ¿permitir excepciones puntuales en E4 hasta −80% o mantener cap duro? **Recomendación**: cap duro −70%; depth >70% requiere donar/destruir, no vender. Justificación: −80% sobre margen 23.3% destruye contribución y entrena al cliente a esperar saldos.
2. **Liquidador externo**: para SKUs muertos con stock > 20 uds que no se mueven en E4 + 8 sem, ¿vender a liquidador (recovery 5–10%) o donar? **Recomendación**: donar ONG hasta 5,000 USD anuales (deducción tributaria), liquidador externo solo si excede ese tope.
3. **Empleados a costo**: ¿permitir compra interna de stock residual ≤5 uds a costo? **Recomendación**: SÍ, máximo 1 vez por SKU, registrado en `markdown_audit_log` para evitar abuso.
4. **Holdout group para medir cannibalization**: ¿aceptar dejar 20% de SKUs slow en sub_categoria sin markdown como control, sacrificando velocidad de liquidación? **Recomendación**: SÍ por primeros 60 días para calibrar KPI #5; después soltar holdout.
5. **Whitelist top sellers**: confirmar lista exacta. **Recomendación inicial**: top decil por velocidad ponderada últimos 90 días = ~42 SKUs. Lista revisada mensualmente por Vicente.