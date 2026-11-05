import { NextResponse } from "next/server";
import { toCsv } from "@/lib/rules/csv";
import { createClient } from "@/lib/supabase/server";

export async function GET(_req: Request, { params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase.from("clients").select("name, archived, created_at").eq("business_id", ws).order("name");
  if (error) return new NextResponse("Forbidden", { status: 403 });
  const csv = toCsv([["name", "archived", "created_at"], ...(data ?? []).map((c) => [c.name, String(c.archived), c.created_at])]);
  return new NextResponse(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="clients.csv"' } });
}
