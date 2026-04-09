import { createClient, SupabaseClient } from "@supabase/supabase-js";

const IS_TEST_MODE = process.env.NEXT_PUBLIC_TEST_MODE === "true";

const SUPABASE_URL = IS_TEST_MODE
  ? (process.env.NEXT_PUBLIC_SUPABASE_TEST_URL || "")
  : (process.env.NEXT_PUBLIC_SUPABASE_URL || "");

const SUPABASE_ANON_KEY = IS_TEST_MODE
  ? (process.env.NEXT_PUBLIC_SUPABASE_TEST_ANON_KEY || "")
  : (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");

let _serverClient: SupabaseClient | null = null;

export function getServerSupabase(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  if (!_serverClient) {
    // CRÍTICO: Next.js 14 App Router cachea fetch() por defecto.
    // Esto causaba que getMLConfig() devolviera tokens viejos desde caché
    // aún cuando saveMLConfig() ya había escrito tokens nuevos en DB.
    // Resultado: ML devolvía 401 "invalid access token" en producción.
    _serverClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        fetch: (input, init) => fetch(input as RequestInfo, { ...(init || {}), cache: "no-store" }),
      },
    });
  }
  return _serverClient;
}
