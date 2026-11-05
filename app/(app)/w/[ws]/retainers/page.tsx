import { back, btn, card, db, ErrorNote, ghost, Hidden, input, myRole, table } from "../lib";

async function act(f: FormData) {
  "use server";
  const ws = String(f.get("ws")), what = String(f.get("what")), id = String(f.get("id") ?? "");
  const supabase = await db();
  let error: string | undefined;
  if (what === "create") {
    const { data: pr } = await supabase.from("projects").select("engagements(client_id)").eq("id", String(f.get("project"))).single();
    error = (await supabase.from("retainers").insert({ business_id: ws, project_id: String(f.get("project")), client_id: (pr?.engagements as unknown as { client_id: string } | null)?.client_id, name: String(f.get("name") ?? ""), included_minutes: Math.round(Number(f.get("hours")) * 60), carryover: f.get("carry") === "on" })).error?.message;
  } else if (what === "roll") error = (await supabase.rpc("roll_retainer", { p_retainer: id })).error?.message;
  else if (what === "overage") error = (await supabase.from("retainer_periods").update({ overage_approved: true }).eq("id", id)).error?.message;
  else if (what === "cancel") error = (await supabase.rpc("cancel_retainer", { p_retainer: id })).error?.message;
  back(`/w/${ws}/retainers`, error);
}

export default async function Retainers({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ ws }, { error }] = await Promise.all([params, searchParams]);
  const supabase = await db();
  const isMgr = ["owner", "manager"].includes((await myRole(ws)) ?? "");
  const [{ data: rs }, { data: ps }, { data: projects }, { data: used }] = await Promise.all([
    supabase.from("retainers").select("id, name, included_minutes, carryover, status").eq("business_id", ws),
    supabase.from("retainer_periods").select("*").eq("business_id", ws).order("starts_on", { ascending: false }),
    supabase.from("projects").select("id, name").eq("business_id", ws),
    supabase.from("time_entries").select("retainer_period_id, minutes").eq("business_id", ws).not("retainer_period_id", "is", null).neq("status", "rejected"),
  ]);
  const usedBy = new Map<string, number>();
  for (const u of used ?? []) usedBy.set(u.retainer_period_id, (usedBy.get(u.retainer_period_id) ?? 0) + u.minutes);
  const h = (what: string, extra: Record<string, string> = {}) => <Hidden fields={{ ws, what, ...extra }} />;
  return (
    <>
      <h1 className="text-xl font-semibold">Retainers</h1>
      <ErrorNote error={error} />
      {(rs ?? []).map((r) => {
        const periods = (ps ?? []).filter((p) => p.retainer_id === r.id);
        return (
          <section key={r.id} className="mt-6">
            <h2 className="font-medium">{r.name} <span className="text-sm font-normal text-muted">· {r.included_minutes / 60} h / period · {r.carryover ? "unused time carries over" : "unused time expires"} · {r.status}</span></h2>
            <table className={table}>
              <thead className="bg-canvas text-left text-muted"><tr><th className="p-3">Period</th><th className="text-right">Allowance</th><th className="text-right">Used</th><th className="text-right">Remaining</th><th /></tr></thead>
              <tbody>
                {periods.length === 0 && <tr><td colSpan={5} className="p-4 text-muted">No periods yet.</td></tr>}
                {periods.map((p) => {
                  const total = p.included_minutes + p.carried_minutes, u = usedBy.get(p.id) ?? 0;
                  return (
                    <tr key={p.id} className="border-t border-line">
                      <td className="p-3">{p.starts_on} → {p.ends_on}</td>
                      <td className="text-right tabular-nums">{(total / 60).toFixed(1)} h{p.carried_minutes ? ` (incl. ${(p.carried_minutes / 60).toFixed(1)} carried)` : ""}</td>
                      <td className="text-right tabular-nums">{(u / 60).toFixed(1)} h</td>
                      <td className={`text-right tabular-nums ${u > total ? "text-danger" : ""}`}>{((total - u) / 60).toFixed(1)} h{u > total ? " (overage)" : ""}</td>
                      <td className="p-2">{isMgr && !p.overage_approved && <form action={act}>{h("overage", { id: p.id })}<button className={ghost}>Approve overage</button></form>}{p.overage_approved && <span className="text-muted">overage approved</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {isMgr && r.status === "active" && (
              <div className="mt-2 flex gap-2">
                <form action={act}>{h("roll", { id: r.id })}<button className={ghost}>Start next period</button></form>
                <form action={act}>{h("cancel", { id: r.id })}<button className={ghost}>Cancel retainer</button></form>
              </div>)}
          </section>
        );
      })}
      {(rs ?? []).length === 0 && <p className="mt-4 text-muted">No retainers yet.</p>}
      {isMgr && (
        <form action={act} className={card}>
          {h("create")}<h2 className="font-medium">New retainer</h2>
          <label className="text-sm">Project<select name="project" required className={input}>{(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="text-sm">Name<input name="name" required className={input} /></label>
          <label className="text-sm">Included hours per period<input name="hours" type="number" min="0.25" step="0.25" required className={input} /></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="carry" /> Unused time carries over</label>
          <button className={btn}>Create</button>
        </form>)}
    </>
  );
}
