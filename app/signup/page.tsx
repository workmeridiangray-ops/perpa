import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

async function signUp(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: String(formData.get("email") ?? ""), password: String(formData.get("password") ?? ""),
    options: { data: { full_name: String(formData.get("name") ?? "") } },
  });
  if (error) redirect(`/signup?error=${encodeURIComponent(error.message)}`);
  // With email confirmation on there is no session yet: ask the person to verify first.
  redirect(data.session ? "/workspaces" : "/signup?sent=1");
}

export default async function SignUp({ searchParams }: { searchParams: Promise<{ error?: string; sent?: string }> }) {
  const { error, sent } = await searchParams;
  if (sent) return <main className="mx-auto max-w-sm px-4 py-16"><h1 className="text-xl font-semibold">Check your email</h1><p className="mt-2 text-muted">Confirm your address, then <Link className="underline" href="/login">sign in</Link>.</p></main>;
  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-xl font-semibold">Create your account</h1>
      {error && <p role="alert" className="mt-3 text-danger">{error}</p>}
      <form action={signUp} className="mt-4 space-y-4">
        <label className="block text-sm">Your name<input name="name" required autoComplete="name" className="mt-1 block w-full rounded-md border border-line bg-white px-3 py-2" /></label>
        <label className="block text-sm">Email<input name="email" type="email" required autoComplete="email" className="mt-1 block w-full rounded-md border border-line bg-white px-3 py-2" /></label>
        <label className="block text-sm">Password (12+ characters)<input name="password" type="password" required minLength={12} autoComplete="new-password" className="mt-1 block w-full rounded-md border border-line bg-white px-3 py-2" /></label>
        <button className="rounded-md bg-brand px-4 py-2 text-white">Create account</button>
      </form>
    </main>
  );
}
