import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/** Membership is enforced by RLS: a business the user does not belong to simply returns no row. */
export default async function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(ws)) notFound();
  const supabase = await createClient();
  const { data: business } = await supabase.from("businesses").select("id, name").eq("id", ws).maybeSingle();
  if (!business) notFound();
  const nav = [["Clients", "clients"], ["Briefs", "briefs"], ["Estimates", "estimates"], ["Projects", "projects"], ["Timesheet", "time"]] as const;
  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-line bg-white p-4 md:w-56 md:border-b-0 md:border-r">
        <div className="font-semibold">{business.name}</div>
        <Link href="/workspaces" className="text-sm text-muted underline">Switch business</Link>
        <nav aria-label="Main" className="mt-4 flex gap-4 md:flex-col md:gap-1">
          {nav.map(([label, path]) => (
            <Link key={path} href={`/w/${ws}/${path}`} className="rounded-md px-2 py-1 hover:bg-canvas">{label}</Link>
          ))}
        </nav>
      </aside>
      <main className="flex-1 p-4 md:p-8">{children}</main>
    </div>
  );
}
