# Fase 9-bis — Validación de las 5 preguntas del owner

> Verificación empírica de los puntos abiertos del resumen ejecutivo. Sin remediar, sin tocar código de la app.

---

## 1. RPC `exec_sql` — definición

**Búsqueda realizada**:
```bash
grep -ri "exec_sql" supabase-*.sql supabase/   → 0 matches (ningún archivo .sql del repo la define)
grep -rni "exec_sql" supabase/                  → 0 matches
```

**Resultado**: la RPC `exec_sql` **no está definida en ninguna migración** versionada en el repo. Tampoco en `supabase/archived/` ni en `supabase/pending-mov/`.

**Hallazgo importante**: existe (o existió) **solo en la base de datos**, creada manualmente vía SQL Editor de Supabase y nunca capturada como migración. Por eso no se puede mostrar el cuerpo desde el repo.

**Lo que sí sé desde los callers** (firma esperada):

- `src/app/api/ml/setup-ventas-cache/route.ts:13` — `sb.rpc("exec_sql", { sql: "..." })` con DDL multi-statement (CREATE TABLE, CREATE INDEX, ALTER, DO $$, NOTIFY).
- `src/app/api/ml/audit-mappings/route.ts:38` — `sb.rpc("exec_sql", { sql: mismatchQuery }).select()` con un SELECT.

Argumento esperado: `{ sql: text }`. Retorno esperado: filas resultantes (porque el segundo caller hace `.select()` después).

**Ambos callers tienen fallback explícito**:
- `setup-ventas-cache:55-63` — "If exec_sql RPC doesn't exist, try direct query via REST".
- `audit-mappings:39-67` — "Fallback: si no existe rpc exec_sql, usar query directa con columnas".

Eso confirma que **el código está preparado para que la RPC no exista** — quizás se eliminó en algún momento, o quizás nunca se creó en producción y solo en una DB de desarrollo.

**Quién tiene grant**: imposible saberlo desde el repo. Para verlo en prod hay que correr en SQL Editor:

```sql
SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_function_result(p.oid) AS returns,
       pg_catalog.array_to_string(p.proacl, ',') AS acl,
       p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = 'exec_sql';
```

**TODO: confirmar con el owner**:
- ¿La RPC existe hoy en producción?
- Si existe, ¿quién la creó y por qué no se versionó como migración?
- Si tiene `SECURITY DEFINER` y GRANT a `anon`, **es una bomba**: la anon key permite SQL arbitrario.

---

## 2. `SUPABASE_SERVICE_ROLE_KEY` — usos exactos

**Búsqueda**:
```bash
grep -rn "SERVICE_ROLE\|service_role" src/ scripts/
```

**3 usos en el repo** (sumando el workflow):

| Archivo | Línea | Para qué se usa |
|---|---:|---|
| `src/app/api/ml/setup-tables/route.ts` | 11 | Bootstrapping de tablas `ml_shipments` / `ml_shipment_items`. Crea cliente Supabase con service role si está, fallback a anon. El endpoint testea si las tablas existen y devuelve el SQL que el admin debe pegar manualmente en SQL Editor — **no ejecuta DDL** vía service role realmente. La key se importa pero no se usa de modo crítico. |
| `scripts/debug-shipping.mjs` | 15 | Script CLI de diagnóstico (`node scripts/debug-shipping.mjs <SKU>`) que consulta `ml_items_map` y `ml_config` (incluyendo tokens OAuth — `access_token`, `refresh_token`). Lee `.env.local`. Usa service role si está, fallback a anon. Local-only. |
| `.github/workflows/db-backup.yml` | 80, 96, 116, 133, 163 | **Uso real y activo**: GitHub Actions usa `secrets.SUPABASE_SERVICE_ROLE_KEY` para subir/listar/borrar dumps en el bucket `db-backups` de Supabase Storage vía REST API. Auth con `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`. |

**Observaciones**:
- El service role en runtime web (Next.js / Vercel) **prácticamente no se usa**. Las dos referencias en `src/` y `scripts/` tienen fallback a anon, y el endpoint que la importa (`setup-tables`) en realidad solo prueba existencia y devuelve SQL para pegar a mano.
- El **uso real, persistente y crítico** es el **workflow de backup de GitHub Actions**: necesita service role porque los buckets `db-backups/*` previsiblemente tienen RLS que solo permite service role.
- La regla `.claude/rules/supabase.md` que dice "no service role" es **correcta para el runtime web**, pero **incompleta**: no menciona el backup en GitHub Actions (siguiente punto).

---

## 3. `plan.md` (raíz) — vigencia

**Contenido**: documento de planning de marzo 2026 (8.8 KB). Plan en 6 pasos para integrar la API ML → `stock_full_cache`, eliminando la carga manual desde Excel/ProfitGuard.

**Estado de los 6 pasos hoy**:

| Paso | Plan | Estado actual |
|---|---|---|
| 1 | Crear `supabase-v17-ml-stock-full.sql` con ALTER a `ml_items_map` y `stock_full_cache` | ✅ **Existe**: el archivo está en raíz, fechado 19-mar. |
| 2 | Función `syncStockFull()` en `src/lib/ml.ts` | ✅ **Existe**: detectada en Fase 8 como función de 517 LOC. |
| 3 | Endpoint `/api/ml/sync-stock-full` con `maxDuration=120` | ✅ **Existe**: route confirmada en Fase 3, cron cada 30 min en `vercel.json`. |
| 4 | Webhook handler para `marketplace_fbm_stock` | ✅ **Existe**: el listado de tópicos del webhook (`route.ts:266`) incluye `marketplace_fbm_stock`. |
| 5 | Integrar sync con cron diario | 🟡 **Diferente a lo planeado**: el cron `sync-stock-full` corre cada 30 min de forma independiente, no se llama desde `agents/cron`. |
| 6 | Botón "Sync Stock ML" + tooltip + alerta `stock_danado_full` en `AdminInteligencia` | TODO confirmar — no verificado en este discovery. |

**Veredicto**: **el plan está completamente obsoleto como plan**. Los pasos 1-4 están implementados, el 5 evolucionó a otra arquitectura (cron independiente), el 6 probablemente sí.

**Recomendación** (sin ejecutar, como pediste): mover `plan.md` a `docs/auditorias/` o `docs/historico/` con prefijo de fecha (`2026-03-plan-ml-stock-full.md`) o eliminarlo. Mantenerlo en raíz crea ruido — un agente nuevo puede confundirlo con un plan vigente.

---

## 4. Migraciones duplicadas — convención vs legado

**Búsqueda**: para cada número de versión con >1 archivo, listar timestamps + descripción.

**Resultados** (filesystem mtime, no commit time):

| Versión | Archivos | mtime |
|---|---|---|
| **v7** | `conciliacion.sql` (6.9 KB) · `discrepancias-qty.sql` (2.2 KB) | ambos `Mar  8 21:22:38 2026` (mismo segundo) |
| **v8** | `finanzas.sql` (11.6 KB) · `stock-sku-venta.sql` (2.2 KB) | ambos `Mar  8 21:22:38 2026` |
| **v9** | `banco-sync.sql` · `fix.sql` · `simple.sql` · `inner-pack.sql` | 3 en `Mar  8 21:22:38`, `inner-pack.sql` en `Mar 12 17:10:09` (4 días después) |
| **v10** | `picking-tipo-titulo.sql` · `reembolsos.sql` | `Mar 12 17:10:09` y `Mar  8 21:23:22` (4 días de diferencia) |
| **v12** | `orders-history.sql` · `profitguard-cache.sql` | ambos `Mar 12 17:10:09` |
| **v14** | `agent-triggers.sql` · `factura-original.sql` | ambos `Mar 12 17:10:09` |
| **v15** | `sku-intelligence.sql` (12 KB) · `ventas-razon-social.sql` (685 B) | `Mar 19 20:53` y `Mar 12 20:32` (7 días) |
| **v17** | `ml-stock-full.sql` · `quiebre-prolongado.sql` | ambos `Mar 19 20:53:11` |
| **v19** | `ml-items-map-sku-origen.sql` · `vel-objetivo.sql` | ambos `Mar 19 20:53:11` |
| **v20** | `stock-full-cache-fuente.sql` · `vel-objetivo-historial.sql` | ambos `Mar 19 20:53:11` |
| **v28** | `costo-promedio.sql` · `qty-reserved.sql` | ambos `Mar 27 15:34/15:41` (mismo día) |
| **v29** | `audit-log.sql` · `reconciliar-reservas.sql` | ambos `Mar 27 15:34:04` |
| **v30** | `calcular-qty-ubicada.sql` · `computed-reservas.sql` | ambos `Mar 27 15:34:04` |
| **v31** | `fix-reservas-cutoff.sql` · `stock-deducted.sql` | `Mar 28 14:02` y `Mar 28 16:52` (2.5 h) |
| **v32** | `fixes-operador.sql` · `reservas-include-full.sql` | ambos `Mar 28 21:32:14` |
| **v33** | `desglose-reservas.sql` (Mar 29) · `qty-after-timeline.sql` (Mar 28) · `shipment-costs-cache.sql` (Apr 4) | 3 archivos en 7 días |
| **v34** | `envio-full-pendiente.sql` · `shipment-hidden.sql` · `timeline-reserva-full.sql` | rango Mar 30 → Apr 5 (6 días) |
| **v36** | `auto-fill-costo.sql` (Apr 1 18:40) · `ml-publicaciones.sql` (Apr 1 18:16) | mismo día |
| **v39** | `conciliacion-parcial.sql` · `proveedor-campos.sql` | mismo día (Apr 6) |
| **v40** | `campaigns-mensual.sql` · `egreso-metadata.sql` · `item-attr-snapshot.sql` | rango Apr 6 → Apr 8 |
| **v45** | `rcv-compras-factura-ref.sql` · `ventas-margen.sql` | Apr 12 y Apr 15 (3 días) |
| **v51** | `forecast-accuracy.sql` · `ml-billing-cfwa.sql` | mismo día (Apr 17) |
| **v64** | `semaforo-markdown.sql` · `ticket-promedio-rpc.sql` | mismo día (Apr 22) |
| **v65** | `margin-cache-status-ml.sql` · `semaforo-intel-bridge.sql` | mismo día (Apr 22) |
| **v67** | `margin-cache-stock.sql` · `semaforo-por-item.sql` | mismo día (Apr 22) |
| **v68** | `productos-pricing-policy.sql` · `semaforo-pk-sku-venta.sql` | Apr 22 y Apr 23 |

**Patrón**: en la **gran mayoría** de los casos, los archivos con el mismo número se crearon **el mismo día (a veces el mismo segundo)**, en dominios separados — uno toca finanzas, el otro toca ML; uno toca semáforo, el otro margen.

**Veredicto**: es **convención implícita**, no legado. La regla parece ser:
> "El número `vN` reserva un slot del día / del feature batch. Si el mismo día se trabajan dos features paralelos, ambos llevan `vN-{descripcion}` con descripción distinta."

Casos atípicos donde la diferencia es de varios días (`v9-inner-pack` 4 días después, `v15-sku-intelligence` 7 días después, `v34-shipment-hidden` 6 días después): probablemente fueron iteraciones / ajustes que el autor no quiso renumerar para mantener correlación con el feature original.

**Riesgo real**: bajo. No hay ninguna `schema_migrations` table que rompa por colisión. Solo molesta a la hora de ordenar (`sort -V` no es estable cuando hay tres `v33`). Convivible.

---

## 5. `.github/workflows/` — qué hay y qué hace

**Búsqueda**:
```bash
ls .github/workflows/   →  db-backup.yml   (único archivo, 7.5 KB)
```

### `db-backup.yml` — **Daily DB Backup**

**Disparo**:
- `schedule: cron '0 1,7,13,19 * * *'` — UTC. Equivale a 22:00 / 04:00 / 10:00 / 16:00 hora Chile (UTC-3, sin DST asumido). **Cada 6 horas**.
- `workflow_dispatch` con input `backup_type` (choice: `6h | daily | weekly | monthly | all`, default `6h`).

**Lógica de targets**:
- En la corrida automática siempre genera el dump `6h`.
- A las `07 UTC` también añade `daily`.
- Si además es domingo (`%u = 7`), añade `weekly`.
- Si además es día 1 del mes (`%d = 01`), añade `monthly`.
- Cuando se dispara manual, el target se elige por el input.

**Pasos**:
1. **Install pg_dump (Postgres 17)** — descarga desde apt.postgresql.org y arma el binario.
2. **Decide targets** — calcula qué prefijos generar para esta corrida.
3. **Create dump** — `pg_dump -F c -d "$SUPABASE_DB_URL" -f dump.bin` (formato custom). Secret `SUPABASE_DB_URL`.
4. **Upload to targets** — sube `dump.bin` al bucket `db-backups` de Supabase Storage en los prefijos correspondientes (`6h/banva-prod-YYYY-MM-DD-HHMM.dump`, `daily/banva-prod-YYYY-MM-DD.dump`, `weekly/...`, `monthly/banva-prod-YYYY-MM.dump`). Auth con `SUPABASE_SERVICE_ROLE_KEY`. `x-upsert: true`.
5. **Prune all prefixes** — recorre cada prefijo y borra dumps que excedan la retención:
   - `6h/` → 7 días
   - `daily/` → 30 días
   - `weekly/` → 90 días
   - `monthly/` → 365 días
6. **Open issue on failure** (`if: failure()`) — abre un GitHub Issue titulado "DB backup failed YYYY-MM-DD" con el run URL, label `backup`. Permission: `issues: write`.

**Está activo**: sí. El cron está enabled por estar mergeado en `main` (GitHub no muestra disabled per-workflow en este YAML). Para confirmar runs reales:
```bash
gh run list --workflow=db-backup.yml --limit 10
```
(no ejecutado para no tomar acción).

**Secrets requeridos**: `SUPABASE_DB_URL`, `SUPABASE_PROJECT_REF`, `SUPABASE_SERVICE_ROLE_KEY`.

**Sin runtime web**: no hay workflows de `ci.yml`, `deploy.yml`, `lint.yml`, `test.yml`. **El proyecto no tiene CI** (la única validación es Vercel build al hacer push a main).

---

## Resumen de actualizaciones a hacer en otros docs (sin ejecutar)

Si en algún momento se quiere reflejar estos hallazgos en los docs ya generados:

- **`08_deuda_tecnica.md` §S4** ("RPC exec_sql accesible desde anon"): matizar — la RPC **no está versionada**, callers tienen fallback. El riesgo real depende de que la función exista en prod *con* GRANT a anon. Pendiente de validar con SQL.
- **`02_stack.md` "Variables de entorno" / `05_integraciones.md`**: agregar el uso de `SUPABASE_SERVICE_ROLE_KEY` como secret de GitHub Actions para backup. Hoy solo lista los usos de runtime.
- **`07_convenciones.md` "Numeración de migraciones colisiona"**: actualizar — confirmado que es convención (mismo segundo de creación en mayoría de casos, dominios paralelos).
- **`CLAUDE.md` raíz**: nada urgente.

Como la instrucción fue "no tomes acciones de remediación", estos cambios quedan como recomendaciones, no aplicados.
