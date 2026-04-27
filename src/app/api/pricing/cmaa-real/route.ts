import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/pricing/cmaa-real
 *
 * CMAA = Contribution Margin After Ads. KPI maestro prescrito por
 * Investigacion_Comparada:245 ("CMAA = Precio − COGS − Fees − Ad Spend
 * atribuible") y Investigacion_Comparada:329 ("alert SKU con CMAA <8%
 * durante 60 días entra a revisión de portfolio pruning").
 *
 * Compone:
 *   - margen contributivo (ventas_ml_cache.margen_neto / subtotal)
 *   - ads atribuibles (ml_ads_daily_cache.cost_neto agregado por SKU vía item_id)
 *
 * Devuelve dos vistas:
 *   1. Por cuadrante: medianas y conteo de problemáticos.
 *   2. Top SKUs en CMAA negativo (lista actuable).
 *
 * Ventanas: 30d (operativo) + 60d (alerta de pruning según manual).
 */

type CMAACuadrante = {
  cuadrante: string;
  skus_con_venta: number;
  margen_real_med_pct: number | null;
  tacos_real_med_pct: number | null;
  cmaa_real_med_pct: number | null;
  cmaa_planeado_med_pct: number | null;
  acos_objetivo_pct: number | null;
  skus_cmaa_negativo: number;
  skus_cmaa_bajo_8pct: number;
};

type CMAASku = {
  sku: string;
  cuadrante: string | null;
  gmv_30d: number;
  margen_neto_30d: number;
  margen_real_pct: number;
  ads_30d: number;
  tacos_pct: number;
  cmaa_real_pct: number;
  cmaa_clp: number;
};

const SQL_CUADRANTE = `
WITH ventas_30d AS (
  SELECT v.sku_venta AS sku,
    SUM(v.subtotal) AS gmv,
    SUM(v.margen_neto) AS margen_neto
  FROM ventas_ml_cache v
  WHERE v.fecha::timestamptz >= now() - interval '30 days'
  GROUP BY v.sku_venta
),
items_sku AS (
  SELECT sku, array_agg(item_id) AS item_ids
  FROM ml_margin_cache WHERE status_ml = 'active'
  GROUP BY sku
),
ads_30d AS (
  SELECT i.sku, SUM(a.cost_neto) AS cost_ads
  FROM items_sku i
  JOIN ml_ads_daily_cache a ON a.item_id = ANY(i.item_ids)
  WHERE a.date >= (now() - interval '30 days')::date
  GROUP BY i.sku
),
sku_data AS (
  SELECT
    si.sku_origen AS sku,
    si.cuadrante,
    v.gmv,
    v.margen_neto,
    CASE WHEN v.gmv > 0 THEN v.margen_neto::numeric / v.gmv * 100 END AS margen_real_pct,
    COALESCE(a.cost_ads, 0) AS cost_ads,
    CASE WHEN v.gmv > 0 THEN COALESCE(a.cost_ads,0)::numeric / v.gmv * 100 END AS tacos_pct,
    pcc.acos_objetivo_pct AS acos_obj
  FROM sku_intelligence si
  LEFT JOIN ventas_30d v ON v.sku = si.sku_origen
  LEFT JOIN ads_30d a ON a.sku = si.sku_origen
  LEFT JOIN pricing_cuadrante_config pcc ON pcc.cuadrante = si.cuadrante
  WHERE v.gmv > 0
)
SELECT
  cuadrante,
  COUNT(*)::int AS skus_con_venta,
  ROUND(AVG(margen_real_pct)::numeric, 1)::float AS margen_real_med_pct,
  ROUND(AVG(tacos_pct)::numeric, 1)::float AS tacos_real_med_pct,
  ROUND(AVG(margen_real_pct - tacos_pct)::numeric, 1)::float AS cmaa_real_med_pct,
  ROUND(AVG(margen_real_pct - acos_obj)::numeric, 1)::float AS cmaa_planeado_med_pct,
  ROUND(AVG(acos_obj)::numeric, 1)::float AS acos_objetivo_pct,
  COUNT(*) FILTER (WHERE margen_real_pct - tacos_pct < 0)::int AS skus_cmaa_negativo,
  COUNT(*) FILTER (WHERE margen_real_pct - tacos_pct < 8)::int AS skus_cmaa_bajo_8pct
FROM sku_data
GROUP BY cuadrante
ORDER BY cuadrante;
`;

const SQL_TOP_NEGATIVOS = `
WITH ventas_30d AS (
  SELECT v.sku_venta AS sku, SUM(v.subtotal) AS gmv, SUM(v.margen_neto) AS margen_neto
  FROM ventas_ml_cache v
  WHERE v.fecha::timestamptz >= now() - interval '30 days'
  GROUP BY v.sku_venta
),
items_sku AS (
  SELECT sku, array_agg(item_id) AS item_ids
  FROM ml_margin_cache WHERE status_ml = 'active'
  GROUP BY sku
),
ads_30d AS (
  SELECT i.sku, SUM(a.cost_neto) AS cost_ads
  FROM items_sku i
  JOIN ml_ads_daily_cache a ON a.item_id = ANY(i.item_ids)
  WHERE a.date >= (now() - interval '30 days')::date
  GROUP BY i.sku
)
SELECT
  v.sku,
  si.cuadrante,
  v.gmv::float AS gmv_30d,
  v.margen_neto::float AS margen_neto_30d,
  ROUND((v.margen_neto::numeric / v.gmv * 100), 1)::float AS margen_real_pct,
  COALESCE(a.cost_ads, 0)::float AS ads_30d,
  ROUND((COALESCE(a.cost_ads,0)::numeric / v.gmv * 100), 1)::float AS tacos_pct,
  ROUND(((v.margen_neto - COALESCE(a.cost_ads,0))::numeric / v.gmv * 100), 1)::float AS cmaa_real_pct,
  (v.margen_neto - COALESCE(a.cost_ads, 0))::float AS cmaa_clp
FROM ventas_30d v
LEFT JOIN sku_intelligence si ON si.sku_origen = v.sku
LEFT JOIN ads_30d a ON a.sku = v.sku
WHERE v.gmv > 0
ORDER BY (v.margen_neto - COALESCE(a.cost_ads, 0)) ASC
LIMIT 30;
`;

export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  // Sin RPC exec_sql disponible en este proyecto: ejecutar la composición
  // directamente con SDK supabase, evitando depender de SQL ad-hoc.
  return await fallbackDirectQueries(sb);
}

// SQL_CUADRANTE y SQL_TOP_NEGATIVOS quedan como referencia documental de
// la lógica que implementa fallbackDirectQueries.
void SQL_CUADRANTE;
void SQL_TOP_NEGATIVOS;

async function fallbackDirectQueries(sb: NonNullable<ReturnType<typeof getServerSupabase>>) {
  // Fallback ejecutando los CTEs en TypeScript (sin RPC).
  const since30 = new Date();
  since30.setDate(since30.getDate() - 30);
  const since30Str = since30.toISOString();
  const since30Date = since30Str.slice(0, 10);

  const ventasMap = new Map<string, { gmv: number; margen_neto: number }>();
  let from = 0;
  const chunk = 1000;
  while (true) {
    const { data, error } = await sb
      .from("ventas_ml_cache")
      .select("sku_venta, subtotal, margen_neto, fecha")
      .gte("fecha", since30Str)
      .range(from, from + chunk - 1);
    if (error) {
      console.error(`[cmaa-real] ventas error: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    for (const v of data as Array<{ sku_venta: string; subtotal: number | null; margen_neto: number | null }>) {
      const cur = ventasMap.get(v.sku_venta) || { gmv: 0, margen_neto: 0 };
      cur.gmv += Number(v.subtotal || 0);
      cur.margen_neto += Number(v.margen_neto || 0);
      ventasMap.set(v.sku_venta, cur);
    }
    if (data.length < chunk) break;
    from += chunk;
  }

  const itemsBySku = new Map<string, string[]>();
  {
    const { data } = await sb
      .from("ml_margin_cache")
      .select("sku, item_id, status_ml")
      .eq("status_ml", "active");
    for (const r of (data || []) as Array<{ sku: string; item_id: string }>) {
      const arr = itemsBySku.get(r.sku) || [];
      arr.push(r.item_id);
      itemsBySku.set(r.sku, arr);
    }
  }

  const allItemIds = Array.from(itemsBySku.values()).flat();
  const adsByItem = new Map<string, number>();
  for (let i = 0; i < allItemIds.length; i += 200) {
    const ids = allItemIds.slice(i, i + 200);
    const { data } = await sb
      .from("ml_ads_daily_cache")
      .select("item_id, cost_neto, date")
      .in("item_id", ids)
      .gte("date", since30Date);
    for (const a of (data || []) as Array<{ item_id: string; cost_neto: number | null }>) {
      adsByItem.set(a.item_id, (adsByItem.get(a.item_id) || 0) + Number(a.cost_neto || 0));
    }
  }
  const adsBySku = new Map<string, number>();
  Array.from(itemsBySku.entries()).forEach(([sku, items]) => {
    let s = 0;
    for (const it of items) s += adsByItem.get(it) || 0;
    if (s > 0) adsBySku.set(sku, s);
  });

  const cuadranteBySku = new Map<string, string | null>();
  {
    const { data } = await sb.from("sku_intelligence").select("sku_origen, cuadrante");
    for (const r of (data || []) as Array<{ sku_origen: string; cuadrante: string | null }>) {
      cuadranteBySku.set(r.sku_origen, r.cuadrante);
    }
  }

  const acosObjBycuad = new Map<string, number>();
  {
    const { data } = await sb.from("pricing_cuadrante_config").select("cuadrante, acos_objetivo_pct");
    for (const r of (data || []) as Array<{ cuadrante: string; acos_objetivo_pct: number | null }>) {
      if (r.acos_objetivo_pct != null) acosObjBycuad.set(r.cuadrante, Number(r.acos_objetivo_pct));
    }
  }

  type Row = { sku: string; cuadrante: string | null; gmv: number; margen: number; ads: number; margen_pct: number; tacos_pct: number; cmaa_pct: number; cmaa_clp: number };
  const rows: Row[] = [];
  Array.from(ventasMap.entries()).forEach(([sku, v]) => {
    if (v.gmv <= 0) return;
    const cuad = cuadranteBySku.get(sku) ?? null;
    const ads = adsBySku.get(sku) || 0;
    const margen_pct = (v.margen_neto / v.gmv) * 100;
    const tacos_pct = (ads / v.gmv) * 100;
    const cmaa_pct = margen_pct - tacos_pct;
    const cmaa_clp = v.margen_neto - ads;
    rows.push({ sku, cuadrante: cuad, gmv: v.gmv, margen: v.margen_neto, ads, margen_pct, tacos_pct, cmaa_pct, cmaa_clp });
  });

  // Agregado por cuadrante
  const cuadrantes = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r.cuadrante || "_SIN_CUADRANTE";
    const arr = cuadrantes.get(k);
    if (arr) arr.push(r);
    else cuadrantes.set(k, [r]);
  }
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(xs.length, 1);
  const cuadranteOut: CMAACuadrante[] = [];
  Array.from(cuadrantes.entries()).forEach(([c, rs]) => {
    const acosObj = acosObjBycuad.get(c) ?? null;
    cuadranteOut.push({
      cuadrante: c,
      skus_con_venta: rs.length,
      margen_real_med_pct: Math.round(avg(rs.map((r: Row) => r.margen_pct)) * 10) / 10,
      tacos_real_med_pct: Math.round(avg(rs.map((r: Row) => r.tacos_pct)) * 10) / 10,
      cmaa_real_med_pct: Math.round(avg(rs.map((r: Row) => r.cmaa_pct)) * 10) / 10,
      cmaa_planeado_med_pct: acosObj != null ? Math.round(avg(rs.map((r: Row) => r.margen_pct - acosObj)) * 10) / 10 : null,
      acos_objetivo_pct: acosObj,
      skus_cmaa_negativo: rs.filter((r: Row) => r.cmaa_pct < 0).length,
      skus_cmaa_bajo_8pct: rs.filter((r: Row) => r.cmaa_pct < 8).length,
    });
  });
  cuadranteOut.sort((a, b) => a.cuadrante.localeCompare(b.cuadrante));

  // Top 30 negativos
  const topOut: CMAASku[] = rows
    .sort((a, b) => a.cmaa_clp - b.cmaa_clp)
    .slice(0, 30)
    .map((r) => ({
      sku: r.sku,
      cuadrante: r.cuadrante,
      gmv_30d: Math.round(r.gmv),
      margen_neto_30d: Math.round(r.margen),
      margen_real_pct: Math.round(r.margen_pct * 10) / 10,
      ads_30d: Math.round(r.ads),
      tacos_pct: Math.round(r.tacos_pct * 10) / 10,
      cmaa_real_pct: Math.round(r.cmaa_pct * 10) / 10,
      cmaa_clp: Math.round(r.cmaa_clp),
    }));

  return NextResponse.json({ ok: true, cuadrante: cuadranteOut, top_negativos: topOut });
}
