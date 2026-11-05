import { notFound, redirect } from "next/navigation";
import { formatINR } from "@/lib/rules/money";
import { createClient } from "@/lib/supabase/server";

async function act(f: FormData) {
  "use server";
  const supabase = await createClient();
  const what = String(f.get("what"));
  let error: string | undefined;
  if (what === "plan") {
    const { data: plan, error: e } = await supabase.from("plans").upsert({ code: String(f.get("code")), name: String(f.get("name")) }, { onConflict: "code" }).select("id").single();
    error = e?.message;
    if (plan) {
      const { data: last } = await supabase.from("plan_versions").select("version").eq("plan_id", plan.id).order("version", { ascending: false }).limit(1);
      error = (await supabase.from("plan_versions").insert({ plan_id: plan.id, version: (last?.[0]?.version ?? 0) + 1, monthly_paise: Math.round(Number(f.get("price")) * 100), max_users: Number(f.get("users")), max_branches: Number(f.get("branches")), effective_from: String(f.get("from")) })).error?.message;
    }
  } else if (what === "status") error = (await supabase.from("subscriptions").update({ status: String(f.get("to")) }).eq("business_id", String(f.get("b")))).error?.message;
  redirect(error ? `/platform?error=${encodeURIComponent(error)}` : "/platform");
}

export default async function Platform({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/platform");
  const { data: staff } = await supabase.from("platform_staff").select("role").eq("user_id", user.id).maybeSingle();
  if (!staff) notFound(); // do not reveal that the area exists
  const canBill = staff.role === "owner" || staff.role === "billing";
  const [{ data: subs }, { data: pv }, { data: audit }] = await Promise.all([
    supabase.from("subscriptions").select("business_id, status, current_period_end, businesses(name), plan_versions(version, monthly_paise, plans(name))"),
    supabase.from("plan_versions").select("id, version, monthly_paise, max_users, max_branches, effective_from, plans(name)").order("effective_from", { ascending: false }),
    supabase.from("audit_log").select("id, table_name, action, at").in("table_name", ["subscriptions", "support_access"]).order("id", { ascending: false }).limit(20),
  ]);
  const input = "mt-1 block w-full rounded-md border border-line bg-white px-3 py-2";
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Platform administration <span className="text-base font-normal text-muted">· {staff.role}</span></h1>
      {error && <p role="alert" className="mt-3 text-danger">{error}</p>}
      <h2 className="mt-6 font-medium">Subscriptions</h2>
      <table className="mt-2 w-full border-collapse overflow-hidden rounded-lg border border-line bg-white text-sm">
        <thead className="bg-canvas text-left text-muted"><tr><th className="p-3">Business</th><th>Plan</th><th>Status</th><th /></tr></thead>
        <tbody>
          {(subs ?? []).length === 0 && <tr><td colSpan={4} className="p-4 text-muted">No subscriptions.</td></tr>}
          {(subs ?? []).map((s) => {
            const v = s.plan_versions as unknown as { version: number; monthly_paise: number; plans: { name: string } } | null;
            return (
              <tr key={s.business_id} className="border-t border-line">
                <td className="p-3">{(s.businesses as unknown as { name: string } | null)?.name ?? s.business_id}</td>
                <td>{v ? `${v.plans.name} v${v.version} · ${formatINR(v.monthly_paise)}/mo` : "—"}</td><td>{s.status}</td>
                <td className="p-2">{canBill && <form action={act} className="flex gap-1"><input type="hidden" name="what" value="status" /><input type="hidden" name="b" value={s.business_id} />
                  <select name="to" defaultValue={s.status} className="rounded-md border border-line px-2 py-1">{["trial", "active", "past_due", "cancelled"].map((x) => <option key={x}>{x}</option>)}</select>
                  <button className="rounded-md border border-line bg-white px-3 py-1 text-sm">Set</button></form>}</td>
              </tr>);
          })}
        </tbody>
      </table>
      <h2 className="mt-8 font-medium">Plan versions</h2>
      <ul className="mt-2 divide-y divide-line rounded-lg border border-line bg-white text-sm">
        {(pv ?? []).map((v) => <li key={v.id} className="p-3">{(v.plans as unknown as { name: string }).name} v{v.version} · {formatINR(v.monthly_paise)}/mo · {v.max_users} users · {v.max_branches} branches · from {v.effective_from}</li>)}
      </ul>
      {canBill && (
        <form action={act} className="mt-4 grid max-w-xl gap-3 rounded-lg border border-line bg-white p-4">
          <input type="hidden" name="what" value="plan" />
          <h3 className="font-medium">New plan version</h3>
          <div className="grid grid-cols-2 gap-2"><label className="text-sm">Code<input name="code" required className={input} /></label><label className="text-sm">Name<input name="name" required className={input} /></label></div>
          <div className="grid grid-cols-4 gap-2">
            <label className="text-sm">₹ / month<input name="price" type="number" min="0" step="0.01" required className={input} /></label>
            <label className="text-sm">Users<input name="users" type="number" min="1" required className={input} /></label>
            <label className="text-sm">Branches<input name="branches" type="number" min="1" required className={input} /></label>
            <label className="text-sm">Effective<input name="from" type="date" required className={input} /></label>
          </div>
          <button className="rounded-md bg-brand px-4 py-2 text-white">Publish version</button>
          <p className="text-sm text-muted">Existing subscriptions keep their version; historical charges are never rewritten.</p>
        </form>)}
      <h2 className="mt-8 font-medium">Recent billing and support-access events</h2>
      <ul className="mt-2 text-sm text-muted">{(audit ?? []).map((a) => <li key={a.id}>{new Date(a.at).toLocaleString("en-IN")} · {a.action} {a.table_name}</li>)}</ul>
    </main>
  );
}
