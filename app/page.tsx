import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-2xl font-semibold">Perpa</h1>
      <p className="mt-2 text-muted">Briefs to estimates to engagements for agencies, studios and consultancies.</p>
      <Link href="/login" className="mt-6 inline-block rounded-md bg-brand px-4 py-2 text-white">Sign in</Link>
    </main>
  );
}
