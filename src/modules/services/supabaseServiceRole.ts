import { createClient } from "@supabase/supabase-js";

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = (
  process.env.SUPABASE_SERVICE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
);

if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing required env var: SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY");
}

export const supabaseServiceRole = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
