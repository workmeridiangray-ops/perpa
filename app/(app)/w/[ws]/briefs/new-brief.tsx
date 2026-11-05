import { back, btn, db, input } from "../lib";

async function createBrief(f: FormData) {
  "use server";
  const ws = String(f.get("ws"));
  const budget = String(f.get("budget") ?? "").trim();
  const supabase = await db();
  const { error } = await supabase.from("briefs").insert({
    business_id: ws, client_id: String(f.get("client")), title: String(f.get("title") ?? ""),
    requirements: String(f.get("requirements") ?? ""),
    budget_paise: budget ? Math.round(Number(budget) * 100) : null,
    due_date: String(f.get("due") ?? "") || null,
  });
  back(`/w/${ws}/briefs`, error?.message);
}

export async function NewBrief({ ws }: { ws: string }) {
  const supabase = await db();
  const { data: clients } = await supabase.from("clients").select("id, name").eq("business_id", ws).eq("archived", false).order("name");
  return (
    <form action={createBrief} className="mt-4 grid max-w-xl gap-3 rounded-lg border border-line bg-white p-4">
      <input type="hidden" name="ws" value={ws} />
      <label className="text-sm">Client
        <select name="client" required className={input}>{(clients ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      </label>
      <label className="text-sm">Title<input name="title" required className={input} /></label>
      <label className="text-sm">Requirements<textarea name="requirements" rows={3} className={input} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">Budget (₹)<input name="budget" type="number" min="0" step="0.01" className={input} /></label>
        <label className="text-sm">Due date<input name="due" type="date" className={input} /></label>
      </div>
      <button className={btn}>Add brief</button>
    </form>
  );
}
