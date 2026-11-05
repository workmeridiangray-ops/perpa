import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Mfa } from "./mfa";

export default async function Security({ searchParams }: { searchParams: Promise<{ need?: string }> }) {
  const { need } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/security");
  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <h1 className="text-xl font-semibold">Account security</h1>
      {need === "platform" && <p role="alert" className="mt-3 text-danger">Platform administration needs a verified second factor.</p>}
      <p className="mt-2 text-sm text-muted">Use an authenticator app (TOTP) as a second step when you sign in.</p>
      <Mfa />
    </main>
  );
}
