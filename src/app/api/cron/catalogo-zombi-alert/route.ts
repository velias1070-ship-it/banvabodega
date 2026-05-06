import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { enqueueNotification } from "@/lib/notifications";

export const maxDuration = 30;

/**
 * Cron diario preventivo (Acción A — derivado de la investigación 2026-05-06).
 *
 * Detecta SKUs con catálogo principal zombi (precio_neto=0 o NULL) cuyo
 * producto está activo y vendiendo (uds_30d > 0). Estos son los SKUs que
 * van a generar disc del bucket A (81% del problema histórico) en la
 * próxima recepción.
 *
 * Notifica a Vicente vía WhatsApp para que actualice el catálogo ANTES
 * de que aparezcan disc retroactivas.
 *
 * GET ?dry_run=1 → no envía WhatsApp, solo retorna lista.
 *
 * Schedule: 09:00 UTC diario (vercel.json).
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const dryRun = req.nextUrl.searchParams.get("dry_run") === "1";

  // Query: SKUs con catálogo zombi pero ventas activas
  const { data: zombi, error } = await sb.rpc("catalogo_zombi_skus_activos");
  if (error) {
    // Fallback si la RPC no existe — query directa
    const { data: prods } = await sb.from("productos")
      .select("sku, costo_promedio")
      .eq("activo", true);
    const skus = (prods || []).map(p => (p as { sku: string }).sku);
    if (skus.length === 0) {
      return NextResponse.json({ scanned: 0, zombi_skus: [], notified: false });
    }

    const [{ data: catRows }, { data: intelRows }] = await Promise.all([
      sb.from("proveedor_catalogo")
        .select("sku_origen, precio_neto, proveedor")
        .eq("es_principal", true)
        .in("sku_origen", skus),
      sb.from("sku_intelligence")
        .select("sku_origen, abc, uds_30d")
        .in("sku_origen", skus),
    ]);
    const catalogoMap = new Map<string, { precio: number; proveedor: string | null }>();
    for (const r of (catRows || []) as Array<{ sku_origen: string; precio_neto: number; proveedor: string | null }>) {
      catalogoMap.set(r.sku_origen, { precio: r.precio_neto || 0, proveedor: r.proveedor });
    }
    const intelMap = new Map<string, { abc: string | null; uds_30d: number | null }>();
    for (const r of (intelRows || []) as Array<{ sku_origen: string; abc: string | null; uds_30d: number | null }>) {
      intelMap.set(r.sku_origen, { abc: r.abc, uds_30d: r.uds_30d });
    }

    type ZombieRow = { sku: string; abc: string | null; uds_30d: number; proveedor: string | null };
    const zombiList: ZombieRow[] = [];
    for (const p of (prods || []) as Array<{ sku: string }>) {
      const cat = catalogoMap.get(p.sku);
      const intel = intelMap.get(p.sku);
      const precioCat = cat?.precio ?? 0;
      const uds30 = intel?.uds_30d ?? 0;
      // Zombi: SIN catálogo o precio<=0, Y vendiendo en últimos 30d
      if ((!cat || precioCat <= 0) && uds30 > 0) {
        zombiList.push({
          sku: p.sku, abc: intel?.abc ?? null, uds_30d: uds30,
          proveedor: cat?.proveedor || null,
        });
      }
    }
    zombiList.sort((a, b) => b.uds_30d - a.uds_30d);

    let notified = false;
    if (!dryRun && zombiList.length > 0) {
      const lines = [
        `⚠️ Catálogo zombi: ${zombiList.length} SKU${zombiList.length === 1 ? "" : "s"} sin precio acordado pero vendiendo`,
      ];
      const top = zombiList.slice(0, 5);
      for (const z of top) {
        lines.push(`· ${z.sku}${z.abc ? ` [${z.abc}]` : ""} — ${z.uds_30d} uds/30d${z.proveedor ? ` (${z.proveedor})` : ""}`);
      }
      if (zombiList.length > 5) lines.push(`… y ${zombiList.length - 5} más`);
      lines.push("Acción: actualizar precios en /admin → Compras → Cargar Catálogo antes de la próxima recepción.");
      const res = await enqueueNotification("whatsapp", "56991655931@s.whatsapp.net", {
        text: lines.join("\n"),
      });
      notified = res.ok;
    }

    if (!dryRun) {
      await sb.from("audit_log").insert({
        accion: "cron_catalogo_zombi_alert",
        entidad: "proveedor_catalogo",
        entidad_id: null,
        operario: "cron",
        params: { scanned: skus.length, dry_run: false },
        resultado: { zombi_count: zombiList.length, notified },
      });
    }

    return NextResponse.json({
      scanned: skus.length,
      zombi_count: zombiList.length,
      zombi_skus: zombiList.slice(0, 50),
      notified,
      dry_run: dryRun,
    });
  }

  // Si la RPC existió y devolvió data
  return NextResponse.json({ via: "rpc", data: zombi });
}
