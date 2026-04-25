# PR Ads Pipeline — Preauditoría

**Fecha**: 2026-04-25
**Alcance**: refactor del pipeline de métricas de ads ML — pasar de modelo mensual con sync condicional a daily con historial de configuración y health monitoring.
**Origen**: gap detectado al investigar PR6b. `ml_campaigns_mensual` se llenaba 1× al mes, dejó de sincronizarse el 6-abril (19 días sin actualizar) sin que nadie se enterara. Además no permite ver eficiencia de campañas en curso.

---

## 1. Findings de investigación previa

### 1.1 Los 5 campos avanzados no están disponibles en `campaigns/search`

Probé `impression_share`, `top_impression_share`, `lost_impression_share_by_budget`, `lost_impression_share_by_ad_rank`, `lost_by_budget`, `lost_by_rank`, `acos_benchmark`, `benchmark_acos` uno por uno contra `/marketplace/advertising/MLC/advertisers/.../product_ads/campaigns/search` con `api-version: 2`. **Todos rechazados**. El comentario actual del código (`ml-metrics.ts:422-423`) es exacto, no obsoleto.

**Métricos confirmados como aceptados**: `clicks, prints, ctr, cost, cpc, acos, roas, cvr, sov, direct_amount, indirect_amount, total_amount, direct_units_quantity, indirect_units_quantity, units_quantity, organic_units_quantity, organic_units_amount, direct_items_quantity, indirect_items_quantity, organic_items_quantity`.

**Decisión**: las columnas SQL se crean igual como `NULLABLE sin DEFAULT`. Si ML las habilita después (otro endpoint, otro tier), el cron las puebla sin tocar schema.

### 1.2 Estrategia de granularidad daily

- `aggregation_type=DAILY` agrega **todas las campañas en un solo row por día** — no sirve para tener `(campaign × day)`
- Sin `aggregation_type` y con `date_from=date_to=DAY` → un row por campaña con métricas de ese día específico
- Iterar día por día. Backfill 2026 (1-ene a 25-abr) = 115 días × 1 request = ~1 minuto con spacing 500ms

### 1.3 Bridge WhatsApp para health alerts

Patrón del droplet (Viki): scripts escriben JSON a `~/.whatsapp-channel/outbound/`, plugin Baileys (proceso bun) los lee con `fs.watch` y entrega.

Vercel no tiene acceso al filesystem del droplet → **outbox pattern**: Vercel inserta a tabla, script en droplet polea cada 1 min y dropa archivos al outbound. Retry gratis, desacoplado.

---

## 2. Migraciones SQL

### 2.1 `supabase-v73-ml-campaigns-daily-cache.sql`

```sql
CREATE TABLE ml_campaigns_daily_cache (
  campaign_id BIGINT NOT NULL,
  date DATE NOT NULL,
  -- Tráfico
  prints INTEGER,
  clicks INTEGER,
  -- Eficiencia
  cpc NUMERIC(10,2),
  ctr NUMERIC(8,4),
  cvr NUMERIC(8,4),
  -- Subasta (NULL hoy — endpoint no los devuelve, ver §1.1)
  sov NUMERIC(8,4),
  impression_share NUMERIC(8,4),
  top_impression_share NUMERIC(8,4),
  lost_by_budget NUMERIC(8,4),
  lost_by_rank NUMERIC(8,4),
  -- Financieras
  cost NUMERIC(12,2),
  direct_amount NUMERIC(12,2),
  indirect_amount NUMERIC(12,2),
  total_amount NUMERIC(12,2),
  acos_real NUMERIC(8,4),
  acos_benchmark NUMERIC(8,4),  -- NULL hoy
  roas_real NUMERIC(8,4),
  -- Unidades
  direct_units INTEGER,
  indirect_units INTEGER,
  organic_units INTEGER,
  organic_amount NUMERIC(12,2),
  -- Config snapshot del día (lo que tenía la campaña ese día)
  acos_target NUMERIC(8,4),
  budget NUMERIC(12,2),
  strategy TEXT,
  status TEXT,
  -- Meta
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, date)
);

CREATE INDEX idx_campaigns_daily_date ON ml_campaigns_daily_cache(date DESC);
CREATE INDEX idx_campaigns_daily_status ON ml_campaigns_daily_cache(status, date DESC);

ALTER TABLE ml_campaigns_daily_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "permissive" ON ml_campaigns_daily_cache USING (true) WITH CHECK (true);
```

### 2.2 `supabase-v74-ml-campaigns-config-history.sql`

```sql
CREATE TABLE ml_campaigns_config_history (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  field TEXT NOT NULL,        -- 'acos_target' | 'budget' | 'strategy' | 'status' | 'initial'
  old_value TEXT,
  new_value TEXT,
  source TEXT NOT NULL DEFAULT 'sync'  -- 'sync' | 'manual' | 'unknown'
);

CREATE INDEX idx_config_history_campaign ON ml_campaigns_config_history(campaign_id, changed_at DESC);

-- Trigger: detecta cambios en daily_cache
CREATE OR REPLACE FUNCTION track_campaign_config_changes()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Baseline: registrar estado inicial al ver la campaña por primera vez
    -- (solo cuando es realmente la primera vez para esa campaña)
    IF NOT EXISTS (
      SELECT 1 FROM ml_campaigns_config_history
      WHERE campaign_id = NEW.campaign_id LIMIT 1
    ) THEN
      INSERT INTO ml_campaigns_config_history(campaign_id, field, old_value, new_value, source)
      VALUES
        (NEW.campaign_id, 'initial.acos_target', NULL, NEW.acos_target::TEXT, 'sync'),
        (NEW.campaign_id, 'initial.budget',      NULL, NEW.budget::TEXT,      'sync'),
        (NEW.campaign_id, 'initial.strategy',    NULL, NEW.strategy,          'sync'),
        (NEW.campaign_id, 'initial.status',      NULL, NEW.status,            'sync');
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.acos_target IS DISTINCT FROM OLD.acos_target THEN
      INSERT INTO ml_campaigns_config_history(campaign_id, field, old_value, new_value, source)
      VALUES (NEW.campaign_id, 'acos_target', OLD.acos_target::TEXT, NEW.acos_target::TEXT, 'sync');
    END IF;
    IF NEW.budget IS DISTINCT FROM OLD.budget THEN
      INSERT INTO ml_campaigns_config_history(campaign_id, field, old_value, new_value, source)
      VALUES (NEW.campaign_id, 'budget', OLD.budget::TEXT, NEW.budget::TEXT, 'sync');
    END IF;
    IF NEW.strategy IS DISTINCT FROM OLD.strategy THEN
      INSERT INTO ml_campaigns_config_history(campaign_id, field, old_value, new_value, source)
      VALUES (NEW.campaign_id, 'strategy', OLD.strategy, NEW.strategy, 'sync');
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO ml_campaigns_config_history(campaign_id, field, old_value, new_value, source)
      VALUES (NEW.campaign_id, 'status', OLD.status, NEW.status, 'sync');
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_campaign_config_changes
AFTER INSERT OR UPDATE ON ml_campaigns_daily_cache
FOR EACH ROW EXECUTE FUNCTION track_campaign_config_changes();

ALTER TABLE ml_campaigns_config_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "permissive" ON ml_campaigns_config_history USING (true) WITH CHECK (true);
```

**Nota**: el INSERT-baseline solo dispara para la primera fila de cada `campaign_id`. Las siguientes inserciones diarias del mismo campaign_id no generan ruido. Los UPDATE solo registran cambios reales (`IS DISTINCT FROM`).

### 2.3 `supabase-v75-ml-sync-health.sql`

```sql
CREATE TABLE ml_sync_health (
  job_name TEXT PRIMARY KEY,
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  staleness_threshold_hours INTEGER NOT NULL,
  alert_channel TEXT NOT NULL DEFAULT 'whatsapp',
  alert_destination TEXT,                       -- chat_id WA o email
  is_alerting BOOLEAN NOT NULL DEFAULT FALSE,
  last_alert_sent_at TIMESTAMPTZ
);

INSERT INTO ml_sync_health(job_name, staleness_threshold_hours, alert_channel, alert_destination) VALUES
  ('campaigns_daily',  36, 'whatsapp', '56991655931@s.whatsapp.net'),
  ('ads_daily',        12, 'whatsapp', '56991655931@s.whatsapp.net'),
  ('metrics_monthly',  72, 'whatsapp', '56991655931@s.whatsapp.net');

ALTER TABLE ml_sync_health ENABLE ROW LEVEL SECURITY;
CREATE POLICY "permissive" ON ml_sync_health USING (true) WITH CHECK (true);
```

### 2.4 `supabase-v76-notifications-outbox.sql`

```sql
CREATE TABLE notifications_outbox (
  id BIGSERIAL PRIMARY KEY,
  channel TEXT NOT NULL,                      -- 'whatsapp', 'email', 'slack', ...
  destination TEXT NOT NULL,                  -- chat_id, email, etc.
  payload JSONB NOT NULL,                     -- { text, attachments, ... }
  status TEXT NOT NULL DEFAULT 'pending',     -- 'pending' | 'sent' | 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  last_error TEXT
);

CREATE INDEX idx_outbox_pending ON notifications_outbox(created_at)
  WHERE status = 'pending';

ALTER TABLE notifications_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY "permissive" ON notifications_outbox USING (true) WITH CHECK (true);
```

### 2.5 `supabase-v77-ml-campaigns-monthly-summary-view.sql`

```sql
CREATE OR REPLACE VIEW ml_campaigns_monthly_summary AS
SELECT
  campaign_id,
  TO_CHAR(date, 'YYYY-MM') AS periodo,
  SUM(prints) AS prints,
  SUM(clicks) AS clicks,
  SUM(cost) AS cost,
  SUM(total_amount) AS total_amount,
  SUM(direct_amount) AS direct_amount,
  SUM(indirect_amount) AS indirect_amount,
  SUM(direct_units) AS direct_units,
  SUM(indirect_units) AS indirect_units,
  SUM(organic_units) AS organic_units,
  -- ACOS y ROAS calculados desde totales (no AVG diario)
  CASE WHEN SUM(total_amount) > 0
       THEN SUM(cost)::NUMERIC / SUM(total_amount) * 100
       ELSE NULL END AS acos_real,
  CASE WHEN SUM(cost) > 0
       THEN SUM(total_amount)::NUMERIC / SUM(cost)
       ELSE NULL END AS roas_real,
  -- Ratios ponderados por prints (no AVG simple)
  CASE WHEN SUM(prints) > 0
       THEN SUM(prints * impression_share)::NUMERIC / SUM(prints)
       ELSE NULL END AS impression_share_avg,
  CASE WHEN SUM(prints) > 0
       THEN SUM(prints * lost_by_budget)::NUMERIC / SUM(prints)
       ELSE NULL END AS lost_by_budget_avg,
  CASE WHEN SUM(prints) > 0
       THEN SUM(prints * lost_by_rank)::NUMERIC / SUM(prints)
       ELSE NULL END AS lost_by_rank_avg,
  -- Config al final del período
  (array_agg(strategy ORDER BY date DESC))[1] AS strategy_final,
  (array_agg(status   ORDER BY date DESC))[1] AS status_final,
  (array_agg(budget   ORDER BY date DESC))[1] AS budget_final,
  MAX(synced_at) AS last_synced_at
FROM ml_campaigns_daily_cache
GROUP BY campaign_id, TO_CHAR(date, 'YYYY-MM');
```

---

## 3. Cambios de código en banvabodega

### 3.1 Nuevos archivos

| Archivo | Rol |
|---|---|
| `src/app/api/ml/campaigns-daily-sync/route.ts` | Endpoint cron del sync diario. Acepta `?action=backfill&date_from=&date_to=` para ejecución one-shot. Itera día por día. Al terminar escribe a `ml_sync_health.last_success_at`. |
| `src/app/api/ml/sync-health-check/route.ts` | Cron horario. Lee `ml_sync_health`, identifica jobs stale (`NOW() - last_success_at > staleness_threshold_hours`), inserta a `notifications_outbox` evitando duplicar (no emitir si `last_alert_sent_at < 6h` para no spamear). |
| `src/lib/notifications.ts` | Helper `enqueueNotification(channel, destination, payload)` — INSERT a `notifications_outbox`. |

### 3.2 Modificaciones

| Archivo | Cambio |
|---|---|
| `vercel.json` | Agregar `/api/ml/campaigns-daily-sync` cada día 06:00 UTC + `/api/ml/sync-health-check` cada hora. NO tocar `/api/ml/metrics-sync` existente. |
| `src/lib/ml-metrics.ts` | Ningún cambio. La fase `ads` mensual sigue como está (poblar `ml_campaigns_mensual` durante 1 sprint en paralelo, después dropear la tabla). |

### 3.3 No tocar

- `ml_ads_daily_cache` ni `ads-daily-sync` — funcionando bien
- `ml_sync_estado` — state machine del cron mensual, no mezclar
- `ml_campaigns_mensual` — durante el sprint en paralelo. Al finalizar comparar `monthly_summary` (vista) vs `ml_campaigns_mensual` para marzo. Si coincide → dropear tabla.

---

## 4. Cambios en Viki (droplet `~/banva-alertas/`)

| Archivo | Rol |
|---|---|
| `notifications-outbox-poll.ts` | Cada minuto: SELECT pending LIMIT 50 ORDER BY created_at. Por cada row: escribe JSON a `~/.whatsapp-channel/outbound/`. UPDATE `status='sent', sent_at=NOW()`. Si error: `attempts++`, después de 5 intentos fallidos → `status='failed', last_error=...`. |
| `notifications-outbox-poll.sh` | Wrapper bash con `.env` (igual al patrón de `check-margenes.sh`). |
| Crontab | Agregar línea: `* * * * * /home/vicente/banva-alertas/notifications-outbox-poll.sh >> ...log 2>&1` |

Coordinación con Viki: dejar entrada en `/home/vicente/.claude/inbox.md` cuando esté lista la tabla `notifications_outbox` y el SQL aplicado, para que Viki implemente el poller en el droplet.

---

## 5. Plan de migración

### Fase 1 — Infraestructura (no rompe nada)

1. Aplicar migraciones v73, v74, v75, v76, v77 en orden
2. Crear `notifications.ts` helper en banvabodega
3. Crear endpoints `campaigns-daily-sync` y `sync-health-check`
4. Agregar crons en `vercel.json`
5. Coordinar con Viki: implementar poller del outbox

### Fase 2 — Backfill (one-shot)

`POST /api/ml/campaigns-daily-sync` con `{action: "backfill", date_from: "2026-01-01", date_to: "2026-04-25"}`. Esto puebla `ml_campaigns_daily_cache` con histórico 2026 completo.

### Fase 3 — Validación (1 semana en sombra)

Mientras corren ambos crons (mensual viejo + daily nuevo):
- Comparar `ml_campaigns_monthly_summary` (vista, calculada desde daily) vs `ml_campaigns_mensual` (tabla, llenada por cron viejo) para marzo 2026
- Validar que `acos_real` y totales coincidan dentro de ±1% (atribución retroactiva puede mover)
- Verificar que `config_history` registra cambios reales (modificar manualmente budget de una campaña en ML → debe aparecer entrada al siguiente sync)
- Probar alerta: pausar el cron `campaigns-daily-sync` por 12h → debe llegar WhatsApp después de 36h sin sync

### Fase 4 — Cutover (post-validación)

- Dropear tabla `ml_campaigns_mensual`
- Eliminar la lógica que escribía esa tabla en `ml-metrics.ts:447-488`
- Documentar en regla nueva del `inventory-policy.md`: "Regla 7 — todo job recurrente debe registrar su estado en `ml_sync_health` y configurar threshold de staleness"

---

## 6. Checklist de aceptación

- [ ] Migraciones v73-v77 aplicadas sin error
- [ ] `campaigns-daily-sync` corre y popula `ml_campaigns_daily_cache` para los 5 campaigns
- [ ] Backfill 2026 (1-ene a 25-abr) ejecutado sin duplicar rows (UPSERT idempotente con PK `(campaign_id, date)`)
- [ ] Cambio manual en una campaña en ML aparece en `config_history` al siguiente sync
- [ ] Vista `monthly_summary` coincide con `ml_campaigns_mensual` para marzo (±1%)
- [ ] Health-check inserta a `notifications_outbox` cuando un job está stale
- [ ] Poller del droplet entrega el mensaje de outbox al WhatsApp en <2 min
- [ ] Apagar cron 12h → recibir alerta WhatsApp dentro del threshold (36h - 12h iniciales = avisa en ~24h)
- [ ] Re-correr backfill mismo día no duplica rows
- [ ] `metrics-sync` mensual sigue funcionando intacto

---

## 7. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| ML cambia el shape del response | Validación defensiva en el sync; si falla, escribe a `last_error` y no rompe el job |
| Backfill consume rate limit | Spacing 500ms + UPSERT idempotente permite re-correr si se corta |
| Viki está caído cuando llega un health alert crítico | Outbox queda con `status='pending'`. Cuando Viki vuelve, drena. Si la urgencia exige <5 min, no es el canal correcto — escalar a otro |
| Tabla `notifications_outbox` crece sin límite | Cleanup cron en droplet o Vercel: `DELETE WHERE status='sent' AND sent_at < NOW() - INTERVAL '30 days'` |
| Vercel cron ejecuta 2× por race | UPSERT idempotente + lock optimista en el endpoint (early return si último sync <30min) |

---

## 8. Esfuerzo estimado

| Bloque | Horas |
|---|---|
| 5 migraciones SQL (v73-v77) | 1.5 |
| `notifications.ts` helper | 0.5 |
| `campaigns-daily-sync` endpoint (sync + backfill) | 4 |
| `sync-health-check` endpoint | 1.5 |
| `notifications-outbox-poll` en droplet (Viki) | 2 |
| Tests unitarios + dry-run validation | 2 |
| Validación de 1 semana en sombra | 0 (calendario, no esfuerzo activo) |
| Cutover + docs | 1 |
| **Total** | **~12.5 horas** |

Distribuido: ~10h en banvabodega (Vercel) + ~2.5h en droplet (Viki).
