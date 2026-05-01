# BANVA Bodega — Convenciones técnicas

> Documento autoritativo de convenciones. Si código contradice este doc, corregir código (per `feedback_disonancia_policy_vs_manual`).
> Vigente desde Sprint 0 (2026-05-01).

## 1. Naming

### Tablas
- **Nuevas tablas**: nombre en **inglés plural snake_case** (`policy_templates`, `cells`, `lanes`).
- **Prefijos por integración externa**:
  - `ml_*` — datos sincronizados desde MercadoLibre (`ml_items_map`, `ml_shipments`).
  - `mp_*` — datos de MercadoPago.
  - `sii_*` — datos del SII.
- **Tablas de auditoría temporal**: prefijo `_sprint{N}_` o `_audit_` y fecha en el nombre. Borrar al cerrar el sprint o cuando ya no se use (`_sprint0_dup_skus`).
- **Tablas zombi** (a deprecar): renombrar con prefijo `_deprecated_<table>_<YYYY_MM_DD>` por ≥30 días, luego DROP. Ya no crear nuevas zombis sin el prefijo.
- **Tablas legacy en español**: NO renombrar (alto blast radius). Sólo nuevas tablas siguen el inglés.

### Columnas
- snake_case siempre.
- SKUs siempre `UPPER(TRIM(...))` antes de persistir. Constraints o triggers deben enforzar esto.
- `created_at`, `updated_at` TIMESTAMPTZ con `DEFAULT NOW()`.
- `*_id` para FK a UUID; `*_sku` para FK a productos.sku.

## 2. Migraciones SQL

### Formato canónico (decisión 4B, 2026-05-01)
- **Nuevas migraciones** (Sprint 0+): `supabase/migrations/YYYYMMDDHHMMSS_<snake_case>.sql`.
- Aplicar vía `mcp__supabase__apply_migration` (DDL) o `mcp__supabase__execute_sql` (queries puntuales).
- Una migración = un cambio atómico transaccional (Supabase la envuelve en BEGIN/COMMIT).
- Toda migración debe tener:
  - Header con ID, owner, fecha, hallazgos cerrados.
  - Pasos numerados con `-- STEP N:`.
  - Pre-condiciones validadas en `DO $$ ... RAISE EXCEPTION` cuando dropea/modifica datos.
  - `COMMENT ON` en toda nueva tabla/columna/tipo.

### Formato legacy (no migrar)
- `supabase-vNN-<descripcion>.sql` en raíz del repo. Inmutables. No crear nuevos.
- `supabase/pending-mov/v{N}-...sql` cola de migraciones a aplicar manualmente.
- `supabase/archived/` ya aplicadas.

### Numeración legacy reservada
- v51-v79: pricing/billing (parallel session, NO TOCAR).
- v80+: track ads/reposición.

## 3. SSoT (Single Source of Truth)

Cada concepto crítico debe tener exactamente UN dueño en `ssot-registry.yml`.

Reglas:
- **Stock canónico**: `stock` table (vía RPC `registrar_movimiento_stock`). Nunca hacer UPDATE silencioso.
- **Stock Full ML**: `stock_full_cache` (cache, rebuilds desde ML). No autoritativo.
- **Composición ventas**: `composicion_venta` con default trivial sku_venta=sku_origen,unidades=1.
- **Velocidades**: `sku_intelligence` (vel_30d, vel_60d, vel_pre_quiebre, etc.). Calculadas en `intelligence.ts`.
- **Estados Full**: `inteligencia_full` derivada vía `calcularEstadoFlexFull` v7 (P-INV-1).

Toda tabla nueva con potencial de conflicto SSoT debe:
1. Aparecer en `ssot-registry.yml` con `owner_table` y `derivable_from`.
2. Documentar si es snapshot, cache, o canónica.

## 4. CDMP (Concept-Domain-Model-Physical)

Capas de la información:
- **Concepto** (`concept-registry.yml`): qué representa el negocio (ej. "Producto", "Reposición", "Quiebre").
- **Dominio** (`domain-registry.yml`): bounded context (Inventario, Ventas, Pricing, Logística, Compras, Reportería).
- **Modelo lógico**: relación conceptual entre conceptos (no físico, no SQL).
- **Físico**: tablas, columnas, tipos PostgreSQL.

Cuando un concepto cambia significativamente:
1. Actualizar `concept-registry.yml`.
2. Verificar que el dominio sigue siendo correcto.
3. Crear migration para alinear el físico.

## 5. Anti-drift

### Auditorías regulares
- Schema audit: `docs/schema-audit-YYYY-MM.md` cada 3 meses, comparando contra `ssot-registry.yml`.
- Dup detection: query de SKUs case-insensitive duplicados. Cero tolerancia post-Sprint-0.
- Zombi detection: tablas sin uso en código (grep) ≥90 días → renombrar `_deprecated_*` y agendar DROP.

### Detection patterns prohibidos (per memorias de feedback)
- ❌ Centinelas numéricos (-1, 0, MAX_INT) que enmascaran NULL.
- ❌ `.select()` sin error catch — todos los Supabase calls usan `void` o `try/catch` (per `feedback_supabase_promiselike`).
- ❌ Updates silenciosos a stock sin movimiento (per `feedback_movimientos_stock`).
- ❌ Inferir costos desde promedio de familia (per `feedback_no_inferir_costos`).
- ❌ Llenar campos required con valores fake. Mejor NULL + check.
- ❌ Usar `fetchVentas` sin `.eq('anulada', false)` (per `feedback_ventas_anuladas_filter`).

### Policies vs Manuales
- `docs/policies/*.md` — vinculantes, autoritativos. Si código difiere, corregir código.
- `docs/manuales/*.md` — biblioteca de referencia. Si código difiere, preguntar al owner.

## 6. Test/Validation

- Toda migration con cambios de datos debe llevar tests SQL en `tests/<migration_name>_validation.sql`.
- Tests forman pre-condiciones (asegurar estado antes) y post-condiciones (verificar resultado).
- Aplicar migration y correr tests via MCP Supabase ANTES de commit.

## 7. Backups

- Antes de toda migration con DROP/UPDATE masivo: crear `backups/sprint{N}/<timestamp>/` con JSON snapshots.
- Script `scripts/backup-pre-sprint-{N}.sh` o equivalente reproducible.
- Mantener al menos 90 días post-merge.

## 8. Decisiones cerradas (referencia)

| Decisión | Hallazgo | Cierre |
|---|---|---|
| Service level por celda ABC×XYZ | H3 | 2026-05-01 (lean Z, conservador A) |
| Bandas XYZ deseasonalizadas (0.25/0.60) | H2 | 2026-05-01 |
| target_dias_full por celda | H11 | 2026-05-01 (42/28/28/15/7/0) |
| Pareto 70/90 ABC | H1 | 2026-04 (Vicente self-closed) |
| Filtro anulada=false en ventas_ml_cache | H27 | 2026-04 (per feedback) |
| Modelo 3 nodos (Bodega + Full + Flex obsoleto) | — | 2026-04 (Vicente self-closed) |
| Op Limpieza modo híbrido | Adendum A | 2026-04-28 |
