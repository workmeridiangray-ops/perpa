import Link from "next/link";
import { redirect } from "next/navigation";
import { safeNext } from "@/lib/rules/routing";
import { createClient } from "@/lib/supabase/server";

async function signIn(formData: FormData) {
  "use server";
  const next = safeNext(String(formData.get("next") ?? ""));
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: String(formData.get("email") ?? ""), password: String(formData.get("password") ?? "") });
  if (error) redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  redirect(next);
}

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-xl font-semibold">Sign in</h1>
      {error && <p role="alert" className="mt-3 text-danger">Email or password is incorrect.</p>}
      <form action={signIn} className="mt-4 space-y-4">
        <input type="hidden" name="next" value={next ?? ""} />
        <label className="block text-sm">Email<input name="email" type="email" required autoComplete="email" className="mt-1 block w-full rounded-md border border-line bg-white px-3 py-2" /></label>
        <label className="block text-sm">Password<input name="password" type="password" required autoComplete="current-password" className="mt-1 block w-full rounded-md border border-line bg-white px-3 py-2" /></label>
        <button className="rounded-md bg-brand px-4 py-2 text-white">Sign in</button>
      </form>
      <p className="mt-4 text-sm text-muted">New here? <Link className="underline" href="/signup">Create an account</Link></p>
    </main>
  );
}
