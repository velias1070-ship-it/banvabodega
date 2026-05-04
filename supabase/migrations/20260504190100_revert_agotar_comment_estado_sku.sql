-- Sprint 5.5.2 — Actualizar COMMENT ON COLUMN productos.estado_sku
-- Owner: Vicente Elías | 2026-05-04 | Tag: [batch:20260504-revert-agotar-filter]
-- Revisión doctrina: docs/policies/estados-sku.md (versión 2026-05-04 PM)
--
-- Cambio: el COMMENT del 20260504181500 describía 'agotar' como excluyente
-- del motor nuevo (cron sync-from-templates) y blocker de recompra. Owner
-- redefinió hoy: 'agotar' es SOLO toggle de buffer Flex=0. Sigue en motor,
-- sigue en sku_node_policy, sigue calculando recompra normal. Lo único que
-- cambia respecto a 'activo' es el buffer de publicación a ML.
--
-- Nota: 100% metadata. Cero cambio de schema ni datos.

COMMENT ON COLUMN productos.estado_sku IS
'Estado operacional del SKU. Setea humano vía /admin → Inventario.
Valores válidos:
- "activo" (default): operación normal, buffer Flex 2 (o 4 si sku_origen
  compartido).
- "agotar": vender al máximo sin reserva. Buffer Flex = 0 (publica TODO el
  stock disponible, ignora el colchón anti-race). NO afecta recompra ni motor
  de inteligencia: sigue entrando a sku_node_policy, intelligence.ts y
  pricing igual que un SKU activo. La doctrina ANTERIOR (excluir del motor
  nuevo) fue revertida 2026-05-04 — owner clarificó que agotar es SOLO un
  flag de publicación. Coexiste con OCs abiertas / liquidacion_accion / promo.
- "descontinuado": fuera de catálogo. intelligence.ts lo skipea
  (intelligence.ts:797). Cron sync-from-templates lo excluye de
  sku_node_policy. Pricing salta (markdown-auto:220, recalcular-floors:177).
  No se publica.
- NULL: legacy / sin clasificación. Se trata como "activo" por defecto.

Detalle completo de comportamiento por componente: /docs/policies/estados-sku.md.

Distribución 2026-05-04: 414 NULL, 73 activo, 22 agotar, 0 descontinuado.

NO escribir desde código nuevo salvo desde la UI admin (admin/page.tsx).
audit_log.accion=''estado_sku_change'' registra cada cambio.';
