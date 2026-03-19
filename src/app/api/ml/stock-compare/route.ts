import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { diagnoseToken, getDistributedStock, getDistributedStockDiagnostic, getItemUserProductId, getSellerStockType, updateFlexStock } from "@/lib/ml";

interface CompareRow {
  sku: string;
  item_id: string;
  user_product_id: string | null;
  stock_wms: number;
  stock_flex_ml: number;
  stock_full_ml: number;
  ultimo_sync: string | null;
  cache_updated_at: string | null;
}

/**
 * GET — Compare WMS stock vs ML stock.
 *
 * ?phase=wms     → INSTANT: WMS data + cached ML stock from DB (no ML API calls)
 * ?phase=ml&skus=SKU1,SKU2,...  → fetch live ML stock for specific SKUs, save to cache
 * (no phase)     → legacy: does everything in one call (may timeout)
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const phase = req.nextUrl.searchParams.get("phase");
  const skusParam = req.nextUrl.searchParams.get("skus");

  try {
    // ── Phase ML batch: fetch live ML stock for specific SKUs + save to cache ──
    if (phase === "ml" && skusParam) {
      const targetSkus = skusParam.split(",").filter(Boolean);
      if (targetSkus.length === 0) return NextResponse.json({ results: {} });

      const { data: mappings } = await sb.from("ml_items_map")
        .select("*")
        .in("sku", targetSkus)
        .eq("activo", true);

      if (!mappings || mappings.length === 0) {
        return NextResponse.json({ results: {} });
      }

      const results: Record<string, { flex: number; full: number; upId: string | null; error?: string }> = {};

      // Resolve missing user_product_ids
      for (const map of mappings) {
        if (!map.user_product_id) {
          try {
            const upId = await getItemUserProductId(map.item_id);
            if (upId) {
              map.user_product_id = upId;
              await sb.from("ml_items_map").update({ user_product_id: upId }).eq("id", map.id);
            }
          } catch { /* ignore */ }
        }
      }

      // Fetch ML stock in parallel
      await Promise.all(mappings.map(async (map) => {
        const upId = map.user_product_id;
        if (!upId) {
          results[map.sku] = { flex: 0, full: 0, upId: null, error: `Sin user_product_id` };
          return;
        }

        try {
          const result = await getDistributedStockDiagnostic(upId);
          if (result.stock) {
            let flex = 0, full = 0;
            for (const loc of result.stock.locations) {
              if (loc.type === "selling_address") flex = loc.quantity;
              // seller_warehouse = stock multi-origen, NO es Flex
              if (loc.type === "meli_facility") full = loc.quantity;
            }
            results[map.sku] = { flex, full, upId };

            // Guardar en cache para que la próxima carga sea instantánea
            await sb.from("ml_items_map").update({
              stock_flex_cache: flex,
              stock_full_cache: full,
              cache_updated_at: new Date().toISOString(),
            }).eq("id", map.id);
          } else {
            results[map.sku] = { flex: 0, full: 0, upId, error: result.error };
          }
        } catch (err) {
          results[map.sku] = { flex: 0, full: 0, upId, error: String(err) };
        }
      }));

      return NextResponse.json({ results });
    }

    // ── Fetch all mappings + WMS stock (shared by wms phase and legacy) ──
    const { data: mappings } = await sb.from("ml_items_map")
      .select("*")
      .eq("activo", true)
      .order("sku");

    if (!mappings || mappings.length === 0) {
      return NextResponse.json({ rows: [], message: "No hay SKUs mapeados a ML" });
    }

    const skus = Array.from(new Set(mappings.map((m: { sku: string }) => m.sku)));
    const { data: stockRows } = await sb.from("stock").select("sku, cantidad").in("sku", skus);
    const wmsStock: Record<string, number> = {};
    for (const r of stockRows || []) {
      wmsStock[r.sku] = (wmsStock[r.sku] || 0) + r.cantidad;
    }

    // ── Phase WMS: return INSTANTLY with cached ML data from DB ──
    if (phase === "wms") {
      const rows: CompareRow[] = mappings.map((map) => ({
        sku: map.sku,
        item_id: map.item_id,
        user_product_id: map.user_product_id || null,
        stock_wms: wmsStock[map.sku] || 0,
        // Usar cache si existe, sino -1 (no data)
        stock_flex_ml: map.stock_flex_cache ?? -1,
        stock_full_ml: map.stock_full_cache ?? 0,
        ultimo_sync: map.ultimo_sync || null,
        cache_updated_at: map.cache_updated_at || null,
      }));
      return NextResponse.json({ rows, phase: "wms" });
    }

    // ── Legacy (no phase): full fetch — may timeout with many SKUs ──
    const diagnostics: string[] = [];
    const needsResolution = mappings.filter((m: { user_product_id: string | null }) => !m.user_product_id);
    if (needsResolution.length > 0) {
      const RESOLVE_BATCH = 5;
      for (let i = 0; i < needsResolution.length; i += RESOLVE_BATCH) {
        const batch = needsResolution.slice(i, i + RESOLVE_BATCH);
        await Promise.all(batch.map(async (map) => {
          try {
            const upId = await getItemUserProductId(map.item_id);
            if (upId) {
              map.user_product_id = upId;
              await sb.from("ml_items_map").update({ user_product_id: upId }).eq("id", map.id);
            }
          } catch { /* ignore */ }
        }));
      }
    }

    const BATCH_SIZE = 5;
    type MlResult = { sku: string; flexQty: number; fullQty: number; upId: string | null; error?: string };
    const mlResults: MlResult[] = [];
    let firstError: string | null = null;

    for (let i = 0; i < mappings.length; i += BATCH_SIZE) {
      const batch = mappings.slice(i, i + BATCH_SIZE);
      const promises = batch.map(async (map): Promise<MlResult> => {
        const upId = map.user_product_id;
        if (!upId) return { sku: map.sku, flexQty: 0, fullQty: 0, upId: null };
        try {
          const result = await getDistributedStockDiagnostic(upId);
          if (result.stock) {
            let flexQty = 0, fullQty = 0;
            for (const loc of result.stock.locations) {
              if (loc.type === "selling_address") flexQty = loc.quantity;
              // seller_warehouse = stock multi-origen, NO es Flex
              if (loc.type === "meli_facility") fullQty = loc.quantity;
            }
            // Save to cache
            await sb.from("ml_items_map").update({
              stock_flex_cache: flexQty,
              stock_full_cache: fullQty,
              cache_updated_at: new Date().toISOString(),
            }).eq("id", map.id);
            return { sku: map.sku, flexQty, fullQty, upId };
          } else {
            return { sku: map.sku, flexQty: 0, fullQty: 0, upId, error: result.error };
          }
        } catch (err) {
          return { sku: map.sku, flexQty: 0, fullQty: 0, upId, error: String(err) };
        }
      });
      const batchResults = await Promise.all(promises);
      mlResults.push(...batchResults);

      if (i === 0) {
        const errors = batchResults.filter(r => r.error);
        if (errors.length === batchResults.length && batchResults.length > 0) {
          firstError = errors[0].error || "error desconocido";
          for (let j = i + BATCH_SIZE; j < mappings.length; j++) {
            const m = mappings[j];
            mlResults.push({ sku: m.sku, flexQty: 0, fullQty: 0, upId: m.user_product_id || null, error: firstError });
          }
          break;
        }
      }
    }

    const rows: CompareRow[] = mappings.map((map, idx) => {
      const ml = mlResults[idx];
      if (ml?.error && (!firstError || idx < BATCH_SIZE)) {
        diagnostics.push(`${map.sku}: ${ml.error}`);
      }
      return {
        sku: map.sku,
        item_id: map.item_id,
        user_product_id: ml?.upId || map.user_product_id || null,
        stock_wms: wmsStock[map.sku] || 0,
        stock_flex_ml: ml?.flexQty || 0,
        stock_full_ml: ml?.fullQty || 0,
        ultimo_sync: map.ultimo_sync || null,
        cache_updated_at: map.cache_updated_at || null,
      };
    });

    if (firstError) {
      const tokenDiag = await diagnoseToken();
      diagnostics.unshift(`Todas las consultas fallaron: ${firstError}`);
      diagnostics.unshift(`Estado del token: ${tokenDiag}`);
    }

    return NextResponse.json({ rows, phase: "ml", diagnostics: diagnostics.length > 0 ? diagnostics : undefined });
  } catch (err) {
    console.error("[Stock Compare] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * POST — Sync specific SKUs immediately with detailed diagnostics.
 * Body: { skus: string[], quantities?: Record<string, number>, force?: boolean }
 * force=true bypasses the safety block (stock >10 → 0).
 */
export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  try {
    const body = await req.json();
    const skus: string[] = body.skus || [];
    const overrides: Record<string, number> | undefined = body.quantities;
    const force: boolean = body.force === true;

    if (skus.length === 0) {
      return NextResponse.json({ error: "no_skus" }, { status: 400 });
    }

    let synced = 0;
    const results: Record<string, { ok: boolean; reason: string; qty?: number }> = {};

    for (let idx = 0; idx < skus.length; idx++) {
      const sku = skus[idx];
      if (idx > 0) await new Promise(r => setTimeout(r, 1000));
      try {
        const { data: mappings } = await sb.from("ml_items_map")
          .select("*")
          .eq("sku", sku)
          .eq("activo", true);

        if (!mappings || mappings.length === 0) {
          results[sku] = { ok: false, reason: "Sin mapeo en ml_items_map" };
          continue;
        }

        let available: number;
        if (overrides && overrides[sku] !== undefined) {
          available = Math.max(0, overrides[sku]);
        } else {
          const { data: stockRows } = await sb.from("stock").select("cantidad").eq("sku", sku);
          const totalStock = (stockRows || []).reduce((s: number, r: { cantidad: number }) => s + r.cantidad, 0);
          // Calculate committed from active shipments (ml_shipments + ml_shipment_items)
          const { data: activeShipments } = await sb.from("ml_shipments").select("shipment_id")
            .neq("logistic_type", "fulfillment")
            .in("status", ["ready_to_ship", "pending"]);
          let committed = 0;
          if (activeShipments && activeShipments.length > 0) {
            const sids = (activeShipments as { shipment_id: number }[]).map(s => s.shipment_id);
            const { data: commitItems } = await sb.from("ml_shipment_items").select("quantity")
              .in("shipment_id", sids).eq("seller_sku", sku);
            committed = (commitItems || []).reduce((s: number, i: { quantity: number }) => s + i.quantity, 0);
          }
          available = Math.max(0, totalStock - committed);
        }

        let skuSynced = false;
        const skuErrors: string[] = [];

        for (const map of mappings) {
          if (!force && available === 0 && map.stock_flex_cache && map.stock_flex_cache > 10) {
            skuErrors.push(`Safety block: último stock Flex fue ${map.stock_flex_cache}, ahora sería 0. Usa 'Forzar' para confirmar.`);
            continue;
          }

          let userProductId = map.user_product_id;
          if (!userProductId) {
            userProductId = await getItemUserProductId(map.item_id);
            if (!userProductId) {
              skuErrors.push(`No se pudo resolver user_product_id para item ${map.item_id}`);
              continue;
            }
            await sb.from("ml_items_map").update({ user_product_id: userProductId }).eq("id", map.id);
          }

          const stockData = await getDistributedStock(userProductId);
          if (!stockData) {
            skuErrors.push(`No se pudo leer stock de ML para ${userProductId}`);
            continue;
          }

          const stockType = getSellerStockType(stockData.locations);
          if (!stockType) {
            const locationTypes = stockData.locations.map(l => l.type).join(", ") || "ninguna";
            skuErrors.push(`${userProductId} solo tiene locations de ML: ${locationTypes}. No se puede escribir stock.`);
            continue;
          }

          let result = await updateFlexStock(userProductId, available, stockData.version, stockType, stockData.locations);

          if (!result.ok && result.error === "VERSION_CONFLICT") {
            const freshStock = await getDistributedStock(userProductId);
            if (freshStock) {
              result = await updateFlexStock(userProductId, available, freshStock.version, stockType, freshStock.locations);
            }
          }

          if (result.ok) {
            // Actualizar sync info + cache al mismo tiempo
            await sb.from("ml_items_map").update({
              ultimo_sync: new Date().toISOString(),
              stock_flex_cache: available,
              stock_version: (stockData.version || 0) + 1,
              cache_updated_at: new Date().toISOString(),
            }).eq("id", map.id);
            skuSynced = true;
          } else {
            skuErrors.push(`PUT falló para ${userProductId}: ${result.error || "error desconocido"}`);
          }
        }

        if (skuSynced) {
          synced++;
          results[sku] = { ok: true, reason: "OK", qty: available };
        } else {
          results[sku] = { ok: false, reason: skuErrors.join("; ") || "Error desconocido" };
        }
      } catch (err) {
        results[sku] = { ok: false, reason: String(err) };
      }
    }

    const syncedSkus = Object.entries(results).filter(([, r]) => r.ok).map(([sku]) => sku);
    if (syncedSkus.length > 0) {
      await sb.from("stock_sync_queue").delete().in("sku", syncedSkus);
    }

    return NextResponse.json({ synced, total: skus.length, results });
  } catch (err) {
    console.error("[Stock Compare POST] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
