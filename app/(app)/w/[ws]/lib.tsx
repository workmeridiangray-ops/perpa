import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function db() {
  return createClient();
}
/** Redirect back with a short error code instead of throwing. */
export function back(path: string, error?: string | null): never {
  redirect(error ? `${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(error.slice(0, 160))}` : path);
}
export const input = "mt-1 block w-full rounded-md border border-line bg-white px-3 py-2";
export const btn = "rounded-md bg-brand px-4 py-2 text-white";
export const ghost = "rounded-md border border-line bg-white px-3 py-1.5 text-sm";
export function ErrorNote({ error }: { error?: string }) {
  return error ? <p role="alert" className="mt-3 text-danger">{error}</p> : null;
}

/** Hidden inputs shared by every action form. */
export function Hidden({ fields }: { fields: Record<string, string> }) {
  return <>{Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}</>;
}
export async function myRole(ws: string): Promise<string | null> {
  const supabase = await db();
  const { data: { user } } = await supabase.auth.getUser();
  const { data } = await supabase.from("memberships").select("role").eq("business_id", ws).eq("user_id", user?.id ?? "").eq("status", "active").maybeSingle();
  return (data?.role as string | undefined) ?? null;
}
export const table = "mt-4 w-full max-w-4xl border-collapse overflow-hidden rounded-lg border border-line bg-white text-sm";
export const card = "mt-4 grid max-w-xl gap-3 rounded-lg border border-line bg-white p-4";
