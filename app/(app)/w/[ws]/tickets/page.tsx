import { back, btn, card, db, ErrorNote, ghost, Hidden, input, table } from "../lib";
import { formatINR } from "@/lib/rules/money";

async function act(f: FormData) {
  "use server";
  const ws = String(f.get("ws")), what = String(f.get("what")), id = String(f.get("id") ?? "");
  const supabase = await db();
  let error: string | undefined;
  if (what === "classify") error = (await supabase.from("tickets").update({ kind: String(f.get("kind")) }).eq("id", id)).error?.message;
  else if (what === "project") error = (await supabase.from("tickets").update({ project_id: String(f.get("project")) }).eq("id", id)).error?.message;
  else if (what === "escalate") error = (await supabase.from("tickets").update({ status: "escalated", escalated_to: String(f.get("to")) || null }).eq("id", id)).error?.message;
  else if (what === "resolve") error = (await supabase.from("tickets").update({ status: "resolved" }).eq("id", id)).error?.message;
  else if (what === "convert") error = (await supabase.rpc("ticket_to_change", { p_ticket: id, p_budget: Math.round(Number(f.get("budget")) * 100), p_minutes: Math.round(Number(f.get("hours")) * 60), p_days: Math.round(Number(f.get("days"))) })).error?.message;
  back(`/w/${ws}/tickets`, error);
}

export default async function Tickets({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ ws }, { error }] = await Promise.all([params, searchParams]);
  const supabase = await db();
  const [{ data: ts }, { data: projects }, { data: team }] = await Promise.all([
    supabase.from("tickets").select("id, title, body, kind, status, project_id, change_request_id, clients(name), created_at").eq("business_id", ws).order("created_at", { ascending: false }),
    supabase.from("projects").select("id, name").eq("business_id", ws),
    supabase.from("memberships").select("user_id, role").eq("business_id", ws).eq("status", "active").in("role", ["owner", "manager"]),
  ]);
  const h = (what: string, id: string) => <Hidden fields={{ ws, what, id }} />;
  void formatINR; void table; void btn; void card; void input;
  return (
    <>
      <h1 className="text-xl font-semibold">Client tickets</h1>
      <p className="text-sm text-muted">Classify each request as included work or a change request; changes go through approval with budget, effort and deadline impact.</p>
      <ErrorNote error={error} />
      <ul className="mt-4 max-w-3xl space-y-3">
        {(ts ?? []).length === 0 && <li className="text-muted">No tickets.</li>}
        {(ts ?? []).map((t) => (
          <li key={t.id} className="rounded-lg border border-line bg-white p-4 text-sm">
            <div className="font-medium">{t.title} <span className="font-normal text-muted">· {(t.clients as unknown as { name: string } | null)?.name} · {t.kind} · {t.status}</span></div>
            <p className="mt-1 text-muted">{t.body}</p>
            {t.status !== "resolved" && (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <form action={act} className="flex gap-1">{h("classify", t.id)}<select name="kind" aria-label="Ticket type" defaultValue={t.kind} className="rounded-md border border-line px-2 py-1"><option value="unclassified">Unclassified</option><option value="included">Included work</option><option value="change">Change request</option></select><button className={ghost}>Set</button></form>
                {!t.project_id && <form action={act} className="flex gap-1">{h("project", t.id)}<select name="project" aria-label="Project" className="rounded-md border border-line px-2 py-1">{(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><button className={ghost}>Link project</button></form>}
                {t.project_id && !t.change_request_id && (
                  <form action={act} className="flex gap-1">{h("convert", t.id)}<input name="budget" type="number" step="0.01" required placeholder="Budget Δ ₹" aria-label="Budget Δ ₹" className="w-24 rounded-md border border-line px-2" /><input name="hours" type="number" step="0.25" required placeholder="Hours" aria-label="Hours" className="w-20 rounded-md border border-line px-2" /><input name="days" type="number" required placeholder="Days" aria-label="Days" className="w-16 rounded-md border border-line px-2" /><button className={ghost}>Convert to change</button></form>)}
                <form action={act} className="flex gap-1">{h("escalate", t.id)}<select name="to" aria-label="Escalate to" className="rounded-md border border-line px-2 py-1">{(team ?? []).map((m) => <option key={m.user_id} value={m.user_id}>{m.role} {m.user_id.slice(0, 6)}</option>)}</select><button className={ghost}>Escalate</button></form>
                <form action={act}>{h("resolve", t.id)}<button className={ghost}>Resolve</button></form>
              </div>)}
          </li>
        ))}
      </ul>
    </>
  );
}
