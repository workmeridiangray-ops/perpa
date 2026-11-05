import { randomBytes } from "node:crypto";
import { back, btn, card, db, ErrorNote, ghost, Hidden, input, myRole, table } from "../lib";

async function act(f: FormData) {
  "use server";
  const ws = String(f.get("ws")), what = String(f.get("what"));
  const supabase = await db();
  let error: string | undefined, note: string | undefined;
  if (what === "invite") {
    const token = randomBytes(24).toString("base64url");
    const { error: e } = await supabase.rpc("create_invitation", { p_business: ws, p_email: String(f.get("email") ?? ""), p_role: String(f.get("role")), p_token: token });
    error = e?.message;
    // Only a hash is stored. The link is shown once, and email delivery is a provider integration still to be wired.
    if (!e) note = `/invite/${token}`;
  } else if (what === "revoke") error = (await supabase.rpc("revoke_invitation", { p_invitation: String(f.get("id")) })).error?.message;
  else if (what === "suspend") error = (await supabase.rpc("suspend_member", { p_membership: String(f.get("id")) })).error?.message;
  back(`/w/${ws}/team${note ? `?link=${encodeURIComponent(note)}` : ""}`, error);
}

export default async function Team({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string; link?: string }> }) {
  const [{ ws }, { error, link }] = await Promise.all([params, searchParams]);
  const role = await myRole(ws);
  const supabase = await db();
  const isOwner = role === "owner";
  const [{ data: ms }, { data: inv }, { data: audit }] = await Promise.all([
    supabase.from("memberships").select("id, role, status, user_id").eq("business_id", ws),
    isOwner ? supabase.from("invitations").select("id, email, role, expires_at, accepted_at, revoked_at").eq("business_id", ws).order("created_at", { ascending: false }) : Promise.resolve({ data: [] }),
    ["owner", "manager"].includes(role ?? "") ? supabase.from("audit_log").select("id, table_name, action, at").eq("business_id", ws).order("id", { ascending: false }).limit(15) : Promise.resolve({ data: [] }),
  ]);
  const { data: profs } = await supabase.from("profiles").select("id, email, full_name").in("id", (ms ?? []).map((m) => m.user_id));
  const who = new Map((profs ?? []).map((p) => [p.id, p.full_name || p.email]));
  const h = (what: string, extra: Record<string, string> = {}) => <Hidden fields={{ ws, what, ...extra }} />;
  return (
    <>
      <h1 className="text-xl font-semibold">Team and access</h1>
      <ErrorNote error={error} />
      {link && <p role="status" className="mt-3 rounded-md border border-line bg-white p-3 text-sm">Invitation link (shown once — copy it now): <code className="break-all">{link}</code></p>}
      <table className={table}>
        <thead className="bg-canvas text-left text-muted"><tr><th className="p-3">Member</th><th>Role</th><th>Status</th><th /></tr></thead>
        <tbody>
          {(ms ?? []).map((m) => (
            <tr key={m.id} className="border-t border-line">
              <td className="p-3">{who.get(m.user_id) ?? m.user_id}</td><td>{m.role}</td><td>{m.status}</td>
              <td className="p-2">{isOwner && m.status === "active" && <form action={act}>{h("suspend", { id: m.id })}<button className={ghost}>Suspend</button></form>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {isOwner && (<>
        <form action={act} className={card}>{h("invite")}<h2 className="font-medium">Invite someone</h2>
          <label className="text-sm">Email<input name="email" type="email" required className={input} /></label>
          <label className="text-sm">Role<select name="role" className={input}><option value="staff">Staff</option><option value="manager">Manager</option><option value="owner">Owner</option><option value="customer">Client user</option></select></label>
          <button className={btn}>Create invitation</button></form>
        <ul className="mt-4 max-w-xl divide-y divide-line rounded-lg border border-line bg-white">
          {(inv ?? []).length === 0 && <li className="p-3 text-muted">No invitations.</li>}
          {(inv ?? []).map((i) => {
            const state = i.accepted_at ? "accepted" : i.revoked_at ? "revoked" : new Date(i.expires_at) < new Date() ? "expired" : "pending";
            return <li key={i.id} className="flex items-center justify-between p-3"><span>{i.email} · {i.role} · {state}</span>{state === "pending" && <form action={act}>{h("revoke", { id: i.id })}<button className={ghost}>Revoke</button></form>}</li>;
          })}
        </ul>
      </>)}
      {(audit ?? []).length > 0 && (<>
        <h2 className="mt-8 font-medium">Recent audit events</h2>
        <ul className="mt-2 max-w-xl text-sm text-muted">{(audit ?? []).map((a) => <li key={a.id}>{new Date(a.at).toLocaleString("en-IN")} · {a.action} {a.table_name}</li>)}</ul>
      </>)}
    </>
  );
}
