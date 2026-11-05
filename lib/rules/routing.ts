export const PUBLIC_PATHS = ["/", "/login", "/signup", "/pricing"];
/** /api/* routes authenticate themselves (HMAC signature, API key or cron secret), so the session gate must not redirect them to /login. */
export const isPublicPath = (p: string): boolean => PUBLIC_PATHS.includes(p) || p.startsWith("/api/") || p.startsWith("/invite/");

/** Only same-site relative paths may be used as a post-login destination. */
export function safeNext(next: string | null | undefined, fallback = "/workspaces"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  return next;
}
