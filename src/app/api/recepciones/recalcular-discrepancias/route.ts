import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 60;

/**
 * Regenerate cost discrepancies for a reception (or all).
 * Compares costo_unitario (from invoice) with costo in productos (dictionary).
 * Only creates PENDIENTE for differences not already resolved.
 *
 * GET ?id=RECEPCION_ID   — single reception
 * GET ?all=1             — all COMPLETADA receptions
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const recId = req.nextUrl.searchParams.get("id");
  const doAll = req.nextUrl.searchParams.get("all") === "1";

  if (!recId && !doAll) return NextResponse.json({ error: "id or all=1 required" }, { status: 400 });

  try {
    // Get receptions to process
    let recIds: string[] = [];
    if (recId) {
      recIds = [recId];
    } else {
      const { data } = await sb.from("recepciones").select("id").in("estado", ["COMPLETADA", "EN_PROCESO"]);
      recIds = (data || []).map((r: { id: string }) => r.id);
    }

    // Load all product costs
    const { data: productos } = await sb.from("productos").select("sku, costo");
    const costoMap = new Map<string, number>();
    for (const p of (productos || []) as { sku: string; costo: number }[]) {
      costoMap.set(p.sku, p.costo || 0);
    }

    // Load existing discrepancies (to not duplicate resolved ones)
    const { data: existingDiscs } = await sb.from("discrepancias_costo")
      .select("recepcion_id, linea_id, estado")
      .in("recepcion_id", recIds);
    const resolvedKeys = new Set<string>();
    for (const d of (existingDiscs || []) as { recepcion_id: string; linea_id: string; estado: string }[]) {
      if (d.estado === "APROBADO" || d.estado === "RECHAZADO") {
        resolvedKeys.add(`${d.recepcion_id}|${d.linea_id}`);
      }
    }

    let totalCreated = 0;
    const results: Array<{ recepcion_id: string; created: number }> = [];

    for (const rid of recIds) {
      // Get lines for this reception
      const { data: lineas } = await sb.from("recepcion_lineas")
        .select("id, sku, costo_unitario")
        .eq("recepcion_id", rid);

      const nuevas: Array<Record<string, unknown>> = [];

      for (const l of (lineas || []) as { id: string; sku: string; costo_unitario: number }[]) {
        // Skip if already resolved
        if (resolvedKeys.has(`${rid}|${l.id}`)) continue;

        const costoDic = costoMap.get(l.sku) || 0;
        const costoFact = l.costo_unitario || 0;
        if (costoDic === 0 && costoFact === 0) continue;
        if (Math.abs(costoDic - costoFact) < 1) continue;

        const diff = costoFact - costoDic;
        const pct = costoDic > 0 ? Math.round((diff / costoDic) * 1000) / 10 : 100;

        nuevas.push({
          recepcion_id: rid,
          linea_id: l.id,
          sku: l.sku,
          costo_diccionario: costoDic,
          costo_factura: costoFact,
          diferencia: diff,
          porcentaje: pct,
          estado: "PENDIENTE",
        });
      }

      if (nuevas.length > 0) {
        // Delete existing PENDIENTE for this reception (to avoid duplicates)
        await sb.from("discrepancias_costo").delete().eq("recepcion_id", rid).eq("estado", "PENDIENTE");
        // Insert new ones
        const { error } = await sb.from("discrepancias_costo").insert(nuevas);
        if (error) console.warn(`[Discrepancias] Error inserting for ${rid}:`, error.message);
        else totalCreated += nuevas.length;
      }

      results.push({ recepcion_id: rid, created: nuevas.length });
    }

    return NextResponse.json({ status: "ok", receptions: recIds.length, total_created: totalCreated, details: results.filter(r => r.created > 0) });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
