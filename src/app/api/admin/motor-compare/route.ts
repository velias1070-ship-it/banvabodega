import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

// Sprint 7 cierre — Comparador motor viejo vs motor nuevo.
// Read-only: lee v_reposicion_explain que ya tiene ambos lados.
// No promueve nada — sólo expone diferencias para auditoría del owner.

export const dynamic = "force-dynamic";

type Row = {
  sku_origen: string;
  nombre: string | null;
  proveedor_nombre: string | null;
  cell: string | null;
  // Motor viejo (sku_intelligence)
  accion_viejo: string | null;
  mandar_full_viejo: number | null;
  pedir_proveedor_viejo: number | null;
  // Motor nuevo (sku_node_policy + v_compras_pendientes)
  accion_nuevo: string | null;
  prioridad_nuevo: number | null;
  mandar_full_nuevo: number | null;
  qty_a_comprar_nuevo: number | null;
  // Comunes / shared
  stock_bodega: number | null;
  stock_full: number | null;
  stock_total: number | null;
  in_transit_oc: number | null;
  in_transit_picking_full: number | null;
  reserva_flex_target: number | null;
  pre_full_target: number | null;
  reorder_point: number | null;
  dio: number | null;
  dias_en_quiebre: number | null;
  vel_decl_dia: number | null;
  vel_real_dia: number | null;
  vel_drift_status: string | null;
  liquidacion_accion: string | null;
  liquidacion_descuento_sugerido: number | null;
  alertas: string[] | null;
  alertas_count: number | null;
  // Estado de comparación
  divergencia_accion: boolean;
  divergencia_compra: boolean;
  divergencia_full: boolean;
};

export async function GET() {
  const sb = getServerSupabase();
  if (!sb) {
    return NextResponse.json({ error: "DB no disponible" }, { status: 500 });
  }

  const { data, error } = await sb
    .from("v_reposicion_explain")
    .select(
      [
        "sku_origen",
        "nombre",
        "proveedor_nombre",
        "cell",
        "cell_efectiva",
        "accion",
        "accion_nueva",
        "prioridad_nueva",
        "mandar_full",
        "mandar_full_uds",
        "pedir_proveedor_motor_viejo",
        "qty_a_comprar",
        "stock_bodega",
        "stock_full",
        "stock_total",
        "in_transit_oc_bodega",
        "in_transit_picking_full",
        "reserva_flex_target",
        "pre_full_target",
        "reorder_point",
        "dio",
        "dias_en_quiebre",
        "vel_decl_dia",
        "vel_real_dia",
        "vel_drift_status",
        "liquidacion_accion",
        "liquidacion_descuento_sugerido",
        "alertas",
        "alertas_count",
      ].join(",")
    );

  if (error) {
    console.error("[motor-compare] query error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = ((data || []) as unknown as Record<string, unknown>[]).map((r) => {
    const accion_v = (r.accion as string) || null;
    const accion_n = ((r.accion_nueva as string) || null);
    const mf_v = Number(r.mandar_full ?? 0);
    const mf_n = Number(r.mandar_full_uds ?? 0);
    const pp_v = Number(r.pedir_proveedor_motor_viejo ?? 0);
    const qc_n = Number(r.qty_a_comprar ?? 0);
    return {
      sku_origen: r.sku_origen as string,
      nombre: (r.nombre as string) || null,
      proveedor_nombre: (r.proveedor_nombre as string) || null,
      cell: (r.cell as string) || null,
      accion_viejo: accion_v,
      mandar_full_viejo: mf_v,
      pedir_proveedor_viejo: pp_v,
      accion_nuevo: accion_n,
      prioridad_nuevo: Number(r.prioridad_nueva ?? 0),
      mandar_full_nuevo: mf_n,
      qty_a_comprar_nuevo: qc_n,
      stock_bodega: Number(r.stock_bodega ?? 0),
      stock_full: Number(r.stock_full ?? 0),
      stock_total: Number(r.stock_total ?? 0),
      in_transit_oc: Number(r.in_transit_oc_bodega ?? 0),
      in_transit_picking_full: Number(r.in_transit_picking_full ?? 0),
      reserva_flex_target: Number(r.reserva_flex_target ?? 0),
      pre_full_target: Number(r.pre_full_target ?? 0),
      reorder_point: Number(r.reorder_point ?? 0),
      dio: r.dio == null ? null : Number(r.dio),
      dias_en_quiebre: r.dias_en_quiebre == null ? null : Number(r.dias_en_quiebre),
      vel_decl_dia: r.vel_decl_dia == null ? null : Number(r.vel_decl_dia),
      vel_real_dia: r.vel_real_dia == null ? null : Number(r.vel_real_dia),
      vel_drift_status: (r.vel_drift_status as string) || null,
      liquidacion_accion: (r.liquidacion_accion as string) || null,
      liquidacion_descuento_sugerido:
        r.liquidacion_descuento_sugerido == null ? null : Number(r.liquidacion_descuento_sugerido),
      alertas: (r.alertas as string[]) || [],
      alertas_count: Number(r.alertas_count ?? 0),
      divergencia_accion: (accion_v || "") !== (accion_n || ""),
      divergencia_compra: pp_v !== qc_n,
      divergencia_full: mf_v !== mf_n,
    } as Row;
  });

  const summary = {
    total_skus: rows.length,
    div_accion: rows.filter((r) => r.divergencia_accion).length,
    div_compra: rows.filter((r) => r.divergencia_compra).length,
    div_full: rows.filter((r) => r.divergencia_full).length,
    paridad_total: rows.filter(
      (r) => !r.divergencia_accion && !r.divergencia_compra && !r.divergencia_full
    ).length,
  };

  return NextResponse.json({ data: rows, summary });
}
