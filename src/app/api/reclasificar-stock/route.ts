import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/reclasificar-stock
 * Reclasifica stock existente (sku_venta = NULL) usando los movimientos de recepción
 * que tienen el formato [SKU_VENTA] en la nota.
 *
 * También usa composicion_venta: si un SKU solo tiene UNA composición con unidades=1,
 * asigna ese formato automáticamente al stock sin etiquetar.
 */
export async function POST() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "DB no configurada" }, { status: 500 });

  try {
    // 1. Obtener TODOS los movimientos de entrada por recepción
    const { data: movimientos } = await sb
      .from("movimientos")
      .select("*")
      .eq("tipo", "entrada")
      .eq("motivo", "recepcion")
      .order("created_at", { ascending: true });

    if (!movimientos || movimientos.length === 0) {
      return NextResponse.json({ message: "No hay movimientos de recepción", reclasificados: 0 });
    }

    // 2. Obtener composiciones de venta
    const { data: composiciones } = await sb.from("composicion_venta").select("*");

    // 3. Obtener stock actual sin etiquetar (sku_venta IS NULL)
    const { data: stockSinEtiquetar } = await sb
      .from("stock")
      .select("*")
      .is("sku_venta", null);

    if (!stockSinEtiquetar || stockSinEtiquetar.length === 0) {
      return NextResponse.json({ message: "No hay stock sin etiquetar para reclasificar", reclasificados: 0 });
    }

    // 4. Agrupar movimientos por sku+posicion, extraer sku_venta de la nota
    // Nota format: "Recepción - Factura #123 - Proveedor [SKU_VENTA]"
    const regex = /\[([^\]]+)\]$/;
    interface MovInfo { sku: string; posicion: string; skuVenta: string; qty: number }
    const movsPorSkuPos: Record<string, MovInfo[]> = {};

    for (const m of movimientos) {
      const match = m.nota?.match(regex);
      if (!match) continue;
      const skuVenta = match[1];
      if (skuVenta === "Sin etiquetar") continue; // skip explicit sin etiquetar
      const key = `${m.sku}::${m.posicion_id}`;
      if (!movsPorSkuPos[key]) movsPorSkuPos[key] = [];
      movsPorSkuPos[key].push({ sku: m.sku, posicion: m.posicion_id, skuVenta, qty: m.cantidad });
    }

    // 5. Para SKUs con composiciones: si un SKU tiene una sola composición individual (unidades=1),
    //    asignar ese formato automáticamente
    const compPorSkuOrigen: Record<string, Array<{ sku_venta: string; unidades: number }>> = {};
    if (composiciones) {
      for (const c of composiciones) {
        if (!compPorSkuOrigen[c.sku_origen]) compPorSkuOrigen[c.sku_origen] = [];
        compPorSkuOrigen[c.sku_origen].push({ sku_venta: c.sku_venta, unidades: c.unidades });
      }
    }

    let reclasificados = 0;
    const detalles: Array<{ sku: string; posicion: string; skuVenta: string; qty: number; metodo: string }> = [];

    for (const row of stockSinEtiquetar) {
      const key = `${row.sku}::${row.posicion_id}`;
      const movsParaEste = movsPorSkuPos[key];
      let qtyRestante = row.cantidad;

      if (movsParaEste && movsParaEste.length > 0) {
        // Método 1: Usar datos de movimientos de recepción
        // Agrupar por sku_venta para sumar cantidades
        const porFormato: Record<string, number> = {};
        for (const m of movsParaEste) {
          porFormato[m.skuVenta] = (porFormato[m.skuVenta] || 0) + m.qty;
        }

        for (const [skuVenta, qtyMov] of Object.entries(porFormato)) {
          const qtyAsignar = Math.min(qtyMov, qtyRestante);
          if (qtyAsignar <= 0) continue;

          try {
            // Salida sin etiquetar + entrada con formato — 2 movimientos atómicos
            await sb.rpc("registrar_movimiento_stock", {
              p_sku: row.sku, p_posicion: row.posicion_id, p_delta: -qtyAsignar,
              p_tipo: "ajuste", p_sku_venta: null, p_motivo: "reclasificacion",
              p_operario: "sistema",
              p_nota: `Reclasificación: Sin etiquetar → ${skuVenta} (${qtyAsignar} uds) [salida]`,
            });
            await sb.rpc("registrar_movimiento_stock", {
              p_sku: row.sku, p_posicion: row.posicion_id, p_delta: qtyAsignar,
              p_tipo: "ajuste", p_sku_venta: skuVenta, p_motivo: "reclasificacion",
              p_operario: "sistema",
              p_nota: `Reclasificación: Sin etiquetar → ${skuVenta} (${qtyAsignar} uds) [entrada]`,
            });
          } catch (err) {
            console.error(`Error reclasificando ${row.sku} → ${skuVenta}:`, err);
            continue;
          }

          qtyRestante -= qtyAsignar;
          reclasificados++;
          detalles.push({ sku: row.sku, posicion: row.posicion_id, skuVenta, qty: qtyAsignar, metodo: "movimiento" });
        }
      }

      // Método 2: Si queda stock sin reclasificar y el SKU tiene UNA sola composición individual
      if (qtyRestante > 0) {
        const comps = compPorSkuOrigen[row.sku];
        if (comps && comps.length === 1 && comps[0].unidades === 1) {
          const skuVenta = comps[0].sku_venta;
          try {
            await sb.rpc("registrar_movimiento_stock", {
              p_sku: row.sku, p_posicion: row.posicion_id, p_delta: -qtyRestante,
              p_tipo: "ajuste", p_sku_venta: null, p_motivo: "reclasificacion",
              p_operario: "sistema",
              p_nota: `Reclasificación auto: Sin etiquetar → ${skuVenta} (${qtyRestante} uds) [salida]`,
            });
            await sb.rpc("registrar_movimiento_stock", {
              p_sku: row.sku, p_posicion: row.posicion_id, p_delta: qtyRestante,
              p_tipo: "ajuste", p_sku_venta: skuVenta, p_motivo: "reclasificacion",
              p_operario: "sistema",
              p_nota: `Reclasificación auto: Sin etiquetar → ${skuVenta} (${qtyRestante} uds) [entrada]`,
            });
            reclasificados++;
            detalles.push({ sku: row.sku, posicion: row.posicion_id, skuVenta, qty: qtyRestante, metodo: "composicion_unica" });
          } catch (err) {
            console.error(`Error reclasificando auto ${row.sku} → ${skuVenta}:`, err);
          }
        }
      }
    }

    return NextResponse.json({
      message: `Reclasificación completada`,
      reclasificados,
      detalles,
      stockSinEtiquetarOriginal: stockSinEtiquetar.length,
    });
  } catch (err) {
    console.error("Error en reclasificación:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
