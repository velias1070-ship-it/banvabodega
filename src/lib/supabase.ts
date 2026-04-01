"use client";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const IS_TEST_MODE = process.env.NEXT_PUBLIC_TEST_MODE === "true";

const SUPABASE_URL = IS_TEST_MODE
  ? (process.env.NEXT_PUBLIC_SUPABASE_TEST_URL || "")
  : (process.env.NEXT_PUBLIC_SUPABASE_URL || "");

const SUPABASE_ANON_KEY = IS_TEST_MODE
  ? (process.env.NEXT_PUBLIC_SUPABASE_TEST_ANON_KEY || "")
  : (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  if (!_client) {
    _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return _client;
}

export function isConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
}

export function isTestMode(): boolean {
  return IS_TEST_MODE;
}
