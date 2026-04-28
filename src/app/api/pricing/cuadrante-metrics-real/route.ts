import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/pricing/cuadrante-metrics-real
 *
 * Métricas reales observadas por cuadrante en últimos 30 días, para overlay
 * informativo en AdminPricingConfig contra los thresholds manuales del config.
 *
 * Permite a Vicente ver "margen min config: 20% / margen real 30d: 24.8%"
 * y detectar thresholds desalineados con la realidad.
 */

type Metrics = {
  cuadrante: string;
  skus_total: number;
  skus_con_venta_30d: number;
  gmv_30d: number;
  margen_real_30d_pct: number | null;
  margen_actual_med_pct: number | null;
  acos_real_30d_pct: number | null;
  acos_total_30d_pct: number | null;
  items_con_gasto_ads: number;
  cost_neto_ads_30d: number;
  descuento_actual_med_pct: number | null;
  ventas_full: number;
  ventas_flex: number;
};

export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const { data, error } = await sb.rpc("pricing_cuadrante_metrics_real");
  if (!error && data) {
    return NextResponse.json({ ok: true, metrics: data });
  }

  // Fallback: ejecutar las queries directamente sin RPC
  const metrics: Metrics[] = [];
  const cuadrantes = ["ESTRELLA", "VOLUMEN", "CASHCOW", "REVISAR"];

  for (const cuad of cuadrantes) {
    const { data: r1 } = await sb
      .from("sku_intelligence")
      .select("sku_origen", { count: "exact", head: false })
      .eq("cuadrante", cuad);
    const skus_total = r1?.length || 0;
    const skuList = (r1 || []).map((x) => x.sku_origen);

    let gmv_30d = 0;
    let margen_neto_sum = 0;
    let subtotal_sum = 0;
    let skus_con_venta = new Set<string>();
    let ventas_full = 0;
    let ventas_flex = 0;

    if (skuList.length) {
      const since = new Date();
      since.setDate(since.getDate() - 30);
      const sinceStr = since.toISOString();

      // ventas_ml_cache no tiene índice ideal por sku_venta IN list grande
      // Hacemos en chunks
      for (let i = 0; i < skuList.length; i += 200) {
        const chunk = skuList.slice(i, i + 200);
        const { data: vs } = await sb
          .from("ventas_ml_cache")
          .select("sku_venta, subtotal, margen_neto, logistic_type, fecha")
          .in("sku_venta", chunk)
          .eq("anulada", false)
          .gte("fecha", sinceStr);
        for (const v of (vs || []) as Array<{
          sku_venta: string;
          subtotal: number | null;
          margen_neto: number | null;
          logistic_type: string | null;
        }>) {
          gmv_30d += Number(v.subtotal || 0);
          margen_neto_sum += Number(v.margen_neto || 0);
          subtotal_sum += Number(v.subtotal || 0);
          skus_con_venta.add(v.sku_venta);
          if (v.logistic_type === "fulfillment") ventas_full++;
          else if (v.logistic_type === "self_service" || v.logistic_type === "custom") ventas_flex++;
        }
      }
    }

    // ml_margin_cache para descuento + margen actual
    let descuentos: number[] = [];
    let margen_actuales: number[] = [];
    let item_ids_cuad: string[] = [];
    if (skuList.length) {
      for (let i = 0; i < skuList.length; i += 200) {
        const chunk = skuList.slice(i, i + 200);
        const { data: ms } = await sb
          .from("ml_margin_cache")
          .select("sku, item_id, price_ml, precio_venta, margen_pct, status_ml")
          .in("sku", chunk)
          .eq("status_ml", "active");
        for (const m of (ms || []) as Array<{
          sku: string;
          item_id: string;
          price_ml: number | null;
          precio_venta: number | null;
          margen_pct: number | null;
        }>) {
          if (m.item_id) item_ids_cuad.push(m.item_id);
          if (m.margen_pct != null) margen_actuales.push(Number(m.margen_pct));
          if (m.price_ml && m.precio_venta && m.price_ml > 0) {
            const desc = (1 - Number(m.precio_venta) / Number(m.price_ml)) * 100;
            descuentos.push(desc);
          }
        }
      }
    }

    // ACOS real 30d desde ml_ads_daily_cache
    let cost_ads = 0;
    let direct_amt = 0;
    let total_amt = 0;
    let items_con_gasto = 0;
    if (item_ids_cuad.length) {
      const since = new Date();
      since.setDate(since.getDate() - 30);
      const sinceStr = since.toISOString().slice(0, 10);
      for (let i = 0; i < item_ids_cuad.length; i += 200) {
        const chunk = item_ids_cuad.slice(i, i + 200);
        const { data: ads } = await sb
          .from("ml_ads_daily_cache")
          .select("item_id, cost_neto, direct_amount, total_amount")
          .in("item_id", chunk)
          .gte("date", sinceStr);
        const itemsHit = new Set<string>();
        for (const a of (ads || []) as Array<{
          item_id: string;
          cost_neto: number | null;
          direct_amount: number | null;
          total_amount: number | null;
        }>) {
          const cn = Number(a.cost_neto || 0);
          if (cn > 0) itemsHit.add(a.item_id);
          cost_ads += cn;
          direct_amt += Number(a.direct_amount || 0);
          total_amt += Number(a.total_amount || 0);
        }
        items_con_gasto += itemsHit.size;
      }
    }

    const median = (arr: number[]): number | null => {
      if (!arr.length) return null;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    metrics.push({
      cuadrante: cuad,
      skus_total,
      skus_con_venta_30d: skus_con_venta.size,
      gmv_30d: Math.round(gmv_30d),
      margen_real_30d_pct:
        subtotal_sum > 0 ? Math.round((margen_neto_sum / subtotal_sum) * 1000) / 10 : null,
      margen_actual_med_pct: margen_actuales.length ? Math.round(median(margen_actuales)! * 10) / 10 : null,
      acos_real_30d_pct: direct_amt > 0 ? Math.round((cost_ads / direct_amt) * 1000) / 10 : null,
      acos_total_30d_pct: total_amt > 0 ? Math.round((cost_ads / total_amt) * 1000) / 10 : null,
      items_con_gasto_ads: items_con_gasto,
      cost_neto_ads_30d: Math.round(cost_ads),
      descuento_actual_med_pct: descuentos.length ? Math.round(median(descuentos)! * 10) / 10 : null,
      ventas_full,
      ventas_flex,
    });
  }

  return NextResponse.json({ ok: true, metrics });
}
