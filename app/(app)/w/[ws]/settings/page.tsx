import { randomBytes } from "node:crypto";
import { checkWebhookUrl } from "@/lib/rules/webhooks";
import { back, btn, card, db, ErrorNote, ghost, Hidden, input, myRole } from "../lib";

async function act(f: FormData) {
  "use server";
  const ws = String(f.get("ws")), what = String(f.get("what"));
  const supabase = await db();
  let error: string | undefined, link = "";
  if (what === "apikey") {
    const key = `pk_${randomBytes(32).toString("base64url")}`;
    const { error: e } = await supabase.rpc("create_api_key", { p_business: ws, p_name: String(f.get("name") ?? ""), p_key: key });
    error = e?.message; if (!e) link = `&key=${encodeURIComponent(key)}`; // shown once; only a hash is stored
  } else if (what === "revokekey") error = (await supabase.rpc("revoke_api_key", { p_id: String(f.get("id")) })).error?.message;
  else if (what === "webhook") {
    const url = String(f.get("url") ?? "");
    error = checkWebhookUrl(url) ?? undefined;
    if (!error) {
      const events = f.getAll("events").map(String);
      error = (await supabase.from("webhook_endpoints").insert({ business_id: ws, url, secret: randomBytes(24).toString("base64url"), events })).error?.message;
    }
  } else if (what === "delhook") error = (await supabase.from("webhook_endpoints").delete().eq("id", String(f.get("id")))).error?.message;
  else if (what === "field") error = (await supabase.from("custom_fields").insert({ business_id: ws, entity: String(f.get("entity")), key: String(f.get("key") ?? ""), label: String(f.get("label") ?? ""), type: String(f.get("type")), required: f.get("required") === "on" })).error?.message;
  else if (what === "coupon") error = (await supabase.rpc("redeem_coupon", { p_business: ws, p_code: String(f.get("code") ?? "") })).error?.message;
  else if (what === "close") error = (await supabase.rpc("request_closure", { p_business: ws, p_confirm: String(f.get("confirm") ?? "") })).error?.message;
  back(`/w/${ws}/settings${link ? `?${link.slice(1)}` : ""}`, error);
}

export default async function Settings({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string; key?: string }> }) {
  const [{ ws }, { error, key }] = await Promise.all([params, searchParams]);
  const role = await myRole(ws);
  const supabase = await db();
  const isOwner = role === "owner", isMgr = isOwner || role === "manager";
  if (!isMgr) return <p>Settings are limited to owners and managers.</p>;
  const [{ data: keys }, { data: hooks }, { data: logs }, { data: fields }, { data: state }, { data: closure }] = await Promise.all([
    isOwner ? supabase.from("api_keys").select("id, name, prefix, revoked_at, last_used_at").eq("business_id", ws) : Promise.resolve({ data: [] }),
    isOwner ? supabase.from("webhook_endpoints").select("id, url, events, active").eq("business_id", ws) : Promise.resolve({ data: [] }),
    supabase.from("webhook_logs").select("id, event, status_code, ok, error, at").eq("business_id", ws).order("id", { ascending: false }).limit(10),
    supabase.from("custom_fields").select("id, entity, key, label, type, required").eq("business_id", ws),
    supabase.rpc("entitlement_state", { p_business: ws }),
    isOwner ? supabase.from("closure_requests").select("status, requested_at, exported_at, error").eq("business_id", ws) : Promise.resolve({ data: [] }),
  ]);
  const h = (what: string, extra: Record<string, string> = {}) => <Hidden fields={{ ws, what, ...extra }} />;
  return (
    <>
      <h1 className="text-xl font-semibold">Settings</h1>
      <ErrorNote error={error} />
      <p className="mt-2 text-sm text-muted">Plan status: <strong>{state ?? "no plan"}</strong></p>
      {key && <p role="status" className="mt-3 rounded-md border border-line bg-white p-3 text-sm">New API key (copy it now — it is not stored): <code className="break-all">{key}</code></p>}

      <h2 className="mt-8 font-medium">Custom fields</h2>
      <ul className="mt-2 max-w-xl divide-y divide-line rounded-lg border border-line bg-white text-sm">
        {(fields ?? []).length === 0 && <li className="p-3 text-muted">None.</li>}
        {(fields ?? []).map((f) => <li key={f.id} className="p-3">{f.entity}.{f.key} — {f.label} ({f.type}{f.required ? ", required" : ""})</li>)}
      </ul>
      <form action={act} className="mt-3 flex max-w-xl flex-wrap items-end gap-2">{h("field")}
        <label className="text-sm">For<select name="entity" className={input}><option value="client">Client</option><option value="project">Project</option></select></label>
        <label className="text-sm">Key<input name="key" required pattern="[a-z][a-z0-9_]{0,39}" placeholder="gstin" aria-label="gstin" className={input} /></label>
        <label className="text-sm">Label<input name="label" required className={input} /></label>
        <label className="text-sm">Type<select name="type" className={input}><option>text</option><option>number</option><option>date</option></select></label>
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="required" /> Required</label>
        <button className={btn}>Add</button></form>

      {isOwner && (<>
        <h2 className="mt-8 font-medium">API keys</h2>
        <ul className="mt-2 max-w-xl divide-y divide-line rounded-lg border border-line bg-white text-sm">
          {(keys ?? []).length === 0 && <li className="p-3 text-muted">None. Read-only endpoint: <code>GET /api/v1/clients</code> with <code>Authorization: Bearer …</code></li>}
          {(keys ?? []).map((k) => <li key={k.id} className="flex items-center justify-between p-3"><span>{k.name} · {k.prefix}… · {k.revoked_at ? "revoked" : k.last_used_at ? `last used ${new Date(k.last_used_at).toLocaleDateString("en-IN")}` : "unused"}</span>
            {!k.revoked_at && <form action={act}>{h("revokekey", { id: k.id })}<button className={ghost}>Revoke</button></form>}</li>)}
        </ul>
        <form action={act} className="mt-3 flex max-w-xl items-end gap-2">{h("apikey")}<label className="flex-1 text-sm">Key name<input name="name" required className={input} /></label><button className={btn}>Create key</button></form>

        <h2 className="mt-8 font-medium">Webhooks</h2>
        <ul className="mt-2 max-w-xl divide-y divide-line rounded-lg border border-line bg-white text-sm">
          {(hooks ?? []).length === 0 && <li className="p-3 text-muted">None.</li>}
          {(hooks ?? []).map((w) => <li key={w.id} className="flex items-center justify-between p-3"><span className="break-all">{w.url} · {(w.events as string[]).join(", ") || "all events"}</span><form action={act}>{h("delhook", { id: w.id })}<button className={ghost}>Remove</button></form></li>)}
        </ul>
        <form action={act} className={card}>{h("webhook")}
          <label className="text-sm">HTTPS URL<input name="url" type="url" required className={input} /></label>
          <fieldset className="text-sm"><legend>Events (none ticked = all)</legend>{["invoice.issued", "payment.received", "estimate.accepted"].map((e) => <label key={e} className="mr-3"><input type="checkbox" name="events" value={e} /> {e}</label>)}</fieldset>
          <button className={btn}>Add webhook</button>
          <p className="text-sm text-muted">Deliveries are signed (<code>x-perpa-signature: sha256=…</code>) and retried with backoff. Delivery runs when the job worker is scheduled.</p></form>
        <h3 className="mt-4 text-sm font-medium">Recent deliveries</h3>
        <ul className="mt-1 max-w-xl text-sm text-muted">{(logs ?? []).map((l) => <li key={l.id}>{new Date(l.at).toLocaleString("en-IN")} · {l.event} · {l.ok ? "ok" : `failed ${l.status_code ?? ""} ${l.error ?? ""}`}</li>)}</ul>

        <h2 className="mt-8 font-medium">Coupon</h2>
        <form action={act} className="mt-2 flex max-w-xl items-end gap-2">{h("coupon")}<label className="flex-1 text-sm">Code<input name="code" required className={input} /></label><button className={btn}>Redeem</button></form>

        <h2 className="mt-8 font-medium">Export and closure</h2>
        <a className={`${ghost} mt-2 inline-block`} href={`/w/${ws}/export`}>Download full export (JSON)</a>
        {(closure ?? []).map((c, i) => <p key={i} className="mt-2 text-sm text-muted">Closure {c.status} — requested {new Date(c.requested_at).toLocaleDateString("en-IN")}{c.exported_at ? ", exported" : ", not yet exported"}{c.error ? `, error: ${c.error}` : ""}. Data is kept for 30 days before permanent deletion.</p>)}
        <form action={act} className={card}>{h("close")}
          <p className="text-sm">Closing cancels the subscription. After 30 days, once you have exported, platform operations can permanently delete the data.</p>
          <label className="text-sm">Type DELETE to request closure<input name="confirm" required className={input} /></label>
          <button className={`${ghost} border-danger text-danger`}>Request closure</button></form>
      </>)}
    </>
  );
}
