import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runJobs } from "@/lib/jobs/worker";

// Call from a scheduler (cron) with `Authorization: Bearer $CRON_SECRET`.
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const a = Buffer.from(secret), b = Buffer.from(token);
  if (secret.length < 24 || a.length !== b.length || !timingSafeEqual(a, b)) return new NextResponse("Unauthorized", { status: 401 });
  return NextResponse.json(await runJobs());
}
