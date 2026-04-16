import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 60;

/**
 * POST /api/admin/dedup-rcv-compras
 * Body: { dryRun?: boolean }
 * Encuentra facturas duplicadas (mismo folio + RUT + tipo_doc) y elimina los
 * huérfanos preservando los que tienen conciliaciones.
 *
 * Estrategia:
 * 1. Por cada grupo de duplicados:
 *    - Si solo uno tiene conciliaciones (rcv_compra_id o conciliacion_items) → mantener ese
 *    - Si varios tienen conciliaciones → mantener todos los que tienen
 *    - Si ninguno tiene conciliaciones → mantener el más antiguo (created_at)
 */
export async function POST(req: Request) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  try {
    const body = await req.json().catch(() => ({}));
    const dryRun = body.dryRun !== false; // Por defecto dryRun=true

    // Cargar todas las compras
    const allCompras: { id: string; nro_doc: string; rut_proveedor: string; tipo_doc: number; created_at: string; razon_social: string; monto_total: number }[] = [];
    let from = 0;
    while (true) {
      const { data } = await sb.from("rcv_compras")
        .select("id, nro_doc, rut_proveedor, tipo_doc, created_at, razon_social, monto_total")
        .range(from, from + 999);
      if (!data || data.length === 0) break;
      allCompras.push(...data);
      if (data.length < 1000) break;
      from += 1000;
    }

    // Agrupar por (folio + RUT + tipo_doc)
    const grupos = new Map<string, typeof allCompras>();
    for (const c of allCompras) {
      const key = `${c.nro_doc}|${c.rut_proveedor}|${c.tipo_doc}`;
      if (!grupos.has(key)) grupos.set(key, []);
      grupos.get(key)!.push(c);
    }

    // Filtrar grupos con duplicados
    const duplicados = Array.from(grupos.entries()).filter(([, arr]) => arr.length > 1);

    if (duplicados.length === 0) {
      return NextResponse.json({ ok: true, mensaje: "Sin duplicados", grupos: 0, eliminar: 0 });
    }

    // Cargar conciliaciones que apuntan a estas compras
    const todosIds = duplicados.flatMap(([, arr]) => arr.map(c => c.id));
    const { data: concsCompra } = await sb.from("conciliaciones")
      .select("id, rcv_compra_id")
      .in("rcv_compra_id", todosIds)
      .eq("estado", "confirmado");

    // Cargar conciliacion_items que apuntan a estas compras
    const { data: items } = await sb.from("conciliacion_items")
      .select("documento_id")
      .in("documento_id", todosIds)
      .eq("documento_tipo", "rcv_compra");

    const idsConConciliacion = new Set<string>();
    for (const c of (concsCompra || [])) if (c.rcv_compra_id) idsConConciliacion.add(c.rcv_compra_id);
    for (const it of (items || [])) idsConConciliacion.add(it.documento_id);

    // Decidir qué eliminar
    const aEliminar: string[] = [];
    const detalle: { folio: string; rut: string; mantenidos: number; eliminados: number }[] = [];

    for (const [key, arr] of duplicados) {
      const conConc = arr.filter(c => idsConConciliacion.has(c.id));
      const sinConc = arr.filter(c => !idsConConciliacion.has(c.id));

      let aMantener: typeof arr;
      if (conConc.length > 0) {
        // Mantener todos los que tienen conciliación
        aMantener = conConc;
        // Eliminar todos los sin conciliación
        aEliminar.push(...sinConc.map(c => c.id));
      } else {
        // Ninguno tiene conciliación: mantener el más antiguo, eliminar el resto
        const sorted = [...arr].sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
        aMantener = [sorted[0]];
        aEliminar.push(...sorted.slice(1).map(c => c.id));
      }

      const [folio, rut] = key.split("|");
      detalle.push({ folio, rut, mantenidos: aMantener.length, eliminados: arr.length - aMantener.length });
    }

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        grupos_con_duplicados: duplicados.length,
        a_eliminar: aEliminar.length,
        detalle: detalle.slice(0, 50),
      });
    }

    // Eliminar en chunks
    let eliminados = 0;
    for (let i = 0; i < aEliminar.length; i += 100) {
      const chunk = aEliminar.slice(i, i + 100);
      const { error } = await sb.from("rcv_compras").delete().in("id", chunk);
      if (error) return NextResponse.json({ error: error.message, eliminados }, { status: 500 });
      eliminados += chunk.length;
    }

    return NextResponse.json({
      ok: true,
      grupos_con_duplicados: duplicados.length,
      eliminados,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
