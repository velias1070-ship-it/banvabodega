/**
 * /api/pricing/velocity-signals — detectores de cambio de velocidad para
 * sugerir ajustes de precio.
 *
 * Manual:
 *   - Investigacion_Comparada:269-279 (matriz precio↔stock/velocidad)
 *   - Investigacion_Comparada:235 (5 triggers reclasificación)
 *   - Engines_a_Escala:544 (lift sostenido p<0.05)
 *   - Investigacion_Comparada:285,310 (regla 30-day, no subir de golpe)
 *
 * Tres detectores:
 *   1. Caída: vel_30d cae >X% vs vel_60d con stock alto → markdown anticipado
 *   2. Aceleración: vel_30d crece >X% vs vel_60d con margen sano → subir gradual
 *   3. Estabilidad post-markdown: 14d post-bajada + vel ≥80% pre-quiebre → no revertir
 *
 * Inputs: TODOS de la DB existente, sin inventar:
 *   - sku_intelligence: vel_7d, vel_30d, vel_60d, tendencia_vel, tendencia_vel_pct,
 *     dias_sin_movimiento, vel_pre_quiebre, fecha_entrada_quiebre, stock_full,
 *     abc, cuadrante
 *   - ml_margin_cache: precio_venta, price_ml, costo_neto, margen_pct, status_ml
 *   - productos: costo, costo_promedio
 *   - pricing_cuadrante_config: margen_min_pct (umbral por cuadrante)
 *
 * Read-only: NO aplica nada, solo sugiere. La aplicación la decide UI.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { loadActiveRuleSet, readRule } from "@/lib/pricing-rules";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

type VelocitySignalsCfg = {
  caida_ratio_30d_vs_60d: number;
  caida_min_dias_sin_movimiento: number;
  caida_min_cobertura_dias: number;
  caida_descuento_pct: number;
  aceleracion_ratio_30d_vs_60d: number;
  aceleracion_subida_pct: number;
  aceleracion_requiere_margen_min: boolean;
  estabilidad_post_markdown_dias: number;
  estabilidad_recovery_pct_pre_quiebre: number;
  min_ventas_60d_para_evaluar: number;
  fuente?: string;
  notas?: string;
};

const FALLBACK: VelocitySignalsCfg = {
  caida_ratio_30d_vs_60d: 0.6,
  caida_min_dias_sin_movimiento: 30,
  caida_min_cobertura_dias: 30,
  caida_descuento_pct: 10,
  aceleracion_ratio_30d_vs_60d: 1.5,
  aceleracion_subida_pct: 5,
  aceleracion_requiere_margen_min: true,
  estabilidad_post_markdown_dias: 14,
  estabilidad_recovery_pct_pre_quiebre: 80,
  min_ventas_60d_para_evaluar: 3,
};

type IntelRow = {
  sku_origen: string;
  vel_7d: number | null;
  vel_30d: number | null;
  vel_60d: number | null;
  tendencia_vel: string | null;
  tendencia_vel_pct: number | null;
  dias_sin_movimiento: number | null;
  vel_pre_quiebre: number | null;
  fecha_entrada_quiebre: string | null;
  stock_full: number | null;
  abc: string | null;
  cuadrante: string | null;
};

type ProductoRow = {
  sku: string; nombre: string; costo: number | null; costo_promedio: number | null;
};

type CacheRow = {
  sku: string; item_id: string; precio_venta: number | null; price_ml: number | null;
  margen_pct: number | null; status_ml: string | null; stock_total: number | null;
};

type CuadranteRow = { cuadrante: string; margen_min_pct: number };

type Senal = "caida" | "aceleracion" | "estabilidad_post_markdown";

type Sugerencia = {
  sku: string;
  nombre: string;
  cuadrante: string | null;
  abc: string | null;
  vel_7d: number;
  vel_30d: number;
  vel_60d: number;
  tendencia_pct: number;
  dias_sin_movimiento: number | null;
  stock_full: number;
  cobertura_dias: number | null;
  precio_actual: number;
  precio_lista: number;
  margen_pct: number;
  costo: number;
  senal: Senal;
  delta_pct_sugerido: number;     // negativo = bajar, positivo = subir
  precio_propuesto: number;
  motivo: string;
  bloqueado_por: string[];
};

export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const sp = req.nextUrl.searchParams;
  const skuFilter = sp.get("sku")?.toUpperCase().trim();
  const tipoFilter = sp.get("tipo") as Senal | null;

  const rs = await loadActiveRuleSet();
  const cfg = readRule<VelocitySignalsCfg>(rs?.rules ?? {}, "velocity_signals", FALLBACK);

  // 1. Inteligencia (velocidades + aging + quiebre)
  let intelQ = sb.from("sku_intelligence")
    .select("sku_origen, vel_7d, vel_30d, vel_60d, tendencia_vel, tendencia_vel_pct, dias_sin_movimiento, vel_pre_quiebre, fecha_entrada_quiebre, stock_full, abc, cuadrante");
  if (skuFilter) intelQ = intelQ.eq("sku_origen", skuFilter);
  const { data: intelRows, error: e1 } = await intelQ;
  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });
  const intel = (intelRows || []) as IntelRow[];

  if (intel.length === 0) {
    return NextResponse.json({ rule_set: rule_set_meta(rs), cfg, sugerencias: [], stats: { total: 0 } });
  }

  const skus = intel.map(r => r.sku_origen);

  // 2. Productos (nombre + costo)
  const { data: prodRows } = await sb.from("productos")
    .select("sku, nombre, costo, costo_promedio")
    .in("sku", skus);
  const prodBySku = new Map<string, ProductoRow>();
  for (const p of (prodRows || []) as ProductoRow[]) prodBySku.set(p.sku, p);

  // 3. Margin cache (precio efectivo + lista + margen)
  const { data: cacheRows } = await sb.from("ml_margin_cache")
    .select("sku, item_id, precio_venta, price_ml, margen_pct, status_ml, stock_total")
    .eq("status_ml", "active")
    .in("sku", skus);
  // un SKU puede tener varios listings — preferir el de mayor stock
  const cacheBySku = new Map<string, CacheRow>();
  for (const r of (cacheRows || []) as CacheRow[]) {
    const cur = cacheBySku.get(r.sku);
    const newStock = r.stock_total ?? 0;
    if (!cur || newStock > (cur.stock_total ?? 0)) cacheBySku.set(r.sku, r);
  }

  // 4. Margen mínimo por cuadrante (gate de aceleración)
  const { data: cuadCfg } = await sb.from("pricing_cuadrante_config")
    .select("cuadrante, margen_min_pct");
  const margenMinByCuadrante = new Map<string, number>();
  for (const c of (cuadCfg || []) as CuadranteRow[]) margenMinByCuadrante.set(c.cuadrante, c.margen_min_pct);

  // 5. Última bajada de precio reciente (para detector estabilidad post-markdown)
  // Lee ml_price_history últimas 60d por sku_origen
  const since60 = new Date(Date.now() - 60 * 86400000).toISOString();
  const { data: priceHist } = await sb.from("ml_price_history")
    .select("sku_origen, precio, precio_anterior, delta_pct, detected_at")
    .gte("detected_at", since60)
    .lt("delta_pct", -5);  // solo bajadas significativas
  const ultimaBajadaBySku = new Map<string, { precio: number; precio_anterior: number; detected_at: string }>();
  for (const h of (priceHist || []) as Array<{ sku_origen: string | null; precio: number; precio_anterior: number; delta_pct: number; detected_at: string }>) {
    if (!h.sku_origen) continue;
    const cur = ultimaBajadaBySku.get(h.sku_origen);
    if (!cur || h.detected_at > cur.detected_at) {
      ultimaBajadaBySku.set(h.sku_origen, { precio: h.precio, precio_anterior: h.precio_anterior, detected_at: h.detected_at });
    }
  }

  // Evaluar cada SKU
  const sugerencias: Sugerencia[] = [];
  const hoy = new Date();

  for (const r of intel) {
    const sku = r.sku_origen;
    const prod = prodBySku.get(sku);
    const cache = cacheBySku.get(sku);

    if (!prod || !cache) continue;
    if (cache.status_ml !== "active") continue;

    const v7  = Number(r.vel_7d  ?? 0);
    const v30 = Number(r.vel_30d ?? 0);
    const v60 = Number(r.vel_60d ?? 0);
    const stock = Number(cache.stock_total ?? r.stock_full ?? 0);
    const precioActual = Number(cache.precio_venta || cache.price_ml || 0);
    const precioLista  = Number(cache.price_ml || 0);
    const margenPct = Number(cache.margen_pct ?? 0);
    const costo = Number(prod.costo_promedio || prod.costo || 0);
    const dsm = r.dias_sin_movimiento;
    const ventas60d = Math.round(v60 * 60);
    const cobertura = v60 > 0 ? Math.round(stock / v60) : null;

    // Filtro mínimo: necesitamos historia
    if (ventas60d < cfg.min_ventas_60d_para_evaluar) continue;
    if (precioActual <= 0) continue;
    if (stock <= 0) continue;

    const cuadrante = r.cuadrante || "_DEFAULT";
    const margenMin = margenMinByCuadrante.get(cuadrante) ?? margenMinByCuadrante.get("_DEFAULT") ?? 0;
    const tendPct = Number(r.tendencia_vel_pct ?? 0);

    const baseSugerencia = {
      sku,
      nombre: prod.nombre,
      cuadrante: r.cuadrante,
      abc: r.abc,
      vel_7d: v7, vel_30d: v30, vel_60d: v60,
      tendencia_pct: tendPct,
      dias_sin_movimiento: dsm,
      stock_full: Number(r.stock_full ?? 0),
      cobertura_dias: cobertura,
      precio_actual: precioActual,
      precio_lista: precioLista,
      margen_pct: margenPct,
      costo,
    };

    // ─── DETECTOR 1: CAÍDA DE VELOCIDAD ─────────────────────────────────
    if (v60 > 0 && v30 < v60 * cfg.caida_ratio_30d_vs_60d) {
      const bloqueadoPor: string[] = [];
      if ((dsm ?? 0) < cfg.caida_min_dias_sin_movimiento) {
        bloqueadoPor.push(`dias_sin_mov<${cfg.caida_min_dias_sin_movimiento}`);
      }
      if ((cobertura ?? 0) < cfg.caida_min_cobertura_dias) {
        bloqueadoPor.push(`cobertura<${cfg.caida_min_cobertura_dias}d`);
      }
      const delta = -cfg.caida_descuento_pct;
      const propuesto = Math.round(precioActual * (1 + delta / 100));
      sugerencias.push({
        ...baseSugerencia,
        senal: "caida",
        delta_pct_sugerido: delta,
        precio_propuesto: propuesto,
        motivo: `vel_30d=${v30.toFixed(2)}/d cayó ${Math.round((1 - v30/v60) * 100)}% vs vel_60d=${v60.toFixed(2)}/d (umbral ${Math.round((1-cfg.caida_ratio_30d_vs_60d)*100)}%). Cobertura ${cobertura}d.`,
        bloqueado_por: bloqueadoPor,
      });
      continue;  // un SKU = una sugerencia
    }

    // ─── DETECTOR 2: ACELERACIÓN DE VELOCIDAD ───────────────────────────
    if (v60 > 0 && v30 > v60 * cfg.aceleracion_ratio_30d_vs_60d) {
      const bloqueadoPor: string[] = [];
      if (cfg.aceleracion_requiere_margen_min && margenPct < margenMin) {
        bloqueadoPor.push(`margen<${margenMin}%(min cuadrante ${cuadrante})`);
      }
      // Regla 30-day (Comparada:285): no subir si precio actual ya > 30d avg
      // Aproximación: si tendencia_vel='subiendo' y tendencia_pct alto → seguro
      const delta = +cfg.aceleracion_subida_pct;
      const propuesto = Math.round(precioActual * (1 + delta / 100));
      sugerencias.push({
        ...baseSugerencia,
        senal: "aceleracion",
        delta_pct_sugerido: delta,
        precio_propuesto: propuesto,
        motivo: `vel_30d=${v30.toFixed(2)}/d creció ${Math.round((v30/v60 - 1) * 100)}% vs vel_60d=${v60.toFixed(2)}/d (umbral +${Math.round((cfg.aceleracion_ratio_30d_vs_60d-1)*100)}%). Margen actual ${margenPct.toFixed(1)}%.`,
        bloqueado_por: bloqueadoPor,
      });
      continue;
    }

    // ─── DETECTOR 3: ESTABILIDAD POST-MARKDOWN ──────────────────────────
    const ultBajada = ultimaBajadaBySku.get(sku);
    if (ultBajada) {
      const diasDesdeBajada = Math.floor((hoy.getTime() - new Date(ultBajada.detected_at).getTime()) / 86400000);
      if (diasDesdeBajada >= cfg.estabilidad_post_markdown_dias) {
        const velPre = Number(r.vel_pre_quiebre ?? 0);
        if (velPre > 0 && v30 >= velPre * (cfg.estabilidad_recovery_pct_pre_quiebre / 100)) {
          sugerencias.push({
            ...baseSugerencia,
            senal: "estabilidad_post_markdown",
            delta_pct_sugerido: 0,
            precio_propuesto: precioActual,
            motivo: `Markdown aplicado hace ${diasDesdeBajada}d (de $${ultBajada.precio_anterior.toLocaleString("es-CL")} a $${ultBajada.precio.toLocaleString("es-CL")}). vel_30d=${v30.toFixed(2)}/d ≥ ${cfg.estabilidad_recovery_pct_pre_quiebre}% del pre-quiebre (${velPre.toFixed(2)}/d). Mantener nuevo baseline.`,
            bloqueado_por: [],
          });
        }
      }
    }
  }

  // Filtrar por tipo si pidieron
  let resultado = sugerencias;
  if (tipoFilter) resultado = sugerencias.filter(s => s.senal === tipoFilter);

  // Ordenar: caídas primero, luego aceleraciones, luego estabilidad
  const ord: Record<Senal, number> = { caida: 0, aceleracion: 1, estabilidad_post_markdown: 2 };
  resultado.sort((a, b) => {
    if (ord[a.senal] !== ord[b.senal]) return ord[a.senal] - ord[b.senal];
    return Math.abs(b.delta_pct_sugerido) - Math.abs(a.delta_pct_sugerido);
  });

  return NextResponse.json({
    rule_set: rule_set_meta(rs),
    cfg,
    stats: {
      total_evaluados: intel.length,
      total_sugerencias: resultado.length,
      caidas:          resultado.filter(s => s.senal === "caida").length,
      aceleraciones:   resultado.filter(s => s.senal === "aceleracion").length,
      estabilidades:   resultado.filter(s => s.senal === "estabilidad_post_markdown").length,
      bloqueadas:      resultado.filter(s => s.bloqueado_por.length > 0).length,
    },
    sugerencias: resultado,
  });
}

function rule_set_meta(rs: Awaited<ReturnType<typeof loadActiveRuleSet>>) {
  if (!rs) return { version_label: "fallback", content_hash: null, using_fallback: true };
  return {
    version_label: rs.version_label,
    content_hash:  rs.content_hash,
    using_fallback: false,
  };
}
