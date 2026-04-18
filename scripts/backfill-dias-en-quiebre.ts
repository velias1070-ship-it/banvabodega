/**
 * backfill-dias-en-quiebre — limpia los valores inflados del bug PR5.
 *
 * Target:
 *   - SKUs con `dias_en_quiebre > 180` y `accion NOT IN (URGENTE, AGOTADO_*, EN_TRANSITO)`
 *     → reset (no estaban en quiebre real).
 *   - SKUs con `dias_en_quiebre > 0` y `accion IN (OK, EXCESO, MANDAR_FULL, PLANIFICAR)`
 *     → reset (la rama de reset no los limpió).
 *   - SKUs en quiebre legítimo (`AGOTADO_*`, `URGENTE` con stock=0) con `dias > 180`:
 *     usar `min(fecha)` de `stock_snapshots` con `en_quiebre_full=true` como ancla.
 *     Si no hay snapshot, setear `fecha_entrada_quiebre = hoy − 7 días`
 *     (fallback conservador; el motor la corregirá en próximos ciclos).
 *
 * Uso:
 *   tsx scripts/backfill-dias-en-quiebre.ts --dry-run    (imprime plan, no escribe)
 *   tsx scripts/backfill-dias-en-quiebre.ts --apply      (ejecuta UPDATEs)
 *
 * Output: tabla antes/después + impacto agregado en pedir_proveedor (uds + CLP).
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
const ACCIONES_QUIEBRE = ["URGENTE", "AGOTADO_PEDIR", "AGOTADO_SIN_PROVEEDOR", "EN_TRANSITO"] as const;
const ACCIONES_SALUDABLES = ["OK", "EXCESO", "MANDAR_FULL", "PLANIFICAR"] as const;

interface Row {
  sku_origen: string;
  nombre: string | null;
  accion: string;
  dias_en_quiebre: number | null;
  pedir_proveedor: number;
  pedir_proveedor_sin_rampup: number;
  factor_rampup_aplicado: number | null;
  stock_total: number;
  stock_full: number;
  vel_ponderada: number;
}

interface Plan {
  sku: string;
  nombre: string;
  accion: string;
  dias_actual: number;
  dias_nuevo: number;
  fecha_ancla: string | null;
  pedir_hoy: number;
  pedir_sin_rampup: number;
  uds_desbloqueadas_estim: number;
  categoria: "reset_fosil" | "reset_saludable" | "reanclar_legitimo";
}

async function main() {
  const hoy = new Date();
  const hoyIso = hoy.toISOString().slice(0, 10);
  console.log(`backfill-dias-en-quiebre @ ${hoy.toISOString()} mode=${mode}`);

  // 1) SKUs candidatos.
  const { data: rows, error } = await sb
    .from("sku_intelligence")
    .select("sku_origen, nombre, accion, dias_en_quiebre, pedir_proveedor, pedir_proveedor_sin_rampup, factor_rampup_aplicado, stock_total, stock_full, vel_ponderada")
    .not("dias_en_quiebre", "is", null);
  if (error) throw new Error(error.message);
  const all = (rows || []) as Row[];

  // 2) Precios del catálogo para cuantificar impacto CLP.
  const { data: cat } = await sb
    .from("proveedor_catalogo")
    .select("sku_origen, precio_neto");
  const precioPorSku = new Map<string, number>();
  for (const c of cat || []) {
    precioPorSku.set((c.sku_origen as string).toUpperCase(), Number(c.precio_neto) || 0);
  }

  // 3) Snapshots de quiebre con fecha real, para reanclar SKUs legítimos.
  const { data: snaps } = await sb
    .from("stock_snapshots")
    .select("sku_origen, fecha, en_quiebre_full")
    .eq("en_quiebre_full", true);
  const primerQuiebrePorSku = new Map<string, string>();
  for (const s of snaps || []) {
    const sku = (s.sku_origen as string).toUpperCase();
    const f = s.fecha as string;
    const prev = primerQuiebrePorSku.get(sku);
    if (!prev || f < prev) primerQuiebrePorSku.set(sku, f);
  }

  // 4) Clasificar cada SKU candidato.
  const planes: Plan[] = [];
  for (const r of all) {
    const sku = r.sku_origen.toUpperCase();
    const dias = r.dias_en_quiebre ?? 0;
    const esQuiebreAccion = (ACCIONES_QUIEBRE as readonly string[]).includes(r.accion);
    const esSaludable = (ACCIONES_SALUDABLES as readonly string[]).includes(r.accion);

    if (dias <= 0) continue; // sin bug

    if (esSaludable) {
      // Fósil en acción saludable → reset.
      planes.push({
        sku, nombre: r.nombre || "—", accion: r.accion,
        dias_actual: dias, dias_nuevo: 0, fecha_ancla: null,
        pedir_hoy: r.pedir_proveedor, pedir_sin_rampup: r.pedir_proveedor_sin_rampup,
        uds_desbloqueadas_estim: Math.max(0, r.pedir_proveedor_sin_rampup - r.pedir_proveedor),
        categoria: "reset_saludable",
      });
      continue;
    }

    if (!esQuiebreAccion && dias > 180) {
      // >180 días con acción que no es de quiebre (NUEVO, INACTIVO, DEAD_STOCK, etc.)
      // → reset (el motor lo recalibrará en el próximo run).
      planes.push({
        sku, nombre: r.nombre || "—", accion: r.accion,
        dias_actual: dias, dias_nuevo: 0, fecha_ancla: null,
        pedir_hoy: r.pedir_proveedor, pedir_sin_rampup: r.pedir_proveedor_sin_rampup,
        uds_desbloqueadas_estim: Math.max(0, r.pedir_proveedor_sin_rampup - r.pedir_proveedor),
        categoria: "reset_fosil",
      });
      continue;
    }

    if (esQuiebreAccion && dias > 180) {
      // Quiebre real pero valor inflado: reanclar con snapshot histórico si existe.
      const snapFecha = primerQuiebrePorSku.get(sku);
      let ancla = snapFecha;
      let nuevoDias = snapFecha
        ? Math.floor((new Date(hoyIso).getTime() - new Date(snapFecha).getTime()) / 86_400_000)
        : 7; // fallback conservador: 7 días
      if (!snapFecha) {
        const fallback = new Date(hoy);
        fallback.setUTCDate(fallback.getUTCDate() - 7);
        ancla = fallback.toISOString().slice(0, 10);
        nuevoDias = 7;
      }
      nuevoDias = Math.min(365, Math.max(0, nuevoDias));
      planes.push({
        sku, nombre: r.nombre || "—", accion: r.accion,
        dias_actual: dias, dias_nuevo: nuevoDias, fecha_ancla: ancla || null,
        pedir_hoy: r.pedir_proveedor, pedir_sin_rampup: r.pedir_proveedor_sin_rampup,
        uds_desbloqueadas_estim: Math.max(0, r.pedir_proveedor_sin_rampup - r.pedir_proveedor),
        categoria: "reanclar_legitimo",
      });
    }
  }

  // 5) Resumen
  const total = planes.length;
  const porCategoria = planes.reduce<Record<string, number>>((acc, p) => {
    acc[p.categoria] = (acc[p.categoria] || 0) + 1;
    return acc;
  }, {});
  const udsAgregadas = planes.reduce((s, p) => s + p.uds_desbloqueadas_estim, 0);
  const clpAgregados = planes.reduce((s, p) => s + p.uds_desbloqueadas_estim * (precioPorSku.get(p.sku) || 0), 0);

  console.log(`\nTotal SKUs a tocar: ${total}`);
  for (const [cat, n] of Object.entries(porCategoria)) console.log(`  ${cat}: ${n}`);
  console.log(`\nImpacto estimado (post siguiente recálculo del motor):`);
  console.log(`  uds desbloqueadas en pedir_proveedor: ~${udsAgregadas}`);
  console.log(`  CLP netos (precio proveedor): ~$${clpAgregados.toLocaleString("es-CL")}`);

  // 6) Detalle
  console.log(`\nDetalle:`);
  for (const p of [...planes].sort((a, b) => b.dias_actual - a.dias_actual)) {
    const arrow = p.dias_nuevo === 0 ? "→ 0 (reset)" : `→ ${p.dias_nuevo} (ancla ${p.fecha_ancla})`;
    console.log(
      `  ${p.sku.padEnd(18)} ${p.accion.padEnd(22)} ${String(p.dias_actual).padStart(5)}d ${arrow}` +
      ` | pedir ${p.pedir_hoy}/${p.pedir_sin_rampup} (+${p.uds_desbloqueadas_estim} uds) [${p.categoria}]`,
    );
  }

  // 7) Apply (si corresponde)
  if (mode === "apply" && planes.length > 0) {
    console.log(`\nAplicando ${planes.length} UPDATEs...`);
    for (const p of planes) {
      const { error: upErr } = await sb.from("sku_intelligence").update({
        dias_en_quiebre: p.dias_nuevo,
        fecha_entrada_quiebre: p.fecha_ancla,
      }).eq("sku_origen", p.sku);
      if (upErr) console.error(`  FAIL ${p.sku}: ${upErr.message}`);
    }
    console.log(`Listo. El próximo recálculo del motor recalibrará pedir_proveedor.`);
  } else if (mode === "dry-run") {
    console.log(`\n(dry-run: no se aplicaron cambios. Correr con --apply para ejecutar.)`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
