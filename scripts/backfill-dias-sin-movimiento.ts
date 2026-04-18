/**
 * backfill-dias-sin-movimiento — repara el centinela 999 (PR6a).
 *
 * Para cada SKU en sku_intelligence:
 *   - Si tiene movimientos en `movimientos` (tabla) → recalcular
 *     `dias_sin_movimiento = floor((now - max(created_at))/día)` y persistir
 *     `ultimo_movimiento = max(created_at)`.
 *   - Si no tiene movimientos → dejar `dias_sin_movimiento = NULL` (v56 lo permite).
 *
 * NO toca los demás campos del row. No recalcula acción/prioridad — el próximo
 * run del motor lo hará con la data limpia.
 *
 * Uso:
 *   tsx scripts/backfill-dias-sin-movimiento.ts --dry-run
 *   tsx scripts/backfill-dias-sin-movimiento.ts --apply
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_ANON);
const mode = process.argv.includes("--apply") ? "apply" : "dry-run";

interface Plan {
  sku: string;
  accion: string;
  dias_pre: number | null;
  dias_post: number | null;
  ultimo_movimiento_post: string | null;
  recupera_nuevo: boolean; // SKU que pasa de DEAD_STOCK/INACTIVO a NUEVO con el fix
}

async function paginatedSelect<T>(build: () => ReturnType<typeof sb.from>): Promise<T[]> {
  const all: T[] = [];
  const size = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await build().range(offset, offset + size - 1);
    if (error) throw new Error(String(error.message));
    if (!data || data.length === 0) break;
    all.push(...(data as unknown as T[]));
    if (data.length < size) break;
    offset += size;
  }
  return all;
}

async function main() {
  const hoy = new Date();
  console.log(`backfill-dias-sin-movimiento @ ${hoy.toISOString()} mode=${mode}`);

  // 1) Última fecha de movimiento por SKU (ventana abierta, no 60d, para recuperar todos).
  const movs = await paginatedSelect<{ sku: string; created_at: string }>(
    () => sb.from("movimientos").select("sku, created_at")
  );
  const ultPorSku = new Map<string, string>();
  for (const m of movs) {
    const prev = ultPorSku.get(m.sku);
    if (!prev || m.created_at > prev) ultPorSku.set(m.sku, m.created_at);
  }
  console.log(`Movimientos totales: ${movs.length}; SKUs con mov: ${ultPorSku.size}`);

  // 2) Estado actual.
  type RowSi = {
    sku_origen: string; accion: string;
    dias_sin_movimiento: number | null; ultimo_movimiento: string | null;
    vel_ponderada: number; vel_pre_quiebre: number; stock_total: number;
  };
  const rows = await paginatedSelect<RowSi>(
    () => sb.from("sku_intelligence")
      .select("sku_origen, accion, dias_sin_movimiento, ultimo_movimiento, vel_ponderada, vel_pre_quiebre, stock_total")
  );

  // 3) Planificar.
  const MS_DIA = 86_400_000;
  const hoyMs = hoy.getTime();
  const planes: Plan[] = [];
  for (const r of rows) {
    const ult = ultPorSku.get(r.sku_origen) ?? null;
    const diasPost = ult ? Math.floor((hoyMs - new Date(ult).getTime()) / MS_DIA) : null;

    // ¿Se habría evitado DEAD_STOCK/INACTIVO si diasPost fuera ≤30?
    const sinHistoria = (r.vel_ponderada || 0) === 0 && (r.vel_pre_quiebre || 0) === 0;
    const tieneStock = (r.stock_total || 0) > 0;
    const movReciente = diasPost === null || diasPost <= 30;
    const recuperaNuevo = sinHistoria && tieneStock && movReciente
      && (r.accion === "DEAD_STOCK" || r.accion === "INACTIVO");

    // Sólo incluimos en el plan si hay cambio real vs estado actual
    const diasActual = r.dias_sin_movimiento;
    const ultActual = r.ultimo_movimiento;
    const cambiaDias = (diasActual ?? -1) !== (diasPost ?? -1);
    const cambiaUlt = (ultActual || null) !== (ult || null);
    if (!cambiaDias && !cambiaUlt) continue;

    planes.push({
      sku: r.sku_origen, accion: r.accion,
      dias_pre: diasActual, dias_post: diasPost,
      ultimo_movimiento_post: ult,
      recupera_nuevo: recuperaNuevo,
    });
  }

  // 4) Resumen.
  const total = planes.length;
  const pasan_a_null = planes.filter(p => p.dias_post === null).length;
  const con_valor = planes.filter(p => p.dias_post !== null).length;
  const recuperan_nuevo = planes.filter(p => p.recupera_nuevo).length;

  console.log(`\nTotal a actualizar: ${total} (de ${rows.length} SKUs)`);
  console.log(`  pasan a NULL (sin movs): ${pasan_a_null}`);
  console.log(`  con valor concreto     : ${con_valor}`);
  console.log(`  candidatos a NUEVO     : ${recuperan_nuevo} SKUs (DEAD_STOCK/INACTIVO hoy con mov reciente)`);

  // 5) Sample detallado
  const byCat = planes.reduce<Record<string, number>>((acc, p) => {
    acc[p.accion] = (acc[p.accion] || 0) + 1;
    return acc;
  }, {});
  console.log(`\nPor acción actual:`);
  for (const [a, n] of Object.entries(byCat).sort((x, y) => y[1] - x[1])) console.log(`  ${a.padEnd(25)} ${n}`);

  console.log(`\nTop 15 candidatos a NUEVO:`);
  for (const p of planes.filter(p => p.recupera_nuevo).slice(0, 15)) {
    console.log(`  ${p.sku.padEnd(20)} ${p.accion.padEnd(12)} dias: ${String(p.dias_pre).padStart(4)} → ${String(p.dias_post).padStart(4)}  mov: ${p.ultimo_movimiento_post?.slice(0, 10)}`);
  }

  if (mode === "apply" && planes.length > 0) {
    console.log(`\nAplicando ${planes.length} UPDATEs...`);
    let ok = 0, fail = 0;
    for (const p of planes) {
      const { error } = await sb.from("sku_intelligence").update({
        dias_sin_movimiento: p.dias_post,
        ultimo_movimiento: p.ultimo_movimiento_post,
      }).eq("sku_origen", p.sku);
      if (error) { console.error(`  FAIL ${p.sku}: ${error.message}`); fail++; } else ok++;
    }
    console.log(`Listo. OK: ${ok}, fallidos: ${fail}. El próximo recálculo del motor reclasificará acciones.`);
  } else if (mode === "dry-run") {
    console.log(`\n(dry-run: no se aplicaron cambios. Correr con --apply para ejecutar.)`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
