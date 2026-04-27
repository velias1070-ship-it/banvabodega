import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/pricing/triggers-reclasificacion
 *
 * Evalúa los 5 triggers de reclasificación prescritos por el manual
 * BANVA_Pricing_Investigacion_Comparada:235:
 *
 *   1. Caída Buy Box >20pp en 7 días        → pendiente_data (price_to_win)
 *   2. Aging >120 días                       → sku_intelligence.dias_sin_movimiento
 *   3. Competidor agresivo con -10% unit eco → pendiente_data (sin scraping/Nubimetrics)
 *   4. Crecimiento 3 meses +20% MoM          → ventas_ml_cache mensual
 *   5. Margen bruto post-fees <15% por 2m    → ventas_ml_cache margen mensual
 *
 * READ-ONLY / dry-run: NO modifica cuadrante ni política. Devuelve la
 * lista de SKUs que disparan cada trigger con la acción sugerida según
 * el manual. La aplicación (cambiar política) es decisión separada.
 *
 * Cuadrante en BANVA hoy se calcula por Pareto (intelligence.ts:1756);
 * los triggers del manual operan como capa de excepción / alerta sobre
 * esa clasificación, no la reemplazan.
 */

type TriggerResult = {
  sku: string;
  cuadrante: string | null;
  triggers_disparados: string[];
  accion_sugerida: string;
  detalle: Record<string, unknown>;
};

export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  // 1. SKUs activos con cuadrante
  const { data: intel } = await sb
    .from("sku_intelligence")
    .select("sku_origen, cuadrante, dias_sin_movimiento, alertas, vel_ponderada, uds_30d, stock_total");
  const skus = (intel || []) as Array<{
    sku_origen: string;
    cuadrante: string | null;
    dias_sin_movimiento: number | null;
    alertas: string[] | null;
    vel_ponderada: number | null;
    uds_30d: number | null;
    stock_total: number | null;
  }>;
  if (!skus.length) return NextResponse.json({ ok: true, skus_evaluados: 0, triggers: [] });

  // 2. Ventas mensuales últimos 4 meses por SKU
  const sinceVentas = new Date();
  sinceVentas.setDate(sinceVentas.getDate() - 120);
  const sinceStr = sinceVentas.toISOString();
  const { data: ventasRaw } = await sb
    .from("ventas_ml_cache")
    .select("sku_venta, subtotal, margen_neto, fecha")
    .gte("fecha", sinceStr);

  // Agregar por mes (YYYY-MM) por SKU
  type MesKpi = { uds: number; gmv: number; margen_neto: number };
  const ventasPorSkuMes = new Map<string, Map<string, MesKpi>>();
  for (const v of (ventasRaw || []) as Array<{ sku_venta: string; subtotal: number | null; margen_neto: number | null; fecha: string }>) {
    const mes = v.fecha.slice(0, 7); // YYYY-MM
    let mapMes = ventasPorSkuMes.get(v.sku_venta);
    if (!mapMes) {
      mapMes = new Map();
      ventasPorSkuMes.set(v.sku_venta, mapMes);
    }
    const k = mapMes.get(mes) || { uds: 0, gmv: 0, margen_neto: 0 };
    k.uds += 1;
    k.gmv += Number(v.subtotal || 0);
    k.margen_neto += Number(v.margen_neto || 0);
    mapMes.set(mes, k);
  }

  // Helper: meses en formato YYYY-MM ordenados desc (más reciente primero)
  const hoy = new Date();
  const mesesAtras = (n: number) => {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - n, 1);
    return d.toISOString().slice(0, 7);
  };
  const M0 = mesesAtras(0); // mes actual
  const M1 = mesesAtras(1);
  const M2 = mesesAtras(2);
  const M3 = mesesAtras(3);

  // 3. Evaluar cada SKU contra los 5 triggers
  const out: TriggerResult[] = [];

  for (const s of skus) {
    const triggers: string[] = [];
    const detalle: Record<string, unknown> = {};
    const ventasMes = ventasPorSkuMes.get(s.sku_origen) || new Map<string, MesKpi>();

    // === Trigger 1: Buy Box drop >20pp/7d (pendiente_data) ===
    // No data: marcar como observable cuando exista price_to_win histórico.
    // No agregamos al disparo, solo dejamos el flag de pendiente.

    // === Trigger 2: Aging >120 días sin movimiento ===
    const dsm = s.dias_sin_movimiento;
    if (dsm != null && dsm > 120) {
      triggers.push("aging_120d");
      detalle.dias_sin_movimiento = dsm;
    }

    // === Trigger 3: Competidor agresivo -10% unit economics (pendiente_data) ===
    // Sin price_to_win/Nubimetrics no hay señal.

    // === Trigger 4: Crecimiento +20% MoM por 3 meses ===
    // Definición manual: 3 meses consecutivos con crecimiento >+20% MoM en uds.
    const u0 = ventasMes.get(M0)?.uds || 0;
    const u1 = ventasMes.get(M1)?.uds || 0;
    const u2 = ventasMes.get(M2)?.uds || 0;
    const u3 = ventasMes.get(M3)?.uds || 0;
    const mom = (cur: number, prev: number) => prev > 0 ? (cur - prev) / prev * 100 : null;
    const mom_M1_M0 = mom(u0, u1);
    const mom_M2_M1 = mom(u1, u2);
    const mom_M3_M2 = mom(u2, u3);
    detalle.uds_mensual = { [M0]: u0, [M1]: u1, [M2]: u2, [M3]: u3 };
    detalle.mom_pct = { [`${M1}_${M0}`]: mom_M1_M0, [`${M2}_${M1}`]: mom_M2_M1, [`${M3}_${M2}`]: mom_M3_M2 };
    if (mom_M1_M0 != null && mom_M1_M0 > 20 &&
        mom_M2_M1 != null && mom_M2_M1 > 20 &&
        mom_M3_M2 != null && mom_M3_M2 > 20) {
      triggers.push("crecimiento_mom_20_3m");
    }

    // === Trigger 5: Margen post-fees <15% por 2 meses ===
    // Definición manual: 2 meses consecutivos con margen real <15%.
    // Usamos margen_neto/subtotal de ventas_ml_cache como proxy de margen post-fees.
    const k0 = ventasMes.get(M0);
    const k1 = ventasMes.get(M1);
    const margen_M0 = k0 && k0.gmv > 0 ? (k0.margen_neto / k0.gmv) * 100 : null;
    const margen_M1 = k1 && k1.gmv > 0 ? (k1.margen_neto / k1.gmv) * 100 : null;
    detalle.margen_pct_mes = { [M0]: margen_M0, [M1]: margen_M1 };
    if (margen_M0 != null && margen_M0 < 15 &&
        margen_M1 != null && margen_M1 < 15) {
      triggers.push("margen_post_fees_lt15_2m");
    }

    // === Acción sugerida según manual ===
    let accion = "mantener";
    if (triggers.includes("aging_120d")) {
      accion = "reclasificar_a_revisar_liquidar"; // Investigacion_Comparada:197 dead stock
    }
    if (triggers.includes("margen_post_fees_lt15_2m")) {
      // Manual Investigacion_Comparada:329: portfolio pruning si CMAA<8% por 60d.
      // Margen bruto post-fees <15% por 2m es señal previa.
      accion = s.cuadrante === "ESTRELLA"
        ? "estrella_aparente_revisar_costo_o_subir_precio"
        : "reclasificar_a_revisar_o_pruning";
    }
    if (triggers.includes("crecimiento_mom_20_3m")) {
      // Manual Investigacion_Comparada:208: bestsellers competitive/dynamic.
      // Si crece sostenido y no es Estrella, promover.
      accion = s.cuadrante === "ESTRELLA" ? "mantener_proteger_estrella" : "promover_a_estrella_o_volumen";
    }

    if (triggers.length > 0) {
      out.push({
        sku: s.sku_origen,
        cuadrante: s.cuadrante,
        triggers_disparados: triggers,
        accion_sugerida: accion,
        detalle,
      });
    }
  }

  // 4. Resumen
  const por_trigger: Record<string, number> = {};
  for (const r of out) {
    for (const t of r.triggers_disparados) {
      por_trigger[t] = (por_trigger[t] || 0) + 1;
    }
  }

  return NextResponse.json({
    ok: true,
    skus_evaluados: skus.length,
    skus_con_triggers: out.length,
    pendiente_data: {
      buy_box_drop_20pp_7d: "requiere serie histórica price_to_win (Task #20). Aplica solo al ~11% catalogado.",
      competidor_agresivo_minus10_ue: "requiere scraping competidor o Nubimetrics. No implementable sin data externa.",
    },
    por_trigger,
    triggers: out.sort((a, b) => b.triggers_disparados.length - a.triggers_disparados.length),
    fuente: "BANVA_Pricing_Investigacion_Comparada:235 (5 triggers automáticos de reclasificación)",
  });
}
