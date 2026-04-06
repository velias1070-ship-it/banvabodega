import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

// Atributos que queremos vigilar
const WATCHED_ATTRS = ["COLOR", "SIZE", "BRAND", "MODEL", "LINE", "SELLER_SKU"];

interface MLItemMultiget {
  code: number;
  body: {
    id: string;
    title: string;
    status: string;
    attributes: Array<{ id: string; name: string; value_name: string | null }>;
  } | null;
}

/**
 * GET /api/ml/attr-watch
 * Compara atributos actuales de items ML con snapshot guardado.
 * Detecta cambios y los registra en ml_item_changes.
 * Primera ejecución: crea snapshot base.
 *
 * ?run=true para ejecutar manualmente
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isLocalDev = process.env.NODE_ENV === "development";
  const hasParams = req.nextUrl.searchParams.has("run");

  if (!isVercelCron && !isLocalDev && !hasParams) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  try {
    // 1. Obtener todos los item_ids activos
    const { data: items } = await sb.from("ml_items_map")
      .select("item_id")
      .eq("activo", true);

    if (!items || items.length === 0) {
      return NextResponse.json({ status: "ok", message: "no active items" });
    }

    const uniqueIds = Array.from(new Set((items as { item_id: string }[]).map(i => i.item_id)));

    // 2. Obtener snapshot actual de la DB
    const { data: snapshots } = await sb.from("ml_item_attr_snapshot").select("item_id, attr_id, attr_value");
    const snapshotMap = new Map<string, string>();
    for (const s of (snapshots || [])) {
      snapshotMap.set(`${s.item_id}:${s.attr_id}`, s.attr_value || "");
    }
    const isFirstRun = snapshotMap.size === 0;

    // 3. Fetch items en batches de 20
    let checked = 0;
    let changes = 0;
    let newSnapshots = 0;
    const changesList: Array<{ item_id: string; titulo: string; attr_id: string; valor_anterior: string; valor_nuevo: string }> = [];

    for (let i = 0; i < uniqueIds.length; i += 20) {
      const batch = uniqueIds.slice(i, i + 20);
      const multiResult = await mlGet<MLItemMultiget[]>(
        `/items?ids=${batch.join(",")}&attributes=id,title,status,attributes`
      );

      if (!multiResult || !Array.isArray(multiResult)) continue;

      for (const wrapper of multiResult) {
        if (wrapper.code !== 200 || !wrapper.body) continue;
        const item = wrapper.body;
        checked++;

        for (const attr of (item.attributes || [])) {
          if (!WATCHED_ATTRS.includes(attr.id)) continue;
          const key = `${item.id}:${attr.id}`;
          const currentVal = attr.value_name || "";
          const prevVal = snapshotMap.get(key);

          if (prevVal === undefined) {
            // Nuevo snapshot
            newSnapshots++;
          } else if (prevVal !== currentVal) {
            // Cambio detectado
            changes++;
            changesList.push({
              item_id: item.id,
              titulo: item.title,
              attr_id: attr.id,
              valor_anterior: prevVal,
              valor_nuevo: currentVal,
            });
            console.log(`[AttrWatch] CAMBIO: ${item.id} ${attr.id}: "${prevVal}" → "${currentVal}" (${item.title})`);
          }

          // Upsert snapshot
          await sb.from("ml_item_attr_snapshot").upsert({
            item_id: item.id,
            attr_id: attr.id,
            attr_value: currentVal,
            snapshot_at: new Date().toISOString(),
          }, { onConflict: "item_id,attr_id" });
        }
      }

      if (i + 20 < uniqueIds.length) await new Promise(r => setTimeout(r, 200));
    }

    // 4. Guardar cambios detectados
    if (changesList.length > 0) {
      await sb.from("ml_item_changes").insert(
        changesList.map(c => ({
          item_id: c.item_id,
          titulo: c.titulo,
          attr_id: c.attr_id,
          valor_anterior: c.valor_anterior,
          valor_nuevo: c.valor_nuevo,
          detected_at: new Date().toISOString(),
        }))
      );
    }

    const msg = isFirstRun
      ? `Snapshot base creado: ${checked} items, ${newSnapshots} atributos guardados`
      : `${checked} items verificados, ${changes} cambios detectados, ${newSnapshots} atributos nuevos`;

    console.log(`[AttrWatch] ${msg}`);
    return NextResponse.json({
      status: "ok",
      first_run: isFirstRun,
      checked,
      changes,
      new_snapshots: newSnapshots,
      changes_detail: changesList,
    });
  } catch (err) {
    console.error("[AttrWatch] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
