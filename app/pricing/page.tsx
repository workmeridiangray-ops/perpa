import Link from "next/link";
import { formatINR } from "@/lib/rules/money";
import { createClient } from "@/lib/supabase/server";

export default async function Pricing() {
  const supabase = await createClient();
  const { data } = await supabase.from("plan_versions").select("id, version, monthly_paise, max_users, max_branches, effective_from, plans(name)").lte("effective_from", new Date().toISOString().slice(0, 10)).order("monthly_paise");
  // Show only the latest version of each plan.
  const latest = new Map<string, NonNullable<typeof data>[number]>();
  for (const v of data ?? []) {
    const name = (v.plans as unknown as { name: string }).name;
    if (!latest.has(name) || latest.get(name)!.version < v.version) latest.set(name, v);
  }
  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Pricing</h1>
      <p className="mt-1 text-muted">Prices in INR per month, excluding applicable taxes.</p>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {latest.size === 0 && <p className="text-muted">Plans are being finalised.</p>}
        {[...latest.entries()].map(([name, v]) => (
          <section key={name} className="rounded-lg border border-line bg-white p-4">
            <h2 className="font-medium">{name}</h2>
            <p className="mt-2 text-xl tabular-nums">{formatINR(v.monthly_paise)}</p>
            <ul className="mt-2 text-sm text-muted"><li>Up to {v.max_users} team members</li><li>Up to {v.max_branches} branches</li></ul>
          </section>
        ))}
      </div>
      <Link href="/signup" className="mt-8 inline-block rounded-md bg-brand px-4 py-2 text-white">Start free trial</Link>
    </main>
  );
}
