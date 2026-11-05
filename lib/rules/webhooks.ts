import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 hex signature over the raw body. Used both to sign outgoing webhooks and verify incoming callbacks. */
export const sign = (secret: string, body: string): string => createHmac("sha256", secret).update(body).digest("hex");

export function verifySignature(secret: string, body: string, provided: string | null | undefined): boolean {
  if (!secret || !provided) return false;
  const a = Buffer.from(sign(secret, body)), b = Buffer.from(provided.replace(/^sha256=/, ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./];
/** Reject URLs that would let a customer make our servers call internal addresses (SSRF). Literal-host check only; DNS-rebinding needs egress filtering at the network layer. */
export function checkWebhookUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "Not a valid URL."; }
  if (u.protocol !== "https:") return "Webhook URLs must use https.";
  if (u.username || u.password) return "Credentials in the URL are not allowed.";
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return "Internal hostnames are not allowed.";
  if (h.startsWith("[") || h.includes(":")) return "IPv6 literals are not allowed.";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) && PRIVATE_V4.some((r) => r.test(h))) return "Private addresses are not allowed.";
  if (/^\d+$/.test(h)) return "Numeric hosts are not allowed.";
  return null;
}
