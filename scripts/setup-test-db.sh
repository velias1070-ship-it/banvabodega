#!/bin/bash
# Genera un archivo SQL combinado con todas las migraciones para el proyecto test.
# Uso:
#   1. Ejecutar: bash scripts/setup-test-db.sh
#   2. Copiar el contenido de scripts/test-schema.sql
#   3. Pegarlo en el SQL Editor del proyecto Supabase TEST
#   4. Ejecutar

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT="$SCRIPT_DIR/test-schema.sql"

echo "-- Schema completo BANVA Bodega (modo test)" > "$OUTPUT"
echo "-- Generado: $(date)" >> "$OUTPUT"
echo "" >> "$OUTPUT"

# Orden de migraciones
MIGRATIONS=(
  "supabase-v2-setup.sql"
  "supabase-v3-setup.sql"
  "supabase-v4-flex-stock.sql"
  "supabase-v5-locks.sql"
  "supabase-v6-atomic-lock.sql"
  "supabase-v7-discrepancias-qty.sql"
  "supabase-v7-conciliacion.sql"
  "supabase-v8-stock-sku-venta.sql"
  "supabase-v8-finanzas.sql"
  "supabase-v8b-feedback.sql"
  "supabase-v9-inner-pack.sql"
  "supabase-v9-banco-sync.sql"
  "supabase-v9-fix.sql"
  "supabase-v9-simple.sql"
  "supabase-v9b-mp-liquidacion.sql"
  "supabase-v10-reembolsos.sql"
  "supabase-v10-picking-tipo-titulo.sql"
  "supabase-v11-agents.sql"
  "supabase-v12-orders-history.sql"
  "supabase-v12-profitguard-cache.sql"
  "supabase-v13-fix-update-stock.sql"
  "supabase-v14-agent-triggers.sql"
  "supabase-v14-factura-original.sql"
  "supabase-v15-ventas-razon-social.sql"
)

for f in "${MIGRATIONS[@]}"; do
  FILE="$PROJECT_DIR/$f"
  if [ -f "$FILE" ]; then
    echo "-- ============================================" >> "$OUTPUT"
    echo "-- Migracion: $f" >> "$OUTPUT"
    echo "-- ============================================" >> "$OUTPUT"
    cat "$FILE" >> "$OUTPUT"
    echo "" >> "$OUTPUT"
    echo "" >> "$OUTPUT"
    echo "[OK] $f"
  else
    echo "[SKIP] $f (no encontrado)"
  fi
done

# Agregar datos de ejemplo para test
cat >> "$OUTPUT" << 'SEED'
-- ============================================
-- Datos de ejemplo para modo test
-- ============================================

-- Operarios de prueba
INSERT INTO operarios (id, nombre, pin, activo, rol) VALUES
  ('TEST-ADMIN', 'Admin Test', '1234', true, 'admin'),
  ('TEST-OP1', 'Operador Test 1', '1111', true, 'operario'),
  ('TEST-OP2', 'Operador Test 2', '2222', true, 'operario')
ON CONFLICT (id) DO NOTHING;

-- Posiciones de prueba
INSERT INTO posiciones (id, label, tipo) VALUES
  ('P1', 'Pallet 1', 'pallet'),
  ('P2', 'Pallet 2', 'pallet'),
  ('P3', 'Pallet 3', 'pallet'),
  ('E1-1', 'Estante 1-1', 'shelf'),
  ('E1-2', 'Estante 1-2', 'shelf'),
  ('E2-1', 'Estante 2-1', 'shelf'),
  ('SIN_ASIGNAR', 'Sin Asignar', 'shelf')
ON CONFLICT (id) DO NOTHING;

-- Productos de prueba
INSERT INTO productos (sku, nombre, categoria, costo, precio) VALUES
  ('TEST-001', 'Producto Test A', 'Categoria 1', 5000, 9990),
  ('TEST-002', 'Producto Test B', 'Categoria 1', 3000, 5990),
  ('TEST-003', 'Producto Test C', 'Categoria 2', 8000, 14990),
  ('TEST-004', 'Producto Test D', 'Categoria 2', 2000, 3990),
  ('TEST-005', 'Producto Test E', 'Categoria 3', 12000, 19990)
ON CONFLICT (sku) DO NOTHING;

-- Stock inicial de prueba
INSERT INTO stock (sku, posicion_id, cantidad) VALUES
  ('TEST-001', 'P1', 50),
  ('TEST-001', 'E1-1', 10),
  ('TEST-002', 'P2', 30),
  ('TEST-003', 'E1-2', 20),
  ('TEST-004', 'E2-1', 100),
  ('TEST-005', 'P3', 15)
ON CONFLICT (sku, posicion_id) DO NOTHING;

SEED

echo ""
echo "Archivo generado: $OUTPUT"
echo ""
echo "Pasos siguientes:"
echo "  1. Ve a https://supabase.com/dashboard y crea un proyecto nuevo (gratis)"
echo "  2. Abre SQL Editor en el proyecto test"
echo "  3. Pega el contenido de: scripts/test-schema.sql"
echo "  4. Ejecuta el SQL"
echo "  5. Copia la URL y anon key del proyecto test"
echo "  6. Pegalas en .env.local como:"
echo "     NEXT_PUBLIC_TEST_MODE=true"
echo "     NEXT_PUBLIC_SUPABASE_TEST_URL=https://xxx.supabase.co"
echo "     NEXT_PUBLIC_SUPABASE_TEST_ANON_KEY=xxx"
echo "  7. Reinicia el dev server: npm run dev"
