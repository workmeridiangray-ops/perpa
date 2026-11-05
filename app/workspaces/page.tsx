import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

async function createBusiness(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_business", { p_name: String(formData.get("name") ?? "") });
  if (error || !data) redirect("/workspaces?error=1");
  redirect(`/w/${data}`);
}

export default async function Workspaces({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const { data: rows } = await supabase.from("memberships").select("role, status, businesses(id, name)").eq("status", "active");
  const list = (rows ?? []).flatMap((m) => {
    const b = m.businesses as unknown as { id: string; name: string } | null;
    return b ? [{ id: b.id, name: b.name, role: m.role as string }] : [];
  });
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="text-xl font-semibold">Choose a workspace</h1>
      {error && <p role="alert" className="mt-3 text-danger">Could not create the workspace.</p>}
      <ul className="mt-4 divide-y divide-line rounded-lg border border-line bg-white">
        {list.length === 0 && <li className="p-4 text-muted">No workspaces yet. Create one below.</li>}
        {list.map((w) => (
          <li key={w.id}>
            <Link href={`/w/${w.id}`} className="flex justify-between p-4 hover:bg-canvas">
              <span>{w.name}</span><span className="text-muted">{w.role}</span>
            </Link>
          </li>
        ))}
      </ul>
      <form action={createBusiness} className="mt-8 flex gap-2">
        <label className="flex-1 text-sm">New business name
          <input name="name" required className="mt-1 block w-full rounded-md border border-line bg-white px-3 py-2" />
        </label>
        <button className="self-end rounded-md bg-brand px-4 py-2 text-white">Create</button>
      </form>
    </main>
  );
}
