import Link from "next/link";

const features = [
  ["Briefs to estimates", "Capture briefs, build versioned estimates with internal cost kept private, and record acceptance by an authorised contact."],
  ["Delivery and capacity", "Projects, change control, tentative and confirmed bookings, and approved timesheets."],
  ["Billing and margin", "Fixed, milestone, time and retainer invoices with no double billing, plus estimated, committed and actual cost."],
  ["Client portal", "Clients review specific proof versions, approve or request changes, and see only what you share."],
] as const;

export default function Home() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-16">
      <h1 className="text-3xl font-semibold">Perpa</h1>
      <p className="mt-2 max-w-prose text-muted">The ERP for agencies, studios, software firms and consultancies: from client brief to profitability report.</p>
      <div className="mt-6 flex gap-3">
        <Link href="/signup" className="rounded-md bg-brand px-4 py-2 text-white">Start free trial</Link>
        <Link href="/pricing" className="rounded-md border border-line bg-white px-4 py-2">Pricing</Link>
        <Link href="/login" className="px-4 py-2 underline">Sign in</Link>
      </div>
      <div className="mt-12 grid gap-4 md:grid-cols-2">
        {features.map(([t, d]) => <section key={t} className="rounded-lg border border-line bg-white p-4"><h2 className="font-medium">{t}</h2><p className="mt-1 text-sm text-muted">{d}</p></section>)}
      </div>
    </main>
  );
}
