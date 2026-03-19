"use client";
import React, { useState, useEffect, useCallback } from "react";
import { resetStore, initStore } from "@/lib/store";
import Link from "next/link";
import SheetSync from "@/components/SheetSync";
import AdminReposicion from "@/components/AdminReposicion";
import AdminAgentes from "@/components/AdminAgentes";
import AdminInteligencia from "@/components/AdminInteligencia";
import AdminCompras from "@/components/AdminCompras";
import AdminEventos from "@/components/AdminEventos";
import AdminRecepciones from "@/components/admin/AdminRecepciones";
import AdminPicking from "@/components/admin/AdminPicking";
import AdminEtiquetas from "@/components/admin/AdminEtiquetas";
import Operaciones from "@/components/admin/Operaciones";
import Dashboard from "@/components/admin/Dashboard";
import Inventario from "@/components/admin/Inventario";
import Movimientos from "@/components/admin/Movimientos";
import Productos from "@/components/admin/Productos";
import AdminPedidosFlex from "@/components/admin/AdminPedidosFlex";
import AdminStockML from "@/components/admin/AdminStockML";
import Configuracion from "@/components/admin/Configuracion";

const ADMIN_PIN = "1234"; // Change this
const AUTH_KEY = "banva_admin_auth";

function useAuth() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const saved = sessionStorage.getItem(AUTH_KEY);
    if (saved === "1") setOk(true);
  }, []);
  const login = (pin: string) => {
    if (pin === ADMIN_PIN) { sessionStorage.setItem(AUTH_KEY, "1"); setOk(true); return true; }
    return false;
  };
  const logout = () => { sessionStorage.removeItem(AUTH_KEY); setOk(false); };
  return { ok, login, logout };
}

function LoginGate({ onLogin }: { onLogin: (pin: string) => boolean }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState(false);
  const submit = () => {
    if (!onLogin(pin)) { setErr(true); setPin(""); setTimeout(() => setErr(false), 1500); }
  };
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100dvh",background:"var(--bg)",padding:24}}>
      <div style={{width:"100%",maxWidth:360,textAlign:"center"}}>
        <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.12em",color:"var(--cyan)",textTransform:"uppercase",marginBottom:6}}>BANVA WMS</div>
        <div style={{fontSize:24,fontWeight:800,marginBottom:4}}>Administrador</div>
        <div style={{fontSize:13,color:"var(--txt3)",marginBottom:32}}>Ingresa el PIN de acceso</div>
        <div style={{display:"flex",gap:8,marginBottom:16}}>
          <input type="password" inputMode="numeric" className="form-input mono" value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g,""))}
            onKeyDown={e=>e.key==="Enter"&&submit()} placeholder="PIN" maxLength={6} autoFocus
            style={{fontSize:24,textAlign:"center",letterSpacing:8,padding:16,flex:1}}/>
        </div>
        <button onClick={submit} disabled={pin.length<4}
          style={{width:"100%",padding:14,borderRadius:10,background:pin.length>=4?"var(--cyan)":"var(--bg3)",color:pin.length>=4?"#000":"var(--txt3)",fontWeight:700,fontSize:14,opacity:pin.length>=4?1:0.5}}>
          Entrar
        </button>
        {err && <div style={{marginTop:12,color:"var(--red)",fontWeight:600,fontSize:13}}>PIN incorrecto</div>}
        <Link href="/" style={{display:"inline-block",marginTop:24,color:"var(--txt3)",fontSize:12}}>&#8592; Volver al inicio</Link>
      </div>
    </div>
  );
}

export default function AdminPage() {
  const [tab, setTab] = useState<"dash"|"rec"|"picking"|"pedidos"|"ops"|"inv"|"mov"|"prod"|"reposicion"|"intel"|"compras"|"eventos"|"agentes"|"stockml"|"config">("dash");
  const [,setTick] = useState(0);
  const r = useCallback(()=>setTick(t=>t+1),[]);
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mlAuthReturn, setMlAuthReturn] = useState(false);
  const auth = useAuth();
  useEffect(()=>{
    setMounted(true);
    initStore().then(()=>setLoading(false));
    // Si volvemos de OAuth ML, ir directo a Config > ML
    const params = new URLSearchParams(window.location.search);
    if (params.get("ml_auth") === "success" || params.get("ml_error")) {
      setTab("config");
      setMlAuthReturn(true);
      window.history.replaceState({}, "", window.location.pathname);
      if (params.get("ml_auth") === "success") {
        setTimeout(() => alert("Cuenta MercadoLibre vinculada exitosamente."), 500);
      } else if (params.get("ml_error")) {
        setTimeout(() => alert("Error al vincular MercadoLibre: " + params.get("ml_error")), 500);
      }
    }
  },[]);
  if(!mounted) return null;
  if(!auth.ok) return <LoginGate onLogin={auth.login}/>;
  if(loading) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100dvh",background:"var(--bg)"}}><div style={{textAlign:"center"}}><div style={{fontSize:24,fontWeight:700,marginBottom:8}}>BANVA WMS</div><div style={{color:"var(--txt3)"}}>Cargando datos...</div></div></div>;

  return (
    <div className="app-admin">
      <div className="admin-topbar">
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <Link href="/"><button className="back-btn">&#8592;</button></Link>
          <div>
            <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",color:"var(--cyan)",textTransform:"uppercase"}}>BANVA WMS</div>
            <h1 style={{fontSize:16,fontWeight:700,margin:0}}>Panel Administrador</h1>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <span style={{fontSize:11,color:"var(--txt3)"}}>{new Date().toLocaleDateString("es-CL",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</span>
          <button onClick={auth.logout} style={{padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--red)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>Cerrar sesión</button>
        </div>
      </div>
      <SheetSync onSynced={r}/>
      <div className="admin-layout">
        <nav className="admin-sidebar">
          {([["dash","Dashboard","📊"],["rec","Recepciones","📦"],["picking","Picking Flex","🏷️"],["pedidos","Pedidos ML","🛒"],["ops","Operaciones","⚡"],["inv","Inventario","📦"],["mov","Movimientos","📋"],["prod","Productos","🏷️"],["reposicion","Reposición","🔄"],["intel","Inteligencia","🧠"],["compras","Compras","🛒"],["eventos","Eventos","📅"],["agentes","Agentes IA","🤖"],["stockml","Stock ML","📡"],["config","Configuración","⚙️"]] as const).map(([key,label,icon])=>(
            <button key={key} className={`sidebar-btn ${tab===key?"active":""}`} onClick={()=>setTab(key as any)}>
              <span className="sidebar-icon">{icon}</span>
              <span className="sidebar-label">{label}</span>
            </button>
          ))}
          <div style={{flex:1}}/>

          <Link href="/admin/qr-codes"><button className="sidebar-btn"><span className="sidebar-icon">🖨️</span><span className="sidebar-label">Imprimir QRs</span></button></Link>
          <button className="sidebar-btn" onClick={()=>{if(confirm("Resetear todos los datos a demo?")){resetStore();window.location.reload();}}}><span className="sidebar-icon">🔄</span><span className="sidebar-label" style={{color:"var(--amber)"}}>Reset Demo</span></button>
        </nav>

        <main className="admin-main">
          {/* Mobile tabs fallback */}
          <div className="admin-mobile-tabs">
            {([["dash","Dashboard"],["rec","Recepción"],["picking","Picking"],["pedidos","Pedidos ML"],["ops","Ops"],["inv","Inventario"],["mov","Movim."],["prod","Productos"],["reposicion","Reposición"],["intel","Inteligencia"],["compras","Compras"],["eventos","Eventos"],["agentes","Agentes IA"],["stockml","Stock ML"],["config","Config"]] as const).map(([key,label])=>(
              <button key={key} className={`tab ${tab===key?"active-cyan":""}`} onClick={()=>setTab(key as any)}>{label}</button>
            ))}
          </div>
          <div className="admin-content">
            {tab==="dash"&&<Dashboard/>}
            {tab==="rec"&&<AdminRecepciones refresh={r}/>}
            {tab==="picking"&&<AdminPicking refresh={r}/>}
            {tab==="pedidos"&&<AdminPedidosFlex refresh={r}/>}
            {tab==="ops"&&<Operaciones refresh={r}/>}
            {tab==="inv"&&<Inventario/>}
            {tab==="mov"&&<Movimientos/>}
            {tab==="prod"&&<Productos refresh={r}/>}
            {tab==="reposicion"&&<AdminReposicion/>}
            {tab==="intel"&&<AdminInteligencia/>}
            {tab==="compras"&&<AdminCompras/>}
            {tab==="eventos"&&<AdminEventos/>}
            {tab==="agentes"&&<AdminAgentes/>}
            {tab==="stockml"&&<AdminStockML/>}
            {tab==="config"&&<Configuracion refresh={r} initialSubTab={mlAuthReturn ? "ml" : undefined}/>}
          </div>
        </main>
      </div>
    </div>
  );
}
