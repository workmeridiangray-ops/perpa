import { db } from "../lib";

export default async function Projects({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const supabase = await db();
  const { data } = await supabase.from("projects").select("id, name, status, engagements(clients(name))").eq("business_id", ws).order("created_at", { ascending: false });
  return (
    <>
      <h1 className="text-xl font-semibold">Projects</h1>
      <ul className="mt-4 max-w-xl divide-y divide-line rounded-lg border border-line bg-white">
        {(data ?? []).length === 0 && <li className="p-4 text-muted">No projects yet. Accept an estimate, then create the engagement.</li>}
        {(data ?? []).map((p) => (
          <li key={p.id} className="flex justify-between p-3"><span>{p.name}</span><span className="text-muted">{(p.engagements as unknown as { clients: { name: string } } | null)?.clients?.name} · {p.status}</span></li>
        ))}
      </ul>
    </>
  );
}
