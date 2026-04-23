import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * Audita ml_items_map buscando:
 * 1. Mappings con inventory_id que no matchea codigo_ml del sku_origen esperado
 *    (resolviendo via composicion_venta si existe).
 * 2. SKUs con stock>0 que no tienen ninguna entrada activa en ml_items_map
 *    (sin_mapping).
 *
 * Retorna un reporte JSON. Pensado para correr como cron (diario?) y
 * generar audit_log si aparecen casos nuevos.
 */
export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  try {
    const mismatchQuery = `
      SELECT
        mim.sku AS sku_venta,
        mim.item_id,
        mim.inventory_id,
        mim.status_ml,
        mim.stock_flex_cache,
        COALESCE(cv.sku_origen, mim.sku_origen, mim.sku) AS sku_origen,
        p.codigo_ml AS codigo_esperado
      FROM ml_items_map mim
      LEFT JOIN composicion_venta cv ON cv.sku_venta = mim.sku
      LEFT JOIN productos p ON p.sku = COALESCE(cv.sku_origen, mim.sku_origen, mim.sku)
      WHERE mim.inventory_id IS NOT NULL
        AND mim.activo = true
        AND p.codigo_ml IS NOT NULL
        AND p.codigo_ml != ''
        AND mim.inventory_id != p.codigo_ml
        AND p.codigo_ml NOT LIKE '%' || mim.inventory_id || '%'
    `;
    const { data: mismatches, error: mErr } = await sb.rpc("exec_sql", { sql: mismatchQuery }).select();
    // Fallback: si no existe rpc exec_sql, usar query directa con columnas
    let mismatchRows: Array<{sku_venta:string;item_id:string;inventory_id:string;status_ml:string|null;stock_flex_cache:number|null;sku_origen:string;codigo_esperado:string}> = [];
    if (mErr || !mismatches) {
      // Fallback manual: trae todo y filtra en memoria
      const [{ data: mims }, { data: comps }, { data: prods }] = await Promise.all([
        sb.from("ml_items_map").select("sku, item_id, inventory_id, status_ml, stock_flex_cache, sku_origen").eq("activo", true).not("inventory_id", "is", null),
        sb.from("composicion_venta").select("sku_venta, sku_origen"),
        sb.from("productos").select("sku, codigo_ml").not("codigo_ml", "is", null).neq("codigo_ml", ""),
      ]);
      const cvMap = new Map((comps || []).map((c:{sku_venta:string;sku_origen:string}) => [c.sku_venta, c.sku_origen]));
      const prodMap = new Map((prods || []).map((p:{sku:string;codigo_ml:string}) => [p.sku, p.codigo_ml]));
      for (const m of (mims || []) as Array<{sku:string;item_id:string;inventory_id:string|null;status_ml:string|null;stock_flex_cache:number|null;sku_origen:string|null}>) {
        if (!m.inventory_id) continue;
        const sko = cvMap.get(m.sku) || m.sku_origen || m.sku;
        const esperado = prodMap.get(sko) || "";
        if (!esperado) continue;
        const invUp = m.inventory_id.toUpperCase();
        const espUp = esperado.toUpperCase();
        if (invUp !== espUp && !espUp.includes(invUp)) {
          mismatchRows.push({
            sku_venta: m.sku, item_id: m.item_id, inventory_id: m.inventory_id,
            status_ml: m.status_ml, stock_flex_cache: m.stock_flex_cache,
            sku_origen: sko, codigo_esperado: esperado,
          });
        }
      }
    } else {
      mismatchRows = mismatches as typeof mismatchRows;
    }

    // SKUs con stock>0 sin mapping activo
    const { data: vStock } = await sb.from("v_stock_disponible").select("sku, disponible").gt("disponible", 0);
    const { data: mapActive } = await sb.from("ml_items_map").select("sku, sku_origen").eq("activo", true);
    const { data: prodsEstado } = await sb.from("productos").select("sku, estado_sku");
    const mappedOrigenes = new Set<string>();
    const { data: compsAll } = await sb.from("composicion_venta").select("sku_venta, sku_origen");
    const svToOrigen = new Map((compsAll || []).map((c:{sku_venta:string;sku_origen:string}) => [c.sku_venta, c.sku_origen]));
    for (const m of (mapActive || []) as Array<{sku:string;sku_origen:string|null}>) {
      const origen = m.sku_origen || svToOrigen.get(m.sku) || m.sku;
      mappedOrigenes.add(origen);
    }
    const descontinuados = new Set(
      (prodsEstado || []).filter((p:{sku:string;estado_sku:string|null}) => p.estado_sku === "descontinuado").map((p:{sku:string;estado_sku:string|null}) => p.sku)
    );
    const sinMapping = ((vStock || []) as Array<{sku:string;disponible:number}>)
      .filter(v => !mappedOrigenes.has(v.sku) && !descontinuados.has(v.sku))
      .map(v => ({ sku: v.sku, disponible: v.disponible }));

    const report = {
      mismatches: mismatchRows,
      sin_mapping: sinMapping,
      totals: { mismatches: mismatchRows.length, sin_mapping: sinMapping.length },
      generated_at: new Date().toISOString(),
    };

    if (mismatchRows.length > 0 || sinMapping.length > 0) {
      await sb.from("audit_log").insert({
        accion: "ml_items_map:audit_report",
        entidad: "ml_items_map",
        entidad_id: "batch",
        params: report,
        operario: "cron",
      });
    }

    return NextResponse.json(report);
  } catch (err) {
    console.error("[audit-mappings] error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
