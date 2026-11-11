import Link from "next/link";
import { back, btn, card, db, ErrorNote, ghost, Hidden, input, myRole, table } from "../../lib";

async function act(f: FormData) {
  "use server";
  const ws = String(f.get("ws")), id = String(f.get("id")), what = String(f.get("what"));
  const supabase = await db();
  let error: string | undefined;
  if (what === "contact") {
    error = (await supabase.from("contacts").insert({ business_id: ws, client_id: id, name: String(f.get("name") ?? ""), email: String(f.get("email") ?? "") || null, phone: String(f.get("phone") ?? "") || null, is_authorised_approver: f.get("approver") === "on" })).error?.message;
  } else if (what === "approver") {
    error = (await supabase.from("contacts").update({ is_authorised_approver: f.get("on") === "1" }).eq("id", String(f.get("contact"))).select("id")).error?.message;
  } else if (what === "portal") {
    error = (await supabase.from("client_users").insert({ business_id: ws, client_id: id, user_id: String(f.get("user")), can_approve: f.get("approve") === "on", can_see_finance: f.get("finance") === "on" })).error?.message;
  } else if (what === "unlink") {
    error = (await supabase.from("client_users").delete().eq("client_id", id).eq("user_id", String(f.get("user")))).error?.message;
  } else if (what === "archive") {
    error = (await supabase.from("clients").update({ archived: true }).eq("id", id)).error?.message;
    if (!error) return back(`/w/${ws}/clients`);
  }
  back(`/w/${ws}/clients/${id}`, error);
}

export default async function ClientPage({ params, searchParams }: { params: Promise<{ ws: string; id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ ws, id }, { error }] = await Promise.all([params, searchParams]);
  const supabase = await db();
  const isMgr = ["owner", "manager"].includes((await myRole(ws)) ?? "");
  const [{ data: c }, { data: contacts }, { data: links }, { data: customers }] = await Promise.all([
    supabase.from("clients").select("id, name, archived").eq("id", id).maybeSingle(),
    supabase.from("contacts").select("id, name, email, phone, is_authorised_approver").eq("client_id", id).order("name"),
    supabase.from("client_users").select("user_id, can_approve, can_see_finance").eq("client_id", id),
    isMgr ? supabase.from("memberships").select("user_id").eq("business_id", ws).eq("role", "customer").eq("status", "active") : Promise.resolve({ data: [] }),
  ]);
  if (!c) return <p>Client not found.</p>;
  const ids = [...new Set([...(links ?? []).map((l) => l.user_id), ...(customers ?? []).map((m) => m.user_id)])];
  const { data: profs } = ids.length ? await supabase.from("profiles").select("id, email, full_name").in("id", ids) : { data: [] };
  const who = new Map((profs ?? []).map((p) => [p.id, p.full_name || p.email || p.id.slice(0, 8)]));
  const linked = new Set((links ?? []).map((l) => l.user_id));
  const h = (what: string, extra: Record<string, string> = {}) => <Hidden fields={{ ws, id, what, ...extra }} />;
  return (
    <>
      <p className="text-sm"><Link className="underline" href={`/w/${ws}/clients`}>← Clients</Link></p>
      <h1 className="text-xl font-semibold">{c.name}{c.archived ? " (archived)" : ""}</h1>
      <ErrorNote error={error} />

      <h2 className="mt-6 font-medium">Contacts</h2>
      <table className={table}>
        <thead className="bg-canvas text-left text-muted"><tr><th className="p-3">Name</th><th>Email</th><th>Phone</th><th>Can accept estimates</th></tr></thead>
        <tbody>
          {(contacts ?? []).length === 0 && <tr><td colSpan={4} className="p-4 text-muted">No contacts yet. Add an authorised approver before recording an estimate acceptance.</td></tr>}
          {(contacts ?? []).map((k) => (
            <tr key={k.id} className="border-t border-line"><td className="p-3">{k.name}</td><td>{k.email}</td><td>{k.phone}</td>
              <td><form action={act} className="flex items-center gap-2">{h("approver", { contact: k.id, on: k.is_authorised_approver ? "0" : "1" })}<span>{k.is_authorised_approver ? "Yes" : "No"}</span><button className={ghost}>{k.is_authorised_approver ? "Remove" : "Authorise"}</button></form></td></tr>
          ))}
        </tbody>
      </table>
      <form action={act} className={card}>{h("contact")}<h3 className="font-medium">Add contact</h3>
        <label className="text-sm">Name<input name="name" required className={input} /></label>
        <div className="grid grid-cols-2 gap-2"><label className="text-sm">Email<input name="email" type="email" className={input} /></label><label className="text-sm">Phone<input name="phone" className={input} /></label></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="approver" /> Authorised to accept estimates</label>
        <button className={btn}>Add contact</button></form>

      {isMgr && (<>
        <h2 className="mt-8 font-medium">Client portal access</h2>
        <ul className="mt-2 max-w-xl divide-y divide-line rounded-lg border border-line bg-white text-sm">
          {(links ?? []).length === 0 && <li className="p-3 text-muted">No portal users. Invite them from Team with the “Client user” role, then link them here.</li>}
          {(links ?? []).map((l) => <li key={l.user_id} className="flex items-center justify-between p-3"><span>{who.get(l.user_id)} · {l.can_approve ? "can approve proofs" : "view only"}{l.can_see_finance ? " · sees invoices" : ""}</span><form action={act}>{h("unlink", { user: l.user_id })}<button className={ghost}>Remove access</button></form></li>)}
        </ul>
        {(customers ?? []).filter((m) => !linked.has(m.user_id)).length > 0 && (
          <form action={act} className={card}>{h("portal")}<h3 className="font-medium">Link a client user</h3>
            <label className="text-sm">Person<select name="user" className={input}>{(customers ?? []).filter((m) => !linked.has(m.user_id)).map((m) => <option key={m.user_id} value={m.user_id}>{who.get(m.user_id) ?? m.user_id.slice(0, 8)}</option>)}</select></label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="approve" /> Can approve or reject proofs</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="finance" /> Can see invoices and payments</label>
            <button className={btn}>Link</button></form>)}
        {!c.archived && <form action={act} className="mt-8">{h("archive")}<button className={ghost}>Archive client</button></form>}
      </>)}
    </>
  );
}
