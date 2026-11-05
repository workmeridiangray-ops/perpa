import { computeEstimate, lineAmount } from "@/lib/rules/estimate";
import { formatINR } from "@/lib/rules/money";
import { back, btn, db, ErrorNote, ghost, input } from "../../lib";

type Line = { id: string; kind: "labour" | "external"; description: string; hours_centi: number | null; rate_paise: number; quantity_centi: number };

async function act(f: FormData) {
  "use server";
  const ws = String(f.get("ws")), id = String(f.get("id")), v = String(f.get("version")), what = String(f.get("what"));
  const here = `/w/${ws}/estimates/${id}`;
  const supabase = await db();
  let error: string | undefined;
  if (what === "addline") {
    const labour = f.get("kind") === "labour";
    const qty = Math.round(Number(f.get("qty")) * 100);
    const rate = Math.round(Number(f.get("rate")) * 100);
    const { data, error: e } = await supabase.from("estimate_lines").insert({
      business_id: ws, version_id: v, kind: labour ? "labour" : "external", description: String(f.get("description") ?? ""),
      hours_centi: labour ? qty : null, quantity_centi: labour ? 100 : qty, rate_paise: rate,
    }).select("id").single();
    error = e?.message;
    const cost = String(f.get("cost") ?? "").trim();
    if (!e && data && cost) {
      // Silently ignored for staff: RLS denies them the cost table.
      await supabase.from("estimate_line_costs").insert({ line_id: data.id, business_id: ws, cost_rate_paise: Math.round(Number(cost) * 100) });
    }
  } else if (what === "delline") {
    error = (await supabase.from("estimate_lines").delete().eq("id", String(f.get("line")))).error?.message;
  } else if (what === "discount") {
    error = (await supabase.from("estimate_versions").update({ discount_bps: Math.round(Number(f.get("discount")) * 100) }).eq("id", v)).error?.message;
  } else if (what === "status") {
    const status = String(f.get("to"));
    const { data, error: e } = await supabase.from("estimate_versions").update({ status }).eq("id", v).select("id");
    error = e?.message ?? (data?.length ? undefined : "You don't have permission for that step.");
  } else if (what === "accept") {
    error = (await supabase.from("estimate_acceptances").insert({ business_id: ws, version_id: v, contact_id: String(f.get("contact")) })).error?.message;
  } else if (what === "engage") {
    const { data: est } = await supabase.from("estimates").select("client_id, title").eq("id", id).single();
    const { data: eng, error: e } = await supabase.from("engagements").insert({ business_id: ws, client_id: est?.client_id, version_id: v, name: est?.title }).select("id").single();
    error = e?.message;
    if (!e && eng) error = (await supabase.rpc("start_project", { p_engagement: eng.id })).error?.message;
  } else if (what === "newversion") {
    error = (await supabase.rpc("new_version", { p_estimate: id })).error?.message;
  }
  back(here, error);
}

export default async function EstimatePage({ params, searchParams }: { params: Promise<{ ws: string; id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ ws, id }, { error }] = await Promise.all([params, searchParams]);
  const supabase = await db();
  const { data: est } = await supabase.from("estimates").select("id, number, title, client_id, clients(name)").eq("id", id).maybeSingle();
  if (!est) return <p>Estimate not found.</p>;
  const { data: versions } = await supabase.from("estimate_versions").select("*").eq("estimate_id", id).order("version", { ascending: false });
  const cur = versions?.[0];
  if (!cur) return <p>No revisions.</p>;
  const [{ data: lines }, { data: costs }, { data: contacts }, { data: eng }] = await Promise.all([
    supabase.from("estimate_lines").select("*").eq("version_id", cur.id).order("id"),
    supabase.from("estimate_line_costs").select("line_id, cost_rate_paise"),
    supabase.from("contacts").select("id, name, is_authorised_approver").eq("client_id", est.client_id).eq("is_authorised_approver", true),
    supabase.from("engagements").select("id").eq("version_id", cur.id).maybeSingle(),
  ]);
  const ls = (lines ?? []) as Line[];
  const costMap = new Map((costs ?? []).map((c) => [c.line_id as string, c.cost_rate_paise as number]));
  // Cost is shown only if the caller can read costs for every line (RLS returns none for staff).
  const canSeeCosts = ls.length > 0 && ls.every((l) => costMap.has(l.id));
  const t = computeEstimate(
    ls.map((l) => ({ kind: l.kind, hoursCenti: l.hours_centi ?? undefined, quantityCenti: l.quantity_centi, ratePaise: l.rate_paise, costRatePaise: costMap.get(l.id) })),
    cur.discount_bps,
  );
  const open = cur.status === "draft" || cur.status === "pending_approval";
  const hidden = (what: string, extra: Record<string, string> = {}) => (
    <>
      <input type="hidden" name="ws" value={ws} /><input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={cur.id} /><input type="hidden" name="what" value={what} />
      {Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
    </>
  );
  const step = (label: string, to: string) => (
    <form action={act}>{hidden("status", { to })}<button className={ghost}>{label}</button></form>
  );
  return (
    <>
      <h1 className="text-xl font-semibold">{est.number} · {est.title}</h1>
      <p className="text-muted">{(est.clients as unknown as { name: string } | null)?.name} · revision {cur.version} · <strong>{cur.status.replace("_", " ")}</strong>
        {cur.approved_at ? ` · approved ${new Date(cur.approved_at).toLocaleDateString("en-IN")}` : ""}</p>
      <ErrorNote error={error} />

      <table className="mt-4 w-full max-w-4xl border-collapse overflow-hidden rounded-lg border border-line bg-white text-sm">
        <thead className="bg-canvas text-left text-muted"><tr><th className="p-3">Item</th><th className="text-right">Qty</th><th className="text-right">Rate</th><th className="text-right">Amount</th>{canSeeCosts && <th className="text-right">Cost rate</th>}<th /></tr></thead>
        <tbody>
          {ls.length === 0 && <tr><td colSpan={6} className="p-4 text-muted">No lines yet.</td></tr>}
          {ls.map((l) => (
            <tr key={l.id} className="border-t border-line">
              <td className="p-3">{l.description}</td>
              <td className="text-right tabular-nums">{l.kind === "labour" ? `${(l.hours_centi ?? 0) / 100} h` : l.quantity_centi / 100}</td>
              <td className="text-right tabular-nums">{formatINR(l.rate_paise)}</td>
              <td className="text-right tabular-nums">{formatINR(lineAmount({ kind: l.kind, hoursCenti: l.hours_centi ?? undefined, quantityCenti: l.quantity_centi, ratePaise: l.rate_paise }))}</td>
              {canSeeCosts && <td className="text-right tabular-nums">{formatINR(costMap.get(l.id) ?? 0)}</td>}
              <td className="p-2 text-right">{open && <form action={act}>{hidden("delline", { line: l.id })}<button className={ghost}>Remove</button></form>}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-line text-right tabular-nums">
          <tr><td colSpan={3} className="p-2">Subtotal</td><td>{formatINR(t.subtotal)}</td><td colSpan={2} /></tr>
          <tr><td colSpan={3} className="p-2">Discount ({cur.discount_bps / 100}%)</td><td>−{formatINR(t.discount)}</td><td colSpan={2} /></tr>
          <tr className="font-semibold"><td colSpan={3} className="p-2">Total</td><td>{formatINR(t.total)}</td><td colSpan={2} /></tr>
        </tfoot>
      </table>
      {canSeeCosts && t.internalCost !== null && (
        <p className="mt-2 text-sm text-muted">Internal only — estimated cost {formatINR(t.internalCost)}, margin {t.marginBps === null ? "—" : `${(t.marginBps / 100).toFixed(1)}%`}.</p>
      )}

      {open && (
        <div className="mt-6 grid max-w-4xl gap-4 md:grid-cols-2">
          <form action={act} className="grid gap-2 rounded-lg border border-line bg-white p-4">
            {hidden("addline")}
            <h2 className="font-medium">Add line</h2>
            <label className="text-sm">Type<select name="kind" className={input}><option value="labour">Labour (hours)</option><option value="external">External cost (units)</option></select></label>
            <label className="text-sm">Description<input name="description" required className={input} /></label>
            <div className="grid grid-cols-3 gap-2">
              <label className="text-sm">Qty<input name="qty" type="number" min="0.01" step="0.01" required className={input} /></label>
              <label className="text-sm">Rate ₹<input name="rate" type="number" min="0" step="0.01" required className={input} /></label>
              <label className="text-sm">Cost ₹ <span className="text-muted">(internal)</span><input name="cost" type="number" min="0" step="0.01" className={input} /></label>
            </div>
            <button className={btn}>Add line</button>
          </form>
          <form action={act} className="grid content-start gap-2 rounded-lg border border-line bg-white p-4">
            {hidden("discount")}
            <h2 className="font-medium">Discount</h2>
            <label className="text-sm">Percent<input name="discount" type="number" min="0" max="100" step="0.01" defaultValue={cur.discount_bps / 100} className={input} /></label>
            <button className={btn}>Save discount</button>
          </form>
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        {cur.status === "draft" && ls.length > 0 && step("Submit for approval", "pending_approval")}
        {cur.status === "pending_approval" && step("Approve (manager)", "approved")}
        {cur.status === "approved" && step("Mark as sent", "sent")}
        {["sent", "approved", "accepted", "rejected"].includes(cur.status) && cur.status !== "accepted" && cur.status !== "rejected" && cur.status === "sent" && step("Mark rejected", "rejected")}
        {["sent", "rejected", "accepted"].includes(cur.status) && <form action={act}>{hidden("newversion")}<button className={ghost}>New revision</button></form>}
      </div>

      {cur.status === "sent" && (
        <form action={act} className="mt-4 flex max-w-xl items-end gap-2 rounded-lg border border-line bg-white p-4">
          {hidden("accept")}
          <label className="flex-1 text-sm">Accepted by (authorised contact)
            <select name="contact" required className={input}>{(contacts ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
          <button className={btn} disabled={!contacts?.length}>Record acceptance</button>
          {!contacts?.length && <span className="text-sm text-muted">No authorised contact on this client.</span>}
        </form>
      )}
      {cur.status === "accepted" && !eng && (
        <form action={act} className="mt-4">{hidden("engage")}<button className={btn}>Create engagement and project</button></form>
      )}
      {eng && <p className="mt-4 text-sm text-muted">Engagement and project created from this revision.</p>}
    </>
  );
}
