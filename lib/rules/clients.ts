/** Matches the database's generated clients.name_norm. */
export const normalizeName = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

export function findDuplicateClient<T extends { name: string; archived?: boolean }>(existing: T[], candidate: string): T | undefined {
  const n = normalizeName(candidate);
  return existing.find((c) => !c.archived && normalizeName(c.name) === n);
}
