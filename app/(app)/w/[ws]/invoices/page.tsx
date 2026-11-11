import { formatINR } from "@/lib/rules/money";
import { back, btn, card, db, ErrorNote, ghost, Hidden, input, myRole, table } from "../lib";

async function act(f: FormData) {
  "use server";
  const ws = String(f.get("ws")), what = String(f.get("what")), inv = String(f.get("inv") ?? "");
  const supabase = await db();
  let error: string | undefined;
  const create = async (project: string, kind: string) => {
    const { data: pr } = await supabase.from("projects").select("engagements(client_id)").eq("id", project).single();
    const clientId = (pr?.engagements as unknown as { client_id: string } | null)?.client_id;
    const { data, error: e } = await supabase.from("invoices").insert({ business_id: ws, client_id: clientId, project_id: project, kind }).select("id").single();
    if (e || !data) throw new Error(e?.message ?? "Could not create the invoice.");
    return data.id as string;
  };
  try {
    if (what === "time") {
      const project = String(f.get("project")), rate = Math.round(Number(f.get("rate")) * 100);
      const [{ data: t }, { data: billed }] = await Promise.all([
        supabase.from("time_entries").select("id, work_date, minutes, note").eq("project_id", project).eq("status", "approved").eq("billable", true),
        supabase.from("invoice_lines").select("source_id").eq("source_type", "time").eq("released", false),
      ]);
      const done = new Set((billed ?? []).map((b) => b.source_id));
      const todo = (t ?? []).filter((e) => !done.has(e.id));
      if (todo.length === 0) throw new Error("No approved, unbilled billable time on this project.");
      const id = await create(project, "time");
      const { error: e } = await supabase.from("invoice_lines").insert(todo.map((e) => ({
        business_id: ws, invoice_id: id, description: `${e.work_date} · ${(e.minutes / 60).toFixed(2)} h${e.note ? ` · ${e.note}` : ""}`,
        amount_paise: Math.round((e.minutes / 60) * rate), source_type: "time", source_id: e.id,
      })));
      if (e) throw new Error(e.message);
    } else if (what === "milestone") {
      const { data: m } = await supabase.from("milestones").select("id, name, amount_paise, project_id, done").eq("id", String(f.get("ms"))).single();
      if (!m?.done || !m.amount_paise) throw new Error("The milestone must be done and have a billing amount.");
      const id = await create(m.project_id, "milestone");
      const { error: e } = await supabase.from("invoice_lines").insert({ business_id: ws, invoice_id: id, description: m.name, amount_paise: m.amount_paise, source_type: "milestone", source_id: m.id });
      if (e) throw new Error(e.message);
    } else if (what === "fixed") {
      const id = await create(String(f.get("project")), String(f.get("kind")));
      const { error: e } = await supabase.from("invoice_lines").insert({ business_id: ws, invoice_id: id, description: String(f.get("description") ?? ""), amount_paise: Math.round(Number(f.get("amount")) * 100) });
      if (e) throw new Error(e.message);
    } else if (["approved", "issued", "void"].includes(what)) {
      const { data, error: e } = await supabase.from("invoices").update({ status: what }).eq("id", inv).select("id");
      error = e?.message ?? (data?.length ? undefined : "Not allowed.");
    } else if (what === "pay") {
      error = (await supabase.from("payments").insert({ business_id: ws, invoice_id: inv, amount_paise: Math.round(Number(f.get("amount")) * 100), received_on: String(f.get("date")), reference: String(f.get("ref") ?? "") })).error?.message;
    } else if (what === "credit") {
      error = (await supabase.from("credit_notes").insert({ business_id: ws, invoice_id: inv, amount_paise: Math.round(Number(f.get("amount")) * 100), reason: String(f.get("reason") ?? "") })).error?.message;
    } else if (what === "dispute") {
      error = (await supabase.from("invoices").update({ disputed: f.get("on") === "1" }).eq("id", inv)).error?.message;
    }
  } catch (e) { error = (e as Error).message; }
  back(`/w/${ws}/invoices`, error);
}

export default async function Invoices({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ ws }, { error }] = await Promise.all([params, searchParams]);
  if (!["owner", "manager"].includes((await myRole(ws)) ?? "")) return <p>Billing is limited to owners and managers.</p>;
  const supabase = await db();
  const [{ data: rows }, { data: projects }, { data: ms }] = await Promise.all([
    supabase.from("receivables").select("*").eq("business_id", ws).order("number", { ascending: false }),
    supabase.from("projects").select("id, name").eq("business_id", ws),
    supabase.from("milestones").select("id, name").eq("business_id", ws).eq("done", true).not("amount_paise", "is", null),
  ]);
  const h = (what: string, extra: Record<string, string> = {}) => <Hidden fields={{ ws, what, ...extra }} />;
  const sum = (k: "billed_paise" | "collected_paise" | "outstanding_paise") => (rows ?? []).filter((r) => r.status === "issued").reduce((s, r) => s + (r[k] as number), 0);
  const popts = (projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>);
  return (
    <>
      <h1 className="text-xl font-semibold">Invoices and receivables</h1>
      <ErrorNote error={error} />
      <p className="mt-2 text-sm text-muted">Issued: billed {formatINR(sum("billed_paise"))} · collected {formatINR(sum("collected_paise"))} · outstanding {formatINR(sum("outstanding_paise"))}</p>
      <table className={table}>
        <thead className="bg-canvas text-left text-muted"><tr><th className="p-3">No.</th><th>Status</th><th>Ageing</th><th className="text-right">Billed</th><th className="text-right">Collected</th><th className="text-right">Credited</th><th className="text-right">Outstanding</th><th /></tr></thead>
        <tbody>
          {(rows ?? []).length === 0 && <tr><td colSpan={8} className="p-4 text-muted">No invoices yet.</td></tr>}
          {(rows ?? []).map((r) => (
            <tr key={r.id} className="border-t border-line align-top">
              <td className="p-3 tabular-nums">{r.number}</td><td>{r.status}{r.disputed ? " · disputed" : ""}</td><td>{r.ageing}</td>
              <td className="text-right tabular-nums">{formatINR(r.billed_paise)}</td><td className="text-right tabular-nums">{formatINR(r.collected_paise)}</td><td className="text-right tabular-nums">{formatINR(r.credited_paise)}</td><td className="text-right tabular-nums">{formatINR(r.outstanding_paise)}</td>
              <td className="flex flex-wrap gap-1 p-2">
                {r.status === "draft" && <form action={act}>{h("approved", { inv: r.id })}<button className={ghost}>Approve</button></form>}
                {r.status === "approved" && <form action={act}>{h("issued", { inv: r.id })}<button className={ghost}>Issue</button></form>}
                {r.status !== "void" && r.collected_paise === 0 && <form action={act}>{h("void", { inv: r.id })}<button className={ghost}>Void</button></form>}
                {r.status === "issued" && r.outstanding_paise > 0 && (
                  <form action={act} className="flex gap-1">{h("pay", { inv: r.id })}<input name="amount" type="number" min="0.01" step="0.01" required placeholder="₹" aria-label="₹" className="w-24 rounded-md border border-line px-2" /><input name="date" type="date" required aria-label="Payment date" className="rounded-md border border-line px-1" /><input name="ref" placeholder="Reference" aria-label="Reference" className="w-24 rounded-md border border-line px-2" /><button className={ghost}>Record payment</button></form>)}
                {r.status === "issued" && r.outstanding_paise > 0 && (
                  <form action={act} className="flex gap-1">{h("credit", { inv: r.id })}<input name="amount" type="number" min="0.01" step="0.01" required placeholder="Credit ₹" aria-label="Credit ₹" className="w-24 rounded-md border border-line px-2" /><input name="reason" required placeholder="Reason" aria-label="Reason" className="w-28 rounded-md border border-line px-2" /><button className={ghost}>Credit note</button></form>)}
                <a className={ghost} href={`/w/${ws}/statement?client=${r.client_id}`}>Statement</a>
                {r.status === "issued" && <form action={act}>{h("dispute", { inv: r.id, on: r.disputed ? "0" : "1" })}<button className={ghost}>{r.disputed ? "Clear dispute" : "Mark disputed"}</button></form>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid max-w-4xl gap-4 md:grid-cols-3">
        <form action={act} className={card}>{h("time")}<h2 className="font-medium">Bill approved time</h2>
          <label className="text-sm">Project<select name="project" className={input}>{popts}</select></label>
          <label className="text-sm">Rate ₹ / hour<input name="rate" type="number" min="0" step="0.01" required className={input} /></label>
          <button className={btn}>Draft invoice</button></form>
        <form action={act} className={card}>{h("milestone")}<h2 className="font-medium">Bill a milestone</h2>
          <label className="text-sm">Milestone<select name="ms" className={input}>{(ms ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          <button className={btn}>Draft invoice</button></form>
        <form action={act} className={card}>{h("fixed")}<h2 className="font-medium">Fixed fee / retainer</h2>
          <label className="text-sm">Project<select name="project" className={input}>{popts}</select></label>
          <label className="text-sm">Type<select name="kind" className={input}><option value="fixed">Fixed fee</option><option value="retainer">Retainer</option></select></label>
          <label className="text-sm">Description<input name="description" required className={input} /></label>
          <label className="text-sm">Amount ₹<input name="amount" type="number" min="0.01" step="0.01" required className={input} /></label>
          <button className={btn}>Draft invoice</button></form>
      </div>
    </>
  );
}
