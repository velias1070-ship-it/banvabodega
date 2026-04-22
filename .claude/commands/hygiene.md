---
description: Barrido de higiene del repo — duplicación, código muerto, recursos solapados. Reporta hallazgos sin modificar.
---

Hacé un barrido de higiene de banvabodega. No toques archivos, solo reportá.

## Qué buscar

### 1. Funciones duplicadas o casi-duplicadas
- Buscá funciones con nombres similares en `src/lib/` (ej. `fetchProductos` en store.ts y db.ts).
- Chequeá que no haya dos funciones haciendo la misma query Supabase con wrappers distintos.
- Grep específico:
  ```
  grep -rn "^export (async )?function" src/lib/ | awk '{print $NF}' | sort | uniq -d
  ```

### 2. Queries Supabase repetidas
- Mismo `sb.from("tabla").select(...)` escrito en múltiples archivos.
- Un mismo patrón de upsert/update replicado en vez de centralizado en `db.ts`.

### 3. API routes solapadas
- Rutas que hagan lo mismo con nombres distintos (ej. `/api/stock/sync` vs `/api/ml/stock-sync`).
- Handlers GET/POST que podrían unificarse.

### 4. Código muerto
- Archivos en `src/` que nadie importa:
  ```
  for f in $(find src -name "*.ts" -o -name "*.tsx"); do
    base=$(basename "$f" | sed 's/\.[^.]*$//')
    [ "$base" = "page" ] || [ "$base" = "layout" ] || [ "$base" = "route" ] && continue
    count=$(grep -rl --include="*.ts" --include="*.tsx" "$base" src | grep -v "$f" | wc -l)
    [ "$count" = "0" ] && echo "DEAD: $f"
  done
  ```
- Exports nunca consumidos (`export function xxx` pero nadie la importa).
- Branches `if (env.DEV) { ... }` o flags legacy sin uso.

### 5. Migraciones SQL con columnas deprecadas o zombis
- Buscá en `supabase-v*.sql` columnas marcadas `DEPRECADA` (ver regla 5 de inventory-policy).
- Columnas que siguen escribiéndose pero nadie lee, o al revés.

### 6. Centinelas numéricos (regla 1 de inventory-policy)
```
grep -nE '= 999([^0-9]|$)|= 2071|= -1([^0-9]|$)' src/lib/intelligence*.ts src/lib/ml.ts src/lib/store.ts
```

### 7. Errores Supabase tragados (regla 3)
```
grep -rnE 'void sb\.|void supabase\.' src/
grep -rnE '\.catch\(\s*\(\s*\)?\s*=>\s*\{?\s*\}?\s*\)' src/
grep -rnE 'const \{ data \} = await sb\.' src/
```

## Formato del reporte

Agrupado por categoría. Cada hallazgo con `file:line` y una línea de contexto.
Al final, **Top 5 acciones sugeridas** priorizadas por impacto/esfuerzo.

No abras PRs ni edites nada. El output es para que Vicente decida qué limpiar.
