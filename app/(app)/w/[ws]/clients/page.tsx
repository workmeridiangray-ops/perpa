import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

async function addClient(formData: FormData) {
  "use server";
  const ws = String(formData.get("ws"));
  const supabase = await createClient();
  const { error } = await supabase.from("clients").insert({ business_id: ws, name: String(formData.get("name") ?? "") });
  // 23505 = unique violation: a live client with this name already exists.
  redirect(`/w/${ws}/clients${error ? (error.code === "23505" ? "?error=duplicate" : "?error=failed") : ""}`);
}

export default async function Clients({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ ws }, { error }] = await Promise.all([params, searchParams]);
  const supabase = await createClient();
  const { data: clients } = await supabase.from("clients").select("id, name").eq("business_id", ws).eq("archived", false).order("name");
  return (
    <>
      <h1 className="text-xl font-semibold">Clients</h1>
      {error && <p role="alert" className="mt-3 text-danger">{error === "duplicate" ? "A client with this name already exists." : "Could not add the client."}</p>}
      <form action={addClient} className="mt-4 flex max-w-md gap-2">
        <input type="hidden" name="ws" value={ws} />
        <label className="flex-1 text-sm">Client name
          <input name="name" required className="mt-1 block w-full rounded-md border border-line bg-white px-3 py-2" />
        </label>
        <button className="self-end rounded-md bg-brand px-4 py-2 text-white">Add</button>
      </form>
      <ul className="mt-6 max-w-md divide-y divide-line rounded-lg border border-line bg-white">
        {(clients ?? []).length === 0 && <li className="p-4 text-muted">No clients yet.</li>}
        {(clients ?? []).map((c) => <li key={c.id} className="p-3">{c.name}</li>)}
      </ul>
    </>
  );
}
