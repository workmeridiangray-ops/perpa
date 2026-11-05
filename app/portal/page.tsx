import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

async function act(f: FormData) {
  "use server";
  const supabase = await createClient();
  const what = String(f.get("what")), v = String(f.get("v"));
  let error: string | undefined;
  if (what === "view") error = (await supabase.rpc("record_view", { p_version: v })).error?.message;
  else if (what === "decide") error = (await supabase.rpc("decide_version", { p_version: v, p_approve: f.get("to") === "approve", p_comment: String(f.get("comment") ?? "") })).error?.message;
  else if (what === "comment") {
    const { data: { user } } = await supabase.auth.getUser();
    const { data: p } = await supabase.from("projects").select("business_id").eq("id", String(f.get("project"))).single();
    error = (await supabase.from("comments").insert({ business_id: p?.business_id, project_id: String(f.get("project")), author: user?.id, body: String(f.get("body") ?? ""), internal: false })).error?.message;
  }
  redirect(error ? `/portal?error=${encodeURIComponent(error)}` : "/portal");
}

export default async function Portal({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/portal");
  const [{ data: projects }, { data: dvs }, { data: cm }, { data: invs }, { data: me }] = await Promise.all([
    supabase.from("projects").select("id, name, status"),
    supabase.from("deliverable_versions").select("id, version, status, comment, deliverables(name, project_id)").order("version", { ascending: false }),
    supabase.from("comments").select("id, project_id, body, created_at").order("created_at", { ascending: false }).limit(30),
    supabase.from("invoices").select("id, number, due_on").eq("status", "issued"),
    supabase.from("client_users").select("can_approve").eq("user_id", user.id),
  ]);
  const canApprove = (me ?? []).some((m) => m.can_approve);
  const input = "mt-1 block w-full rounded-md border border-line bg-white px-3 py-2";
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Your projects</h1>
      {error && <p role="alert" className="mt-3 text-danger">{error}</p>}
      {(projects ?? []).length === 0 && <p className="mt-4 text-muted">Nothing has been shared with you yet.</p>}
      {(projects ?? []).map((p) => (
        <section key={p.id} className="mt-6 rounded-lg border border-line bg-white p-4">
          <h2 className="font-medium">{p.name} <span className="text-sm font-normal text-muted">· {p.status}</span></h2>
          <h3 className="mt-3 text-sm font-medium">Proofs to review</h3>
          <ul className="mt-1 divide-y divide-line">
            {(dvs ?? []).filter((d) => (d.deliverables as unknown as { project_id: string }).project_id === p.id).map((d) => (
              <li key={d.id} className="py-2 text-sm">
                <div>{(d.deliverables as unknown as { name: string }).name} · version {d.version} · <strong>{d.status.replace("_", " ")}</strong>{d.comment ? ` — “${d.comment}”` : ""}</div>
                <form action={act} className="mt-1 inline"><input type="hidden" name="what" value="view" /><input type="hidden" name="v" value={d.id} /><button className="text-brand underline">Mark as viewed</button></form>
                {d.status === "pending" && canApprove && (
                  <form action={act} className="mt-2 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="what" value="decide" /><input type="hidden" name="v" value={d.id} />
                    <label className="flex-1 text-sm">Comment (required to request changes)<input name="comment" className={input} /></label>
                    <button name="to" value="approve" className="rounded-md bg-brand px-3 py-2 text-white">Approve</button>
                    <button name="to" value="changes" className="rounded-md border border-line bg-white px-3 py-2">Request changes</button>
                  </form>)}
                {d.status === "pending" && !canApprove && <p className="text-muted">You can view this proof; an approver on your team needs to decide.</p>}
              </li>
            ))}
          </ul>
          <h3 className="mt-3 text-sm font-medium">Messages</h3>
          <ul className="mt-1 space-y-1 text-sm">{(cm ?? []).filter((c) => c.project_id === p.id).map((c) => <li key={c.id}>{c.body}</li>)}</ul>
          <form action={act} className="mt-2 flex gap-2"><input type="hidden" name="what" value="comment" /><input type="hidden" name="project" value={p.id} /><label className="flex-1 text-sm">Message<input name="body" required className={input} /></label><button className="self-end rounded-md bg-brand px-3 py-2 text-white">Send</button></form>
        </section>
      ))}
      {(invs ?? []).length > 0 && (
        <section className="mt-6 rounded-lg border border-line bg-white p-4"><h2 className="font-medium">Invoices</h2>
          <ul className="mt-2 text-sm">{(invs ?? []).map((i) => <li key={i.id}>{i.number} · due {i.due_on}</li>)}</ul></section>)}
    </main>
  );
}
