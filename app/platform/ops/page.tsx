import { notFound, redirect } from "next/navigation";
import { formatINR } from "@/lib/rules/money";
import { createClient } from "@/lib/supabase/server";

async function act(f: FormData) {
  "use server";
  const supabase = await createClient();
  const what = String(f.get("what"));
  let error: string | undefined;
  if (what === "retry") error = (await supabase.rpc("retry_job", { p_id: String(f.get("id")) })).error?.message;
  else if (what === "coupon") error = (await supabase.from("coupons").insert({ code: String(f.get("code") ?? "").toUpperCase(), percent_bps: Math.round(Number(f.get("percent")) * 100), valid_until: String(f.get("until") ?? "") || null, max_redemptions: f.get("max") ? Number(f.get("max")) : null })).error?.message;
  else if (what === "refund") error = (await supabase.from("refunds").insert({ charge_id: String(f.get("charge")), amount_paise: Math.round(Number(f.get("amount")) * 100), reason: String(f.get("reason") ?? "") })).error?.message;
  else if (what === "decide") error = (await supabase.from("refunds").update({ status: String(f.get("to")) }).eq("id", String(f.get("id")))).error?.message;
  else if (what === "incident") error = (await supabase.from("incidents").insert({ title: String(f.get("title") ?? ""), severity: String(f.get("severity")) })).error?.message;
  else if (what === "resolve") error = (await supabase.from("incidents").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", String(f.get("id")))).error?.message;
  else if (what === "announce") error = (await supabase.from("announcements").insert({ title: String(f.get("title") ?? ""), body: String(f.get("body") ?? ""), ends_at: String(f.get("ends") ?? "") || null })).error?.message;
  redirect(error ? `/platform/ops?error=${encodeURIComponent(error)}` : "/platform/ops");
}

export default async function Ops({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/platform/ops");
  const { data: staff } = await supabase.from("platform_staff").select("role").eq("user_id", user.id).maybeSingle();
  if (!staff) notFound();
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== "aal2") redirect("/security?need=platform");
  const [{ data: jobs }, { data: charges }, { data: refunds }, { data: coupons }, { data: incidents }, { data: anns }, { data: audit }] = await Promise.all([
    supabase.from("jobs").select("id, kind, status, attempts, last_error, run_after").in("status", ["failed", "dead"]).order("run_after", { ascending: false }).limit(30),
    supabase.from("saas_charges").select("id, business_id, amount_paise, status, provider_ref, created_at").order("created_at", { ascending: false }).limit(30),
    supabase.from("refunds").select("id, charge_id, amount_paise, reason, status, requested_by").order("id", { ascending: false }).limit(20),
    supabase.from("coupons").select("id, code, percent_bps, valid_until, redeemed, max_redemptions"),
    supabase.from("incidents").select("id, title, severity, status").order("created_at", { ascending: false }).limit(20),
    supabase.from("announcements").select("id, title, ends_at").order("starts_at", { ascending: false }).limit(10),
    supabase.from("platform_audit").select("id, table_name, action, at").order("id", { ascending: false }).limit(15),
  ]);
  const input = "rounded-md border border-line bg-white px-2 py-1.5 text-sm";
  const btn = "rounded-md border border-line bg-white px-3 py-1.5 text-sm";
  const hid = (w: string, extra: Record<string, string> = {}) => <><input type="hidden" name="what" value={w} />{Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}</>;
  const box = "mt-2 max-w-4xl divide-y divide-line rounded-lg border border-line bg-white text-sm";
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Operations console <span className="text-base font-normal text-muted">· {staff.role}</span></h1>
      {error && <p role="alert" className="mt-3 text-danger">{error}</p>}
      <p className="mt-2 text-sm text-muted">Tenant documents are not visible here. Support access to a business needs that owner’s time-limited approval.</p>

      <h2 className="mt-8 font-medium">Failed background jobs</h2>
      <ul className={box}>
        {(jobs ?? []).length === 0 && <li className="p-3 text-muted">None (visible to ops/owner roles only).</li>}
        {(jobs ?? []).map((j) => (
          <li key={j.id} className="flex items-center justify-between gap-2 p-3"><span>{j.kind} · {j.status} · {j.attempts} attempts<span className="block text-muted">{j.last_error}</span></span>
            <form action={act}>{hid("retry", { id: j.id })}<button className={btn}>Retry (3 more attempts)</button></form></li>))}
      </ul>

      <h2 className="mt-8 font-medium">Subscription charges</h2>
      <ul className={box}>
        {(charges ?? []).length === 0 && <li className="p-3 text-muted">No charges recorded.</li>}
        {(charges ?? []).map((c) => <li key={c.id} className="p-3">{formatINR(c.amount_paise)} · {c.status} · ref {c.provider_ref} · {c.business_id.slice(0, 8)}</li>)}
      </ul>
      <h3 className="mt-4 text-sm font-medium">Refunds (a different person must approve)</h3>
      <ul className={box}>
        {(refunds ?? []).map((r) => (
          <li key={r.id} className="flex items-center justify-between p-3"><span>{formatINR(r.amount_paise)} · {r.status} · {r.reason}</span>
            {r.status === "requested" && r.requested_by !== user.id && <span className="flex gap-1"><form action={act}>{hid("decide", { id: r.id, to: "approved" })}<button className={btn}>Approve</button></form><form action={act}>{hid("decide", { id: r.id, to: "rejected" })}<button className={btn}>Reject</button></form></span>}</li>))}
      </ul>
      <form action={act} className="mt-2 flex flex-wrap items-end gap-2">{hid("refund")}
        <select name="charge" aria-label="Charge" className={input}>{(charges ?? []).filter((c) => c.status === "succeeded" || c.status === "disputed").map((c) => <option key={c.id} value={c.id}>{c.provider_ref} · {formatINR(c.amount_paise)}</option>)}</select>
        <input name="amount" type="number" min="0.01" step="0.01" required placeholder="₹" aria-label="₹" className={input} /><input name="reason" required placeholder="Reason" aria-label="Reason" className={input} /><button className={btn}>Request refund</button></form>

      <h2 className="mt-8 font-medium">Coupons</h2>
      <ul className={box}>{(coupons ?? []).map((c) => <li key={c.id} className="p-3">{c.code} · {c.percent_bps / 100}% · used {c.redeemed}{c.max_redemptions ? `/${c.max_redemptions}` : ""}{c.valid_until ? ` · until ${c.valid_until}` : ""}</li>)}</ul>
      <form action={act} className="mt-2 flex flex-wrap items-end gap-2">{hid("coupon")}<input name="code" required placeholder="CODE" aria-label="CODE" className={input} /><input name="percent" type="number" min="0.01" max="100" step="0.01" required placeholder="% off" aria-label="% off" className={input} /><input name="until" type="date" className={input} /><input name="max" type="number" min="1" placeholder="Max uses" aria-label="Max uses" className={input} /><button className={btn}>Create coupon</button></form>

      <h2 className="mt-8 font-medium">Incidents</h2>
      <ul className={box}>{(incidents ?? []).map((i) => <li key={i.id} className="flex items-center justify-between p-3"><span>{i.title} · {i.severity} · {i.status}</span>{i.status !== "resolved" && <form action={act}>{hid("resolve", { id: i.id })}<button className={btn}>Resolve</button></form>}</li>)}</ul>
      <form action={act} className="mt-2 flex flex-wrap items-end gap-2">{hid("incident")}<input name="title" required placeholder="What happened" aria-label="What happened" className={input} /><select name="severity" aria-label="Severity" className={input}><option>minor</option><option>major</option><option>critical</option></select><button className={btn}>Open incident</button></form>

      <h2 className="mt-8 font-medium">Announcements</h2>
      <ul className={box}>{(anns ?? []).map((a) => <li key={a.id} className="p-3">{a.title}{a.ends_at ? ` · until ${new Date(a.ends_at).toLocaleDateString("en-IN")}` : ""}</li>)}</ul>
      <form action={act} className="mt-2 flex flex-wrap items-end gap-2">{hid("announce")}<input name="title" required placeholder="Headline" aria-label="Headline" className={input} /><input name="body" placeholder="Details" aria-label="Details" className={input} /><input name="ends" type="datetime-local" className={input} /><button className={btn}>Publish</button></form>

      <h2 className="mt-8 font-medium">Platform audit</h2>
      <ul className="mt-2 text-sm text-muted">{(audit ?? []).map((a) => <li key={a.id}>{new Date(a.at).toLocaleString("en-IN")} · {a.action} {a.table_name}</li>)}</ul>
    </main>
  );
}
