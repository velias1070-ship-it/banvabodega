"use client";
import { useMemo, useState } from "react";
import { calcularMargen, generarCurvaMargen, tramoPorPeso, columnaPorPrecio, fmtCLP } from "@/lib/ml-shipping";
import { calcularFloor, margenPostAds, IVA_PCT, VALLE_MUERTE_MIN, VALLE_MUERTE_MAX } from "@/lib/pricing";

// Comisiones tipicas ML Chile en categorias textil hogar BANVA.
// Numeros de referencia — siempre se pueden override en el input.
const CATEGORIAS_PRESET: Array<{ key: string; label: string; comisionClasica: number }> = [
  { key: "plumones",   label: "Plumones / Cobertores", comisionClasica: 14.0 },
  { key: "sabanas",    label: "Sabanas / Juegos",      comisionClasica: 13.5 },
  { key: "almohadas",  label: "Almohadas",             comisionClasica: 16.0 },
  { key: "cubrecamas", label: "Cubrecamas / Quilts",   comisionClasica: 14.0 },
  { key: "toallas",    label: "Toallas",               comisionClasica: 15.0 },
  { key: "ropa_cama",  label: "Ropa de cama (otro)",   comisionClasica: 14.0 },
  { key: "otra",       label: "Otra (definir manual)", comisionClasica: 14.0 },
];

const PREMIUM_DELTA_PP = 3.0; // Premium suma ~3pp sobre Clasica (referencia)

type Canal = "flex" | "full";
type TipoPub = "clasica" | "premium";

// Divisor volumetrico ML Chile = 4000 (resultado en kg).
// Editable en UI por si ML actualiza la formula o para escenarios "what-if".
const ML_DIVISOR_VOLUMETRICO_DEFAULT = 4000;

function pesoVolumetrico(largoCm: number, anchoCm: number, altoCm: number, divisor: number): number {
  if (largoCm <= 0 || anchoCm <= 0 || altoCm <= 0 || divisor <= 0) return 0;
  return Math.round((largoCm * anchoCm * altoCm) / divisor * 1000);
}

export default function AdminCalculadora() {
  // --- Producto ---
  const [nombre, setNombre] = useState("");
  const [costoNetoStr, setCostoNetoStr] = useState("");

  // Peso facturable: dos modos
  const [modoPeso, setModoPeso] = useState<"directo" | "dimensiones">("directo");
  const [pesoGrStr, setPesoGrStr] = useState("");
  const [pesoRealStr, setPesoRealStr] = useState("");
  const [largoStr, setLargoStr] = useState("");
  const [anchoStr, setAnchoStr] = useState("");
  const [altoStr, setAltoStr] = useState("");
  const [divisorStr, setDivisorStr] = useState(String(ML_DIVISOR_VOLUMETRICO_DEFAULT));

  // --- ML ---
  const [categoriaKey, setCategoriaKey] = useState<string>("plumones");
  const [tipoPub, setTipoPub] = useState<TipoPub>("clasica");
  const [comisionOverrideStr, setComisionOverrideStr] = useState("");
  const [canal, setCanal] = useState<Canal>("flex");
  const [costoEnvioFullStr, setCostoEnvioFullStr] = useState("");

  // --- Pricing ---
  const [precioTentativoStr, setPrecioTentativoStr] = useState("");
  const [margenMinPctStr, setMargenMinPctStr] = useState("15");
  const [acosPctStr, setAcosPctStr] = useState("0");

  // ---- Derivados ----
  const costoNeto = Number(costoNetoStr) || 0;
  const costoBruto = Math.round(costoNeto * (1 + IVA_PCT));

  const pesoReal = Number(pesoRealStr) || 0;
  const divisorVol = Number(divisorStr) || ML_DIVISOR_VOLUMETRICO_DEFAULT;
  const pesoVol = pesoVolumetrico(Number(largoStr) || 0, Number(anchoStr) || 0, Number(altoStr) || 0, divisorVol);
  const pesoFacturable = modoPeso === "dimensiones"
    ? Math.max(pesoReal, pesoVol)
    : (Number(pesoGrStr) || 0);
  const tramo = tramoPorPeso(pesoFacturable);

  const catPreset = CATEGORIAS_PRESET.find(c => c.key === categoriaKey) || CATEGORIAS_PRESET[0];
  const comisionBase = catPreset.comisionClasica + (tipoPub === "premium" ? PREMIUM_DELTA_PP : 0);
  const comisionOverride = Number(comisionOverrideStr);
  const comisionPct = comisionOverrideStr.trim() !== "" && comisionOverride > 0
    ? comisionOverride
    : comisionBase;

  const precioTentativo = Number(precioTentativoStr) || 0;
  const margenMinPct = Number(margenMinPctStr) || 0;
  const acosPct = Number(acosPctStr) || 0;
  const costoEnvioFullUnit = canal === "full" ? (Number(costoEnvioFullStr) || 0) : 0;

  const floorInputs = useMemo(() => ({
    costoNeto,
    precioReferencia: precioTentativo > 0 ? precioTentativo : Math.max(costoBruto * 2, 9990),
    pesoGr: pesoFacturable,
    comisionPct,
    canal,
    costoEnvioFullUnit,
    acosFrac: acosPct / 100,
    margenMinimoFrac: margenMinPct / 100,
  }), [costoNeto, precioTentativo, costoBruto, pesoFacturable, comisionPct, canal, costoEnvioFullUnit, acosPct, margenMinPct]);

  const floorRes = useMemo(() => calcularFloor(floorInputs), [floorInputs]);

  const margenRes = useMemo(() => {
    if (!precioTentativo || !costoNeto) return null;
    return calcularMargen({
      precio: precioTentativo,
      costoBruto,
      pesoGr: pesoFacturable,
      comisionPct,
    });
  }, [precioTentativo, costoNeto, costoBruto, pesoFacturable, comisionPct]);

  // Margen post-ads (descuenta ads sobre el margen plano)
  const margenPostAdsFrac = useMemo(() => {
    if (!precioTentativo || !costoNeto) return null;
    return margenPostAds(precioTentativo, floorInputs);
  }, [precioTentativo, costoNeto, floorInputs]);

  const curva = useMemo(() => {
    if (!costoNeto || !pesoFacturable) return [];
    return generarCurvaMargen({
      precioActual: precioTentativo > 0 ? precioTentativo : 19990,
      costoBruto,
      pesoGr: pesoFacturable,
      comisionPct,
    });
  }, [costoNeto, pesoFacturable, precioTentativo, costoBruto, comisionPct]);

  // Validaciones
  const valleMuerte = precioTentativo > VALLE_MUERTE_MIN && precioTentativo < VALLE_MUERTE_MAX;
  const bajoFloor = precioTentativo > 0 && precioTentativo < floorRes.floor;
  const zona = precioTentativo > 0 ? columnaPorPrecio(precioTentativo) : null;

  // ---- Render ----
  const numStyle: React.CSSProperties = { fontFamily: "var(--font-mono, JetBrains Mono, monospace)" };

  return (
    <div style={{ padding: 16, maxWidth: 1200 }}>
      <h2 style={{ margin: 0, marginBottom: 4 }}>Calculadora de precios y margen</h2>
      <div style={{ color: "var(--txt3)", fontSize: 13, marginBottom: 16 }}>
        Evaluar un producto nuevo (o existente). Ingresa datos del producto + categoria ML + canal y obten precio piso, margen y curva de precios.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* COLUMNA INPUTS */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Producto */}
          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: "var(--txt2)" }}>1. PRODUCTO</div>
            <Field label="Nombre / SKU (opcional, solo display)">
              <input className="form-input" value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Ej: Plumon 2P Beige" />
            </Field>
            <Field label="Costo neto unitario (CLP, sin IVA)">
              <input className="form-input" inputMode="numeric" value={costoNetoStr} onChange={e => setCostoNetoStr(e.target.value.replace(/[^\d]/g, ""))} placeholder="Ej: 8500" />
              {costoNeto > 0 && (
                <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 4 }}>
                  Con IVA: <span style={numStyle}>{fmtCLP(costoBruto)}</span>
                </div>
              )}
            </Field>
          </div>

          {/* Peso */}
          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: "var(--txt2)" }}>2. PESO FACTURABLE</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <button
                className={`scan-btn ${modoPeso === "directo" ? "blue" : ""}`}
                style={{ flex: 1, padding: "8px 12px", fontSize: 12, opacity: modoPeso === "directo" ? 1 : 0.6 }}
                onClick={() => setModoPeso("directo")}
              >
                Lo se directo
              </button>
              <button
                className={`scan-btn ${modoPeso === "dimensiones" ? "blue" : ""}`}
                style={{ flex: 1, padding: "8px 12px", fontSize: 12, opacity: modoPeso === "dimensiones" ? 1 : 0.6 }}
                onClick={() => setModoPeso("dimensiones")}
              >
                Calcular desde dimensiones
              </button>
            </div>
            {modoPeso === "directo" ? (
              <Field label="Peso facturable (gramos)">
                <input className="form-input" inputMode="numeric" value={pesoGrStr} onChange={e => setPesoGrStr(e.target.value.replace(/[^\d]/g, ""))} placeholder="Ej: 2500" />
              </Field>
            ) : (
              <>
                <Field label="Peso real (gramos)">
                  <input className="form-input" inputMode="numeric" value={pesoRealStr} onChange={e => setPesoRealStr(e.target.value.replace(/[^\d]/g, ""))} placeholder="Ej: 1800" />
                </Field>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <Field label="Largo (cm)"><input className="form-input" inputMode="decimal" value={largoStr} onChange={e => setLargoStr(e.target.value.replace(/[^\d.]/g, ""))} placeholder="40" /></Field>
                  <Field label="Ancho (cm)"><input className="form-input" inputMode="decimal" value={anchoStr} onChange={e => setAnchoStr(e.target.value.replace(/[^\d.]/g, ""))} placeholder="30" /></Field>
                  <Field label="Alto (cm)"><input className="form-input" inputMode="decimal" value={altoStr} onChange={e => setAltoStr(e.target.value.replace(/[^\d.]/g, ""))} placeholder="15" /></Field>
                </div>
                <Field label={`Divisor volumetrico (default ML Chile = ${ML_DIVISOR_VOLUMETRICO_DEFAULT})`}>
                  <input className="form-input" inputMode="numeric" value={divisorStr} onChange={e => setDivisorStr(e.target.value.replace(/[^\d]/g, ""))} placeholder="4000" />
                  <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 4 }}>
                    Formula: (L × A × H) / divisor = peso vol en kg. ML Chile usa 4000. IATA aereo 6000. DHL 5000.
                  </div>
                </Field>
                {(pesoReal > 0 || pesoVol > 0) && (
                  <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 6 }}>
                    Real <span style={numStyle}>{pesoReal}g</span> · Volumetrico <span style={numStyle}>{pesoVol}g</span> (÷{divisorVol}) · ML usa el mayor: <b style={numStyle}>{pesoFacturable}g</b>
                  </div>
                )}
              </>
            )}
            {pesoFacturable > 0 && (
              <div style={{ marginTop: 8, padding: 8, background: "var(--bg3)", borderRadius: 6, fontSize: 12 }}>
                Tramo: <b>{tramo.label}</b>
                <div style={{ ...numStyle, color: "var(--txt2)", fontSize: 11, marginTop: 2 }}>
                  Envio Flex: barato {fmtCLP(tramo.costo_barato)} · medio {fmtCLP(tramo.costo_medio)} · caro {fmtCLP(tramo.costo_caro)}
                </div>
              </div>
            )}
          </div>

          {/* ML */}
          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: "var(--txt2)" }}>3. MERCADOLIBRE</div>
            <Field label="Categoria">
              <select className="form-input" value={categoriaKey} onChange={e => setCategoriaKey(e.target.value)}>
                {CATEGORIAS_PRESET.map(c => <option key={c.key} value={c.key}>{c.label} ({c.comisionClasica}% Clasica)</option>)}
              </select>
            </Field>
            <Field label="Tipo de publicacion">
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className={`scan-btn ${tipoPub === "clasica" ? "blue" : ""}`}
                  style={{ flex: 1, padding: "8px 12px", fontSize: 12, opacity: tipoPub === "clasica" ? 1 : 0.6 }}
                  onClick={() => setTipoPub("clasica")}
                >
                  Clasica
                </button>
                <button
                  className={`scan-btn ${tipoPub === "premium" ? "blue" : ""}`}
                  style={{ flex: 1, padding: "8px 12px", fontSize: 12, opacity: tipoPub === "premium" ? 1 : 0.6 }}
                  onClick={() => setTipoPub("premium")}
                >
                  Premium (+{PREMIUM_DELTA_PP}pp)
                </button>
              </div>
            </Field>
            <Field label={`Comision % (override) — base estimada ${comisionBase.toFixed(1)}%`}>
              <input className="form-input" inputMode="decimal" value={comisionOverrideStr} onChange={e => setComisionOverrideStr(e.target.value.replace(/[^\d.]/g, ""))} placeholder="Vacio = usa base" />
            </Field>
            <Field label="Canal logistico">
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className={`scan-btn ${canal === "flex" ? "blue" : ""}`}
                  style={{ flex: 1, padding: "8px 12px", fontSize: 12, opacity: canal === "flex" ? 1 : 0.6 }}
                  onClick={() => setCanal("flex")}
                >
                  Flex (BANVA despacha)
                </button>
                <button
                  className={`scan-btn ${canal === "full" ? "blue" : ""}`}
                  style={{ flex: 1, padding: "8px 12px", fontSize: 12, opacity: canal === "full" ? 1 : 0.6 }}
                  onClick={() => setCanal("full")}
                >
                  Full (ML despacha)
                </button>
              </div>
            </Field>
            {canal === "full" && (
              <Field label="Costo envio Full unitario (CLP)">
                <input className="form-input" inputMode="numeric" value={costoEnvioFullStr} onChange={e => setCostoEnvioFullStr(e.target.value.replace(/[^\d]/g, ""))} placeholder="Estimado por dimensiones del bulto" />
              </Field>
            )}
          </div>

          {/* Pricing */}
          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: "var(--txt2)" }}>4. PRECIO Y OBJETIVOS</div>
            <Field label="Precio de venta tentativo (CLP, con IVA)">
              <input className="form-input" inputMode="numeric" value={precioTentativoStr} onChange={e => setPrecioTentativoStr(e.target.value.replace(/[^\d]/g, ""))} placeholder="Ej: 19990" />
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Field label="Margen minimo objetivo (%)">
                <input className="form-input" inputMode="decimal" value={margenMinPctStr} onChange={e => setMargenMinPctStr(e.target.value.replace(/[^\d.]/g, ""))} />
              </Field>
              <Field label="ACOS / ads objetivo (%)">
                <input className="form-input" inputMode="decimal" value={acosPctStr} onChange={e => setAcosPctStr(e.target.value.replace(/[^\d.]/g, ""))} />
              </Field>
            </div>
          </div>
        </div>

        {/* COLUMNA OUTPUTS */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Resultado principal */}
          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: "var(--txt2)" }}>RESULTADO</div>
            {!costoNeto || !pesoFacturable ? (
              <div style={{ color: "var(--txt3)", fontSize: 13 }}>
                Ingresa al menos costo neto y peso facturable para ver resultados.
              </div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                  <KPI label="Precio piso" value={fmtCLP(floorRes.floor)} sub={`min para margen ${margenMinPct}% post-ads`} tone="amber" />
                  {margenRes && (
                    <KPI
                      label="Margen a precio tentativo"
                      value={fmtCLP(margenRes.margen)}
                      sub={`${margenRes.margenPct.toFixed(1)}%${margenPostAdsFrac !== null && acosPct > 0 ? ` (${(margenPostAdsFrac*100).toFixed(1)}% post-ads)` : ""}`}
                      tone={margenRes.margen <= 0 ? "red" : margenRes.margenPct < margenMinPct ? "amber" : "green"}
                    />
                  )}
                </div>

                {precioTentativo > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
                    {bajoFloor && (
                      <div style={{ padding: 8, background: "var(--redBg)", border: "1px solid var(--redBd)", borderRadius: 6, color: "var(--red)" }}>
                        Precio bajo el piso: te faltan <b>{fmtCLP(floorRes.floor - precioTentativo)}</b> para llegar al margen minimo.
                      </div>
                    )}
                    {valleMuerte && (
                      <div style={{ padding: 8, background: "var(--amberBg)", border: "1px solid var(--amberBd)", borderRadius: 6, color: "var(--amber)" }}>
                        Valle de la muerte ML: precio entre {fmtCLP(VALLE_MUERTE_MIN)} y {fmtCLP(VALLE_MUERTE_MAX)} fuerza envio gratis sin compensacion. Subir a $19.990+ o bajar a $19.989.
                      </div>
                    )}
                    {zona && (
                      <div style={{ padding: 8, background: "var(--bg3)", borderRadius: 6 }}>
                        Zona ML: <b>{zona}</b>
                        {zona === "barato" && " — seller paga envio completo"}
                        {zona === "medio" && " — seller paga ~50% del envio"}
                        {zona === "caro" && " — envio gratis al cliente, seller paga subsidio minimo"}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Desglose */}
          {costoNeto > 0 && pesoFacturable > 0 && precioTentativo > 0 && margenRes && (
            <div className="card" style={{ padding: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: "var(--txt2)" }}>DESGLOSE A {fmtCLP(precioTentativo)}</div>
              <table className="tbl" style={{ width: "100%", fontSize: 12 }}>
                <tbody>
                  <Row label="Precio venta (con IVA)" value={fmtCLP(precioTentativo)} bold />
                  <Row label="Costo neto" value={`- ${fmtCLP(costoNeto)}`} />
                  <Row label={`IVA sobre costo (${(IVA_PCT*100).toFixed(0)}%)`} value={`- ${fmtCLP(costoBruto - costoNeto)}`} muted />
                  <Row label={`Comision ML (${comisionPct.toFixed(1)}%)`} value={`- ${fmtCLP(margenRes.comision)}`} />
                  <Row label={`Envio ${canal === "full" ? "Full" : "Flex"} (zona ${margenRes.columna})`} value={`- ${fmtCLP(margenRes.envio)}`} />
                  {acosPct > 0 && (
                    <Row label={`Ads (${acosPct}% ACOS)`} value={`- ${fmtCLP(Math.round(precioTentativo * acosPct / 100))}`} />
                  )}
                  <Row
                    label="Margen neto"
                    value={fmtCLP(margenRes.margen - (acosPct > 0 ? Math.round(precioTentativo * acosPct / 100) : 0))}
                    bold
                    tone={margenRes.margen <= 0 ? "red" : "green"}
                  />
                </tbody>
              </table>
            </div>
          )}

          {/* Curva */}
          {curva.length > 0 && (
            <div className="card" style={{ padding: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, color: "var(--txt2)" }}>CURVA DE MARGEN POR PRECIO</div>
              <div style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 8 }}>
                Verde = sweet spot bajo $19.990 · Rojo = zona muerta · Cyan = break-even (recupera el sweet spot)
              </div>
              <div style={{ maxHeight: 360, overflowY: "auto" }}>
                <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "right" }}>Precio</th>
                      <th style={{ textAlign: "right" }}>Comision</th>
                      <th style={{ textAlign: "right" }}>Envio</th>
                      <th style={{ textAlign: "right" }}>Margen</th>
                      <th style={{ textAlign: "right" }}>%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {curva.map(r => {
                      let bg: string | undefined;
                      let bd: string | undefined;
                      if (r.esSweetSpotMedio) { bg = "var(--greenBg)"; bd = "var(--greenBd)"; }
                      else if (r.esBreakEven) { bg = "var(--cyanBg)"; bd = "var(--cyanBd)"; }
                      else if (r.esDeadZone)  { bg = "var(--redBg)"; bd = "var(--redBd)"; }
                      return (
                        <tr key={r.precio} style={{ background: bg, borderBottom: bd ? `1px solid ${bd}` : undefined, fontWeight: r.esActual ? 700 : undefined }}>
                          <td style={{ ...numStyle, textAlign: "right" }}>{fmtCLP(r.precio)}{r.esActual ? " ←" : ""}</td>
                          <td style={{ ...numStyle, textAlign: "right" }}>{fmtCLP(r.comision)}</td>
                          <td style={{ ...numStyle, textAlign: "right" }}>{fmtCLP(r.envio)}</td>
                          <td style={{ ...numStyle, textAlign: "right", color: r.margen <= 0 ? "var(--red)" : undefined }}>{fmtCLP(r.margen)}</td>
                          <td style={{ ...numStyle, textAlign: "right" }}>{r.margenPct.toFixed(1)}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="form-label" style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function KPI({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "green" | "red" | "amber" | "cyan" }) {
  const colorMap: Record<string, string> = { green: "var(--green)", red: "var(--red)", amber: "var(--amber)", cyan: "var(--cyan)" };
  return (
    <div style={{ background: "var(--bg3)", padding: 12, borderRadius: 8 }}>
      <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-mono, JetBrains Mono, monospace)", color: tone ? colorMap[tone] : undefined, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Row({ label, value, bold, muted, tone }: { label: string; value: string; bold?: boolean; muted?: boolean; tone?: "green" | "red" }) {
  const colorMap: Record<string, string> = { green: "var(--green)", red: "var(--red)" };
  return (
    <tr>
      <td style={{ padding: "4px 0", color: muted ? "var(--txt3)" : undefined, fontWeight: bold ? 700 : undefined }}>{label}</td>
      <td style={{ padding: "4px 0", textAlign: "right", fontFamily: "var(--font-mono, JetBrains Mono, monospace)", fontWeight: bold ? 700 : undefined, color: tone ? colorMap[tone] : muted ? "var(--txt3)" : undefined }}>{value}</td>
    </tr>
  );
}
