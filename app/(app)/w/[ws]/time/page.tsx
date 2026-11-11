import { back, btn, db, ErrorNote, ghost, input } from "../lib";

async function act(f: FormData) {
  "use server";
  const ws = String(f.get("ws")), what = String(f.get("what"));
  const supabase = await db();
  const { data: { user } } = await supabase.auth.getUser();
  let error: string | undefined;
  if (what === "log") {
    error = (await supabase.from("time_entries").insert({
      business_id: ws, project_id: String(f.get("project")), user_id: user?.id, work_date: String(f.get("date")),
      minutes: Math.round(Number(f.get("hours")) * 60), billable: f.get("billable") === "on", note: String(f.get("note") ?? ""),
    })).error?.message;
  } else if (what === "submit") {
    error = (await supabase.from("time_entries").update({ status: "submitted" }).eq("id", String(f.get("entry"))).select("id")).error?.message;
  } else if (what === "approve") {
    error = (await supabase.from("time_entries").update({ status: "approved" }).eq("id", String(f.get("entry")))).error?.message;
  } else if (what === "reject") {
    error = (await supabase.from("time_entries").update({ status: "rejected", reject_reason: String(f.get("reason") ?? "") }).eq("id", String(f.get("entry")))).error?.message;
  }
  back(`/w/${ws}/time`, error);
}

export default async function Time({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ ws }, { error }] = await Promise.all([params, searchParams]);
  const supabase = await db();
  const { data: { user } } = await supabase.auth.getUser();
  const [{ data: projects }, { data: entries }, { data: me }] = await Promise.all([
    supabase.from("projects").select("id, name").eq("business_id", ws).eq("status", "active"),
    supabase.from("time_entries").select("id, user_id, work_date, minutes, billable, status, note, reject_reason, projects(name)").eq("business_id", ws).order("work_date", { ascending: false }).limit(100),
    supabase.from("memberships").select("role").eq("business_id", ws).eq("user_id", user?.id ?? "").maybeSingle(),
  ]);
  const isMgr = me?.role === "owner" || me?.role === "manager";
  const hid = (what: string, extra: Record<string, string> = {}) => (<><input type="hidden" name="ws" value={ws} /><input type="hidden" name="what" value={what} />{Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}</>);
  return (
    <>
      <h1 className="text-xl font-semibold">Timesheet</h1>
      <ErrorNote error={error} />
      <form action={act} className="mt-4 grid max-w-xl gap-3 rounded-lg border border-line bg-white p-4">
        {hid("log")}
        <label className="text-sm">Project<select name="project" required className={input}>{(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">Date<input name="date" type="date" required className={input} /></label>
          <label className="text-sm">Hours<input name="hours" type="number" min="0.25" max="16" step="0.25" required className={input} /></label>
        </div>
        <label className="text-sm">Note<input name="note" className={input} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="billable" defaultChecked /> Billable</label>
        <button className={btn} disabled={!projects?.length}>Log time</button>
        {!projects?.length && <p className="text-sm text-muted">No active projects yet.</p>}
      </form>
      <table className="mt-6 w-full max-w-4xl border-collapse overflow-hidden rounded-lg border border-line bg-white text-sm">
        <thead className="bg-canvas text-left text-muted"><tr><th className="p-3">Date</th><th>Project</th><th className="text-right">Hours</th><th>Status</th><th /></tr></thead>
        <tbody>
          {(entries ?? []).length === 0 && <tr><td colSpan={5} className="p-4 text-muted">No time logged yet.</td></tr>}
          {(entries ?? []).map((e) => (
            <tr key={e.id} className="border-t border-line">
              <td className="p-3">{e.work_date}</td>
              <td>{(e.projects as unknown as { name: string } | null)?.name}{e.billable ? "" : " (non-billable)"}</td>
              <td className="text-right tabular-nums">{(e.minutes / 60).toFixed(2)}</td>
              <td>{e.status}{e.reject_reason ? ` — ${e.reject_reason}` : ""}</td>
              <td className="flex justify-end gap-2 p-2">
                {(e.status === "draft" || e.status === "rejected") && e.user_id === user?.id && <form action={act}>{hid("submit", { entry: e.id })}<button className={ghost}>Submit</button></form>}
                {isMgr && e.status === "submitted" && e.user_id !== user?.id && (
                  <>
                    <form action={act}>{hid("approve", { entry: e.id })}<button className={ghost}>Approve</button></form>
                    <form action={act} className="flex gap-1">{hid("reject", { entry: e.id })}<input name="reason" required placeholder="Reason" aria-label="Reason" className="rounded-md border border-line px-2 text-sm" /><button className={ghost}>Reject</button></form>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
