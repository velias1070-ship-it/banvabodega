# Reposición manual — Operación Camino 1

**Decisión owner (2026-05-03):** BANVA opera Camino 1 — humanos + fórmulas
+ dashboards. Agentes AI deshabilitados desde Sprint 4.

## Por qué Camino 1 (y no Camino 2/3)

- Volumen actual: 425 SKUs activos. Manejable manualmente con una visita
  diaria al dashboard (~5 min) y una revisión semanal (~30 min).
- Pre-Sprint 4: agentes AI generaban 46.637 corridas en 30 días, todas
  con `estado='error'` (API key apagada para no gastar). Cero decisiones
  reales tomadas por agentes — el sistema ya operaba 100% por dashboards
  + decisiones humanas.
- Foundation IA queda lista: cuando volumen lo requiera (>1500 SKUs
  estimado), reactivación documentada al final de este doc.

## Flujo operativo

### Diario (Vicente o Enrique, 5-10 min)

1. Abrir [`/admin/reposicion-suggestions`](/admin/reposicion-suggestions).
2. Mirar banner superior:
   - ¿Hay SKUs en `QUIEBRE_TOTAL`? → acción inmediata.
   - ¿Cuántos `CRITICO` (≤3 días cobertura)? → revisar y priorizar.
3. Filtrar por `Quiebre` + `Crítico`, agrupar mentalmente por proveedor.
4. Para cada proveedor con >3 SKUs urgentes: crear OC manualmente.

### Semanal (Vicente, 30 min, lunes)

1. Revisar `/admin/reposicion-suggestions` sin filtros.
2. Mirar `URGENTE` (≤7d) y `ATENCION` (≤14d).
3. Decidir compras consolidadas para optimizar shipping de proveedor.
4. El cron weekly de policy sync corrió a las 11:30 UTC, datos frescos.

### Mensual (Vicente, 1 hora)

1. Revisar `v_sku_policy_diff`: ¿algún SKU en `drift_unexpected`?
   Investigar.
2. Revisar SKUs `blocked_no_cost` — actualizar costos faltantes en
   `/admin/productos`.
3. Revisar `seasonal_categories.is_active` — ¿agregar/quitar?

## Cómo crear una OC manualmente

1. En `/admin/reposicion-suggestions`, marcar checkbox de SKUs a comprar.
2. Click "Copiar para OC (N)" → al clipboard va `SKU\tQty\tProveedor`.
3. Ir a `/admin/oc-nueva`, pegar y revisar.
4. Ajustar cantidades (siempre podés comprar más que la sugerencia).
5. Asignar proveedor, fecha estimada.
6. Crear OC.

## Cuándo NO confiar en la sugerencia

- SKU con `xyz_confidence='low_confidence_seasonal'` y temporada baja:
  la sugerencia puede subestimar el peak siguiente. Sprint 2.5 protege
  con z=1.88 pero sigue siendo sub-óptimo en peak.
- SKU con `seasonal_match_source='name_pattern'` (Sprint 2.5): mitigación
  por regex sobre `productos.nombre`, frágil si nombre se edita. Validar
  en peak.
- SKU con `margen_neto_30d_imputed=true` (Sprint 3, no expuesto en este
  dashboard hoy): margen es estimado, validar margen real antes de
  comprar grandes cantidades.
- SKU recién agregado (<30 días): datos insuficientes, política puede
  ser `blocked_no_history`.
- SKU sin costo conocido: `clp_estimado` queda `NULL` (per
  `feedback_no_inferir_costos`: nunca rellenar). Revisar el SKU en
  `/admin/productos` y cargar el costo antes de decidir cantidad.

## Override manual de política

Si un SKU tiene política bloqueada o no querés que cambie:

```sql
UPDATE sku_node_policy
   SET manual_override = true,
       z_value         = 1.88,
       target_dias_full = 35,
       action          = 'reorder_normal',
       updated_at      = now()
 WHERE sku_origen = 'TU-SKU' AND node_id = 'full_ml';
```

El cron weekly (`/api/policy/sync-from-templates`) NO sobreescribe filas
con `manual_override = true` (Sprint 2 garantiza esa invariante).

## Estructura de las vistas (Sprint 4)

- **`v_safety_stock`** — SS, cycle_stock, ROP, pre_full_target por (SKU, Nodo).
  Excluye `policy_status != 'active'` y `action = 'no_reorder'` (CZ).
- **`v_compras_pendientes`** — solo `bodega_central`, solo bajo ROP.
  `clp_estimado=NULL` cuando sin costo (no inferimos).
- **`v_alertas_quiebre`** — solo bajo ROP, con nivel y prioridad.
- **`v_reposicion_dashboard`** — master. La UI sólo lee esta vista.

## Reactivar agentes AI en el futuro

Cuando volumen lo requiera (>1500 SKUs estimado):

1. Restaurar API key de Anthropic en variables de entorno Vercel.
2. Restaurar entrada `/api/agents/cron` en `vercel.json` (commit
   ` da172b5..` de Sprint 4 contiene la remoción para git revert).
3. Validar que los endpoints siguen ejecutables (código mantenido,
   marcado `DEPRECATED Sprint 4` en el header).
4. Remover los `console.warn` de cada `src/app/api/agents/*/route.ts`.
5. Empezar con UN solo agente (Reposición) primero, no los 6 a la vez.
6. Shadow mode 14 días antes de actuar (compara sugerencia AI vs
   `v_compras_pendientes`).

Costo estimado mensual con agentes activos:

- Camino 2 (alertas diarias): $5-15/mes (Anthropic API).
- Camino 3 (decisiones automáticas): $30-100/mes.

## Referencias

- Sprint 4 doc: `/docs/sprints/sprint-4-camino-1-manual.md`
- Sprint 2 (política poblada): `/docs/sprints/sprint-2-populate-policy.md`
- Sprint 2.5 (seasonal name fallback): `/docs/sprints/sprint-2.5-h2-name-fallback.md`
- Frontera Reposición/Pricing: `/docs/policies/frontera-reposicion-pricing.md`
- Inventario regla: `.claude/rules/inventory-policy.md`
