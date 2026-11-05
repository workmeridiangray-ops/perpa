import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client. Used ONLY by server routes that are not acting for a signed-in user
 * (job worker, verified provider callbacks, API-key reads). It bypasses RLS, so every caller must
 * authenticate the request itself and scope queries explicitly.
 */
export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
