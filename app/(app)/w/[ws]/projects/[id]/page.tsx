import { summarize, type Financials } from "@/lib/rules/profit";
import { formatINR } from "@/lib/rules/money";
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { checkUpload } from "@/lib/rules/uploads";
import { back, btn, card, db, ErrorNote, ghost, Hidden, input, myRole, table } from "../../lib";

async function act(f: FormData) {
  "use server";
  const ws = String(f.get("ws")), id = String(f.get("id")), what = String(f.get("what"));
  const supabase = await db();
  const { data: { user } } = await supabase.auth.getUser();
  const rupees = (k: string) => Math.round(Number(f.get(k) ?? 0) * 100);
  let error: string | undefined;
  if (what === "change") {
    error = (await supabase.from("change_requests").insert({
      business_id: ws, project_id: id, title: String(f.get("title") ?? ""), reason: String(f.get("reason") ?? ""),
      budget_delta_paise: rupees("budget"), effort_delta_minutes: Math.round(Number(f.get("hours") ?? 0) * 60), deadline_delta_days: Math.round(Number(f.get("days") ?? 0)),
    })).error?.message;
  } else if (what === "decide") {
    const approve = f.get("to") === "approved";
    error = (await supabase.from("change_requests").update({ status: approve ? "approved" : "rejected", decision_note: String(f.get("note") ?? "") || null }).eq("id", String(f.get("cr")))).error?.message;
  } else if (what === "milestone") {
    error = (await supabase.from("milestones").insert({ business_id: ws, project_id: id, name: String(f.get("name") ?? ""), due_on: String(f.get("due") ?? "") || null, amount_paise: f.get("amount") ? rupees("amount") : null })).error?.message;
  } else if (what === "done") {
    error = (await supabase.from("milestones").update({ done: true }).eq("id", String(f.get("ms"))).select("id")).error?.message;
  } else if (what === "deliverable") {
    const { data, error: e } = await supabase.from("deliverables").insert({ business_id: ws, project_id: id, name: String(f.get("name") ?? "") }).select("id").single();
    error = e?.message;
    if (data) error = (await supabase.from("deliverable_versions").insert({ business_id: ws, deliverable_id: data.id, version: 1 })).error?.message;
  } else if (what === "upload") {
    const file = f.get("file");
    if (!(file instanceof File) || file.size === 0) return back(`/w/${ws}/projects/${id}`, "Choose a file.");
    const bad = checkUpload({ name: file.name, type: file.type, size: file.size });
    if (bad) return back(`/w/${ws}/projects/${id}`, bad);
    const path = `${ws}/${id}/${randomUUID()}.${file.name.split(".").pop()!.toLowerCase()}`;
    const up = await supabase.storage.from("deliverables").upload(path, file, { contentType: file.type, upsert: false });
    if (up.error) return back(`/w/${ws}/projects/${id}`, up.error.message);
    const { data: fr, error: fe } = await supabase.from("files").insert({ business_id: ws, project_id: id, path, mime: file.type, size_bytes: file.size, uploaded_by: user?.id }).select("id").single();
    if (fe || !fr) return back(`/w/${ws}/projects/${id}`, fe?.message);
    const { data: d, error: de } = await supabase.from("deliverables").insert({ business_id: ws, project_id: id, name: String(f.get("name") || file.name) }).select("id").single();
    if (de || !d) return back(`/w/${ws}/projects/${id}`, de?.message);
    error = (await supabase.from("deliverable_versions").insert({ business_id: ws, deliverable_id: d.id, version: 1, file_id: fr.id })).error?.message;
  } else if (what === "open") {
    const { data: fl } = await supabase.from("files").select("path, scan_status").eq("id", String(f.get("file"))).maybeSingle();
    if (!fl || fl.scan_status !== "clean") return back(`/w/${ws}/projects/${id}`, "This file has not passed malware screening.");
    const { data: signed, error: se } = await supabase.storage.from("deliverables").createSignedUrl(fl.path, 60);
    if (se || !signed) return back(`/w/${ws}/projects/${id}`, se?.message);
    redirect(signed.signedUrl);
  } else if (what === "template") {
    const r = await supabase.rpc("apply_template", { p_template: String(f.get("template")), p_project: id });
    error = r.error?.message;
  } else if (what === "check") {
    error = (await supabase.from("check_items").update({ done: true }).eq("id", String(f.get("item"))).select("id")).error?.message;
  } else if (what === "share") {
    error = (await supabase.from("deliverable_versions").update({ shared: true }).eq("id", String(f.get("dv"))).select("id")).error?.message;
  } else if (what === "comment") {
    error = (await supabase.from("comments").insert({ business_id: ws, project_id: id, author: user?.id, body: String(f.get("body") ?? ""), internal: f.get("internal") === "on" })).error?.message;
  } else if (what === "close") {
    error = (await supabase.rpc("close_project", { p_project: id })).error?.message;
  }
  back(`/w/${ws}/projects/${id}`, error);
}

export default async function Project({ params, searchParams }: { params: Promise<{ ws: string; id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ ws, id }, { error }] = await Promise.all([params, searchParams]);
  const supabase = await db();
  const role = await myRole(ws);
  const isMgr = role === "owner" || role === "manager";
  const [{ data: tpls }, { data: checks }] = await Promise.all([
    supabase.from("templates").select("id, title").eq("business_id", ws),
    supabase.from("check_items").select("id, text, done").eq("project_id", id).order("text"),
  ]);
  const [{ data: p }, { data: crs }, { data: ms }, { data: dvs }, { data: cm }] = await Promise.all([
    supabase.from("projects").select("id, name, status").eq("id", id).maybeSingle(),
    supabase.from("change_requests").select("*").eq("project_id", id).order("created_at", { ascending: false }),
    supabase.from("milestones").select("*").eq("project_id", id).order("due_on"),
    supabase.from("deliverable_versions").select("id, version, shared, status, comment, file_id, files(scan_status), deliverables!inner(name, project_id)").eq("deliverables.project_id", id),
    supabase.from("comments").select("id, body, internal, created_at").eq("project_id", id).order("created_at", { ascending: false }).limit(20),
  ]);
  if (!p) return <p>Project not found.</p>;
  let fin: Financials | null = null;
  if (isMgr) fin = (await supabase.rpc("project_financials", { p_project: id })).data?.[0] ?? null;
  const s = fin ? summarize(fin) : null;
  const pct = (b: number | null) => (b === null ? "—" : `${(b / 100).toFixed(1)}%`);
  const form = (what: string, extra: Record<string, string> = {}) => <Hidden fields={{ ws, id, what, ...extra }} />;
  return (
    <>
      <h1 className="text-xl font-semibold">{p.name} <span className="text-base font-normal text-muted">· {p.status}</span></h1>
      <ErrorNote error={error} />

      {fin && s && (
        <section aria-labelledby="fin" className="mt-4 max-w-4xl rounded-lg border border-line bg-white p-4">
          <h2 id="fin" className="font-medium">Financials <span className="text-sm font-normal text-muted">(owner/manager only)</span></h2>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
            {([["Estimated revenue", fin.estimated_revenue_paise], ["Estimated cost", fin.estimated_cost_paise], ["Committed (open)", fin.committed_open_paise], ["Actual cost", s.actualCost],
               ["Invoiced", fin.invoiced_paise], ["Collected", fin.collected_paise], ["Unbilled (est.)", s.unbilled], ["Outstanding", s.outstanding]] as const).map(([k, v]) => (
              <div key={k}><dt className="text-muted">{k}</dt><dd className="tabular-nums">{formatINR(v)}</dd></div>
            ))}
          </dl>
          <p className="mt-2 text-sm text-muted">Margin — estimated {pct(s.estimatedMarginBps)} · forecast incl. commitments {pct(s.forecastMarginBps)} · on invoiced to date {pct(s.billedMarginBps)}</p>
        </section>
      )}

      <h2 className="mt-8 font-medium">Change requests</h2>
      <table className={table}>
        <thead className="bg-canvas text-left text-muted"><tr><th className="p-3">Change</th><th className="text-right">Budget</th><th className="text-right">Effort</th><th className="text-right">Deadline</th><th>Status</th><th /></tr></thead>
        <tbody>
          {(crs ?? []).length === 0 && <tr><td colSpan={6} className="p-4 text-muted">No change requests.</td></tr>}
          {(crs ?? []).map((c) => (
            <tr key={c.id} className="border-t border-line align-top">
              <td className="p-3">{c.title}<div className="text-muted">{c.reason}</div></td>
              <td className="text-right tabular-nums">{formatINR(c.budget_delta_paise)}</td>
              <td className="text-right tabular-nums">{(c.effort_delta_minutes / 60).toFixed(1)} h</td>
              <td className="text-right tabular-nums">{c.deadline_delta_days} d</td>
              <td>{c.status}{c.decision_note ? ` — ${c.decision_note}` : ""}</td>
              <td className="p-2">{isMgr && c.status === "pending" && (
                <div className="flex flex-wrap items-center gap-1">
                  <form action={act}>{form("decide", { cr: c.id, to: "approved" })}<button className={ghost}>Approve</button></form>
                  <form action={act} className="flex gap-1">{form("decide", { cr: c.id, to: "rejected" })}<input name="note" required placeholder="Reason to reject" aria-label="Reason to reject" className="rounded-md border border-line px-2" /><button className={ghost}>Reject</button></form>
                </div>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form action={act} className={card}>
        {form("change")}
        <label className="text-sm">What changes<input name="title" required className={input} /></label>
        <label className="text-sm">Why<input name="reason" required className={input} /></label>
        <div className="grid grid-cols-3 gap-2">
          <label className="text-sm">Budget Δ ₹<input name="budget" type="number" step="0.01" required className={input} /></label>
          <label className="text-sm">Effort Δ hours<input name="hours" type="number" step="0.25" required className={input} /></label>
          <label className="text-sm">Deadline Δ days<input name="days" type="number" step="1" required className={input} /></label>
        </div>
        <button className={btn}>Request change</button>
      </form>

      <h2 className="mt-8 font-medium">Milestones</h2>
      <ul className="mt-2 max-w-xl divide-y divide-line rounded-lg border border-line bg-white">
        {(ms ?? []).length === 0 && <li className="p-3 text-muted">None yet.</li>}
        {(ms ?? []).map((m) => (
          <li key={m.id} className="flex items-center justify-between p-3"><span>{m.name} {m.due_on && <span className="text-muted">· {m.due_on}</span>} {m.amount_paise != null && <span className="text-muted">· {formatINR(m.amount_paise)}</span>}</span>
            {m.done ? <span className="text-muted">done</span> : isMgr && <form action={act}>{form("done", { ms: m.id })}<button className={ghost}>Mark done</button></form>}</li>
        ))}
      </ul>
      {isMgr && (
        <form action={act} className="mt-3 flex max-w-xl flex-wrap items-end gap-2">
          {form("milestone")}
          <label className="flex-1 text-sm">Milestone<input name="name" required className={input} /></label>
          <label className="text-sm">Due<input name="due" type="date" className={input} /></label>
          <label className="text-sm">Billing ₹<input name="amount" type="number" min="0" step="0.01" className={input} /></label>
          <button className={btn}>Add</button>
        </form>
      )}

      <h2 className="mt-8 font-medium">Deliverables and client proofs</h2>
      <ul className="mt-2 max-w-xl divide-y divide-line rounded-lg border border-line bg-white">
        {(dvs ?? []).length === 0 && <li className="p-3 text-muted">None yet.</li>}
        {(dvs ?? []).map((v) => (
          <li key={v.id} className="flex items-center justify-between p-3">
            <span>{(v.deliverables as unknown as { name: string }).name} v{v.version} · {v.status}{v.comment ? ` — “${v.comment}”` : ""}</span>
            <span className="flex items-center gap-2">
              {v.file_id && <><span className="text-muted">file: {(v.files as unknown as { scan_status: string } | null)?.scan_status}</span>
                {(v.files as unknown as { scan_status: string } | null)?.scan_status === "clean" && <form action={act}>{form("open", { file: v.file_id })}<button className={ghost}>Open</button></form>}</>}
              {!v.shared ? <form action={act}>{form("share", { dv: v.id })}<button className={ghost}>Share with client</button></form> : <span className="text-muted">shared</span>}
            </span>
          </li>
        ))}
      </ul>
      <form action={act} className="mt-3 flex max-w-xl items-end gap-2">
        {form("deliverable")}
        <label className="flex-1 text-sm">New deliverable<input name="name" required className={input} /></label>
        <button className={btn}>Add</button>
      </form>

      <form action={act} className={card}>
        {form("upload")}
        <h3 className="font-medium">Upload a file as a new deliverable</h3>
        <label className="text-sm">Name<input name="name" className={input} /></label>
        <label className="text-sm">File (PDF, PNG, JPEG, WebP or CSV, up to 10 MB)<input name="file" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.csv" required className={input} /></label>
        <button className={btn}>Upload</button>
        <p className="text-sm text-muted">Files can be shared with the client only after the malware scanner marks them clean.</p>
      </form>

      <h2 className="mt-8 font-medium">Checklist</h2>
      <ul className="mt-2 max-w-xl divide-y divide-line rounded-lg border border-line bg-white text-sm">
        {(checks ?? []).length === 0 && <li className="p-3 text-muted">No checklist. Apply a template below.</li>}
        {(checks ?? []).map((c) => <li key={c.id} className="flex items-center justify-between p-3"><span className={c.done ? "text-muted line-through" : ""}>{c.text}</span>{!c.done && <form action={act}>{form("check", { item: c.id })}<button className={ghost}>Done</button></form>}</li>)}
      </ul>
      {(tpls ?? []).length > 0 && <form action={act} className="mt-3 flex max-w-xl items-end gap-2">{form("template")}<label className="flex-1 text-sm">Apply template<select name="template" className={input}>{(tpls ?? []).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label><button className={btn}>Apply</button></form>}

      <h2 className="mt-8 font-medium">Discussion</h2>
      <ul className="mt-2 max-w-xl space-y-2">
        {(cm ?? []).map((c) => <li key={c.id} className={`rounded-md border p-2 text-sm ${c.internal ? "border-line bg-canvas" : "border-brand bg-white"}`}><span className="text-muted">{c.internal ? "Internal" : "Visible to client"} · </span>{c.body}</li>)}
      </ul>
      <form action={act} className={card}>
        {form("comment")}
        <label className="text-sm">Comment<textarea name="body" required rows={2} className={input} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="internal" defaultChecked /> Internal only</label>
        <button className={btn}>Post</button>
      </form>

      {isMgr && p.status === "active" && (
        <form action={act} className="mt-8">{form("close")}<button className={ghost}>Close project</button>
          <span className="ml-2 text-sm text-muted">Checks open changes, unapproved time/expenses, unissued invoices and milestones.</span></form>
      )}
    </>
  );
}
