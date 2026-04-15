import type { CostoFuente } from "./costos";

export interface PrevSnapshot {
  costo_producto: number | null;
  costo_fuente: string | null;
  costo_snapshot_at: string | null;
}

export interface ResolvedCosto {
  costo_producto: number;
  costo_fuente: CostoFuente;
}

export interface SnapshotCostoResult {
  costo_producto: number;
  costo_fuente: CostoFuente;
  costo_snapshot_at: string;
  fromSnapshot: boolean;
}

export interface SnapshotLogger {
  warn: (msg: string, data: Record<string, unknown>) => void;
}

export interface SnapshotContext {
  order_id: string | number;
  sku_venta: string;
}

/**
 * Decide qué costo_producto/costo_fuente/costo_snapshot_at escribir en una
 * fila de ventas_ml_cache, respetando la inmutabilidad contable del snapshot
 * previo si existe.
 *
 * Casos:
 *  - sin snapshot previo          → resuelve ahora (WAC vigente al momento del sync)
 *  - snapshot previo completo     → preserva tal cual
 *  - snapshot previo sin fuente   → preserva costo_producto, marca 'sin_fuente'
 *                                   y emite warning para investigar
 *  - snapshot previo sin timestamp → usa el snapshotAt nuevo
 */
export function decidirSnapshotCosto(
  prev: PrevSnapshot | null | undefined,
  resolverAhora: () => ResolvedCosto,
  snapshotAt: string,
  context: SnapshotContext,
  logger: SnapshotLogger = console,
): SnapshotCostoResult {
  if (prev && prev.costo_producto != null) {
    let costo_fuente: CostoFuente | null = prev.costo_fuente as CostoFuente | null;
    if (!costo_fuente) {
      logger.warn("[SNAPSHOT] Snapshot sin fuente", {
        order_id: context.order_id,
        sku_venta: context.sku_venta,
        costo_producto: prev.costo_producto,
      });
      costo_fuente = "sin_fuente";
    }
    return {
      costo_producto: prev.costo_producto,
      costo_fuente,
      costo_snapshot_at: prev.costo_snapshot_at || snapshotAt,
      fromSnapshot: true,
    };
  }
  const resolved = resolverAhora();
  return {
    costo_producto: resolved.costo_producto,
    costo_fuente: resolved.costo_fuente,
    costo_snapshot_at: snapshotAt,
    fromSnapshot: false,
  };
}
