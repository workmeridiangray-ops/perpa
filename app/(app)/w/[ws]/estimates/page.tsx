import Link from "next/link";
import { back, btn, db, ErrorNote, input } from "../lib";

async function createEstimate(f: FormData) {
  "use server";
  const ws = String(f.get("ws"));
  const supabase = await db();
  const { data, error } = await supabase.rpc("new_estimate", { p_client: String(f.get("client")), p_brief: null, p_title: String(f.get("title") ?? "") });
  back(error || !data ? `/w/${ws}/estimates` : `/w/${ws}/estimates/${data}`, error?.message);
}

export default async function Estimates({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ ws }, { error }] = await Promise.all([params, searchParams]);
  const supabase = await db();
  const [{ data }, { data: clients }] = await Promise.all([
    supabase.from("estimates").select("id, number, title, clients(name), estimate_versions(version, status)").eq("business_id", ws).order("number", { ascending: false }),
    supabase.from("clients").select("id, name").eq("business_id", ws).eq("archived", false).order("name"),
  ]);
  return (
    <>
      <h1 className="text-xl font-semibold">Estimates</h1>
      <ErrorNote error={error} />
      <form action={createEstimate} className="mt-4 flex max-w-xl flex-wrap items-end gap-2">
        <input type="hidden" name="ws" value={ws} />
        <label className="text-sm">Client<select name="client" required className={input}>{(clients ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="flex-1 text-sm">Title<input name="title" required className={input} /></label>
        <button className={btn}>New estimate</button>
      </form>
      <table className="mt-6 w-full max-w-4xl border-collapse overflow-hidden rounded-lg border border-line bg-white text-sm">
        <thead className="bg-canvas text-left text-muted"><tr><th className="p-3">No.</th><th>Title</th><th>Client</th><th>Latest revision</th></tr></thead>
        <tbody>
          {(data ?? []).length === 0 && <tr><td colSpan={4} className="p-4 text-muted">No estimates yet.</td></tr>}
          {(data ?? []).map((e) => {
            const vs = (e.estimate_versions as unknown as { version: number; status: string }[]) ?? [];
            const latest = [...vs].sort((a, b) => b.version - a.version)[0];
            return (
              <tr key={e.id} className="border-t border-line">
                <td className="p-3 tabular-nums"><Link className="text-brand underline" href={`/w/${ws}/estimates/${e.id}`}>{e.number}</Link></td>
                <td>{e.title}</td><td>{(e.clients as unknown as { name: string } | null)?.name}</td>
                <td>{latest ? `v${latest.version} · ${latest.status}` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
