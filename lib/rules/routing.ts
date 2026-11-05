export const PUBLIC_PATHS = ["/", "/login", "/signup", "/pricing"];
export const isPublicPath = (p: string): boolean => PUBLIC_PATHS.includes(p);

/** Only same-site relative paths may be used as a post-login destination. */
export function safeNext(next: string | null | undefined, fallback = "/workspaces"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  return next;
}
