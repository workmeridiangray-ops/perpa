import { back, btn, card, db, ErrorNote, Hidden, input, myRole } from "../lib";

async function act(f: FormData) {
  "use server";
  const ws = String(f.get("ws")), what = String(f.get("what"));
  const supabase = await db();
  let error: string | undefined;
  if (what === "create") {
    const { data, error: e } = await supabase.from("templates").insert({ business_id: ws, kind: String(f.get("kind")), title: String(f.get("title") ?? ""), body: String(f.get("body") ?? "") }).select("id").single();
    error = e?.message;
    const items = String(f.get("items") ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
    if (data && items.length) error = (await supabase.from("template_items").insert(items.map((text, i) => ({ business_id: ws, template_id: data.id, position: i, text })))).error?.message;
  }
  back(`/w/${ws}/templates`, error);
}

export default async function Templates({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ ws }, { error }] = await Promise.all([params, searchParams]);
  const supabase = await db();
  const isMgr = ["owner", "manager"].includes((await myRole(ws)) ?? "");
  const { data: ts } = await supabase.from("templates").select("id, kind, title, body, template_items(text, position)").eq("business_id", ws).order("title");
  return (
    <>
      <h1 className="text-xl font-semibold">SOPs and checklists</h1>
      <ErrorNote error={error} />
      <div className="mt-4 grid max-w-4xl gap-3 md:grid-cols-2">
        {(ts ?? []).length === 0 && <p className="text-muted">No templates yet.</p>}
        {(ts ?? []).map((t) => (
          <section key={t.id} className="rounded-lg border border-line bg-white p-4 text-sm"><h2 className="font-medium">{t.title} <span className="font-normal text-muted">· {t.kind}</span></h2>
            {t.body && <p className="mt-1 whitespace-pre-wrap text-muted">{t.body}</p>}
            <ol className="mt-2 list-decimal pl-5">{[...(t.template_items as { text: string; position: number }[])].sort((a, b) => a.position - b.position).map((i, k) => <li key={k}>{i.text}</li>)}</ol></section>
        ))}
      </div>
      {isMgr && (
        <form action={act} className={card}><Hidden fields={{ ws, what: "create" }} /><h2 className="font-medium">New template</h2>
          <label className="text-sm">Type<select name="kind" className={input}><option value="sop">SOP</option><option value="delivery">Delivery template</option><option value="review">Review checklist</option></select></label>
          <label className="text-sm">Title<input name="title" required className={input} /></label>
          <label className="text-sm">Notes<textarea name="body" rows={2} className={input} /></label>
          <label className="text-sm">Checklist items (one per line)<textarea name="items" rows={4} className={input} /></label>
          <button className={btn}>Save template</button></form>)}
      <p className="mt-4 text-sm text-muted">Apply a template to a project from the project page; open checklist items block closing it.</p>
    </>
  );
}
