import Link from "next/link";
import { back, db, ghost } from "../lib";

async function markAll(f: FormData) {
  "use server";
  const ws = String(f.get("ws"));
  await (await db()).from("notifications").update({ read_at: new Date().toISOString() }).eq("business_id", ws).is("read_at", null);
  back(`/w/${ws}/notifications`);
}

export default async function Notifications({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const supabase = await db();
  const [{ data }, { data: delays }] = await Promise.all([
    supabase.from("notifications").select("id, title, link, read_at, created_at").eq("business_id", ws).order("created_at", { ascending: false }).limit(50),
    supabase.rpc("review_delays", { p_business: ws, p_days: 5 }),
  ]);
  return (
    <>
      <h1 className="text-xl font-semibold">Notifications</h1>
      {(delays ?? []).length > 0 && (
        <section className="mt-4 max-w-xl rounded-lg border border-danger bg-white p-4 text-sm"><h2 className="font-medium">Overdue reviews</h2>
          <ul className="mt-1">{(delays ?? []).map((d: { kind: string; ref: string; waiting_days: number }, i: number) => <li key={i}>{d.kind}: {d.ref} — waiting {d.waiting_days} days</li>)}</ul></section>)}
      <form action={markAll} className="mt-4"><input type="hidden" name="ws" value={ws} /><button className={ghost}>Mark all read</button></form>
      <ul className="mt-3 max-w-xl divide-y divide-line rounded-lg border border-line bg-white">
        {(data ?? []).length === 0 && <li className="p-4 text-muted">Nothing yet.</li>}
        {(data ?? []).map((n) => (
          <li key={n.id} className={`p-3 text-sm ${n.read_at ? "text-muted" : "font-medium"}`}>
            {n.link ? <Link className="underline" href={n.link}>{n.title}</Link> : n.title}
            <div className="text-xs text-muted">{new Date(n.created_at).toLocaleString("en-IN")}</div>
          </li>
        ))}
      </ul>
    </>
  );
}
