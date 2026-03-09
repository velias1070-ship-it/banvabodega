import { NextRequest, NextResponse } from "next/server";
import { fetchAgentRules, insertAgentRule, updateAgentRule, deleteAgentRule } from "@/lib/agents-db";

export async function GET(req: NextRequest) {
  try {
    const agente = req.nextUrl.searchParams.get("agente") || undefined;
    const rules = await fetchAgentRules(agente);
    return NextResponse.json({ rules });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { agente, regla, contexto, prioridad } = body as {
      agente: string; regla: string; contexto?: string; prioridad?: number;
    };

    if (!agente || !regla) {
      return NextResponse.json({ error: "Faltan campos requeridos" }, { status: 400 });
    }

    await insertAgentRule({
      agente,
      regla,
      contexto: contexto || null,
      origen: "manual",
      origen_insight_id: null,
      prioridad: prioridad || 5,
      activa: true,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, ...fields } = body as { id: string; [key: string]: unknown };

    if (!id) {
      return NextResponse.json({ error: "Falta id" }, { status: 400 });
    }

    await updateAgentRule(id, fields);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "Falta id" }, { status: 400 });
    }

    await deleteAgentRule(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
