import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

async function accept(f: FormData) {
  "use server";
  const token = String(f.get("token"));
  const { data, error } = await (await createClient()).rpc("accept_invitation", { p_token: token });
  if (error || !data) redirect(`/invite/${encodeURIComponent(token)}?error=${encodeURIComponent(error?.message ?? "Invalid invitation")}`);
  redirect("/workspaces");
}

export default async function Invite({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ token }, { error }] = await Promise.all([params, searchParams]);
  const { data: { user } } = await (await createClient()).auth.getUser();
  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-xl font-semibold">Join a workspace</h1>
      {error && <p role="alert" className="mt-3 text-danger">{error}</p>}
      {user ? (
        <form action={accept} className="mt-4"><input type="hidden" name="token" value={token} /><p className="text-sm text-muted">Signed in as {user.email}. The invitation must have been sent to this address.</p><button className="mt-3 rounded-md bg-brand px-4 py-2 text-white">Accept invitation</button></form>
      ) : <p className="mt-3">Please <Link className="underline" href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>sign in</Link> or <Link className="underline" href="/signup">create an account</Link> with the invited email first.</p>}
    </main>
  );
}
