// ==================== SUPABASE CONFIG ====================
// INSTRUCCIONES:
// 1. Crea un proyecto en https://supabase.com
// 2. Ve a Settings → API y copia tu URL y anon key
// 3. Pégalos aquí abajo
// 4. Ve a SQL Editor y ejecuta el SQL del archivo supabase-setup.sql

const SUPABASE_URL = "https://qaircihuiafgnnrwcjls.supabase.co"; // ej: "https://xxxxx.supabase.co"
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFhaXJjaWh1aWFmZ25ucndjamxzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNTM0MDIsImV4cCI6MjA4NzYyOTQwMn0.R3jT5azcoj1IPacCo0HJFVYlLrqbbM4PoihKQoz0FS8"; // ej: "eyJhbGciOiJI..."

// ==================== HELPERS ====================
export function isSupabaseConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
}

function headers() {
  return {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    "Prefer": "return=representation",
  };
}

const TABLE = "wms_state";
const ROW_ID = "banva_main"; // single row for all state

// ==================== PUSH STATE TO CLOUD ====================
// Debounced push - waits 1s after last saveStore() call before uploading
let _pushTimer: ReturnType<typeof setTimeout> | null = null;
let _pushing = false;

export function schedulePush(data: unknown) {
  if (!isSupabaseConfigured()) return;
  if (_pushTimer) clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => pushToCloud(data), 1000);
}

async function pushToCloud(data: unknown) {
  if (_pushing) return;
  _pushing = true;
  try {
    const payload = { id: ROW_ID, state: data, updated_at: new Date().toISOString() };
    // Upsert: insert or update
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?on_conflict=id`, {
      method: "POST",
      headers: { ...headers(), "Prefer": "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      console.error("Supabase push error:", resp.status, await resp.text());
    }
  } catch (err) {
    console.error("Supabase push failed:", err);
  }
  _pushing = false;
}

// ==================== PULL STATE FROM CLOUD ====================
let _lastPulledAt: string | null = null;

export async function pullFromCloud(): Promise<{ data: unknown; changed: boolean } | null> {
  if (!isSupabaseConfigured()) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=state,updated_at`, {
      method: "GET",
      headers: headers(),
    });
    if (!resp.ok) return null;
    const rows = await resp.json();
    if (!rows || rows.length === 0) return null;
    
    const row = rows[0];
    const changed = row.updated_at !== _lastPulledAt;
    _lastPulledAt = row.updated_at;
    
    return { data: row.state, changed };
  } catch (err) {
    console.error("Supabase pull failed:", err);
    return null;
  }
}

// ==================== CLOUD STATUS ====================
export async function getCloudStatus(): Promise<"connected" | "empty" | "error" | "not_configured"> {
  if (!isSupabaseConfigured()) return "not_configured";
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=updated_at`, {
      method: "GET",
      headers: headers(),
    });
    if (!resp.ok) return "error";
    const rows = await resp.json();
    return rows.length > 0 ? "connected" : "empty";
  } catch {
    return "error";
  }
}
