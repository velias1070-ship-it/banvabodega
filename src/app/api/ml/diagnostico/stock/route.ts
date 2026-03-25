import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { getDistributedStock, getItemUserProductId, mlGet } from "@/lib/ml";

/**
 * GET /api/ml/diagnostico/stock?sku=XXX  o  ?item_id=MLC123  o  ?user_product_id=MLCU123
 *
 * Consulta el stock distribuido de un producto en ML.
 * Muestra stock por tipo de depósito (selling_address, meli_facility, etc.)
 * junto con el stock registrado en el WMS para comparar.
 */
export async function GET(req: NextRequest) {
  const sku = req.nextUrl.searchParams.get("sku");
  const itemId = req.nextUrl.searchParams.get("item_id");
  const upId = req.nextUrl.searchParams.get("user_product_id");

  if (!sku && !itemId && !upId) {
    return NextResponse.json({
      error: "Pasar ?sku=XXX o ?item_id=MLC123 o ?user_product_id=MLCU123",
      ejemplo: "/api/ml/diagnostico/stock?sku=MI-SKU-001",
    }, { status: 400 });
  }

  try {
    const sb = getServerSupabase();
    let userProductId = upId;
    let resolvedItemId = itemId;
    let mapInfo: Record<string, unknown> | null = null;

    // 1. Si viene SKU, buscar en ml_items_map
    if (sku && sb) {
      const { data: maps } = await sb.from("ml_items_map")
        .select("*")
        .eq("sku", sku.toUpperCase())
        .eq("activo", true);

      if (!maps || maps.length === 0) {
        return NextResponse.json({
          error: `SKU "${sku}" no encontrado en ml_items_map (o no está activo)`,
          sugerencia: "Verificar que el SKU existe en la tabla ml_items_map con activo=true",
        });
      }

      mapInfo = maps[0];
      resolvedItemId = maps[0].item_id;
      userProductId = maps[0].user_product_id || null;
    }

    // 2. Si tenemos item_id pero no user_product_id, resolverlo
    if (resolvedItemId && !userProductId) {
      userProductId = await getItemUserProductId(resolvedItemId);
      if (!userProductId) {
        return NextResponse.json({
          error: `No se pudo resolver user_product_id para item ${resolvedItemId}`,
          item_id: resolvedItemId,
          ml_items_map: mapInfo,
        });
      }
    }

    if (!userProductId) {
      return NextResponse.json({ error: "No se pudo determinar user_product_id" });
    }

    // 3. Consultar stock distribuido en ML
    const stockML = await getDistributedStock(userProductId);

    // 4. Consultar stock en WMS para comparar
    let stockWMS: { posicion_id: string; cantidad: number }[] = [];
    let stockComprometido = 0;
    const skuBuscar = sku?.toUpperCase() || (mapInfo as { sku?: string })?.sku;

    if (sb && skuBuscar) {
      const { data: stockRows } = await sb.from("stock")
        .select("posicion_id, cantidad")
        .eq("sku", skuBuscar);
      stockWMS = stockRows || [];

      // Get committed from v_stock_disponible
      const { data: dispRow } = await sb.from("v_stock_disponible")
        .select("reserved").eq("sku", skuBuscar).maybeSingle();
      stockComprometido = (dispRow as { reserved: number } | null)?.reserved ?? 0;
    }

    const totalWMS = stockWMS.reduce((s, r) => s + r.cantidad, 0);
    const disponibleWMS = Math.max(0, totalWMS - stockComprometido);

    // 5. Parsear locations de ML
    const mlLocations = (stockML?.locations || []).map((loc: { type: string; quantity: number }) => ({
      tipo: loc.type,
      cantidad: loc.quantity,
      descripcion: loc.type === "selling_address" ? "Tu bodega (Flex)"
        : loc.type === "meli_facility" ? "Bodega ML Colina (Full)"
        : loc.type === "seller_warehouse" ? "Multi-origen"
        : loc.type,
    }));

    const stockFlex = mlLocations.find((l: { tipo: string }) => l.tipo === "selling_address")?.cantidad ?? null;
    const stockFull = mlLocations.find((l: { tipo: string }) => l.tipo === "meli_facility")?.cantidad ?? null;

    return NextResponse.json({
      ok: true,
      consulta: { sku: skuBuscar, item_id: resolvedItemId, user_product_id: userProductId },
      ml: {
        locations: mlLocations,
        stock_flex: stockFlex,
        stock_full: stockFull,
        total_visible: (stockFlex || 0) + (stockFull || 0),
        version: stockML?.version,
      },
      wms: {
        stock_total: totalWMS,
        stock_comprometido: stockComprometido,
        disponible: disponibleWMS,
        posiciones: stockWMS,
      },
      comparacion: {
        flex_ml_vs_wms: stockFlex !== null ? {
          ml: stockFlex,
          wms_disponible: disponibleWMS,
          diferencia: stockFlex - disponibleWMS,
          sincronizado: stockFlex === disponibleWMS,
        } : "Sin stock Flex en ML",
      },
      ml_items_map: mapInfo,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
