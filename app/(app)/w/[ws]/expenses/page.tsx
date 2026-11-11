import { back, btn, card, db, ErrorNote, ghost, Hidden, input, myRole, table } from "../lib";
import { formatINR } from "@/lib/rules/money";

async function act(f: FormData) {
  "use server";
  const ws = String(f.get("ws")), what = String(f.get("what"));
  const supabase = await db();
  const { data: { user } } = await supabase.auth.getUser();
  const id = String(f.get("entry"));
  let error: string | undefined;
  if (what === "add") {
    error = (await supabase.from("expenses").insert({ business_id: ws, project_id: String(f.get("project")), user_id: user?.id, description: String(f.get("description") ?? ""), amount_paise: Math.round(Number(f.get("amount")) * 100), incurred_on: String(f.get("date")), status: "submitted" })).error?.message;
  } else if (what === "approve") error = (await supabase.from("expenses").update({ status: "approved" }).eq("id", id)).error?.message;
  else if (what === "reject") error = (await supabase.from("expenses").update({ status: "rejected", reject_reason: String(f.get("reason") ?? "") }).eq("id", id)).error?.message;
  else if (what === "pay") error = (await supabase.from("expenses").update({ paid_at: new Date().toISOString() }).eq("id", id)).error?.message;
  else if (what === "supplier") error = (await supabase.from("suppliers").insert({ business_id: ws, name: String(f.get("name") ?? ""), is_freelancer: f.get("freelancer") === "on", hourly_rate_paise: f.get("rate") ? Math.round(Number(f.get("rate")) * 100) : null })).error?.message;
  else if (what === "commit") error = (await supabase.from("commitments").insert({ business_id: ws, project_id: String(f.get("project")), supplier_id: String(f.get("supplier")), description: String(f.get("description") ?? ""), committed_paise: Math.round(Number(f.get("amount")) * 100) })).error?.message;
  else if (what === "bill") error = (await supabase.from("commitments").update({ actual_paise: Math.round(Number(f.get("actual")) * 100) }).eq("id", id)).error?.message;
  back(`/w/${ws}/expenses`, error);
}

export default async function Expenses({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ ws }, { error }] = await Promise.all([params, searchParams]);
  const supabase = await db();
  const isMgr = ["owner", "manager"].includes((await myRole(ws)) ?? "");
  const { data: { user } } = await supabase.auth.getUser();
  const [{ data: projects }, { data: ex }, { data: sup }, { data: cm }] = await Promise.all([
    supabase.from("projects").select("id, name").eq("business_id", ws).eq("status", "active"),
    supabase.from("expenses").select("id, user_id, description, amount_paise, status, paid_at, reject_reason, incurred_on, projects(name)").eq("business_id", ws).order("incurred_on", { ascending: false }).limit(100),
    isMgr ? supabase.from("suppliers").select("id, name, is_freelancer").eq("business_id", ws) : Promise.resolve({ data: [] }),
    isMgr ? supabase.from("commitments").select("id, description, committed_paise, actual_paise, suppliers(name), projects(name)").eq("business_id", ws) : Promise.resolve({ data: [] }),
  ]);
  const h = (what: string, extra: Record<string, string> = {}) => <Hidden fields={{ ws, what, ...extra }} />;
  const projOpts = (projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>);
  return (
    <>
      <h1 className="text-xl font-semibold">Expenses</h1>
      <ErrorNote error={error} />
      <form action={act} className={card}>
        {h("add")}
        <label className="text-sm">Project<select name="project" required className={input}>{projOpts}</select></label>
        <label className="text-sm">What for<input name="description" required className={input} /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm">Amount ₹<input name="amount" type="number" min="0.01" step="0.01" required className={input} /></label>
          <label className="text-sm">Date<input name="date" type="date" required className={input} /></label>
        </div>
        <button className={btn}>Submit expense</button>
      </form>
      <table className={table}>
        <thead className="bg-canvas text-left text-muted"><tr><th className="p-3">Date</th><th>Project</th><th>For</th><th className="text-right">Amount</th><th>Status</th><th /></tr></thead>
        <tbody>
          {(ex ?? []).length === 0 && <tr><td colSpan={6} className="p-4 text-muted">No expenses yet.</td></tr>}
          {(ex ?? []).map((e) => (
            <tr key={e.id} className="border-t border-line">
              <td className="p-3">{e.incurred_on}</td><td>{(e.projects as unknown as { name: string } | null)?.name}</td><td>{e.description}</td>
              <td className="text-right tabular-nums">{formatINR(e.amount_paise)}</td>
              <td>{e.status === "approved" ? (e.paid_at ? "approved · paid" : "approved · unpaid") : e.status}{e.reject_reason ? ` — ${e.reject_reason}` : ""}</td>
              <td className="flex gap-1 p-2">
                {isMgr && e.status === "submitted" && e.user_id !== user?.id && (<>
                  <form action={act}>{h("approve", { entry: e.id })}<button className={ghost}>Approve</button></form>
                  <form action={act} className="flex gap-1">{h("reject", { entry: e.id })}<input name="reason" required placeholder="Reason" aria-label="Reason" className="rounded-md border border-line px-2" /><button className={ghost}>Reject</button></form></>)}
                {isMgr && e.status === "approved" && !e.paid_at && <form action={act}>{h("pay", { entry: e.id })}<button className={ghost}>Mark paid</button></form>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {isMgr && (<>
        <h2 className="mt-8 font-medium">Suppliers and freelancers <span className="text-sm font-normal text-muted">(owner/manager only)</span></h2>
        <form action={act} className="mt-2 flex max-w-xl flex-wrap items-end gap-2">
          {h("supplier")}
          <label className="flex-1 text-sm">Name<input name="name" required className={input} /></label>
          <label className="text-sm">Hourly ₹<input name="rate" type="number" min="0" step="0.01" className={input} /></label>
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="freelancer" /> Freelancer</label>
          <button className={btn}>Add</button>
        </form>
        <h2 className="mt-8 font-medium">Purchase commitments</h2>
        <table className={table}>
          <thead className="bg-canvas text-left text-muted"><tr><th className="p-3">Supplier</th><th>Project</th><th>For</th><th className="text-right">Committed</th><th className="text-right">Actual</th><th /></tr></thead>
          <tbody>
            {(cm ?? []).length === 0 && <tr><td colSpan={6} className="p-4 text-muted">No commitments.</td></tr>}
            {(cm ?? []).map((c) => (
              <tr key={c.id} className="border-t border-line">
                <td className="p-3">{(c.suppliers as unknown as { name: string } | null)?.name}</td><td>{(c.projects as unknown as { name: string } | null)?.name}</td><td>{c.description}</td>
                <td className="text-right tabular-nums">{formatINR(c.committed_paise)}</td><td className="text-right tabular-nums">{c.actual_paise == null ? "—" : formatINR(c.actual_paise)}</td>
                <td className="p-2">{c.actual_paise == null && <form action={act} className="flex gap-1">{h("bill", { entry: c.id })}<input name="actual" type="number" min="0" step="0.01" required placeholder="Bill ₹" aria-label="Bill ₹" className="w-24 rounded-md border border-line px-2" /><button className={ghost}>Record bill</button></form>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form action={act} className={card}>
          {h("commit")}
          <h3 className="font-medium">New commitment</h3>
          <label className="text-sm">Project<select name="project" required className={input}>{projOpts}</select></label>
          <label className="text-sm">Supplier<select name="supplier" required className={input}>{(sup ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_freelancer ? " (freelancer)" : ""}</option>)}</select></label>
          <label className="text-sm">For<input name="description" required className={input} /></label>
          <label className="text-sm">Committed ₹<input name="amount" type="number" min="0" step="0.01" required className={input} /></label>
          <button className={btn}>Commit</button>
        </form>
      </>)}
    </>
  );
}
