import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/proveedores/resolve
 *
 * Resuelve un proveedor al nombre canónico + id, usando RUT como key.
 *
 * Body: { rut?: string, razon_social?: string, nombre?: string }
 *   - rut: preferido cuando viene del DTE (match exacto por RUT único).
 *   - razon_social: para fallback por alias si no hay RUT.
 *   - nombre: último fallback (comparación case-insensitive con nombre existente).
 *
 * Response: { id: string, nombre_canonico: string, created: boolean }
 *
 * Comportamiento:
 *   1. Si viene RUT: buscar en proveedores(rut) → devolver id + nombre_canonico.
 *      Si no existe → crear proveedor nuevo con nombre = razon_social (o nombre) y
 *      razón_social = razon_social.
 *   2. Si no hay RUT: buscar por alias (proveedores.aliases array contains razon_social o nombre).
 *      Si no → por nombre case-insensitive.
 *      Si no → crear con razon_social/nombre como fallback.
 *   3. Siempre agregar razon_social a aliases si no está ya (aprendizaje automático).
 *
 * Idempotente: múltiples calls con el mismo RUT siempre devuelven el mismo id.
 * Race-safe: depende de UNIQUE index en rut (creado en v72).
 */

interface ResolveBody {
  rut?: string;
  razon_social?: string;
  nombre?: string;
}

interface ProveedorRow {
  id: string;
  nombre: string;
  nombre_canonico: string | null;
  rut: string | null;
  razon_social: string | null;
  aliases: string[] | null;
}

const normRut = (rut: string): string => (rut || "").replace(/[.\s]/g, "").toUpperCase();
const normStr = (s: string): string => (s || "").toUpperCase().trim()
  .replace(/\s+(S\.?A\.?|SPA|LTDA\.?|LIMITADA|SRL|EIRL)\.?$/i, "")
  .replace(/[.,]/g, "").replace(/\s+/g, " ").trim();

export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  let body: ResolveBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const rutNorm = body.rut ? normRut(body.rut) : "";
  const razonSocial = (body.razon_social || "").trim();
  const nombreHint = (body.nombre || razonSocial || "").trim();

  if (!rutNorm && !razonSocial && !nombreHint) {
    return NextResponse.json({ error: "needs_rut_or_name" }, { status: 400 });
  }

  // Cargar todos los proveedores (tabla es pequeña, <1000 filas)
  const { data: provs, error: fetchErr } = await sb.from("proveedores")
    .select("id, nombre, nombre_canonico, rut, razon_social, aliases");
  if (fetchErr) {
    return NextResponse.json({ error: `fetch_failed: ${fetchErr.message}` }, { status: 500 });
  }
  const rows = (provs || []) as ProveedorRow[];

  // 1. Match por RUT (prioridad)
  let matched: ProveedorRow | null = null;
  if (rutNorm) {
    matched = rows.find(p => normRut(p.rut || "") === rutNorm) || null;
  }

  // 2. Match por alias (lista de nombres/razones alternativas guardadas)
  if (!matched && razonSocial) {
    const target = normStr(razonSocial);
    matched = rows.find(p => {
      const aliases = p.aliases || [];
      return aliases.some(a => normStr(a) === target) ||
             normStr(p.razon_social || "") === target;
    }) || null;
  }

  // 3. Match por nombre_canonico o nombre
  if (!matched && nombreHint) {
    const target = normStr(nombreHint);
    matched = rows.find(p =>
      normStr(p.nombre_canonico || p.nombre || "") === target
    ) || null;
  }

  // 4. Crear si no existe
  let created = false;
  if (!matched) {
    const newNombre = razonSocial || nombreHint || "Proveedor sin nombre";
    const { data: inserted, error: insErr } = await sb.from("proveedores")
      .insert({
        nombre: newNombre,
        nombre_canonico: newNombre,
        rut: rutNorm || null,
        razon_social: razonSocial || null,
        aliases: razonSocial ? [razonSocial] : [],
        lead_time_dias: 7,  // default
      })
      .select("id, nombre, nombre_canonico, rut, razon_social, aliases")
      .single();
    if (insErr) {
      // Si chocó con UNIQUE de rut por race condition, reintentamos el fetch
      if (insErr.code === "23505" && rutNorm) {
        const { data: retry } = await sb.from("proveedores")
          .select("id, nombre, nombre_canonico, rut, razon_social, aliases")
          .eq("rut", rutNorm).single();
        if (retry) matched = retry as ProveedorRow;
      }
      if (!matched) {
        return NextResponse.json({ error: `insert_failed: ${insErr.message}` }, { status: 500 });
      }
    } else {
      matched = inserted as ProveedorRow;
      created = true;
    }
  }

  // 5. Aprender alias si es nuevo (aditivo, no destructivo)
  if (matched && razonSocial) {
    const aliases = matched.aliases || [];
    const razonNorm = normStr(razonSocial);
    const existe = aliases.some(a => normStr(a) === razonNorm) ||
                   normStr(matched.nombre_canonico || matched.nombre || "") === razonNorm;
    if (!existe) {
      const nuevasAliases = [...aliases, razonSocial];
      const updates: Record<string, unknown> = { aliases: nuevasAliases };
      // Si no tenía razon_social guardada, guardamos esta
      if (!matched.razon_social) updates.razon_social = razonSocial;
      // Si tenía RUT pero le viene RUT nuevo y son distintos, NO tocar (caso raro)
      if (rutNorm && !matched.rut) updates.rut = rutNorm;
      await sb.from("proveedores").update(updates).eq("id", matched.id);
    }
  }

  return NextResponse.json({
    id: matched!.id,
    nombre_canonico: matched!.nombre_canonico || matched!.nombre,
    created,
  });
}
