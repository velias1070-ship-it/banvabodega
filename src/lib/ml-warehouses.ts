/**
 * ML Warehouses — Fuente única de verdad (SSoT) para tiendas/bodegas ML activas y deprecadas.
 *
 * Cambio de bodega BANVA 2026-05-11: Los Libertadores 74 → Casa Central Los Fresnos 600.
 * ML no permite eliminar locations via API, solo dejarlas en quantity=0.
 *
 * Regla 5 (.claude/rules/inventory-policy.md): fuente única canónica + lecturas derivadas.
 * Para cambios futuros (mudanza 3+): editar ACTIVE_WAREHOUSE y NEUTRALIZE_WAREHOUSES acá.
 * Todos los callers importan desde este archivo:
 *   - src/lib/ml.ts (updateFlexStock)
 *   - src/app/api/ml/activate-warehouse-all/route.ts
 *   - src/app/api/ml/activate-warehouse/route.ts
 */

export interface MLWarehouse {
  store_id: string;
  network_node_id: string;
  nombre?: string;
}

export const ACTIVE_WAREHOUSE: MLWarehouse = {
  store_id: "82225378",
  network_node_id: "CLP19538063214",
  nombre: "Casa Central Los Fresnos 600",
};

export const NEUTRALIZE_WAREHOUSES: MLWarehouse[] = [
  {
    store_id: "73722087",
    network_node_id: "CLP19538063212",
    nombre: "Los Libertadores 74 (deprecada 2026-05-11)",
  },
];
