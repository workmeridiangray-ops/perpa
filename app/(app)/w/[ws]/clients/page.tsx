import { previewClientImport } from "@/lib/rules/csv";
import { back, btn, card, db, ErrorNote, ghost, Hidden, input } from "../lib";
import Link from "next/link";

async function addClient(f: FormData) {
  "use server";
  const ws = String(f.get("ws"));
  const { error } = await (await db()).from("clients").insert({ business_id: ws, name: String(f.get("name") ?? "") });
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

export default async function Clients({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string; note?: string }> }) {
  const [{ ws }, { error, note }] = await Promise.all([params, searchParams]);
  const { data: clients } = await (await db()).from("clients").select("id, name").eq("business_id", ws).eq("archived", false).order("name");
  return (
    <>
      <h1 className="text-xl font-semibold">Clients</h1>
      <ErrorNote error={error} />
      {note && <p role="status" className="mt-3 text-muted">{note}</p>}
      <form action={addClient} className="mt-4 flex max-w-md gap-2">
        <Hidden fields={{ ws }} />
        <label className="flex-1 text-sm">Client name<input name="name" required className={input} /></label>
        <button className={`${btn} self-end`}>Add</button>
      </form>
      <ul className="mt-6 max-w-md divide-y divide-line rounded-lg border border-line bg-white">
        {(clients ?? []).length === 0 && <li className="p-4 text-muted">No clients yet.</li>}
        {(clients ?? []).map((c) => <li key={c.id} className="p-3">{c.name}</li>)}
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
