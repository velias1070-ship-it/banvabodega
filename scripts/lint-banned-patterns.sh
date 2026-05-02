#!/usr/bin/env bash
# I4 — Sprint 3 (2026-05-03)
# Lint que falla si encuentra patrones prohibidos en src/.
# Registry canónico: tabla _lint_forbidden_patterns en Supabase.
# Mantener sincronizado con la migration que la crea.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAIL=0

check() {
  local pattern="$1"
  local reason="$2"
  local hits
  hits=$(grep -rln --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' \
                "$pattern" src/ 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "::error::Patrón prohibido encontrado: $pattern"
    echo "  Razón: $reason"
    echo "  Archivos:"
    echo "$hits" | sed 's/^/    /'
    FAIL=1
  fi
}

# I4 — H27 cerrada Sprint 0.5: usar .eq("anulada", false), nunca .neq.
check '.neq("anulada", true)' "I4: usar .eq(\"anulada\", false). H27 Sprint 0.5."
check ".neq('anulada', true)" "I4: usar .eq('anulada', false). H27 Sprint 0.5."

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "Solución: reemplazar por .eq(\"anulada\", false)."
  echo "Registry: SELECT * FROM _lint_forbidden_patterns;"
  exit 1
fi

echo "Lint OK — ningún patrón prohibido detectado."
