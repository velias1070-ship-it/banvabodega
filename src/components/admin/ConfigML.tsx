"use client";
import React, { useState, useEffect, useCallback } from "react";
import { fetchMLConfig, upsertMLConfig } from "@/lib/db";
import type { DBMLConfig } from "@/lib/db";
import { getOAuthUrl } from "@/lib/ml";

function ConfigML() {
  const [mlConfig, setMlConfig] = useState<DBMLConfig | null>(null);
  const [configForm, setConfigForm] = useState({ client_id: "", client_secret: "", seller_id: "", hora_corte_lv: 13, hora_corte_sab: 12 });
  const [loading, setLoading] = useState(true);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagResult, setDiagResult] = useState<Record<string, unknown> | null>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    const cfg = await fetchMLConfig();
    setMlConfig(cfg);
    if (cfg) {
      setConfigForm({
        client_id: cfg.client_id || "",
        client_secret: cfg.client_secret || "",
        seller_id: cfg.seller_id || "",
        hora_corte_lv: cfg.hora_corte_lv || 13,
        hora_corte_sab: cfg.hora_corte_sab || 12,
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const doSaveConfig = async () => {
    await upsertMLConfig({
      client_id: configForm.client_id,
      client_secret: configForm.client_secret,
      seller_id: configForm.seller_id,
      hora_corte_lv: configForm.hora_corte_lv,
      hora_corte_sab: configForm.hora_corte_sab,
    });
    await loadConfig();
    alert("Configuración guardada");
  };

  const doDiagnose = async () => {
    setDiagnosing(true);
    try {
      const resp = await fetch("/api/ml/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ diagnose: true }) });
      const data = await resp.json();
      setDiagResult(data);
    } catch (err) {
      setDiagResult({ error: String(err) });
    }
    setDiagnosing(false);
  };

  const tokenValid = mlConfig?.token_expires_at && new Date(mlConfig.token_expires_at) > new Date();
  const hasRefreshToken = !!mlConfig?.refresh_token;
  const authUrl = configForm.client_id && typeof window !== "undefined" ? getOAuthUrl(configForm.client_id, `${window.location.origin}/api/ml/auth`) : "";

  if (loading) return <div className="card" style={{textAlign:"center",padding:40,color:"var(--txt3)"}}>Cargando configuración...</div>;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* Estado de conexión */}
      <div className="card" style={{border: tokenValid && hasRefreshToken ? "2px solid var(--green)" : tokenValid ? "2px solid var(--amber)" : "2px solid var(--red)"}}>
        <div className="card-title">Estado de Conexión</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:12}}>
          <div>
            <div style={{fontSize:11,color:"var(--txt3)",textTransform:"uppercase",letterSpacing:1}}>Token</div>
            <div style={{fontSize:14,fontWeight:700,color: tokenValid ? "var(--green)" : "var(--red)",marginTop:4}}>
              {tokenValid ? "Válido" : "Vencido / No configurado"}
            </div>
          </div>
          <div>
            <div style={{fontSize:11,color:"var(--txt3)",textTransform:"uppercase",letterSpacing:1}}>Auto-renovación</div>
            <div style={{fontSize:14,fontWeight:700,color: hasRefreshToken ? "var(--green)" : "var(--red)",marginTop:4}}>
              {hasRefreshToken ? "Activa (refresh_token presente)" : "Inactiva (sin refresh_token)"}
            </div>
          </div>
          <div>
            <div style={{fontSize:11,color:"var(--txt3)",textTransform:"uppercase",letterSpacing:1}}>Seller ID</div>
            <div className="mono" style={{fontSize:14,fontWeight:700,marginTop:4}}>{mlConfig?.seller_id || "—"}</div>
          </div>
          <div>
            <div style={{fontSize:11,color:"var(--txt3)",textTransform:"uppercase",letterSpacing:1}}>Última actualización</div>
            <div style={{fontSize:13,marginTop:4,color:"var(--txt2)"}}>{mlConfig?.updated_at ? new Date(mlConfig.updated_at).toLocaleString("es-CL") : "—"}</div>
          </div>
          {mlConfig?.token_expires_at && (
            <div>
              <div style={{fontSize:11,color:"var(--txt3)",textTransform:"uppercase",letterSpacing:1}}>Token expira</div>
              <div className="mono" style={{fontSize:13,marginTop:4,color: tokenValid ? "var(--txt2)" : "var(--red)"}}>{new Date(mlConfig.token_expires_at).toLocaleString("es-CL")}</div>
            </div>
          )}
        </div>

        {!tokenValid && (
          <div style={{marginTop:16,padding:12,borderRadius:8,background:"var(--redBg)",border:"1px solid var(--redBd)",fontSize:12,color:"var(--red)"}}>
            El token está vencido. {configForm.client_id ? 'Haz click en "Vincular cuenta ML" para re-autorizar.' : "Ingresa el Client ID y Secret primero."}
          </div>
        )}
        {tokenValid && !hasRefreshToken && (
          <div style={{marginTop:16,padding:12,borderRadius:8,background:"var(--amberBg)",border:"1px solid var(--amberBd)",fontSize:12,color:"var(--amber)"}}>
            Token válido pero SIN refresh_token. Cuando expire (~6 hrs), dejará de funcionar. Re-autoriza para obtener refresh_token permanente.
          </div>
        )}
      </div>

      {/* Credenciales */}
      <div className="card">
        <div className="card-title">Credenciales MercadoLibre</div>
        <div className="admin-form-grid" style={{marginTop:12}}>
          <div className="form-group"><label className="form-label">Client ID (App ID)</label><input className="form-input mono" value={configForm.client_id} onChange={e => setConfigForm({...configForm, client_id: e.target.value})} placeholder="App ID de ML"/></div>
          <div className="form-group"><label className="form-label">Client Secret</label><input className="form-input mono" type="password" value={configForm.client_secret} onChange={e => setConfigForm({...configForm, client_secret: e.target.value})} placeholder="Secret key"/></div>
          <div className="form-group"><label className="form-label">Seller ID</label><input className="form-input mono" value={configForm.seller_id} onChange={e => setConfigForm({...configForm, seller_id: e.target.value})} placeholder="Se autocompleta al vincular" readOnly style={{opacity:0.7}}/></div>
        </div>
        <div style={{display:"flex",gap:8,marginTop:16}}>
          <button onClick={doSaveConfig} style={{padding:"10px 20px",borderRadius:8,background:"var(--green)",color:"#fff",fontWeight:700,fontSize:13,border:"none",cursor:"pointer"}}>Guardar Credenciales</button>
          {configForm.client_id && authUrl && (
            <a href={authUrl} style={{padding:"10px 20px",borderRadius:8,background:"#3483fa",color:"#fff",fontWeight:700,fontSize:13,border:"none",cursor:"pointer",textDecoration:"none",display:"inline-flex",alignItems:"center"}}>
              🔗 Vincular cuenta ML
            </a>
          )}
        </div>
      </div>

      {/* Horarios de corte */}
      <div className="card">
        <div className="card-title">Horarios de Corte Flex</div>
        <div style={{fontSize:12,color:"var(--txt2)",marginBottom:12}}>Hora límite para despachar pedidos del día. Pedidos que lleguen después se arman para el día siguiente.</div>
        <div className="admin-form-grid" style={{maxWidth:400}}>
          <div className="form-group"><label className="form-label">Lunes a Viernes</label><input type="number" className="form-input mono" value={configForm.hora_corte_lv} onFocus={e=>e.target.select()} onChange={e => setConfigForm({...configForm, hora_corte_lv: parseInt(e.target.value) || 13})} min={0} max={23}/></div>
          <div className="form-group"><label className="form-label">Sábado</label><input type="number" className="form-input mono" value={configForm.hora_corte_sab} onFocus={e=>e.target.select()} onChange={e => setConfigForm({...configForm, hora_corte_sab: parseInt(e.target.value) || 12})} min={0} max={23}/></div>
        </div>
        <button onClick={doSaveConfig} style={{marginTop:12,padding:"8px 16px",borderRadius:8,background:"var(--green)",color:"#fff",fontWeight:700,fontSize:12,border:"none",cursor:"pointer"}}>Guardar Horarios</button>
      </div>

      {/* Diagnóstico */}
      <div className="card">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div className="card-title">Diagnóstico de Conexión</div>
          <button onClick={doDiagnose} disabled={diagnosing} style={{padding:"8px 16px",borderRadius:8,background:"var(--bg3)",color:"#f59e0b",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)",cursor:"pointer"}}>
            {diagnosing ? "Diagnosticando..." : "🩺 Ejecutar Diagnóstico"}
          </button>
        </div>
        {diagResult && (
          <div style={{marginTop:12,padding:12,borderRadius:8,background:"var(--bg2)",border: (diagResult.errors as string[])?.length > 0 ? "1px solid var(--red)" : "1px solid var(--green)"}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,fontSize:12}}>
              <div><strong>Token:</strong> <span style={{color: diagResult.token_status === "valid" ? "var(--green)" : "var(--red)"}}>{diagResult.token_status === "valid" ? "Válido" : String(diagResult.token_status)}</span></div>
              <div><strong>Expira:</strong> <span className="mono">{diagResult.token_expires_at ? new Date(diagResult.token_expires_at as string).toLocaleString("es-CL") : "—"}</span></div>
              <div><strong>Seller ID:</strong> <span className="mono">{String(diagResult.seller_id || "—")}</span></div>
              <div><strong>Nickname:</strong> <span className="mono">{String(diagResult.seller_nickname || "—")}</span></div>
            </div>
            {(diagResult.errors as string[])?.length > 0 && (
              <div style={{marginTop:8,fontSize:11,color:"var(--red)"}}>
                {(diagResult.errors as string[]).map((e, i) => <div key={i}>• {e}</div>)}
              </div>
            )}
          </div>
        )}
        {!diagResult && <div style={{marginTop:8,fontSize:12,color:"var(--txt3)"}}>Ejecuta el diagnóstico para verificar la conexión con MercadoLibre, permisos y estado de la cuenta.</div>}
      </div>
    </div>
  );
}

export default ConfigML;
