import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/proveedores/backfill?dry_run=1
 *
 * Recorre las 5 tablas con proveedor string (recepciones, ordenes_compra,
 * productos, proveedor_catalogo, rcv_compras) y popula proveedor_id usando
 * la misma lógica que /api/proveedores/resolve:
 *   1. rut exacto (solo rcv_compras tiene rut)
 *   2. alias / razon_social (tablas con solo proveedor string)
 *   3. nombre_canonico / nombre
 *   4. crear proveedor si no existe
 *
 * Query params:
 *   - dry_run=1: no escribe, solo devuelve estadísticas (default: false)
 *   - tabla: limitar a una sola tabla (ej "recepciones")
 *
 * Response: {
 *   dryRun: boolean,
 *   tablas: {
 *     [tabla]: { total: N, resolved: N, created: N, errors: N }
 *   },
 *   nuevos_proveedores: [{ id, nombre, razon_social }]
 * }
 *
 * Idempotente: re-correr solo toca filas con proveedor_id=null.
 */

const normRut = (rut: string): string => (rut || "").replace(/[.\s]/g, "").toUpperCase();
const normStr = (s: string): string => (s || "").toUpperCase().trim()
  .replace(/\s+(S\.?A\.?|SPA|LTDA\.?|LIMITADA|SRL|EIRL)\.?$/i, "")
  .replace(/[.,]/g, "").replace(/\s+/g, " ").trim();

interface ProveedorRow {
  id: string;
  nombre: string;
  nombre_canonico: string | null;
  rut: string | null;
  razon_social: string | null;
  aliases: string[] | null;
}

const TABLAS_PROVEEDOR: Array<{ name: string; col: string; rutCol?: string; idCol: string }> = [
  { name: "recepciones", col: "proveedor", idCol: "id" },
  { name: "ordenes_compra", col: "proveedor", idCol: "id" },
  { name: "productos", col: "proveedor", idCol: "id" },
  { name: "proveedor_catalogo", col: "proveedor", idCol: "id" },
  { name: "rcv_compras", col: "razon_social", rutCol: "rut_proveedor", idCol: "id" },
];

export async function POST(req: NextRequest) {
  const sbOrNull = getServerSupabase();
  if (!sbOrNull) return NextResponse.json({ error: "no_db" }, { status: 500 });
  const sb = sbOrNull; // narrow type para closures

  const dryRun = req.nextUrl.searchParams.get("dry_run") === "1";
  const tablaFiltro = req.nextUrl.searchParams.get("tabla");

  // Pre-cargar todos los proveedores
  const { data: provData } = await sb.from("proveedores")
    .select("id, nombre, nombre_canonico, rut, razon_social, aliases");
  const proveedores = (provData || []) as ProveedorRow[];

  function findProveedor(rut: string, strVal: string): ProveedorRow | null {
    const rutNorm = rut ? normRut(rut) : "";
    if (rutNorm) {
      const byRut = proveedores.find(p => normRut(p.rut || "") === rutNorm);
      if (byRut) return byRut;
    }
    if (strVal) {
      const target = normStr(strVal);
      const byAlias = proveedores.find(p => {
        const aliases = p.aliases || [];
        return aliases.some(a => normStr(a) === target) ||
               normStr(p.razon_social || "") === target ||
               normStr(p.nombre_canonico || p.nombre || "") === target;
      });
      if (byAlias) return byAlias;
    }
    return null;
  }

  async function createProveedor(rut: string, strVal: string): Promise<ProveedorRow | null> {
    const rutNorm = rut ? normRut(rut) : null;
    const newNombre = strVal || "Proveedor sin nombre";
    const { data, error } = await sb.from("proveedores")
      .insert({
        nombre: newNombre,
        nombre_canonico: newNombre,
        rut: rutNorm,
        razon_social: strVal || null,
        aliases: strVal ? [strVal] : [],
        lead_time_dias: 7,
      })
      .select("id, nombre, nombre_canonico, rut, razon_social, aliases")
      .single();
    if (error) {
      // Race-safe: si chocó con UNIQUE en rut, buscar el existente
      if (error.code === "23505" && rutNorm) {
        const { data: retry } = await sb.from("proveedores")
          .select("id, nombre, nombre_canonico, rut, razon_social, aliases")
          .eq("rut", rutNorm).single();
        return retry as ProveedorRow | null;
      }
      console.error(`[backfill] insert proveedor falló: ${error.message}`);
      return null;
    }
    const row = data as ProveedorRow;
    proveedores.push(row);
    return row;
  }

  const resultados: Record<string, { total: number; resolved: number; created: number; errors: number }> = {};
  const nuevosProveedores = new Set<string>();

  for (const t of TABLAS_PROVEEDOR) {
    if (tablaFiltro && t.name !== tablaFiltro) continue;
    resultados[t.name] = { total: 0, resolved: 0, created: 0, errors: 0 };

    // Traer filas sin proveedor_id aún
    const selectCols = [t.idCol, t.col];
    if (t.rutCol) selectCols.push(t.rutCol);
    const { data: rows, error: selErr } = await sb.from(t.name)
      .select(selectCols.join(",") + ", proveedor_id")
      .is("proveedor_id", null)
      .not(t.col, "is", null)
      .limit(5000);
    if (selErr) {
      console.error(`[backfill] select ${t.name}: ${selErr.message}`);
      continue;
    }
    const data = (rows || []) as unknown as Array<Record<string, unknown>>;
    resultados[t.name].total = data.length;

    // Cachear por (rut, strVal) para no hacer resolve mil veces si se repiten
    const cache = new Map<string, ProveedorRow | null>();

    for (const row of data) {
      const rut = t.rutCol ? (row[t.rutCol] as string || "") : "";
      const strVal = (row[t.col] as string) || "";
      const cacheKey = `${normRut(rut)}|${normStr(strVal)}`;

      let prov: ProveedorRow | null = null;
      if (cache.has(cacheKey)) {
        prov = cache.get(cacheKey) || null;
      } else {
        prov = findProveedor(rut, strVal);
        if (!prov && !dryRun) {
          prov = await createProveedor(rut, strVal);
          if (prov) {
            nuevosProveedores.add(prov.id);
            resultados[t.name].created++;
          }
        }
        cache.set(cacheKey, prov);
      }

      if (!prov) {
        resultados[t.name].errors++;
        continue;
      }

      resultados[t.name].resolved++;
      if (!dryRun) {
        const { error: upErr } = await sb.from(t.name)
          .update({ proveedor_id: prov.id })
          .eq(t.idCol, row[t.idCol]);
        if (upErr) {
          resultados[t.name].errors++;
          resultados[t.name].resolved--;
          console.error(`[backfill] update ${t.name}.${row[t.idCol]}: ${upErr.message}`);
        }
      }
    }
  }

  // Info de proveedores nuevos (si se crearon)
  const nuevos = proveedores
    .filter(p => nuevosProveedores.has(p.id))
    .map(p => ({ id: p.id, nombre: p.nombre_canonico || p.nombre, razon_social: p.razon_social }));

  return NextResponse.json({
    dryRun,
    tablas: resultados,
    nuevos_proveedores: nuevos,
  });
}
