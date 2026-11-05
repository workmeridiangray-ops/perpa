import "server-only";
import { checkWebhookUrl, sign } from "@/lib/rules/webhooks";
import { serviceClient } from "@/lib/supabase/service";

type Job = { id: string; business_id: string | null; kind: "email" | "webhook"; payload: Record<string, unknown> };

async function sendEmail(p: Record<string, unknown>) {
  const url = process.env.EMAIL_API_URL, key = process.env.EMAIL_API_KEY, from = process.env.EMAIL_FROM;
  if (!url || !key || !from) throw new Error("Email provider is not configured (EMAIL_API_URL, EMAIL_API_KEY, EMAIL_FROM)");
  const res = await fetch(url, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: p.to, subject: p.subject, text: p.text }), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Email provider answered ${res.status}`);
}

async function deliverWebhook(job: Job) {
  const db = serviceClient();
  const { endpoint, event, data } = job.payload as { endpoint: string; event: string; data: unknown };
  const { data: ep } = await db.from("webhook_endpoints").select("id, url, secret, active").eq("id", endpoint).maybeSingle();
  if (!ep || !ep.active) return; // endpoint removed or paused: nothing to deliver
  const bad = checkWebhookUrl(ep.url);
  if (bad) throw new Error(bad);
  const body = JSON.stringify({ event, data, delivered_at: new Date().toISOString() });
  let status: number | null = null, err: string | null = null;
  try {
    const res = await fetch(ep.url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", "x-perpa-event": event, "x-perpa-signature": `sha256=${sign(ep.secret, body)}` }, body,
    });
    status = res.status;
    if (!res.ok) err = `Endpoint answered ${res.status}`;
  } catch (e) { err = (e as Error).message; }
  await db.from("webhook_logs").insert({ business_id: job.business_id, endpoint_id: ep.id, event, status_code: status, ok: !err, error: err });
  if (err) throw new Error(err);
}

/** Claims due jobs, runs them, and records success or a backed-off failure. Bounded per run. */
export async function runJobs(limit = 20): Promise<{ done: number; failed: number }> {
  const db = serviceClient();
  const { data: jobs, error } = await db.rpc("claim_jobs", { p_limit: limit });
  if (error) throw new Error(error.message);
  let done = 0, failed = 0;
  for (const job of (jobs ?? []) as Job[]) {
    try {
      if (job.kind === "email") await sendEmail(job.payload);
      else await deliverWebhook(job);
      await db.rpc("complete_job", { p_id: job.id });
      done++;
    } catch (e) {
      await db.rpc("fail_job", { p_id: job.id, p_error: (e as Error).message });
      failed++;
    }
  }
  return { done, failed };
}
