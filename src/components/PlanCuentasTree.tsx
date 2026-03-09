"use client";
import { useState, useEffect } from "react";
import {
  fetchPlanCuentas,
  updatePlanCuenta,
  upsertPlanCuenta,
} from "@/lib/db";
import type { DBPlanCuentas } from "@/lib/db";

// ==================== TIPOS ====================

// Nodo del árbol con hijos anidados
interface TreeNode extends DBPlanCuentas {
  children: TreeNode[];
}

// Props del componente
interface PlanCuentasTreeProps {
  onSelect?: (cuenta: DBPlanCuentas) => void;
}

// ==================== HELPERS ====================

// Construir árbol jerárquico a partir de lista plana
function buildTree(cuentas: DBPlanCuentas[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  // Crear nodos
  for (const c of cuentas) {
    map.set(c.id!, { ...c, children: [] });
  }

  // Conectar padres e hijos
  for (const c of cuentas) {
    const node = map.get(c.id!)!;
    if (c.parent_id && map.has(c.parent_id)) {
      map.get(c.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

// Color por tipo de cuenta
const TIPO_COLORS: Record<string, { bg: string; color: string; label: string }> = {
  ingreso:           { bg: "var(--greenBg)", color: "var(--green)", label: "Ingreso" },
  costo:             { bg: "var(--redBg)",   color: "var(--red)",   label: "Costo" },
  gasto_operacional: { bg: "var(--amberBg)", color: "var(--amber)", label: "Gasto Op." },
  gasto_no_op:       { bg: "var(--blueBg)",  color: "var(--blue)",  label: "Gasto No Op." },
};

// ==================== COMPONENTE NODO ====================

function TreeNodeItem({
  node,
  depth,
  onToggleActive,
  onEditName,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  onToggleActive: (id: string, activa: boolean) => void;
  onEditName: (id: string, nombre: string) => void;
  onSelect?: (cuenta: DBPlanCuentas) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 2); // Expandir 2 niveles por defecto
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(node.nombre);

  const hasChildren = node.children.length > 0;
  const tipoStyle = TIPO_COLORS[node.tipo] || TIPO_COLORS.ingreso;

  const handleSaveName = () => {
    if (editName.trim() && editName !== node.nombre) {
      onEditName(node.id!, editName.trim());
    }
    setEditing(false);
  };

  return (
    <div>
      {/* Fila del nodo */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          paddingLeft: depth * 24 + 8,
          borderBottom: "1px solid var(--bg4)",
          background: !node.activa ? "var(--bg)" : depth === 0 ? "var(--bg3)" : "transparent",
          opacity: node.activa ? 1 : 0.5,
          cursor: onSelect && node.es_hoja ? "pointer" : "default",
        }}
        onClick={() => onSelect && node.es_hoja && onSelect(node)}
      >
        {/* Expand/collapse */}
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            style={{
              width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center",
              background: "none", border: "none", color: "var(--txt2)", fontSize: 12, cursor: "pointer",
              transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s",
            }}
          >
            ▶
          </button>
        ) : (
          <div style={{ width: 20 }} />
        )}

        {/* Código */}
        <span className="mono" style={{ fontSize: 11, color: "var(--cyan)", minWidth: 50, fontWeight: 600 }}>
          {node.codigo}
        </span>

        {/* Nombre (editable) */}
        {editing ? (
          <input
            className="form-input"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleSaveName}
            onKeyDown={(e) => e.key === "Enter" && handleSaveName()}
            autoFocus
            style={{ fontSize: 12, padding: "2px 6px", flex: 1 }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            style={{
              flex: 1, fontSize: 12, fontWeight: depth === 0 ? 700 : depth === 1 ? 600 : 400,
              cursor: "text",
            }}
            onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
          >
            {node.nombre}
          </span>
        )}

        {/* Badge tipo (solo en nivel 0) */}
        {depth === 0 && (
          <span style={{
            fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
            background: tipoStyle.bg, color: tipoStyle.color, textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}>
            {tipoStyle.label}
          </span>
        )}

        {/* Indicador hoja */}
        {node.es_hoja && (
          <span style={{ fontSize: 9, color: "var(--txt3)", fontWeight: 600 }}>HOJA</span>
        )}

        {/* Toggle activa */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleActive(node.id!, !node.activa); }}
          style={{
            width: 32, height: 18, borderRadius: 9, border: "none", cursor: "pointer",
            background: node.activa ? "var(--green)" : "var(--bg4)",
            position: "relative", transition: "background 0.2s",
          }}
        >
          <div style={{
            width: 14, height: 14, borderRadius: 7, background: "#fff",
            position: "absolute", top: 2,
            left: node.activa ? 16 : 2, transition: "left 0.2s",
          }} />
        </button>
      </div>

      {/* Hijos (si expandido) */}
      {expanded && hasChildren && node.children.map((child) => (
        <TreeNodeItem
          key={child.id}
          node={child}
          depth={depth + 1}
          onToggleActive={onToggleActive}
          onEditName={onEditName}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

// ==================== FORMULARIO NUEVA CUENTA ====================

function NuevaCuentaForm({
  cuentas,
  onSave,
  onCancel,
}: {
  cuentas: DBPlanCuentas[];
  onSave: (c: DBPlanCuentas) => void;
  onCancel: () => void;
}) {
  const [codigo, setCodigo] = useState("");
  const [nombre, setNombre] = useState("");
  const [tipo, setTipo] = useState<DBPlanCuentas["tipo"]>("gasto_operacional");
  const [parentId, setParentId] = useState<string>("");
  const [esHoja, setEsHoja] = useState(true);

  // Padres posibles: solo cuentas que no son hoja
  const padres = cuentas.filter((c) => !c.es_hoja);

  const handleSubmit = () => {
    if (!codigo.trim() || !nombre.trim()) return;
    // Calcular nivel basado en puntos del código
    const nivel = codigo.split(".").length - 1;
    onSave({
      codigo: codigo.trim(),
      nombre: nombre.trim(),
      tipo,
      parent_id: parentId || null,
      nivel,
      es_hoja: esHoja,
      activa: true,
    });
  };

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Nueva cuenta contable</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8, marginBottom: 12 }}>
        <div>
          <label className="form-label">Código</label>
          <input className="form-input mono" value={codigo} onChange={(e) => setCodigo(e.target.value)}
            placeholder="ej: 6.1.08" style={{ fontSize: 13 }} />
        </div>
        <div>
          <label className="form-label">Nombre</label>
          <input className="form-input" value={nombre} onChange={(e) => setNombre(e.target.value)}
            placeholder="ej: Fletes y transporte" style={{ fontSize: 13 }} />
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
        <div>
          <label className="form-label">Tipo</label>
          <select className="form-input" value={tipo} onChange={(e) => setTipo(e.target.value as DBPlanCuentas["tipo"])} style={{ fontSize: 12 }}>
            <option value="ingreso">Ingreso</option>
            <option value="costo">Costo</option>
            <option value="gasto_operacional">Gasto Operacional</option>
            <option value="gasto_no_op">Gasto No Op.</option>
          </select>
        </div>
        <div>
          <label className="form-label">Cuenta padre</label>
          <select className="form-input" value={parentId} onChange={(e) => setParentId(e.target.value)} style={{ fontSize: 12 }}>
            <option value="">— Raíz —</option>
            {padres.map((p) => (
              <option key={p.id} value={p.id}>{p.codigo} — {p.nombre}</option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8, paddingBottom: 4 }}>
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={esHoja} onChange={(e) => setEsHoja(e.target.checked)} />
            Es cuenta hoja
          </label>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel}
          style={{ padding: "6px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", fontSize: 12, border: "1px solid var(--bg4)" }}>
          Cancelar
        </button>
        <button onClick={handleSubmit} disabled={!codigo.trim() || !nombre.trim()}
          className="scan-btn green" style={{ padding: "6px 16px", fontSize: 12 }}>
          Guardar
        </button>
      </div>
    </div>
  );
}

// ==================== COMPONENTE PRINCIPAL ====================

export default function PlanCuentasTree({ onSelect }: PlanCuentasTreeProps) {
  const [cuentas, setCuentas] = useState<DBPlanCuentas[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const load = async () => {
    setLoading(true);
    const data = await fetchPlanCuentas();
    setCuentas(data);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const tree = buildTree(cuentas);

  // Toggle activa/inactiva
  const handleToggleActive = async (id: string, activa: boolean) => {
    await updatePlanCuenta(id, { activa });
    load();
  };

  // Editar nombre
  const handleEditName = async (id: string, nombre: string) => {
    await updatePlanCuenta(id, { nombre });
    load();
  };

  // Crear nueva cuenta
  const handleCreate = async (c: DBPlanCuentas) => {
    await upsertPlanCuenta(c);
    setShowForm(false);
    load();
  };

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando plan de cuentas...</div>;

  // Resumen por tipo
  const hojas = cuentas.filter((c) => c.es_hoja && c.activa);
  const porTipo = hojas.reduce((acc, c) => {
    acc[c.tipo] = (acc[c.tipo] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Plan de Cuentas</h2>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 2 }}>
            {cuentas.length} cuentas · {hojas.length} hojas activas
          </div>
        </div>
        <button onClick={() => setShowForm(!showForm)}
          className="scan-btn blue" style={{ padding: "6px 16px", fontSize: 12 }}>
          {showForm ? "Cancelar" : "+ Nueva cuenta"}
        </button>
      </div>

      {/* Resumen por tipo */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {Object.entries(TIPO_COLORS).map(([key, style]) => (
          <div key={key} style={{ padding: "4px 10px", borderRadius: 6, background: style.bg, fontSize: 11 }}>
            <span style={{ color: style.color, fontWeight: 600 }}>{style.label}</span>
            <span className="mono" style={{ marginLeft: 6, fontWeight: 700 }}>{porTipo[key] || 0}</span>
          </div>
        ))}
      </div>

      {/* Formulario nueva cuenta */}
      {showForm && (
        <NuevaCuentaForm cuentas={cuentas} onSave={handleCreate} onCancel={() => setShowForm(false)} />
      )}

      {/* Árbol */}
      <div className="card" style={{ overflow: "hidden" }}>
        <div style={{ fontSize: 10, color: "var(--txt3)", padding: "6px 8px", background: "var(--bg3)", borderBottom: "1px solid var(--bg4)" }}>
          Doble click en el nombre para editar · Toggle para activar/desactivar
        </div>
        {tree.map((node) => (
          <TreeNodeItem
            key={node.id}
            node={node}
            depth={0}
            onToggleActive={handleToggleActive}
            onEditName={handleEditName}
            onSelect={onSelect}
          />
        ))}
        {tree.length === 0 && (
          <div style={{ padding: 32, textAlign: "center", color: "var(--txt3)" }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>📋</div>
            <div style={{ fontSize: 13 }}>Sin cuentas contables. Ejecuta la migración v8 primero.</div>
          </div>
        )}
      </div>
    </div>
  );
}
