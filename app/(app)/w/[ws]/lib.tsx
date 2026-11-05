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
