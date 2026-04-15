import { describe, it, expect, vi } from "vitest";
import { decidirSnapshotCosto } from "../snapshot-costo";

describe("decidirSnapshotCosto", () => {
  const SNAPSHOT_AT_NUEVO = "2026-04-15T12:00:00.000Z";
  const CONTEXT = { order_id: "ORD-123", sku_venta: "SKU-ABC" };

  it("sin snapshot previo: invoca resolverAhora y fromSnapshot=false", () => {
    const resolverAhora = vi.fn().mockReturnValue({
      costo_producto: 5000,
      costo_fuente: "promedio" as const,
    });

    const result = decidirSnapshotCosto(null, resolverAhora, SNAPSHOT_AT_NUEVO, CONTEXT);

    expect(resolverAhora).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      costo_producto: 5000,
      costo_fuente: "promedio",
      costo_snapshot_at: SNAPSHOT_AT_NUEVO,
      fromSnapshot: false,
    });
  });

  it("snapshot previo completo: preserva costo_producto/fuente/snapshot_at y NO invoca resolverAhora", () => {
    const prev = {
      costo_producto: 4000,
      costo_fuente: "promedio",
      costo_snapshot_at: "2026-03-01T10:00:00.000Z",
    };
    const resolverAhora = vi.fn().mockReturnValue({
      costo_producto: 6000, // productos.costo_promedio subió, pero la función NO debería usarlo
      costo_fuente: "promedio" as const,
    });

    const result = decidirSnapshotCosto(prev, resolverAhora, SNAPSHOT_AT_NUEVO, CONTEXT);

    expect(resolverAhora).not.toHaveBeenCalled();
    expect(result).toEqual({
      costo_producto: 4000,
      costo_fuente: "promedio",
      costo_snapshot_at: "2026-03-01T10:00:00.000Z",
      fromSnapshot: true,
    });
  });

  it("snapshot previo con costo_fuente=null: emite logger.warn y marca 'sin_fuente'", () => {
    const prev = {
      costo_producto: 4500,
      costo_fuente: null,
      costo_snapshot_at: "2026-03-01T10:00:00.000Z",
    };
    const warn = vi.fn();
    const logger = { warn };
    const resolverAhora = vi.fn().mockReturnValue({
      costo_producto: 9999,
      costo_fuente: "promedio" as const,
    });

    const result = decidirSnapshotCosto(prev, resolverAhora, SNAPSHOT_AT_NUEVO, CONTEXT, logger);

    expect(resolverAhora).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[SNAPSHOT] Snapshot sin fuente",
      expect.objectContaining({
        order_id: "ORD-123",
        sku_venta: "SKU-ABC",
        costo_producto: 4500,
      }),
    );
    expect(result).toEqual({
      costo_producto: 4500,
      costo_fuente: "sin_fuente",
      costo_snapshot_at: "2026-03-01T10:00:00.000Z",
      fromSnapshot: true,
    });
  });

  it("snapshot previo con costo_snapshot_at=null: usa el snapshotAt nuevo", () => {
    const prev = {
      costo_producto: 4000,
      costo_fuente: "promedio",
      costo_snapshot_at: null,
    };
    const resolverAhora = vi.fn().mockReturnValue({
      costo_producto: 9999,
      costo_fuente: "promedio" as const,
    });

    const result = decidirSnapshotCosto(prev, resolverAhora, SNAPSHOT_AT_NUEVO, CONTEXT);

    expect(result.costo_snapshot_at).toBe(SNAPSHOT_AT_NUEVO);
    expect(result.costo_producto).toBe(4000);
    expect(result.costo_fuente).toBe("promedio");
    expect(result.fromSnapshot).toBe(true);
  });
});
