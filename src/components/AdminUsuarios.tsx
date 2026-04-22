"use client";
import { useState, useEffect, useCallback } from "react";
import {
  ADMIN_TAB_CATALOG,
  fetchAdminUsers,
  upsertAdminUser,
  deleteAdminUser,
  type AdminUser,
  type AdminRol,
} from "@/lib/admin-users";

const ROLES: Array<{ value: AdminRol; label: string; desc: string }> = [
  { value: "super_admin", label: "Super Admin", desc: "Todo incluyendo gestion de usuarios" },
  { value: "admin", label: "Admin", desc: "Todo el panel, no puede gestionar usuarios" },
  { value: "operaciones", label: "Operaciones", desc: "Recepciones, picking, envios, reposicion" },
  { value: "viewer", label: "Viewer", desc: "Solo lectura: dashboard, inventario, movimientos" },
  { value: "custom", label: "Custom", desc: "Permisos seleccionados a mano" },
];

export default function AdminUsuarios({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [showForm, setShowForm] = useState(false);

  const cargar = useCallback(async () => {
    setLoading(true);
    const data = await fetchAdminUsers();
    setUsers(data);
    setLoading(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const onGuardar = async (u: Partial<AdminUser> & { nombre: string; pin: string; rol: AdminRol }) => {
    const res = await upsertAdminUser(u);
    if (res) {
      setEditing(null);
      setShowForm(false);
      cargar();
    } else {
      alert("Error al guardar usuario");
    }
  };

  const onEliminar = async (u: AdminUser) => {
    if (u.id === currentUserId) { alert("No puedes eliminarte a ti mismo"); return; }
    if (!confirm(`Eliminar usuario ${u.nombre}?`)) return;
    const ok = await deleteAdminUser(u.id);
    if (ok) cargar();
    else alert("Error al eliminar");
  };

  const onToggleActivo = async (u: AdminUser) => {
    if (u.id === currentUserId && u.activo) { alert("No puedes desactivarte a ti mismo"); return; }
    await upsertAdminUser({ ...u, activo: !u.activo });
    cargar();
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Usuarios del Panel</h2>
          <p style={{ fontSize: 12, color: "var(--txt3)", margin: 0 }}>Quienes pueden ingresar al admin y a que secciones.</p>
        </div>
        <button
          onClick={() => { setEditing(null); setShowForm(true); }}
          style={{ padding: "8px 14px", borderRadius: 8, background: "var(--cyan)", color: "#000", fontSize: 12, fontWeight: 700, border: "none", cursor: "pointer" }}
        >
          + Nuevo usuario
        </button>
      </div>

      {loading && <div style={{ color: "var(--txt3)", padding: 12 }}>Cargando...</div>}

      {!loading && users.length === 0 && (
        <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>
          Sin usuarios registrados.
        </div>
      )}

      {users.length > 0 && (
        <table className="tbl" style={{ fontSize: 12, width: "100%" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Nombre</th>
              <th style={{ textAlign: "left" }}>Email</th>
              <th style={{ textAlign: "center" }}>Rol</th>
              <th style={{ textAlign: "center" }}>PIN</th>
              <th style={{ textAlign: "center" }}>Activo</th>
              <th style={{ textAlign: "center" }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} style={{ opacity: u.activo ? 1 : 0.5 }}>
                <td style={{ fontWeight: 600 }}>{u.nombre}{u.id === currentUserId && <span style={{ marginLeft: 6, color: "var(--cyan)", fontSize: 10 }}>(yo)</span>}</td>
                <td style={{ color: "var(--txt3)" }}>{u.email || "—"}</td>
                <td style={{ textAlign: "center" }}>
                  <span style={{ padding: "2px 8px", borderRadius: 4, background: "var(--bg3)", fontSize: 10 }}>
                    {ROLES.find(r => r.value === u.rol)?.label || u.rol}
                  </span>
                </td>
                <td style={{ textAlign: "center", fontFamily: "monospace" }}>{u.pin}</td>
                <td style={{ textAlign: "center" }}>
                  <button
                    onClick={() => onToggleActivo(u)}
                    style={{
                      padding: "3px 10px", borderRadius: 4,
                      background: u.activo ? "var(--greenBg)" : "var(--bg3)",
                      color: u.activo ? "var(--green)" : "var(--txt3)",
                      fontSize: 10, fontWeight: 600, border: "1px solid " + (u.activo ? "var(--greenBd)" : "var(--bg4)"), cursor: "pointer",
                    }}
                  >
                    {u.activo ? "ON" : "OFF"}
                  </button>
                </td>
                <td style={{ textAlign: "center" }}>
                  <button
                    onClick={() => { setEditing(u); setShowForm(true); }}
                    style={{ padding: "3px 10px", borderRadius: 4, background: "var(--bg3)", color: "var(--cyan)", fontSize: 10, border: "1px solid var(--bg4)", marginRight: 4, cursor: "pointer" }}
                  >
                    Editar
                  </button>
                  {u.id !== currentUserId && (
                    <button
                      onClick={() => onEliminar(u)}
                      style={{ padding: "3px 10px", borderRadius: 4, background: "var(--redBg)", color: "var(--red)", fontSize: 10, border: "1px solid var(--redBd)", cursor: "pointer" }}
                    >
                      Borrar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showForm && (
        <UsuarioForm
          user={editing}
          onCancel={() => { setShowForm(false); setEditing(null); }}
          onSave={onGuardar}
        />
      )}
    </div>
  );
}

function UsuarioForm({
  user,
  onCancel,
  onSave,
}: {
  user: AdminUser | null;
  onCancel: () => void;
  onSave: (u: Partial<AdminUser> & { nombre: string; pin: string; rol: AdminRol }) => Promise<void>;
}) {
  const [nombre, setNombre] = useState(user?.nombre || "");
  const [email, setEmail] = useState(user?.email || "");
  const [pin, setPin] = useState(user?.pin || "");
  const [rol, setRol] = useState<AdminRol>(user?.rol || "operaciones");
  const [permisos, setPermisos] = useState<Set<string>>(new Set(user?.permisos || []));
  const [saving, setSaving] = useState(false);

  const togglePermiso = (key: string) => {
    setPermisos(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const submit = async () => {
    if (!nombre.trim()) { alert("Nombre requerido"); return; }
    if (!pin.trim() || pin.length < 4) { alert("PIN de al menos 4 caracteres"); return; }
    setSaving(true);
    await onSave({
      id: user?.id,
      nombre: nombre.trim(),
      email: email.trim() || null,
      pin: pin.trim(),
      rol,
      permisos: Array.from(permisos),
      activo: user?.activo ?? true,
    });
    setSaving(false);
  };

  const grupos = Array.from(new Set(ADMIN_TAB_CATALOG.map(t => t.group)));

  return (
    <div
      onClick={onCancel}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: "var(--bg2)", borderRadius: 12, padding: 24, width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto", border: "1px solid var(--bg4)" }}
      >
        <h3 style={{ margin: 0, marginBottom: 16, fontSize: 16, fontWeight: 700 }}>
          {user ? "Editar usuario" : "Nuevo usuario"}
        </h3>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--txt3)" }}>Nombre *</span>
            <input className="form-input" value={nombre} onChange={e => setNombre(e.target.value)} style={{ fontSize: 13 }} />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--txt3)" }}>Email (opcional)</span>
            <input className="form-input" type="email" value={email} onChange={e => setEmail(e.target.value)} style={{ fontSize: 13 }} />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--txt3)" }}>PIN * (4+ caracteres, numerico o alfanumerico)</span>
            <input className="form-input mono" value={pin} onChange={e => setPin(e.target.value)} style={{ fontSize: 13 }} maxLength={20} />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--txt3)" }}>Rol *</span>
            <select className="form-input" value={rol} onChange={e => setRol(e.target.value as AdminRol)} style={{ fontSize: 13 }}>
              {ROLES.map(r => (
                <option key={r.value} value={r.value}>{r.label} — {r.desc}</option>
              ))}
            </select>
          </label>

          {rol === "custom" && (
            <div>
              <div style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 8 }}>
                Permisos por seccion ({permisos.size} seleccionadas)
              </div>
              <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 10, fontStyle: "italic" }}>
                Tip: si un tab tiene subsecciones (ej. Configuracion), marcar solo algunas limita el acceso a esas. Marcar solo el parent = acceso a TODAS sus subsecciones.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {grupos.map(g => {
                  const tabsGrupo = ADMIN_TAB_CATALOG.filter(t => t.group === g);
                  const parents = tabsGrupo.filter(t => !t.parent);
                  return (
                    <div key={g}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--cyan)", marginBottom: 4, letterSpacing: "0.05em", textTransform: "uppercase" }}>{g}</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {parents.map(t => {
                          const active = permisos.has(t.key);
                          const children = tabsGrupo.filter(c => c.parent === t.key);
                          return (
                            <div key={t.key}>
                              <button
                                type="button"
                                onClick={() => togglePermiso(t.key)}
                                style={{
                                  padding: "4px 10px", borderRadius: 6,
                                  background: active ? "var(--cyan)" : "var(--bg3)",
                                  color: active ? "#000" : "var(--txt2)",
                                  fontSize: 11, fontWeight: 600, border: "1px solid " + (active ? "var(--cyan)" : "var(--bg4)"), cursor: "pointer",
                                }}
                              >
                                {active ? "✓ " : ""}{t.label}
                              </button>
                              {children.length > 0 && active && (
                                <div style={{ marginTop: 4, marginLeft: 16, display: "flex", flexWrap: "wrap", gap: 4, paddingLeft: 8, borderLeft: "2px solid var(--bg4)" }}>
                                  {children.map(c => {
                                    const cActive = permisos.has(c.key);
                                    return (
                                      <button
                                        key={c.key}
                                        type="button"
                                        onClick={() => togglePermiso(c.key)}
                                        style={{
                                          padding: "3px 8px", borderRadius: 4,
                                          background: cActive ? "var(--cyanBg)" : "var(--bg3)",
                                          color: cActive ? "var(--cyan)" : "var(--txt3)",
                                          fontSize: 10, fontWeight: 600, border: "1px solid " + (cActive ? "var(--cyanBd)" : "var(--bg4)"), cursor: "pointer",
                                        }}
                                      >
                                        {cActive ? "✓ " : "· "}{c.label}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 20, justifyContent: "flex-end" }}>
          <button onClick={onCancel} disabled={saving} style={{ padding: "8px 14px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt3)", fontSize: 12, border: "1px solid var(--bg4)", cursor: "pointer" }}>
            Cancelar
          </button>
          <button onClick={submit} disabled={saving} style={{ padding: "8px 14px", borderRadius: 6, background: "var(--cyan)", color: "#000", fontWeight: 700, fontSize: 12, border: "none", cursor: "pointer" }}>
            {saving ? "Guardando..." : "Guardar"}
          </button>
        </div>
      </div>
    </div>
  );
}
