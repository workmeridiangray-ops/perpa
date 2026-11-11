import { previewClientImport } from "@/lib/rules/csv";
import { back, btn, card, db, ErrorNote, ghost, Hidden, input } from "../lib";
import Link from "next/link";

async function addClient(f: FormData) {
  "use server";
  const ws = String(f.get("ws"));
  const supabase = await db();
  const { data: defs } = await supabase.from("custom_fields").select("key, type").eq("business_id", ws).eq("entity", "client");
  const custom: Record<string, string | number> = {};
  for (const d of defs ?? []) {
    const v = String(f.get(`cf_${d.key}`) ?? "").trim();
    if (v) custom[d.key] = d.type === "number" ? Number(v) : v;
  }
  const { error } = await supabase.from("clients").insert({ business_id: ws, name: String(f.get("name") ?? ""), custom });
  back(`/w/${ws}/clients`, error ? (error.code === "23505" ? "A client with this name already exists." : error.message) : null);
}

/** Two steps: preview shows every row error; commit inserts only the valid, de-duplicated rows. */
async function importClients(f: FormData) {
  "use server";
  const ws = String(f.get("ws")), csv = String(f.get("csv") ?? "");
  const supabase = await db();
  const { data: existing } = await supabase.from("clients").select("name").eq("business_id", ws);
  const p = previewClientImport(csv, (existing ?? []).map((c) => c.name));
  if (f.get("commit") !== "yes") {
    const msg = `Preview: ${p.valid.length} to import, ${p.errors.length} skipped. ${p.errors.slice(0, 5).map((e) => `row ${e.line}: ${e.message}`).join(" · ")}`;
    return back(`/w/${ws}/clients?note=${encodeURIComponent(msg)}`);
  }
  if (p.valid.length) {
    const { error } = await supabase.from("clients").insert(p.valid.map((v) => ({ business_id: ws, name: v.name })));
    if (error) return back(`/w/${ws}/clients`, error.message);
  }
  back(`/w/${ws}/clients?note=${encodeURIComponent(`Imported ${p.valid.length}; skipped ${p.errors.length}.`)}`);
}

async function saveView(f: FormData) {
  "use server";
  const ws = String(f.get("ws"));
  const supabase = await db();
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("saved_views").upsert({ business_id: ws, user_id: user?.id, screen: "clients", name: String(f.get("name") ?? ""), params: { q: String(f.get("q") ?? "") } }, { onConflict: "user_id,business_id,screen,name" });
  back(`/w/${ws}/clients?q=${encodeURIComponent(String(f.get("q") ?? ""))}`, error?.message);
}

export default async function Clients({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string; note?: string; q?: string }> }) {
  const [{ ws }, { error, note, q }] = await Promise.all([params, searchParams]);
  const supabase = await db();
  let query = supabase.from("clients").select("id, name, custom").eq("business_id", ws).eq("archived", false).order("name");
  if (q) query = query.ilike("name", `%${q.replace(/[%_]/g, "")}%`);
  const [{ data: clients }, { data: defs }, { data: views }] = await Promise.all([
    query,
    supabase.from("custom_fields").select("key, label, type, required").eq("business_id", ws).eq("entity", "client"),
    supabase.from("saved_views").select("id, name, params").eq("business_id", ws).eq("screen", "clients"),
  ]);
  return (
    <>
      <h1 className="text-xl font-semibold">Clients</h1>
      <ErrorNote error={error} />
      {note && <p role="status" className="mt-3 text-muted">{note}</p>}
      <form action={addClient} className="mt-4 flex max-w-md flex-wrap gap-2">
        <Hidden fields={{ ws }} />
        <label className="flex-1 text-sm">Client name<input name="name" required className={input} /></label>
        {(defs ?? []).map((d) => <label key={d.key} className="text-sm">{d.label}<input name={`cf_${d.key}`} required={d.required} type={d.type === "number" ? "number" : d.type === "date" ? "date" : "text"} className={input} /></label>)}
        <button className={`${btn} self-end`}>Add</button>
      </form>
      <form className="mt-4 flex max-w-md items-end gap-2" action={saveView}>
        <Hidden fields={{ ws }} />
        <label className="flex-1 text-sm">Search<input name="q" defaultValue={q ?? ""} className={input} /></label>
        <button formAction={`/w/${ws}/clients`} formMethod="get" className={ghost}>Filter</button>
        <input name="name" placeholder="View name" aria-label="View name" className="w-28 rounded-md border border-line bg-white px-2 py-1.5 text-sm" />
        <button className={ghost}>Save view</button>
      </form>
      {(views ?? []).length > 0 && <p className="mt-2 text-sm">Saved views: {(views ?? []).map((v) => <Link key={v.id} className="mr-2 underline" href={`/w/${ws}/clients?q=${encodeURIComponent((v.params as { q?: string }).q ?? "")}`}>{v.name}</Link>)}</p>}
      <ul className="mt-6 max-w-md divide-y divide-line rounded-lg border border-line bg-white">
        {(clients ?? []).length === 0 && <li className="p-4 text-muted">No clients yet.</li>}
        {(clients ?? []).map((c) => <li key={c.id} className="p-3"><Link className="text-brand underline" href={`/w/${ws}/clients/${c.id}`}>{c.name}</Link>{Object.keys((c.custom as object) ?? {}).length > 0 && <span className="block text-xs text-muted">{Object.entries(c.custom as Record<string, unknown>).map(([k, v]) => `${k}: ${v}`).join(" · ")}</span>}</li>)}
      </ul>
      <Link href={`/w/${ws}/clients/export`} className={`${ghost} mt-3 inline-block`}>Export CSV</Link>
      <form action={importClients} className={card}>
        <Hidden fields={{ ws }} />
        <h2 className="font-medium">Import clients (CSV)</h2>
        <label className="text-sm">Paste CSV with a “name” column<textarea name="csv" rows={4} required className={input} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="commit" value="yes" /> Commit (leave unticked to preview only)</label>
        <button className={btn}>Preview / import</button>
      </form>
    </>
  );
}
