/**
 * /api/pricing/seguimiento — estado de cada SKU con cambio de precio reciente.
 *
 * Manuales:
 *   - Op_Limpieza:521 KPI #3 Sell-through 14d/30d (uds_post / stock_al_inicio_md)
 *   - Op_Limpieza:522 KPI #4 Velocity Lift (vel_post_14d / vel_pre_14d, target ≥1.5×)
 *   - Op_Limpieza:498 ventana credibilidad MLC 30d (no subir post-MD)
 *   - Op_Limpieza:402 pausar profundización si lift ≥2×
 *   - Comparada:285 regla 30-day rolling (Buy Box suppression)
 *   - Engines:411 input_snapshot en pricing_decision_log para auditoría
 *
 * Sin tabla nueva: deriva al vuelo de
 *   ml_price_history (eventos colapsados via collapseSwapBlips)
 *   ventas_ml_cache  (uds pre/post)
 *   ml_margin_cache  (stock al T0 aproximado: stock_actual + uds_post)
 *
 * Read-only: NO aplica nada.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  collapseSwapBlips, tierVitrina,
  VENTANA_EVAL_DIAS, VENTANA_LIFT_DIAS,
  type PriceHistoryRow,
} from "@/lib/pricing";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MIN_DELTA_PCT_BAJADA = -5; // bajadas significativas (más estricto que el global -3% para sugerencias UI)

type Estado = "en_eval" | "exitoso" | "marginal" | "sin_lift" | "indeterminado" | "expirado";
type Confianza = "nula" | "baja" | "media" | "alta";

// Thresholds para clasificar confianza estadística del lift parcial.
// Engines:544 — "lift sostenido p<0.05" requiere ventana completa de 14d.
// Antes de eso, distinguir señal real vs ruido por n insuficiente.
//   nula:  <3d post O 0 uds. Cualquier número es ruido. No mostrar lift.
//   baja:  3-7d con <5 uds. Mostrar lift parcial pero NO emitir acciones
//          (excepto alerta de stock crítico — esa viene del lado del stock,
//          no del lift, así que escala con cualquier confianza).
//   media: ≥7d Y ≥5 uds. Suficiente n para early-stop preliminar.
//   alta:  ≥14d. Ventana completa, decisión final.
const CONFIANZA_MIN_DIAS_BAJA = 3;
const CONFIANZA_MIN_UDS_BAJA = 1;
const CONFIANZA_MIN_DIAS_MEDIA = 7;
const CONFIANZA_MIN_UDS_MEDIA = 5;

interface SeguimientoRow {
  sku: string;
  titulo: string | null;
  cuadrante: string | null;
  abc: string | null;
  precio_pre: number;
  precio_post: number;
  delta_pct: number;
  fuente_cambio: string;
  ejecutado_por: string | null;
  t0: string;
  dias_desde_md: number;
  dias_restantes_lift: number;     // hasta cierre ventana 14d
  dias_restantes_eval: number;     // hasta cierre ventana 30d
  uds_pre_14d: number;
  uds_post_actuales: number;       // uds vendidas desde T0 hasta hoy
  uds_post_14d: number | null;     // proyección lineal a 14d (null si <2d)
  vel_pre: number;                 // uds/dia 14d antes
  vel_post: number | null;         // uds/dia desde T0 hasta hoy (null si dias=0)
  lift: number | null;             // vel_post / vel_pre
  stock_al_t0: number;
  stock_actual: number;
  sell_through: number | null;     // uds_post / stock_al_t0
  estado: Estado;
  confianza: Confianza;             // calidad estadística de la medición actual
  confianza_motivo: string;          // por qué esa confianza
  recomendacion: string;
  recomendacion_accion: "esperar" | "mantener_baseline" | "subir_precio" | "esperar_fin_promo" | "profundizar" | "salir_deal" | "ninguna";
  alerta_stock_temprana: boolean;    // escala aunque confianza sea baja (Hueco 4 proactivo)
  margen_pct_actual: number | null;
  // Hueco 1 — contexto para recomendación ramificada:
  tiene_promo_activa: boolean;
  promo_activa_nombre: string | null;
  promo_activa_tier: number;
  cob_actual_dias: number | null;
  lead_time_dias: number | null;
  safety_stock_dias: number | null;
  stock_critico: boolean;          // cob_actual < lead_time + safety_stock
  reposicion_disponible: boolean;
}

export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const sp = req.nextUrl.searchParams;
  const skuFilter = sp.get("sku")?.toUpperCase().trim();
  const estadoFilter = sp.get("estado") as Estado | null;
  const incluirExpirados = sp.get("incluir_expirados") === "1";

  const hoy = Date.now();
  const sinceVentanaEval = new Date(hoy - VENTANA_EVAL_DIAS * 86400000).toISOString();
  const sinceLargo = new Date(hoy - 2 * VENTANA_LIFT_DIAS * 86400000).toISOString(); // 28d para tener pre completo

  // 1. Eventos de bajada en ventana de evaluación, colapsando blips de promo-swap.
  let phQuery = sb.from("ml_price_history")
    .select("item_id, sku, sku_origen, precio, precio_anterior, delta_pct, fuente, ejecutado_por, detected_at")
    .gte("detected_at", sinceLargo);
  if (skuFilter) phQuery = phQuery.eq("sku", skuFilter);
  const { data: priceHistRaw, error: phErr } = await phQuery;
  if (phErr) {
    console.error(`[seguimiento] ml_price_history query failed: ${phErr.message}`);
    return NextResponse.json({ error: phErr.message }, { status: 500 });
  }
  const priceHist = collapseSwapBlips((priceHistRaw || []) as PriceHistoryRow[]);

  // Última bajada significativa por SKU dentro de la ventana de evaluación.
  type Cambio = {
    sku: string;
    item_id: string;
    sku_origen: string;
    precio_pre: number;
    precio_post: number;
    delta_pct: number;
    fuente: string;
    ejecutado_por: string | null;
    t0: string;
  };
  const ultimaBajadaBySku = new Map<string, Cambio>();
  for (const e of priceHist) {
    if (!e.sku) continue;
    if (e.delta_pct == null || e.delta_pct >= MIN_DELTA_PCT_BAJADA) continue;
    if (e.detected_at < sinceVentanaEval) continue;
    const cambio: Cambio = {
      sku: e.sku,
      item_id: e.item_id,
      sku_origen: e.sku_origen ?? e.sku,
      precio_pre: Number(e.precio_anterior ?? 0),
      precio_post: Number(e.precio),
      delta_pct: Number(e.delta_pct),
      fuente: String(e.fuente),
      ejecutado_por: e.ejecutado_por ?? null,
      t0: e.detected_at,
    };
    const cur = ultimaBajadaBySku.get(e.sku);
    if (!cur || cambio.t0 > cur.t0) ultimaBajadaBySku.set(e.sku, cambio);
  }

  if (ultimaBajadaBySku.size === 0) {
    return NextResponse.json({
      ventana_eval_dias: VENTANA_EVAL_DIAS,
      ventana_lift_dias: VENTANA_LIFT_DIAS,
      total: 0,
      seguimiento: [],
    });
  }

  const skus = Array.from(ultimaBajadaBySku.keys());

  // 2. Cargar ventas en ventana [T0_min - 14d, hoy].
  const t0Min = Math.min(...Array.from(ultimaBajadaBySku.values()).map(c => new Date(c.t0).getTime()));
  const ventanaPreInicio = new Date(t0Min - VENTANA_LIFT_DIAS * 86400000).toISOString();
  const { data: ventasRows, error: vErr } = await sb.from("ventas_ml_cache")
    .select("sku_venta, fecha, cantidad, anulada")
    .in("sku_venta", skus)
    .eq("anulada", false)
    .gte("fecha", ventanaPreInicio);
  if (vErr) {
    console.error(`[seguimiento] ventas_ml_cache query failed: ${vErr.message}`);
    return NextResponse.json({ error: vErr.message }, { status: 500 });
  }
  type Venta = { sku_venta: string; fecha: string; cantidad: number };
  const ventasBySku = new Map<string, Venta[]>();
  for (const v of (ventasRows || []) as Venta[]) {
    if (!v.sku_venta) continue;
    const arr = ventasBySku.get(v.sku_venta) ?? [];
    arr.push(v);
    ventasBySku.set(v.sku_venta, arr);
  }

  // 3. Cargar margin_cache + intelligence + productos para contexto.
  // Para Hueco 1 (recomendación ramificada en estado=exitoso) necesitamos:
  //   - ml_margin_cache: tiene_promo, promo_type, promo_name → si hay promo
  //     activa de tier alto (DEAL/SMART/etc.), no se puede "salir" sin perder
  //     ranking — esperar fin de promo.
  //   - sku_intelligence: abc, abc_ingreso, lead_time_usado_dias, safety_stock_completo,
  //     cob_total, vel_30d, tiene_stock_prov, stock_proveedor → detectar stock
  //     crítico que justifica subir precio (Ajuste_Plan:21).
  type CacheFull = {
    sku: string; titulo: string | null; stock_total: number | null; margen_pct: number | null;
    tiene_promo: boolean | null; promo_type: string | null; promo_name: string | null;
    price_ml: number | null; precio_venta: number | null;
  };
  type IntelFull = {
    sku_origen: string; cuadrante: string | null; abc: string | null; abc_ingreso: string | null;
    lead_time_usado_dias: number | null; safety_stock_completo: number | null;
    cob_total: number | null; vel_30d: number | null;
    tiene_stock_prov: boolean | null; stock_proveedor: number | null;
  };
  const [{ data: cacheRows }, { data: intelRows }, { data: prodRows }] = await Promise.all([
    sb.from("ml_margin_cache").select("sku, titulo, stock_total, margen_pct, tiene_promo, promo_type, promo_name, price_ml, precio_venta").in("sku", skus),
    sb.from("sku_intelligence").select("sku_origen, cuadrante, abc, abc_ingreso, lead_time_usado_dias, safety_stock_completo, cob_total, vel_30d, tiene_stock_prov, stock_proveedor").in("sku_origen", skus),
    sb.from("productos").select("sku, costo, costo_promedio").in("sku", skus),
  ]);
  const cacheBySku = new Map<string, CacheFull>();
  for (const r of (cacheRows || []) as CacheFull[]) cacheBySku.set(r.sku, r);
  const intelBySku = new Map<string, IntelFull>();
  for (const r of (intelRows || []) as IntelFull[]) intelBySku.set(r.sku_origen, r);

  // 4. Construir filas de seguimiento.
  const seguimiento: SeguimientoRow[] = [];
  for (const [sku, cambio] of Array.from(ultimaBajadaBySku.entries())) {
    const t0Ms = new Date(cambio.t0).getTime();
    const diasDesdeMd = Math.floor((hoy - t0Ms) / 86400000);
    const cache = cacheBySku.get(sku);
    const intel = intelBySku.get(sku) || intelBySku.get(cambio.sku_origen);
    const ventas = ventasBySku.get(sku) || [];

    let udsPre = 0, udsPost = 0;
    const tPreInicio = t0Ms - VENTANA_LIFT_DIAS * 86400000;
    for (const v of ventas) {
      const f = new Date(v.fecha).getTime();
      const cant = Number(v.cantidad) || 0;
      if (f >= tPreInicio && f < t0Ms) udsPre += cant;
      else if (f >= t0Ms) udsPost += cant;
    }

    const velPre = udsPre / VENTANA_LIFT_DIAS;
    const velPost = diasDesdeMd > 0 ? udsPost / diasDesdeMd : null;
    const lift = velPre > 0 && velPost != null ? velPost / velPre : null;
    const udsPost14Proj = diasDesdeMd >= 2
      ? Math.round((udsPost / diasDesdeMd) * VENTANA_LIFT_DIAS * 10) / 10
      : null;
    const stockActual = cache?.stock_total ?? 0;
    const stockAlT0 = stockActual + udsPost; // aproximación: lo vendido post salió del stock
    const sellThrough = stockAlT0 > 0 ? udsPost / stockAlT0 : null;

    // Hueco 1 — contexto para recomendación ramificada.
    const tienePromoActiva = !!cache?.tiene_promo;
    const promoActivaNombre = cache?.promo_name ?? null;
    const promoActivaTier = tienePromoActiva ? tierVitrina(cache?.promo_type ?? null) : 0;
    const ltDias = intel?.lead_time_usado_dias != null ? Number(intel.lead_time_usado_dias) : null;
    const ssDias = intel?.safety_stock_completo != null ? Number(intel.safety_stock_completo) : null;
    const cobActual = intel?.cob_total != null ? Number(intel.cob_total) : null;
    const cobMinima = (ltDias ?? 0) + (ssDias ?? 0);
    // velPost real (uds/d desde T0) es mejor proxy del régimen post-MD que vel_30d
    // (que mezcla pre y post). Si no hay velPost (dias=0), caemos a vel_30d.
    const velRegimenPost = velPost ?? Number(intel?.vel_30d ?? 0);
    const cobAlVelPost = velRegimenPost > 0 ? stockActual / velRegimenPost : null;
    const stockCritico = cobAlVelPost != null && cobMinima > 0 && cobAlVelPost < cobMinima;
    const reposicionDisponible = !!intel?.tiene_stock_prov && (intel?.stock_proveedor ?? 0) > 0;
    const esClaseAB = intel?.abc === "A" || intel?.abc === "B" || intel?.abc_ingreso === "A" || intel?.abc_ingreso === "B";

    // Confianza estadística del lift parcial (Engines:544).
    let confianza: Confianza;
    let confianza_motivo: string;
    if (diasDesdeMd < CONFIANZA_MIN_DIAS_BAJA || udsPost < CONFIANZA_MIN_UDS_BAJA) {
      confianza = "nula";
      confianza_motivo = `Solo ${diasDesdeMd}d post-MD y ${udsPost} uds — ruido estadístico, esperá ${CONFIANZA_MIN_DIAS_BAJA - diasDesdeMd}d más`;
    } else if (diasDesdeMd >= VENTANA_LIFT_DIAS) {
      confianza = "alta";
      confianza_motivo = `Ventana 14d completa con ${udsPost} uds`;
    } else if (diasDesdeMd >= CONFIANZA_MIN_DIAS_MEDIA && udsPost >= CONFIANZA_MIN_UDS_MEDIA) {
      confianza = "media";
      confianza_motivo = `${diasDesdeMd}d + ${udsPost} uds — early-stop preliminar (faltan ${VENTANA_LIFT_DIAS - diasDesdeMd}d para confianza alta)`;
    } else {
      confianza = "baja";
      confianza_motivo = `${diasDesdeMd}d + ${udsPost} uds — n insuficiente para concluir lift, observar`;
    }

    // Hueco 4 PROACTIVO: alerta stock temprana. Esta señal viene del LADO del
    // stock, no del lift, así que se escala aunque confianza sea baja/nula.
    // Para clase A/B con stock crítico que va a quebrar antes del próximo
    // reabastecimiento (lead_time + ss) y SIN reposición disponible.
    const alerta_stock_temprana = esClaseAB && stockCritico && !reposicionDisponible;

    let estado: Estado;
    let recomendacion: string;
    let recomendacion_accion: SeguimientoRow["recomendacion_accion"] = "ninguna";

    if (diasDesdeMd >= VENTANA_EVAL_DIAS) {
      estado = "expirado";
      recomendacion = "Ventana eval cerrada. Liberado para nuevas señales.";
      recomendacion_accion = "ninguna";
    } else if (confianza === "nula") {
      // Caso "muy temprano": no decir nada de lift, pero SÍ alertar stock.
      estado = "en_eval";
      if (alerta_stock_temprana) {
        const promoBloquea = tienePromoActiva && promoActivaTier >= 3;
        recomendacion = promoBloquea
          ? `⚠️ ALERTA STOCK TEMPRANA (n=${udsPost} aún ruido): cob ${cobAlVelPost?.toFixed(1)}d < lead_time+ss ${cobMinima.toFixed(1)}d, clase ${intel?.abc || intel?.abc_ingreso}. Promo activa "${promoActivaNombre}" tier ${promoActivaTier} bloquea subir. Acelerar OC al proveedor.`
          : `⚠️ ALERTA STOCK TEMPRANA (n=${udsPost} aún ruido): cob ${cobAlVelPost?.toFixed(1)}d < lead_time+ss ${cobMinima.toFixed(1)}d, clase ${intel?.abc || intel?.abc_ingreso}. Sin promo activa — considerar subir precio o acelerar OC.`;
        recomendacion_accion = promoBloquea ? "esperar_fin_promo" : "subir_precio";
      } else {
        recomendacion = `Solo ${diasDesdeMd}d post-MD y ${udsPost} uds — esperar más datos antes de evaluar.`;
        recomendacion_accion = "esperar";
      }
    } else if (velPre <= 0) {
      estado = "indeterminado";
      recomendacion = `No había base de venta en pre-period (vel_pre=0). Observar absoluto: ${udsPost} uds en ${diasDesdeMd}d a $${cambio.precio_post.toLocaleString("es-CL")}.`;
      recomendacion_accion = "esperar";
    } else if (confianza === "baja") {
      // Datos pero pocos: mostrar lift parcial pero NO emitir acción de lift.
      // Excepción: alerta stock temprana sí escala.
      estado = "en_eval";
      if (alerta_stock_temprana) {
        const promoBloquea = tienePromoActiva && promoActivaTier >= 3;
        recomendacion = promoBloquea
          ? `⚠️ ALERTA STOCK (lift parcial ${lift?.toFixed(2) ?? "—"}× con n=${udsPost} aún preliminar): cob ${cobAlVelPost?.toFixed(1)}d < lead_time+ss ${cobMinima.toFixed(1)}d, A/B. Promo "${promoActivaNombre}" bloquea — acelerar OC.`
          : `⚠️ ALERTA STOCK (lift parcial ${lift?.toFixed(2) ?? "—"}× con n=${udsPost} aún preliminar): cob ${cobAlVelPost?.toFixed(1)}d < lead_time+ss ${cobMinima.toFixed(1)}d, A/B sin promo. Subir precio o acelerar OC.`;
        recomendacion_accion = promoBloquea ? "esperar_fin_promo" : "subir_precio";
      } else {
        recomendacion = `Datos preliminares (${udsPost} uds en ${diasDesdeMd}d, lift parcial ${lift?.toFixed(2) ?? "—"}×). Esperar a 7d+5uds para early-stop.`;
        recomendacion_accion = "esperar";
      }
    } else if (lift != null && lift >= 1.5) {
      // confianza media o alta + lift bueno → ramificar Hueco 1
      estado = "exitoso";
      const tag = confianza === "alta" ? "✅" : "🟢 (preliminar)";
      if (stockCritico && esClaseAB && !reposicionDisponible) {
        if (tienePromoActiva && promoActivaTier >= 3) {
          recomendacion = `${tag} Lift ${lift.toFixed(2)}× cumple, PERO stock crítico (cob ${cobAlVelPost?.toFixed(1)}d < lead_time+ss ${cobMinima.toFixed(1)}d, clase ${intel?.abc || intel?.abc_ingreso}). Promo "${promoActivaNombre}" tier ${promoActivaTier} → NO salir (Op_Limpieza:504). Esperar fin promo y subir.`;
          recomendacion_accion = "esperar_fin_promo";
        } else {
          recomendacion = `${tag} Lift ${lift.toFixed(2)}× cumple, PERO stock crítico (cob ${cobAlVelPost?.toFixed(1)}d < lead_time+ss ${cobMinima.toFixed(1)}d, A/B sin reposición). Subir precio (Ajuste_Plan:21).`;
          recomendacion_accion = "subir_precio";
        }
      } else if (stockCritico && reposicionDisponible) {
        recomendacion = `${tag} Lift ${lift.toFixed(2)}×. Cob baja (${cobAlVelPost?.toFixed(1)}d) pero hay stock_proveedor. Mantener + acelerar OC.`;
        recomendacion_accion = "mantener_baseline";
      } else {
        recomendacion = `${tag} Lift ${lift.toFixed(2)}× ≥1.5× — mantener baseline (Op_Limpieza KPI #4 cumple).`;
        recomendacion_accion = "mantener_baseline";
      }
    } else if (lift != null && lift >= 1.0) {
      estado = "marginal";
      recomendacion = `Lift ${lift.toFixed(2)}× entre 1.0× y 1.5× (confianza ${confianza}) — rondar antes de profundizar.`;
      recomendacion_accion = "esperar";
    } else {
      estado = "sin_lift";
      if (confianza === "alta") {
        recomendacion = `Lift ${lift?.toFixed(2) ?? "—"}× <1.0× con ventana 14d completa. Profundizar al siguiente escalón al cerrar ventana eval (${VENTANA_EVAL_DIAS - diasDesdeMd}d restantes).`;
      } else {
        recomendacion = `Lift ${lift?.toFixed(2) ?? "—"}× <1.0× preliminar (${confianza}). Esperar cierre ventana 14d antes de profundizar.`;
      }
      recomendacion_accion = "esperar";
    }

    seguimiento.push({
      sku,
      titulo: cache?.titulo ?? null,
      cuadrante: intel?.cuadrante ?? null,
      abc: intel?.abc ?? null,
      precio_pre: cambio.precio_pre,
      precio_post: cambio.precio_post,
      delta_pct: Math.round(cambio.delta_pct * 100) / 100,
      fuente_cambio: cambio.fuente,
      ejecutado_por: cambio.ejecutado_por,
      t0: cambio.t0,
      dias_desde_md: diasDesdeMd,
      dias_restantes_lift: Math.max(0, VENTANA_LIFT_DIAS - diasDesdeMd),
      dias_restantes_eval: Math.max(0, VENTANA_EVAL_DIAS - diasDesdeMd),
      uds_pre_14d: udsPre,
      uds_post_actuales: udsPost,
      uds_post_14d: udsPost14Proj,
      vel_pre: Math.round(velPre * 1000) / 1000,
      vel_post: velPost != null ? Math.round(velPost * 1000) / 1000 : null,
      lift: lift != null ? Math.round(lift * 100) / 100 : null,
      stock_al_t0: stockAlT0,
      stock_actual: stockActual,
      sell_through: sellThrough != null ? Math.round(sellThrough * 1000) / 1000 : null,
      estado,
      confianza,
      confianza_motivo,
      recomendacion,
      recomendacion_accion,
      alerta_stock_temprana,
      margen_pct_actual: cache?.margen_pct ?? null,
      tiene_promo_activa: tienePromoActiva,
      promo_activa_nombre: promoActivaNombre,
      promo_activa_tier: promoActivaTier,
      cob_actual_dias: cobAlVelPost != null ? Math.round(cobAlVelPost * 10) / 10 : (cobActual != null ? Math.round(cobActual * 10) / 10 : null),
      lead_time_dias: ltDias,
      safety_stock_dias: ssDias,
      stock_critico: stockCritico,
      reposicion_disponible: reposicionDisponible,
    });
  }

  // Filtros
  let filtered = seguimiento;
  if (estadoFilter) filtered = filtered.filter(r => r.estado === estadoFilter);
  if (!incluirExpirados) filtered = filtered.filter(r => r.estado !== "expirado");

  // Orden: en_eval primero (más recientes arriba), luego sin_lift, marginal, exitoso, indeterminado.
  const ord: Record<Estado, number> = {
    sin_lift: 0,
    marginal: 1,
    en_eval: 2,
    exitoso: 3,
    indeterminado: 4,
    expirado: 5,
  };
  filtered.sort((a, b) => {
    const oa = ord[a.estado], ob = ord[b.estado];
    if (oa !== ob) return oa - ob;
    return b.t0.localeCompare(a.t0);
  });

  return NextResponse.json({
    ventana_eval_dias: VENTANA_EVAL_DIAS,
    ventana_lift_dias: VENTANA_LIFT_DIAS,
    total: filtered.length,
    breakdown: {
      en_eval: seguimiento.filter(r => r.estado === "en_eval").length,
      exitoso: seguimiento.filter(r => r.estado === "exitoso").length,
      marginal: seguimiento.filter(r => r.estado === "marginal").length,
      sin_lift: seguimiento.filter(r => r.estado === "sin_lift").length,
      indeterminado: seguimiento.filter(r => r.estado === "indeterminado").length,
      expirado: seguimiento.filter(r => r.estado === "expirado").length,
    },
    seguimiento: filtered,
  });
}
