"use client";
import { useState } from "react";
import { createBrowserClient } from "@supabase/ssr";

const field = "mt-1 block w-full rounded-md border border-line bg-white px-3 py-2";
export function Mfa() {
  const [msg, setMsg] = useState("");
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const supabase = () => createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

  async function start() {
    const { data, error } = await supabase().auth.mfa.enroll({ factorType: "totp" });
    if (error || !data) return setMsg(error?.message ?? "Could not start enrolment.");
    setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    setMsg("");
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault();
    const s = supabase();
    const factorId = enroll?.id ?? (await s.auth.mfa.listFactors()).data?.totp?.[0]?.id;
    if (!factorId) return setMsg("No authenticator is set up yet.");
    const ch = await s.auth.mfa.challenge({ factorId });
    if (ch.error) return setMsg(ch.error.message);
    const v = await s.auth.mfa.verify({ factorId, challengeId: ch.data.id, code });
    setMsg(v.error ? "That code was not accepted." : "Verified. You can continue.");
    if (!v.error) window.location.assign("/workspaces");
  }
  return (
    <div className="mt-4 max-w-sm space-y-4">
      {!enroll && <button onClick={start} className="rounded-md border border-line bg-white px-3 py-2">Set up an authenticator app</button>}
      {enroll && (
        <div className="space-y-2 text-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={enroll.qr} alt="QR code for your authenticator app" width={160} height={160} />
          <p>Or enter this key manually: <code className="break-all">{enroll.secret}</code></p>
        </div>)}
      <form onSubmit={verify} className="space-y-2">
        <label className="block text-sm">6-digit code<input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" pattern="[0-9]{6}" required className={field} /></label>
        <button className="rounded-md bg-brand px-4 py-2 text-white">Verify</button>
      </form>
      {msg && <p role="status" className="text-sm">{msg}</p>}
    </div>
  );
}
