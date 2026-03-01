import { createClient, SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

let _serverClient: SupabaseClient | null = null;

export function getServerSupabase(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  if (!_serverClient) {
    _serverClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return _serverClient;
}
