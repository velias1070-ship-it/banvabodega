import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/ml/investigate?item_id=MLC...
 * Investiga quién modificó un item: apps conectadas, historial, variantes actuales
 *
 * GET /api/ml/investigate?search=multicolor
 * Busca items que contengan "multicolor" en variantes
 *
 * GET /api/ml/investigate?audit=true&fecha=2026-04-03
 * Busca en audit_log cambios del día indicado
 *
 * GET /api/ml/investigate?apps=true
 * Lista apps con acceso a la cuenta
 */

interface MLItemFull {
  id: string;
  title: string;
  status: string;
  last_updated: string;
  date_created: string;
  variations?: Array<{
    id: number;
    attribute_combinations: Array<{ id: string; name: string; value_name: string }>;
    available_quantity: number;
  }>;
  attributes?: Array<{ id: string; name: string; value_name: string }>;
  pictures?: Array<{ id: string; url: string }>;
  tags?: string[];
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const itemId = url.searchParams.get("item_id");
  const searchTerm = url.searchParams.get("search");
  const showApps = url.searchParams.get("apps");
  const showAudit = url.searchParams.get("audit");
  const fecha = url.searchParams.get("fecha") || "2026-04-03";

  const results: Record<string, unknown> = {};

  try {
    // 1. Apps conectadas a la cuenta
    if (showApps) {
      const me = await mlGet<{ id: number; nickname: string }>("/users/me");
      if (me) {
        results.user = { id: me.id, nickname: me.nickname };
        // Listar aplicaciones con acceso
        const apps = await mlGet<Array<{ app_id: string; scopes: string[] }>>(`/users/${me.id}/applications`);
        results.connected_apps = apps;
        // También ver permisos de la app actual
        const myApp = await mlGet<{ id: number; name: string; short_name: string }>("/applications/me");
        results.my_app = myApp;
      }
    }

    // 2. Detalle de un item específico
    if (itemId) {
      const item = await mlGet<MLItemFull>(`/items/${itemId}`);
      results.item = item ? {
        id: item.id,
        title: item.title,
        status: item.status,
        last_updated: item.last_updated,
        date_created: item.date_created,
        tags: item.tags,
        variations: item.variations?.map(v => ({
          id: v.id,
          attributes: v.attribute_combinations,
          available_quantity: v.available_quantity,
        })),
        attributes: item.attributes?.filter(a =>
          ["COLOR", "SIZE", "SELLER_SKU", "BRAND"].includes(a.id?.toUpperCase() || "")
        ),
      } : null;

      // Descripción del item
      const desc = await mlGet<{ plain_text: string }>(`/items/${itemId}/description`);
      results.description_length = desc?.plain_text?.length || 0;

      // Visitas recientes (puede mostrar actividad)
      const visits = await mlGet<{ total_visits: number }>(`/items/${itemId}/visits/time_window?last=30&unit=days`);
      results.visits_30d = visits?.total_visits;
    }

    // 3. Buscar items con variantes que contengan un término
    if (searchTerm) {
      const sb = getServerSupabase();
      if (sb) {
        // Buscar en ml_items_map por título
        const { data: maps } = await sb.from("ml_items_map")
          .select("sku, item_id, titulo, price, status_ml, updated_at")
          .or(`titulo.ilike.%${searchTerm}%,sku.ilike.%${searchTerm}%`)
          .limit(20);
        results.local_matches = maps;

        // Para cada match, consultar variantes en ML
        if (maps && maps.length > 0) {
          const itemDetails = [];
          for (const m of maps.slice(0, 5)) {
            const item = await mlGet<MLItemFull>(`/items/${m.item_id}`);
            if (item) {
              itemDetails.push({
                item_id: item.id,
                title: item.title,
                last_updated: item.last_updated,
                variations: item.variations?.map(v => ({
                  id: v.id,
                  attributes: v.attribute_combinations,
                })),
              });
            }
          }
          results.ml_item_details = itemDetails;
        }
      }

      // También buscar directamente en ML
      const me = await mlGet<{ id: number }>("/users/me");
      if (me) {
        const mlSearch = await mlGet<{ results: Array<{ id: string; title: string }> }>(
          `/users/${me.id}/items/search?search_type=scan&q=${encodeURIComponent(searchTerm)}&limit=10`
        );
        results.ml_search = mlSearch?.results;
      }
    }

    // 4. Audit log del día
    if (showAudit) {
      const sb = getServerSupabase();
      if (sb) {
        const desde = `${fecha}T00:00:00`;
        const hasta = `${fecha}T23:59:59`;
        const { data: audits } = await sb.from("audit_log")
          .select("*")
          .gte("created_at", desde)
          .lte("created_at", hasta)
          .order("created_at", { ascending: false })
          .limit(100);
        results.audit_log = audits;

        // También sync_log
        const { data: syncs } = await sb.from("sync_log")
          .select("*")
          .gte("synced_at", desde)
          .lte("synced_at", hasta)
          .order("synced_at", { ascending: false })
          .limit(50);
        results.sync_log = syncs;
      }
    }

    return NextResponse.json(results);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
