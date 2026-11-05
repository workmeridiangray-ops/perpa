import { NextResponse } from "next/server";
import { verifySignature } from "@/lib/rules/webhooks";
import { serviceClient } from "@/lib/supabase/service";

/**
 * Provider-agnostic payment callback. The provider (or an adapter in front of it) sends JSON
 * { business_id, provider_ref, amount_paise, status } signed with HMAC-SHA256 in `x-signature`
 * (the scheme Razorpay uses for its webhooks). Replays are harmless: provider_ref is unique.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySignature(process.env.PAYMENT_WEBHOOK_SECRET ?? "", raw, req.headers.get("x-signature"))) return new NextResponse("Bad signature", { status: 401 });
  let b: { business_id?: string; provider_ref?: string; amount_paise?: number; status?: string };
  try { b = JSON.parse(raw); } catch { return new NextResponse("Bad JSON", { status: 400 }); }
  if (!b.business_id || !b.provider_ref || !Number.isInteger(b.amount_paise) || !["pending", "succeeded", "failed", "disputed", "refunded"].includes(b.status ?? "")) {
    return new NextResponse("Invalid payload", { status: 422 });
  }
  const { error } = await serviceClient().rpc("record_saas_charge", { p_business: b.business_id, p_ref: b.provider_ref, p_amount: b.amount_paise, p_status: b.status });
  return error ? new NextResponse("Failed", { status: 500 }) : NextResponse.json({ ok: true });
}
