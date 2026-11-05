import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Owner-only full export of the business's records as JSON (closure / portability). */
export async function GET(_req: Request, { params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("export_business", { p_business: ws });
  if (error) return new NextResponse("Forbidden", { status: 403 });
  await supabase.rpc("mark_exported", { p_business: ws });
  return new NextResponse(JSON.stringify(data, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="business-export-${new Date().toISOString().slice(0, 10)}.json"` } });
}
