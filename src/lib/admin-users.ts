import { getSupabase } from "./supabase";

export type AdminRol = "super_admin" | "admin" | "operaciones" | "viewer" | "custom";

export interface AdminUser {
  id: string;
  email: string | null;
  nombre: string;
  pin: string;
  rol: AdminRol;
  permisos: string[];
  activo: boolean;
  created_at?: string;
  updated_at?: string;
}

// Catalogo canonico de tabs del admin (fuente unica de verdad para permisos).
// Al agregar tabs nuevos al panel hay que sumarlos aca para que aparezcan en
// el editor de permisos custom.
export const ADMIN_TAB_CATALOG: Array<{ key: string; label: string; group: string; parent?: string }> = [
  { key: "dash", label: "Dashboard", group: "Principal" },
  { key: "rec", label: "Recepciones", group: "Operaciones" },
  { key: "discrepancias", label: "Discrepancias", group: "Operaciones" },
  { key: "flex", label: "Ultima Milla", group: "Operaciones" },
  { key: "enviosfull", label: "Envios Full", group: "Operaciones" },
  { key: "ops", label: "Operaciones", group: "Operaciones" },
  { key: "reposicion", label: "Reposicion", group: "Operaciones" },
  { key: "inv", label: "Inventario", group: "Inventario" },
  { key: "mov", label: "Movimientos", group: "Inventario" },
  { key: "timeline", label: "Timeline", group: "Inventario" },
  { key: "prod", label: "Productos", group: "Inventario" },
  { key: "costoauditoria", label: "Auditoria Costos", group: "Inventario" },
  { key: "stockml", label: "Stock ML", group: "Inventario" },
  { key: "intel", label: "Inteligencia", group: "Inteligencia" },
  { key: "semaforo", label: "Semaforo", group: "Inteligencia" },
  { key: "compras", label: "Compras", group: "Inteligencia" },
  { key: "eventos", label: "Eventos", group: "Inteligencia" },
  { key: "ventasdash", label: "Ventas - Dashboard", group: "Comercial" },
  { key: "ventasord", label: "Ventas - Ordenes", group: "Comercial" },
  { key: "comercial", label: "Publicaciones", group: "Comercial" },
  { key: "margenes", label: "Margenes", group: "Comercial" },
  { key: "agentes", label: "Agentes IA", group: "Sistema" },
  { key: "config", label: "Configuracion", group: "Sistema" },
  // Sub-tabs de Configuracion (granularidad fina para rol custom).
  { key: "config.por_atender", label: "Por Atender", group: "Sistema", parent: "config" },
  { key: "config.general", label: "General (categorias/proveedores)", group: "Sistema", parent: "config" },
  { key: "config.ml", label: "MercadoLibre (OAuth)", group: "Sistema", parent: "config" },
  { key: "config.diccionario", label: "Diccionario", group: "Sistema", parent: "config" },
  { key: "config.posiciones", label: "Posiciones", group: "Sistema", parent: "config" },
  { key: "config.mapa", label: "Mapa Bodega", group: "Sistema", parent: "config" },
  { key: "config.etiquetas", label: "Etiquetas", group: "Sistema", parent: "config" },
  { key: "config.carga_stock", label: "Carga Stock", group: "Sistema", parent: "config" },
  { key: "config.conteos", label: "Conteo Ciclico", group: "Sistema", parent: "config" },
  { key: "config.conciliador", label: "Conciliador", group: "Sistema", parent: "config" },
];

// Permisos por rol (super_admin = "*" = todo, incluyendo gestion de usuarios).
// "admin" = todo menos "usuarios" (dentro de config). No hay tab separado
// para gestion de usuarios, se maneja adentro del tab config con flag.
const ROL_PERMISOS: Record<Exclude<AdminRol, "custom">, string[]> = {
  super_admin: ADMIN_TAB_CATALOG.map(t => t.key),
  admin: ADMIN_TAB_CATALOG.map(t => t.key),
  operaciones: ["dash", "rec", "discrepancias", "flex", "enviosfull", "ops", "reposicion"],
  viewer: ["dash", "inv", "mov", "timeline"],
};

/** Verifica si un usuario puede acceder a un tab (top-level o con dot-notation). */
export function canAccessTab(user: AdminUser | null, tabKey: string): boolean {
  if (!user) return false;
  if (user.rol === "super_admin") return true;
  if (user.rol === "admin") return true;
  if (user.rol === "custom") {
    const perms = user.permisos || [];
    return perms.includes(tabKey);
  }
  const allowed = ROL_PERMISOS[user.rol] || [];
  return allowed.includes(tabKey);
}

/**
 * Verifica si un usuario puede ver un subtab dentro de un tab padre.
 *
 * Reglas:
 *  - super_admin / admin → todos los subtabs.
 *  - Roles predefinidos (operaciones / viewer) → todos los subtabs de los tabs
 *    que tienen permiso en el tab padre (no hay granularidad para estos).
 *  - Custom: si el user tiene al menos UN subtab especifico del padre en sus
 *    permisos (p.ej. "config.carga_stock"), solo esos son visibles. Si tiene
 *    solo "config" sin subtabs especificos, ve TODOS los subtabs (compat).
 */
export function canAccessSubtab(user: AdminUser | null, parentKey: string, subKey: string): boolean {
  if (!user) return false;
  if (user.rol === "super_admin" || user.rol === "admin") return true;
  if (user.rol === "custom") {
    const perms = user.permisos || [];
    if (!perms.includes(parentKey)) return false;
    const specificSubs = perms.filter(p => p.startsWith(`${parentKey}.`));
    if (specificSubs.length === 0) return true; // sin granularidad = todos
    return perms.includes(`${parentKey}.${subKey}`);
  }
  // Roles predefinidos: si pueden entrar al padre, ven todos los subtabs.
  return canAccessTab(user, parentKey);
}

/** Verifica si un usuario puede gestionar otros usuarios (solo super_admin). */
export function canManageUsers(user: AdminUser | null): boolean {
  return user?.rol === "super_admin";
}

/** Devuelve los permisos efectivos (resuelve el rol a la lista de tabs). */
export function permisosEfectivos(user: AdminUser): string[] {
  if (user.rol === "custom") return user.permisos || [];
  return ROL_PERMISOS[user.rol] || [];
}

function rowToUser(r: Record<string, unknown>): AdminUser {
  return {
    id: r.id as string,
    email: (r.email as string) || null,
    nombre: (r.nombre as string) || "",
    pin: (r.pin as string) || "",
    rol: ((r.rol as string) || "custom") as AdminRol,
    permisos: Array.isArray(r.permisos) ? (r.permisos as string[]) : [],
    activo: (r.activo as boolean) ?? true,
    created_at: r.created_at as string | undefined,
    updated_at: r.updated_at as string | undefined,
  };
}

/** Login por PIN. Devuelve user o null si no matchea. */
export async function loginAdminUser(pin: string): Promise<AdminUser | null> {
  const sb = getSupabase(); if (!sb) return null;
  const { data, error } = await sb
    .from("admin_users")
    .select("*")
    .eq("pin", pin)
    .eq("activo", true)
    .limit(1);
  if (error) {
    console.error("[admin-users] login error:", error.message);
    return null;
  }
  if (!data || data.length === 0) return null;
  return rowToUser(data[0]);
}

export async function fetchAdminUsers(): Promise<AdminUser[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data, error } = await sb
    .from("admin_users")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[admin-users] fetch error:", error.message);
    return [];
  }
  return (data || []).map(rowToUser);
}

export async function upsertAdminUser(user: Partial<AdminUser> & { nombre: string; pin: string; rol: AdminRol }): Promise<AdminUser | null> {
  const sb = getSupabase(); if (!sb) return null;
  const payload: Record<string, unknown> = {
    nombre: user.nombre,
    pin: user.pin,
    rol: user.rol,
    permisos: user.rol === "custom" ? (user.permisos || []) : [],
    activo: user.activo ?? true,
    updated_at: new Date().toISOString(),
  };
  if (user.email !== undefined) payload.email = user.email || null;
  if (user.id) payload.id = user.id;

  const { data, error } = await sb
    .from("admin_users")
    .upsert(payload, { onConflict: "id" })
    .select("*")
    .single();
  if (error) {
    console.error("[admin-users] upsert error:", error.message);
    return null;
  }
  return rowToUser(data);
}

export async function deleteAdminUser(id: string): Promise<boolean> {
  const sb = getSupabase(); if (!sb) return false;
  const { error } = await sb.from("admin_users").delete().eq("id", id);
  if (error) {
    console.error("[admin-users] delete error:", error.message);
    return false;
  }
  return true;
}
