import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";

/** Read-only API: GET /api/v1/clients with `Authorization: Bearer <api key>`. Scoped to the key's business. */
export async function GET(req: Request) {
  const key = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (key.length < 32) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = serviceClient();
  const { data: business } = await db.rpc("resolve_api_key", { p_key: key });
  if (!business) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data } = await db.from("clients").select("id, name, archived, created_at, custom").eq("business_id", business).order("name").limit(500);
  return NextResponse.json({ data: data ?? [] });
}
