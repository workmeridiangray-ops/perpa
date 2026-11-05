import { formatINR } from "@/lib/rules/money";
import { db, table } from "../lib";

export default async function Statement({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ client?: string; from?: string; to?: string }> }) {
  const [{ ws }, q] = await Promise.all([params, searchParams]);
  const supabase = await db();
  const from = q.from ?? `${new Date().getFullYear()}-01-01`, to = q.to ?? new Date().toISOString().slice(0, 10);
  const [{ data: client }, { data: rows, error }] = await Promise.all([
    supabase.from("clients").select("name").eq("id", q.client ?? "").maybeSingle(),
    supabase.rpc("client_statement", { p_client: q.client, p_from: from, p_to: to }),
  ]);
  if (!client || error) return <p>Statement not available.</p>;
  return (
    <>
      <h1 className="text-xl font-semibold">Statement — {client.name}</h1>
      <p className="text-muted">{from} to {to}</p>
      <table className={table}>
        <thead className="bg-canvas text-left text-muted"><tr><th className="p-3">Date</th><th>Document</th><th className="text-right">Debit</th><th className="text-right">Credit</th><th className="pr-3 text-right">Balance</th></tr></thead>
        <tbody>
          {(rows ?? []).length === 0 && <tr><td colSpan={5} className="p-4 text-muted">No activity in this period.</td></tr>}
          {(rows ?? []).map((r: { on_date: string; document: string; debit_paise: number; credit_paise: number; balance_paise: number }, i: number) => (
            <tr key={i} className="border-t border-line"><td className="p-3">{r.on_date}</td><td>{r.document}</td>
              <td className="text-right tabular-nums">{r.debit_paise ? formatINR(r.debit_paise) : ""}</td><td className="text-right tabular-nums">{r.credit_paise ? formatINR(r.credit_paise) : ""}</td>
              <td className="pr-3 text-right tabular-nums">{formatINR(r.balance_paise)}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
