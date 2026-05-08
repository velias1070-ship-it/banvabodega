import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

// POST /api/intelligence/reactivar
// Body: { sku_origen: string, motivo?: string }
//
// Marca un SKU como is_new_sku=true en sku_node_policy (ambos nodos:
// bodega_central y full_ml). Esto fuerza al motor a tratarlo como SKU
// nuevo y entrarlo al cálculo de pedido/envío, sobrepasando el filtro
// CZ no_reorder de v_safety_stock.
//
// Caso de uso: SKUs durmientes que vendían bien históricamente pero
// el motor enterró. El admin (desde tab Durmientes) decide reactivarlos
// para que comience a recibir acciones. Idempotente.
//
// Audit: queda log en audit_log para trazabilidad.

export const dynamic = "force-dynamic";

interface Body {
  sku_origen?: string;
  motivo?: string;
}

export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const sku = (body.sku_origen || "").toUpperCase().trim();
  if (!sku) return NextResponse.json({ error: "sku_origen requerido" }, { status: 400 });

  const motivo = (body.motivo || "reactivado_manual_durmientes").slice(0, 200);

  // Verificar que el SKU exista en productos
  const { data: prodRows, error: prodErr } = await sb.from("productos")
    .select("sku, nombre, proveedor").eq("sku", sku).maybeSingle();
  if (prodErr) return NextResponse.json({ error: prodErr.message }, { status: 500 });
  if (!prodRows) return NextResponse.json({ error: `SKU ${sku} no existe en productos` }, { status: 404 });

  // Update sku_node_policy: is_new_sku=true para ambos nodos.
  const { data: updRows, error: updErr } = await sb.from("sku_node_policy")
    .update({ is_new_sku: true })
    .eq("sku_origen", sku)
    .select("sku_origen, node_id, is_new_sku");
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  // Audit log
  const { error: audErr } = await sb.from("audit_log").insert({
    accion: "reactivar_durmiente",
    entidad: "sku_node_policy",
    params: { sku_origen: sku, motivo },
    resultado: { rows_actualizadas: (updRows || []).length, nodes: (updRows || []).map(r => r.node_id) },
  });
  if (audErr) console.error("[reactivar] audit_log:", audErr.message);

  return NextResponse.json({
    ok: true,
    sku_origen: sku,
    nombre: prodRows.nombre,
    proveedor: prodRows.proveedor,
    nodos_actualizados: (updRows || []).length,
    nota: "El SKU entrará al motor en el próximo recálculo. Tocá 'Recalcular' en Inteligencia para verlo de inmediato.",
  });
}
