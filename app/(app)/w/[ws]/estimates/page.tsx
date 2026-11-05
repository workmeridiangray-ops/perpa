import { createClient } from "@/lib/supabase/server";

export default async function Estimates({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const supabase = await createClient();
  const { data } = await supabase.from("estimates").select("id, number, title, clients(name), estimate_versions(version, status)").eq("business_id", ws).order("number", { ascending: false });
  return (
    <>
      <h1 className="text-xl font-semibold">Estimates</h1>
      <table className="mt-4 w-full max-w-4xl border-collapse overflow-hidden rounded-lg border border-line bg-white text-sm">
        <thead className="bg-canvas text-left text-muted"><tr><th className="p-3">No.</th><th>Title</th><th>Client</th><th>Latest revision</th></tr></thead>
        <tbody>
          {(data ?? []).length === 0 && <tr><td colSpan={4} className="p-4 text-muted">No estimates yet.</td></tr>}
          {(data ?? []).map((e) => {
            const vs = (e.estimate_versions as unknown as { version: number; status: string }[]) ?? [];
            const latest = [...vs].sort((a, b) => b.version - a.version)[0];
            return (
              <tr key={e.id} className="border-t border-line">
                <td className="p-3 tabular-nums">{e.number}</td><td>{e.title}</td>
                <td>{(e.clients as unknown as { name: string } | null)?.name}</td>
                <td>{latest ? `v${latest.version} · ${latest.status}` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
