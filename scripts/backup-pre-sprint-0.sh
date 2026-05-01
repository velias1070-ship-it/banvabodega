#!/usr/bin/env bash
# scripts/backup-pre-sprint-0.sh
# Snapshot de tablas críticas antes de aplicar Sprint 0 (Master cleanup).
# Idempotente — un nuevo run crea un nuevo timestamp dir.
#
# Uso:
#   bash scripts/backup-pre-sprint-0.sh
#
# Requiere: psql con DATABASE_URL apuntando a la prod de banvabodega
# (project qaircihuiafgnnrwcjls), o $SUPABASE_DB_URL.
#
# Crea: backups/sprint0/<YYYYMMDD_HHMMSS>/
#   - _deprecated_ml_velocidad_semanal_2026_05_09.json
#   - productos_id_sku_precio.json
#   - skus_pre_upper.json
#   - migration_preconditions.json
#
# La aplicación real de Sprint 0 (2026-05-01) se hizo vía MCP Supabase, y los JSON
# fueron escritos directamente en la sesión. Este script existe para reproducibilidad
# y para futuros rollbacks si se necesitan.

set -euo pipefail

if [[ -z "${SUPABASE_DB_URL:-${DATABASE_URL:-}}" ]]; then
  echo "ERROR: Set SUPABASE_DB_URL or DATABASE_URL with the banvabodega prod connection string."
  exit 1
fi

DB_URL="${SUPABASE_DB_URL:-$DATABASE_URL}"
TS="$(date -u +%Y%m%d_%H%M%S)"
BACKUP_DIR="$(cd "$(dirname "$0")/.." && pwd)/backups/sprint0/$TS"

mkdir -p "$BACKUP_DIR"
echo "Backup dir: $BACKUP_DIR"

# 1. Zombie table snapshot (if it still exists)
psql "$DB_URL" -At -c "
  SELECT json_agg(row_to_json(t))
  FROM (SELECT * FROM _deprecated_ml_velocidad_semanal_2026_05_09 LIMIT 100000) t;
" 2>/dev/null > "$BACKUP_DIR/_deprecated_ml_velocidad_semanal_2026_05_09.json" || \
  echo "(table already dropped — skipping)"

# 2. productos.precio snapshot (column to be dropped)
psql "$DB_URL" -At -c "
  SELECT json_agg(json_build_object('id', id, 'sku', sku, 'precio', precio))
  FROM productos;
" > "$BACKUP_DIR/productos_id_sku_precio.json" || \
  echo "(precio column already dropped — skipping)"

# 3. SKUs whose stored value differs from UPPER(TRIM(value))
psql "$DB_URL" -At -c "
  SELECT json_build_object(
    'productos', (SELECT json_agg(row_to_json(p)) FROM productos p WHERE sku <> UPPER(TRIM(sku))),
    'stock_full_cache', (SELECT json_agg(row_to_json(s)) FROM stock_full_cache s WHERE sku_venta <> UPPER(TRIM(sku_venta))),
    'composicion_venta', (SELECT json_agg(row_to_json(c)) FROM composicion_venta c WHERE sku_venta <> UPPER(TRIM(sku_venta)) OR sku_origen <> UPPER(TRIM(sku_origen))),
    'ml_items_map', (SELECT json_agg(row_to_json(m)) FROM ml_items_map m WHERE
      (sku IS NOT NULL AND sku <> UPPER(TRIM(sku))) OR
      (sku_venta IS NOT NULL AND sku_venta <> UPPER(TRIM(sku_venta))) OR
      (sku_origen IS NOT NULL AND sku_origen <> UPPER(TRIM(sku_origen))))
  );
" > "$BACKUP_DIR/skus_pre_upper.json"

# 4. Pre-condition snapshot
psql "$DB_URL" -At -c "
  SELECT json_build_object(
    'precio_non_zero', (SELECT COUNT(*) FROM productos WHERE precio IS NOT NULL AND precio <> 0),
    'zombie_table_exists', (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='_deprecated_ml_velocidad_semanal_2026_05_09'),
    'precio_col_exists', (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='productos' AND column_name='precio'),
    'policy_templates_exists', (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='policy_templates'),
    'policy_action_enum_exists', (SELECT COUNT(*) FROM pg_type WHERE typname='policy_action_enum')
  );
" > "$BACKUP_DIR/migration_preconditions.json"

echo "Done. Backup at: $BACKUP_DIR"
ls -la "$BACKUP_DIR"
