import { back, btn, card, db, ErrorNote, Hidden, input, myRole, table } from "../lib";

async function act(f: FormData) {
  "use server";
  const ws = String(f.get("ws")), what = String(f.get("what"));
  const supabase = await db();
  let error: string | undefined;
  if (what === "resource") error = (await supabase.from("resources").insert({ business_id: ws, name: String(f.get("name") ?? ""), role_label: String(f.get("role") ?? "") || null, daily_capacity_minutes: Math.round(Number(f.get("hours")) * 60) })).error?.message;
  else if (what === "book") error = (await supabase.from("allocations").insert({ business_id: ws, project_id: String(f.get("project")), resource_id: String(f.get("resource")), starts_on: String(f.get("from")), ends_on: String(f.get("to")), minutes_per_day: Math.round(Number(f.get("hours")) * 60), status: String(f.get("status")), override_reason: String(f.get("override") ?? "") || null })).error?.message;
  else if (what === "confirm") error = (await supabase.from("allocations").update({ status: "confirmed", override_reason: String(f.get("override") ?? "") || null }).eq("id", String(f.get("id")))).error?.message;
  back(`/w/${ws}/capacity`, error);
}

export default async function Capacity({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ ws }, { error }] = await Promise.all([params, searchParams]);
  const supabase = await db();
  const isMgr = ["owner", "manager"].includes((await myRole(ws)) ?? "");
  const [{ data: res }, { data: al }, { data: pr }] = await Promise.all([
    supabase.from("resources").select("id, name, role_label, daily_capacity_minutes").eq("business_id", ws),
    supabase.from("allocations").select("id, starts_on, ends_on, minutes_per_day, status, override_reason, resources(name), projects(name)").eq("business_id", ws).order("starts_on"),
    supabase.from("projects").select("id, name").eq("business_id", ws).eq("status", "active"),
  ]);
  const h = (what: string) => <Hidden fields={{ ws, what }} />;
  return (
    <>
      <h1 className="text-xl font-semibold">Capacity and allocation</h1>
      <ErrorNote error={error} />
      <table className={table}>
        <thead className="bg-canvas text-left text-muted"><tr><th className="p-3">Resource</th><th>Project</th><th>From</th><th>To</th><th className="text-right">h/day</th><th>State</th><th /></tr></thead>
        <tbody>
          {(al ?? []).length === 0 && <tr><td colSpan={7} className="p-4 text-muted">No bookings yet.</td></tr>}
          {(al ?? []).map((a) => (
            <tr key={a.id} className="border-t border-line">
              <td className="p-3">{(a.resources as unknown as { name: string } | null)?.name}</td><td>{(a.projects as unknown as { name: string } | null)?.name}</td>
              <td>{a.starts_on}</td><td>{a.ends_on}</td><td className="text-right tabular-nums">{a.minutes_per_day / 60}</td>
              <td><span className={a.status === "confirmed" ? "font-semibold" : "italic text-muted"}>{a.status}</span>{a.override_reason ? ` · override: ${a.override_reason}` : ""}</td>
              <td className="p-2">{isMgr && a.status === "tentative" && <form action={act} className="flex gap-1"><Hidden fields={{ ws, what: "confirm", id: a.id }} /><input name="override" placeholder="Override reason (if over capacity)" className="rounded-md border border-line px-2" /><button className="rounded-md border border-line bg-white px-3 py-1.5 text-sm">Confirm</button></form>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {isMgr && (
        <div className="grid max-w-4xl gap-4 md:grid-cols-2">
          <form action={act} className={card}>{h("resource")}<h2 className="font-medium">Add resource</h2>
            <label className="text-sm">Name<input name="name" required className={input} /></label>
            <label className="text-sm">Role (matches a cost-rate role)<input name="role" className={input} /></label>
            <label className="text-sm">Capacity hours/day<input name="hours" type="number" min="0" max="24" step="0.25" defaultValue="8" className={input} /></label>
            <button className={btn}>Add</button></form>
          <form action={act} className={card}>{h("book")}<h2 className="font-medium">Book</h2>
            <label className="text-sm">Resource<select name="resource" required className={input}>{(res ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
            <label className="text-sm">Project<select name="project" required className={input}>{(pr ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <div className="grid grid-cols-3 gap-2">
              <label className="text-sm">From<input name="from" type="date" required className={input} /></label>
              <label className="text-sm">To<input name="to" type="date" required className={input} /></label>
              <label className="text-sm">h/day<input name="hours" type="number" min="0.25" step="0.25" required className={input} /></label>
            </div>
            <label className="text-sm">State<select name="status" className={input}><option value="tentative">Tentative</option><option value="confirmed">Confirmed</option></select></label>
            <label className="text-sm">Override reason (only if over capacity)<input name="override" className={input} /></label>
            <button className={btn}>Book</button></form>
        </div>)}
    </>
  );
}
