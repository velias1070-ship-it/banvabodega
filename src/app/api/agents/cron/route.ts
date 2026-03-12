import { NextRequest, NextResponse } from "next/server";
import { fetchAgentTriggersServer, updateAgentTriggerServer, DBAgentTrigger } from "@/lib/agents-db";

const CRON_SECRET = process.env.AGENTS_CRON_SECRET || "";

// Mapeo de días en español a números (0=dom, 1=lun, ..., 6=sab)
const DIA_MAP: Record<string, number> = {
  dom: 0, lun: 1, mar: 2, mie: 3, jue: 4, vie: 5, sab: 6,
};

function getChileNow(): Date {
  // Obtener hora actual en Chile (America/Santiago)
  const now = new Date();
  const chileStr = now.toLocaleString("en-US", { timeZone: "America/Santiago" });
  return new Date(chileStr);
}

function isSameDay(d1: Date, d2: Date): boolean {
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();
}

function isSameWeek(d1: Date, d2: Date): boolean {
  // Get Monday of each week
  const getMonday = (d: Date) => {
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.getFullYear(), d.getMonth(), diff);
  };
  const m1 = getMonday(d1);
  const m2 = getMonday(d2);
  return isSameDay(m1, m2);
}

function isSameMonth(d1: Date, d2: Date): boolean {
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth();
}

function shouldExecuteTrigger(trigger: DBAgentTrigger, now: Date): boolean {
  const config = trigger.configuracion as {
    intervalo?: string;
    hora?: string;
    dias?: string[];
    dia_mes?: number;
  };

  if (!config.hora) return false;

  // Parse hora configurada
  const [horaConfig, minConfig] = config.hora.split(":").map(Number);
  const nowHour = now.getHours();
  const nowMin = now.getMinutes();

  // Solo ejecutar si la hora actual es >= hora del trigger (dentro de la misma hora)
  if (nowHour < horaConfig) return false;
  if (nowHour === horaConfig && nowMin < minConfig) return false;

  // Verificar que no se ejecutó ya en este período
  const lastExec = trigger.ultima_ejecucion ? new Date(trigger.ultima_ejecucion) : null;
  // Convert lastExec to Chile timezone for comparison
  const lastExecChile = lastExec
    ? new Date(lastExec.toLocaleString("en-US", { timeZone: "America/Santiago" }))
    : null;

  const dayOfWeek = now.getDay(); // 0=dom, 1=lun...

  switch (config.intervalo) {
    case "diario": {
      // Verificar que hoy es uno de los días configurados
      if (config.dias) {
        const todayStr = Object.entries(DIA_MAP).find(([, v]) => v === dayOfWeek)?.[0];
        if (!todayStr || !config.dias.includes(todayStr)) return false;
      }
      // No ejecutar si ya se ejecutó hoy
      if (lastExecChile && isSameDay(lastExecChile, now)) return false;
      return true;
    }

    case "semanal": {
      // Verificar día de la semana
      if (config.dias) {
        const todayStr = Object.entries(DIA_MAP).find(([, v]) => v === dayOfWeek)?.[0];
        if (!todayStr || !config.dias.includes(todayStr)) return false;
      }
      // No ejecutar si ya se ejecutó esta semana (para el mismo día)
      if (lastExecChile && isSameDay(lastExecChile, now)) return false;
      return true;
    }

    case "mensual": {
      // Verificar día del mes
      if (config.dia_mes && now.getDate() !== config.dia_mes) return false;
      // No ejecutar si ya se ejecutó este mes
      if (lastExecChile && isSameMonth(lastExecChile, now)) return false;
      return true;
    }

    default:
      return false;
  }
}

/**
 * GET /api/agents/cron
 * Called hourly by Vercel Cron. Evaluates time-based triggers and executes matching agents.
 */
export async function GET(req: NextRequest) {
  // Verify authorization
  const authHeader = req.headers.get("authorization");
  const querySecret = req.nextUrl.searchParams.get("secret");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = CRON_SECRET && querySecret === CRON_SECRET;
  const isLocalDev = process.env.NODE_ENV === "development";

  if (!isVercelCron && !isManual && !isLocalDev && CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const now = getChileNow();
    console.log(`[agents/cron] Evaluando triggers de tiempo. Hora Chile: ${now.toLocaleString("es-CL")}`);

    // Fetch active time triggers
    const triggers = await fetchAgentTriggersServer({ tipo: "tiempo", activo: true });
    if (triggers.length === 0) {
      return NextResponse.json({ status: "ok", message: "No hay triggers de tiempo activos", ejecutados: 0 });
    }

    const ejecutados: { agente: string; trigger_nombre: string }[] = [];

    // Determine base URL for internal API calls
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000";

    for (const trigger of triggers) {
      if (!shouldExecuteTrigger(trigger, now)) continue;

      console.log(`[agents/cron] Ejecutando trigger '${trigger.nombre}' para agente '${trigger.agente}'`);

      // Execute agent (fire and forget to avoid timeout issues with long-running agents)
      try {
        const res = await fetch(`${baseUrl}/api/agents/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agente: trigger.agente,
            trigger: "cron",
          }),
        });

        if (res.ok) {
          ejecutados.push({ agente: trigger.agente, trigger_nombre: trigger.nombre });
        } else {
          const err = await res.text();
          console.error(`[agents/cron] Error ejecutando ${trigger.agente}: ${err}`);
        }
      } catch (err) {
        console.error(`[agents/cron] Error de red ejecutando ${trigger.agente}:`, err);
      }

      // Update ultima_ejecucion
      await updateAgentTriggerServer(trigger.id, {
        ultima_ejecucion: new Date().toISOString(),
      });
    }

    console.log(`[agents/cron] Completado. ${ejecutados.length} triggers ejecutados.`);

    return NextResponse.json({
      status: "ok",
      hora_chile: now.toLocaleString("es-CL"),
      triggers_evaluados: triggers.length,
      ejecutados: ejecutados.length,
      detalle: ejecutados,
    });

  } catch (err) {
    console.error("[agents/cron] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
