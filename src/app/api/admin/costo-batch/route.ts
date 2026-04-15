import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 120;

/**
 * POST /api/admin/costo-batch
 *
 * Regulariza en lote el costo_unitario de SKUs cuyas entradas históricas
 * quedaron con costo NULL (falta de ingreso de factura en recepciones).
 *
 * Body:
 *   {
 *     filas: [{ sku: string, costo_neto: number, factura_ref?: string }],
 *     dryRun?: boolean   // default false
 *   }
 *
 * Comportamiento por SKU:
 *   - Si existen movimientos tipo='entrada' con costo_unitario IS NULL
 *       → modo "entradas": actualiza esos movimientos por recepcion_id,
 *         replica la lógica auditada de sincronizarCostoMovimientosRecepcion,
 *         recalcula WAC desde todas las entradas con costo > 0.
 *   - Si NO hay movimientos para ese SKU
 *       → modo "huerfano": inserta UN movimiento sintético
 *         tipo='entrada', motivo='regularizacion_historica' por el stock
 *         físico actual + costo de la planilla, NO mueve stock, y setea
 *         productos.costo_promedio = costo_neto directamente.
 *
 * Toda escritura deja entradas en audit_log con un run_id común por llamada.
 */

type FilaInput = { sku: string; costo_neto: number; factura_ref?: string };
type Modo = "entradas" | "huerfano" | "skip";

type Resultado = {
  sku: string;
  modo: Modo;
  costo_neto: number;
  factura_ref: string | null;
  wac_anterior: number | null;
  wac_nuevo: number | null;
  stock_actual?: number;
  movimientos_actualizados?: number;
  recepciones_actualizadas?: number;
  movimientos_sin_recepcion?: number;
  movimiento_sintetico_id?: string;
  error?: string;
};

export async function POST(req: Request) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  let body: { filas?: FilaInput[]; dryRun?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body_invalido" }, { status: 400 });
  }

  const filasRaw = Array.isArray(body.filas) ? body.filas : [];
  const filas = filasRaw
    .map(f => ({
      sku: String(f?.sku || "").toUpperCase().trim(),
      costo_neto: Number(f?.costo_neto),
      factura_ref: f?.factura_ref ? String(f.factura_ref).trim() : null,
    }))
    .filter(f => f.sku && Number.isFinite(f.costo_neto) && f.costo_neto > 0);

  if (filas.length === 0) {
    return NextResponse.json(
      { error: "filas_vacias_o_invalidas", recibidas: filasRaw.length },
      { status: 400 },
    );
  }

  const dryRun = body.dryRun === true;
  const runId = randomUUID();
  const detalle: Resultado[] = [];
  let exitosos = 0;
  let errores = 0;

  for (const fila of filas) {
    const { sku, costo_neto: costo, factura_ref } = fila;
    const res: Resultado = {
      sku,
      modo: "skip",
      costo_neto: costo,
      factura_ref,
      wac_anterior: null,
      wac_nuevo: null,
    };

    try {
      // 1. Verificar producto + leer WAC previo
      const { data: prodRows } = await sb
        .from("productos")
        .select("costo, costo_promedio")
        .eq("sku", sku)
        .limit(1);
      if (!prodRows || prodRows.length === 0) {
        res.error = "producto_no_existe";
        errores++;
        detalle.push(res);
        continue;
      }
      const prod = prodRows[0] as { costo: number | null; costo_promedio: number | null };
      res.wac_anterior = Number(prod.costo_promedio || 0);

      // 2. Contar movimientos de entrada con costo NULL
      const { data: movsNullRaw } = await sb
        .from("movimientos")
        .select("id, recepcion_id")
        .eq("sku", sku)
        .eq("tipo", "entrada")
        .is("costo_unitario", null);
      const movsNull = (movsNullRaw || []) as Array<{ id: string; recepcion_id: string | null }>;

      if (movsNull.length > 0) {
        // ────────────────────────────────────────────────────────────────
        // CAMINO A — existen entradas: update por recepcion_id + WAC recalc
        // ────────────────────────────────────────────────────────────────
        res.modo = "entradas";
        const recepcionIds = Array.from(
          new Set(movsNull.filter(m => m.recepcion_id).map(m => m.recepcion_id as string)),
        );
        const movsSinRecepcion = movsNull.filter(m => !m.recepcion_id);
        res.movimientos_actualizados = movsNull.length;
        res.recepciones_actualizadas = recepcionIds.length;
        res.movimientos_sin_recepcion = movsSinRecepcion.length;

        if (dryRun) {
          res.wac_nuevo = res.wac_anterior; // en dryRun no proyectamos WAC
          exitosos++;
          detalle.push(res);
          continue;
        }

        // 2a. Update movimientos por recepción — mismo filtro que
        //     sincronizarCostoMovimientosRecepcion(sku, rid, costo)
        for (const rid of recepcionIds) {
          const { error: updErr } = await sb
            .from("movimientos")
            .update({ costo_unitario: costo })
            .eq("recepcion_id", rid)
            .eq("sku", sku)
            .eq("tipo", "entrada");
          if (updErr) throw new Error(`update_movimientos_recepcion(${rid}): ${updErr.message}`);

          await sb.from("audit_log").insert({
            accion: "sincronizarCostoMovimientosRecepcion",
            entidad: "recepcion",
            entidad_id: rid,
            operario: "costo-batch",
            params: {
              sku,
              nuevoCostoUnitario: costo,
              run_id: runId,
              factura_ref,
              origen: "costo_batch_endpoint",
            },
            resultado: { movs_actualizados: true },
          });
        }

        // 2b. Update movimientos NULL sin recepcion_id (edge case)
        if (movsSinRecepcion.length > 0) {
          const ids = movsSinRecepcion.map(m => m.id);
          const { error: updOrfErr } = await sb
            .from("movimientos")
            .update({ costo_unitario: costo })
            .in("id", ids);
          if (updOrfErr) throw new Error(`update_movimientos_sin_recepcion: ${updOrfErr.message}`);

          await sb.from("audit_log").insert({
            accion: "costo_batch_movs_sin_recepcion",
            entidad: "producto",
            entidad_id: sku,
            operario: "costo-batch",
            params: { sku, costo, run_id: runId, ids },
            resultado: { actualizados: ids.length },
          });
        }

        // 2c. Recalcular WAC desde todas las entradas con costo > 0
        //     (misma lógica que sincronizarCostoMovimientosRecepcion)
        const { data: entradasRaw } = await sb
          .from("movimientos")
          .select("cantidad, costo_unitario")
          .eq("sku", sku)
          .eq("tipo", "entrada")
          .not("costo_unitario", "is", null)
          .gt("costo_unitario", 0);
        const entradas = (entradasRaw || []) as Array<{ cantidad: number; costo_unitario: number }>;
        let sumQty = 0;
        let sumQtyCost = 0;
        for (const m of entradas) {
          sumQty += m.cantidad;
          sumQtyCost += m.cantidad * m.costo_unitario;
        }
        const nuevoWac = sumQty > 0 ? Math.round((sumQtyCost / sumQty) * 100) / 100 : costo;

        const { error: prodErr } = await sb
          .from("productos")
          .update({ costo_promedio: nuevoWac })
          .eq("sku", sku);
        if (prodErr) throw new Error(`update_producto_costo_promedio: ${prodErr.message}`);
        res.wac_nuevo = nuevoWac;
      } else {
        // ────────────────────────────────────────────────────────────────
        // CAMINO B — huérfano: stock sin entradas registradas
        // ────────────────────────────────────────────────────────────────
        res.modo = "huerfano";

        // Leer stock físico por posición
        const { data: stockRaw } = await sb
          .from("stock")
          .select("cantidad, posicion_id")
          .eq("sku", sku)
          .gt("cantidad", 0);
        const stockRows = (stockRaw || []) as Array<{ cantidad: number; posicion_id: string }>;
        const stockTotal = stockRows.reduce((a, r) => a + (r.cantidad || 0), 0);
        res.stock_actual = stockTotal;

        if (stockTotal <= 0) {
          res.error = "sin_stock_fisico_para_regularizar";
          errores++;
          detalle.push(res);
          continue;
        }

        if (dryRun) {
          res.wac_nuevo = costo;
          exitosos++;
          detalle.push(res);
          continue;
        }

        // Usar posicion con mayor cantidad como referencia textual del movimiento
        const posicionRef = stockRows
          .slice()
          .sort((a, b) => b.cantidad - a.cantidad)[0]?.posicion_id || "SIN_ASIGNAR";

        const nota = factura_ref
          ? `Regularizacion historica — Factura ref: ${factura_ref}`
          : "Regularizacion historica sin factura";

        // Insertar movimiento sintético (NO mueve stock — INSERT directo)
        const { data: movIns, error: movErr } = await sb
          .from("movimientos")
          .insert({
            tipo: "entrada",
            motivo: "regularizacion_historica",
            sku,
            posicion_id: posicionRef,
            cantidad: stockTotal,
            costo_unitario: costo,
            recepcion_id: null,
            operario: "costo-batch",
            nota,
          })
          .select("id")
          .limit(1);
        if (movErr) throw new Error(`insert_movimiento_sintetico: ${movErr.message}`);
        const movId = (movIns?.[0] as { id?: string } | undefined)?.id;
        res.movimiento_sintetico_id = movId;

        // Update directo del WAC
        const { error: prodErr } = await sb
          .from("productos")
          .update({ costo_promedio: costo })
          .eq("sku", sku);
        if (prodErr) throw new Error(`update_producto_huerfano: ${prodErr.message}`);
        res.wac_nuevo = costo;

        // Audit
        await sb.from("audit_log").insert({
          accion: "regularizacion_historica_costo",
          entidad: "producto",
          entidad_id: sku,
          operario: "costo-batch",
          params: {
            sku,
            costo_neto: costo,
            stock_regularizado: stockTotal,
            posicion_snapshot: posicionRef,
            factura_ref,
            run_id: runId,
          },
          resultado: {
            costo_promedio: costo,
            movimiento_sintetico_id: movId,
          },
        });
      }

      exitosos++;
      detalle.push(res);
    } catch (e) {
      res.error = e instanceof Error ? e.message : String(e);
      errores++;
      detalle.push(res);
      try {
        await sb.from("audit_log").insert({
          accion: "costo_batch_error",
          entidad: "producto",
          entidad_id: sku,
          operario: "costo-batch",
          params: { sku, costo_neto: costo, factura_ref, run_id: runId, modo: res.modo },
          error: res.error,
        });
      } catch {
        // nunca bloquear por audit
      }
    }
  }

  // Audit resumen del run
  try {
    await sb.from("audit_log").insert({
      accion: "costo_batch_run",
      entidad: "batch",
      entidad_id: runId,
      operario: "costo-batch",
      params: { total: filas.length, dry_run: dryRun },
      resultado: { exitosos, errores },
    });
  } catch {
    // never block on audit
  }

  return NextResponse.json({
    ok: errores === 0,
    run_id: runId,
    dry_run: dryRun,
    total: filas.length,
    exitosos,
    errores,
    detalle,
  });
}
