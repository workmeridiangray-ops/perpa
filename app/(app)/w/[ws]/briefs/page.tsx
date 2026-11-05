import { formatINR } from "@/lib/rules/money";
import { createClient } from "@/lib/supabase/server";
import { NewBrief } from "./new-brief";
import { ErrorNote } from "../lib";

export default async function Briefs({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ ws }, { error }] = await Promise.all([params, searchParams]);
  const supabase = await createClient();
  const { data } = await supabase.from("briefs").select("id, title, status, budget_paise, due_date, clients(name)").eq("business_id", ws).order("created_at", { ascending: false });
  return (
    <>
      <h1 className="text-xl font-semibold">Briefs</h1>
      <ErrorNote error={error} />
      <NewBrief ws={ws} />
      <table className="mt-4 w-full max-w-4xl border-collapse overflow-hidden rounded-lg border border-line bg-white text-sm">
        <thead className="bg-canvas text-left text-muted"><tr><th className="p-3">Title</th><th>Client</th><th>Status</th><th>Due</th><th className="pr-3 text-right">Budget</th></tr></thead>
        <tbody>
          {(data ?? []).length === 0 && <tr><td colSpan={5} className="p-4 text-muted">No briefs yet.</td></tr>}
          {(data ?? []).map((b) => (
            <tr key={b.id} className="border-t border-line">
              <td className="p-3">{b.title}</td>
              <td>{(b.clients as unknown as { name: string } | null)?.name}</td>
              <td>{b.status}</td><td>{b.due_date ?? "—"}</td>
              <td className="pr-3 text-right tabular-nums">{b.budget_paise == null ? "—" : formatINR(b.budget_paise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
