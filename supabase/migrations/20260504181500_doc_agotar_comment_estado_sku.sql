-- Doctrina 'agotar' — actualizar COMMENT ON COLUMN productos.estado_sku
-- Owner: Vicente Elías | 2026-05-04 | Tag: [batch:20260504-doc-agotar]
-- Discovery: docs/discovery/estado-sku-agotar-2026-05-04.md
-- Doctrina: docs/policies/estados-sku.md
--
-- Nota: 100% metadata. Cero cambio de comportamiento ni datos.
-- Reemplaza el COMMENT previo (que solo contemplaba activo/dormido/phaseout/descontinuado)
-- por uno que reconoce "agotar" como estado válido implementado y usado en producción.

COMMENT ON COLUMN productos.estado_sku IS
'Estado operacional del SKU. Setea humano vía /admin → Inventario.
Valores válidos:
- "activo" (default): operación normal, entra a motor + sku_node_policy + pricing,
  buffer Flex 2/4, recibe reposición.
- "agotar": vender lo que queda al máximo. Buffer Flex = 0 (publica todo el stock),
  cron sync-from-templates lo excluye de sku_node_policy (motor nuevo lo invisibiliza
  para reposición). Pricing y motor viejo siguen calculando normal. Estado intermedio
  previo a "descontinuado". Doctrina formalizada 2026-05-04.
- "descontinuado": fuera de catálogo. intelligence.ts y pricing lo skipean
  explícitamente. No se publica.
- "dormido" (futuro): vel_30d=vel_60d=0 ≥ 60 días con stock. Reservado, no en uso.
- NULL: legacy / sin clasificación. Se trata como "activo" por defecto.

Detalle completo de comportamiento por componente: /docs/policies/estados-sku.md.

Distribución 2026-05-04: 414 NULL, 73 activo, 22 agotar, 0 descontinuado.

NO escribir desde código nuevo salvo desde la UI admin (admin/page.tsx).
audit_log.accion=''estado_sku_change'' registra cada cambio.';
