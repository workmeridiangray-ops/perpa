#!/usr/bin/env node
/**
 * Malware scanner worker for Perpa.
 *
 * Polls for files with scan_status = 'pending', downloads each from private storage, scans it with clamd,
 * and reports the result by calling the app's signed callback (/api/webhooks/scan). A file is only ever
 * marked "clean" when clamd answered OK; any error leaves it pending so it stays unshareable and is retried.
 */
import { createHmac } from "node:crypto";
import { MAX_BYTES, ping, scanBuffer } from "./clamd.mjs";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  supabaseUrl: env("SUPABASE_URL"),
  serviceKey: env("SUPABASE_SERVICE_ROLE_KEY"),
  appUrl: env("APP_URL"),
  secret: env("SCAN_WEBHOOK_SECRET"),
  clamd: { host: env("CLAMD_HOST", "127.0.0.1"), port: Number(env("CLAMD_PORT", "3310")) },
  pollMs: Number(env("POLL_SECONDS", "10")) * 1000,
  batch: Number(env("BATCH_SIZE", "20")),
  bucket: env("STORAGE_BUCKET", "deliverables"),
};

const log = (level, msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));
const sign = (body) => createHmac("sha256", cfg.secret).update(body).digest("hex");

export async function pending() {
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/files?scan_status=eq.pending&select=id,path,size_bytes&order=created_at.asc&limit=${cfg.batch}`, {
    headers: { apikey: cfg.serviceKey, authorization: `Bearer ${cfg.serviceKey}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`listing pending files failed: ${res.status}`);
  return res.json();
}

async function download(path) {
  const res = await fetch(`${cfg.supabaseUrl}/storage/v1/object/${cfg.bucket}/${path.split("/").map(encodeURIComponent).join("/")}`, {
    headers: { apikey: cfg.serviceKey, authorization: `Bearer ${cfg.serviceKey}` }, signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) throw new Error("object exceeds the scan size limit");
  return Buffer.from(await res.arrayBuffer());
}

async function report(fileId, status) {
  const body = JSON.stringify({ file_id: fileId, status });
  const res = await fetch(`${cfg.appUrl}/api/webhooks/scan`, { method: "POST", body, headers: { "content-type": "application/json", "x-signature": sign(body) }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`callback answered ${res.status}`);
}

/** Scan one batch. Returns counts. Exported for tests. */
export async function runOnce() {
  const counts = { clean: 0, infected: 0, deferred: 0 };
  for (const f of await pending()) {
    try {
      const result = await scanBuffer(await download(f.path), cfg.clamd);
      if (result.status === "error") throw new Error(result.detail);
      await report(f.id, result.status); // "clean" or "infected"
      counts[result.status]++;
      log(result.status === "infected" ? "warn" : "info", "scanned", { file: f.id, result: result.status, signature: result.status === "infected" ? result.detail : undefined });
    } catch (e) {
      counts.deferred++; // stays pending: unshareable and retried on the next poll
      log("error", "scan deferred", { file: f.id, error: e.message });
    }
  }
  return counts;
}

async function main() {
  for (const k of ["supabaseUrl", "serviceKey", "appUrl", "secret"]) if (!cfg[k]) { console.error(`Missing configuration: ${k}`); process.exit(2); }
  log("info", "scanner starting", { clamd: cfg.clamd, poll_seconds: cfg.pollMs / 1000 });
  const once = process.argv.includes("--once");
  for (;;) {
    if (!(await ping(cfg.clamd))) log("error", "clamd is not answering; files stay pending");
    else { try { const c = await runOnce(); if (c.clean + c.infected + c.deferred > 0) log("info", "batch done", c); } catch (e) { log("error", "batch failed", { error: e.message }); } }
    if (once) return;
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
