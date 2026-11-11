import { cell, daysFrom, type Booking, type Leave as LeaveT, type Resource } from "@/lib/rules/capacity";
import { back, btn, card, db, ErrorNote, ghost, Hidden, input, myRole, table } from "../lib";

async function act(f: FormData) {
  "use server";
  const ws = String(f.get("ws")), what = String(f.get("what"));
  const supabase = await db();
  let error: string | undefined;
  const pattern = () => {
    const raw = String(f.get("pattern") ?? "").trim();
    if (!raw) return null;
    const a = raw.split(",").map((x) => Math.round(Number(x) * 60));
    return a.length === 7 && a.every((n) => Number.isInteger(n) && n >= 0 && n <= 1440) ? a : undefined;
  };
  if (what === "resource") {
    const p = pattern();
    if (p === undefined) return back(`/w/${ws}/capacity`, "Weekly pattern needs 7 comma-separated hour values, Monday to Sunday.");
    error = (await supabase.from("resources").insert({ business_id: ws, user_id: String(f.get("user") ?? "") || null, name: String(f.get("name") ?? ""), role_label: String(f.get("role") ?? "") || null, daily_capacity_minutes: Math.round(Number(f.get("hours")) * 60), weekly_minutes: p })).error?.message;
  } else if (what === "book") error = (await supabase.from("allocations").insert({ business_id: ws, project_id: String(f.get("project")), resource_id: String(f.get("resource")), starts_on: String(f.get("from")), ends_on: String(f.get("to")), minutes_per_day: Math.round(Number(f.get("hours")) * 60), status: String(f.get("status")), override_reason: String(f.get("override") ?? "") || null })).error?.message;
  else if (what === "confirm") error = (await supabase.from("allocations").update({ status: "confirmed", override_reason: String(f.get("override") ?? "") || null }).eq("id", String(f.get("id")))).error?.message;
  else if (what === "leave") error = (await supabase.from("leave").insert({ business_id: ws, resource_id: String(f.get("resource")), starts_on: String(f.get("from")), ends_on: String(f.get("to")) })).error?.message;
  else if (what === "decide") error = (await supabase.from("leave").update({ status: String(f.get("to")) }).eq("id", String(f.get("id")))).error?.message;
  back(`/w/${ws}/capacity`, error);
}

const tone = { off: "bg-canvas text-muted", free: "bg-white", ok: "bg-white", full: "bg-brand text-white", over: "bg-danger text-white" } as const;

export default async function Capacity({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string; from?: string }> }) {
  const [{ ws }, { error, from }] = await Promise.all([params, searchParams]);
  const supabase = await db();
  const isMgr = ["owner", "manager"].includes((await myRole(ws)) ?? "");
  const start = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date().toISOString().slice(0, 10);
  const days = daysFrom(start, 14);
  const [{ data: res }, { data: al }, { data: pr }, { data: lv }] = await Promise.all([
    supabase.from("resources").select("id, name, role_label, daily_capacity_minutes, weekly_minutes").eq("business_id", ws).order("name"),
    supabase.from("allocations").select("id, resource_id, starts_on, ends_on, minutes_per_day, status, override_reason, resources(name), projects(name)").eq("business_id", ws).order("starts_on"),
    supabase.from("projects").select("id, name").eq("business_id", ws).eq("status", "active"),
    supabase.from("leave").select("id, resource_id, starts_on, ends_on, status, resources(name)").eq("business_id", ws).order("starts_on", { ascending: false }),
  ]);
  const { data: mem } = isMgr ? await supabase.from("memberships").select("user_id").eq("business_id", ws).eq("status", "active").neq("role", "customer") : { data: [] };
  const { data: profs } = (mem ?? []).length ? await supabase.from("profiles").select("id, email, full_name").in("id", (mem ?? []).map((m) => m.user_id)) : { data: [] };
  const resources: Resource[] = (res ?? []).map((r) => ({ id: r.id, dailyMinutes: r.daily_capacity_minutes, weeklyMinutes: r.weekly_minutes }));
  const leave: LeaveT[] = (lv ?? []).map((l) => ({ resourceId: l.resource_id, startsOn: l.starts_on, endsOn: l.ends_on, status: l.status }));
  const bookings: Booking[] = (al ?? []).map((a) => ({ resourceId: a.resource_id, startsOn: a.starts_on, endsOn: a.ends_on, minutesPerDay: a.minutes_per_day, status: a.status as "tentative" | "confirmed" }));
  const h = (what: string) => <Hidden fields={{ ws, what }} />;
  const next = daysFrom(start, 15)[14]!, prev = new Date(new Date(`${start}T00:00:00Z`).getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
  const resOpts = (res ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>);
  return (
    <>
      <h1 className="text-xl font-semibold">Capacity and allocation</h1>
      <ErrorNote error={error} />
      <div className="mt-2 flex items-center gap-3 text-sm"><a className="underline" href={`?from=${prev}`}>← Earlier</a><span className="text-muted">{days[0]} to {days[13]}</span><a className="underline" href={`?from=${next}`}>Later →</a></div>
      <div className="mt-3 overflow-x-auto">
        <table className="border-collapse text-xs" aria-label="Capacity calendar">
          <thead><tr><th className="p-2 text-left">Resource</th>{days.map((d) => <th key={d} className="px-1 py-2 font-normal text-muted">{d.slice(5)}</th>)}</tr></thead>
          <tbody>
            {resources.length === 0 && <tr><td className="p-3 text-muted" colSpan={15}>No resources yet.</td></tr>}
            {resources.map((r, i) => (
              <tr key={r.id} className="border-t border-line">
                <th scope="row" className="whitespace-nowrap p-2 text-left font-normal">{res?.[i]?.name}</th>
                {days.map((d) => {
                  const c = cell(r, leave, bookings, d);
                  return (
                    <td key={d} className={`h-10 min-w-12 border border-line text-center ${tone[c.state]}`} title={`${c.confirmed / 60}h confirmed, ${c.tentative / 60}h tentative of ${c.capacity / 60}h`}>
                      {c.state === "off" ? "–" : <>{c.confirmed ? `${c.confirmed / 60}h` : ""}{c.tentative ? <span className="italic opacity-80"> +{c.tentative / 60}</span> : ""}</>}
                      <span className="sr-only"> {c.state}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">Solid blue = fully booked (confirmed); red = overbooked; italic “+n” = tentative hours; “–” = non-working day or approved leave.</p>

      <h2 className="mt-8 font-medium">Bookings</h2>
      <table className={table}>
        <thead className="bg-canvas text-left text-muted"><tr><th className="p-3">Resource</th><th>Project</th><th>From</th><th>To</th><th className="text-right">h/day</th><th>State</th><th /></tr></thead>
        <tbody>
          {(al ?? []).length === 0 && <tr><td colSpan={7} className="p-4 text-muted">No bookings yet.</td></tr>}
          {(al ?? []).map((a) => (
            <tr key={a.id} className="border-t border-line">
              <td className="p-3">{(a.resources as unknown as { name: string } | null)?.name}</td><td>{(a.projects as unknown as { name: string } | null)?.name}</td>
              <td>{a.starts_on}</td><td>{a.ends_on}</td><td className="text-right tabular-nums">{a.minutes_per_day / 60}</td>
              <td><span className={a.status === "confirmed" ? "font-semibold" : "italic text-muted"}>{a.status}</span>{a.override_reason ? ` · override: ${a.override_reason}` : ""}</td>
              <td className="p-2">{isMgr && a.status === "tentative" && <form action={act} className="flex gap-1"><Hidden fields={{ ws, what: "confirm", id: a.id }} /><input name="override" placeholder="Override reason (if over capacity)" aria-label="Override reason (if over capacity)" className="rounded-md border border-line px-2" /><button className={ghost}>Confirm</button></form>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="mt-8 font-medium">Leave</h2>
      <ul className="mt-2 max-w-xl divide-y divide-line rounded-lg border border-line bg-white text-sm">
        {(lv ?? []).length === 0 && <li className="p-3 text-muted">No leave recorded.</li>}
        {(lv ?? []).map((l) => (
          <li key={l.id} className="flex items-center justify-between p-3"><span>{(l.resources as unknown as { name: string } | null)?.name} · {l.starts_on} → {l.ends_on} · {l.status}</span>
            {isMgr && l.status === "requested" && <span className="flex gap-1"><form action={act}><Hidden fields={{ ws, what: "decide", id: l.id, to: "approved" }} /><button className={ghost}>Approve</button></form><form action={act}><Hidden fields={{ ws, what: "decide", id: l.id, to: "rejected" }} /><button className={ghost}>Reject</button></form></span>}</li>
        ))}
      </ul>
      <form action={act} className="mt-3 flex max-w-xl flex-wrap items-end gap-2">
        {h("leave")}
        <label className="text-sm">Resource<select name="resource" required className={input}>{resOpts}</select></label>
        <label className="text-sm">From<input name="from" type="date" required className={input} /></label>
        <label className="text-sm">To<input name="to" type="date" required className={input} /></label>
        <button className={btn}>Request leave</button>
      </form>

      {isMgr && (
        <div className="grid max-w-4xl gap-4 md:grid-cols-2">
          <form action={act} className={card}>{h("resource")}<h2 className="font-medium">Add resource</h2>
            <label className="text-sm">Name<input name="name" required className={input} /></label>
            <label className="text-sm">Team member (links their time, leave and bookings)<select name="user" className={input}><option value="">Not a system user</option>{(profs ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}</select></label>
            <label className="text-sm">Role (matches a cost-rate role)<input name="role" className={input} /></label>
            <label className="text-sm">Capacity hours/day (Mon–Fri)<input name="hours" type="number" min="0" max="24" step="0.25" defaultValue="8" className={input} /></label>
            <label className="text-sm">Weekly pattern, hours Mon…Sun (optional, part-time)<input name="pattern" placeholder="4,4,4,4,0,0,0" aria-label="4,4,4,4,0,0,0" className={input} /></label>
            <button className={btn}>Add</button></form>
          <form action={act} className={card}>{h("book")}<h2 className="font-medium">Book</h2>
            <label className="text-sm">Resource<select name="resource" required className={input}>{resOpts}</select></label>
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
