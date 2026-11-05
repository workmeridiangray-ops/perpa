import { NextResponse } from "next/server";
import { verifySignature } from "@/lib/rules/webhooks";
import { serviceClient } from "@/lib/supabase/service";

/** Malware-scanner callback: { file_id, status: "clean" | "infected" } signed with SCAN_WEBHOOK_SECRET. Files stay unshareable until this arrives. */
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySignature(process.env.SCAN_WEBHOOK_SECRET ?? "", raw, req.headers.get("x-signature"))) return new NextResponse("Bad signature", { status: 401 });
  let b: { file_id?: string; status?: string };
  try { b = JSON.parse(raw); } catch { return new NextResponse("Bad JSON", { status: 400 }); }
  if (!b.file_id || !["clean", "infected"].includes(b.status ?? "")) return new NextResponse("Invalid payload", { status: 422 });
  const { error } = await serviceClient().rpc("set_scan_result", { p_file: b.file_id, p_status: b.status });
  return error ? new NextResponse("Failed", { status: 500 }) : NextResponse.json({ ok: true });
}
