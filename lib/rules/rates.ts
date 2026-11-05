export type RateEntry = { roleLabel: string; ratePaise: number; effectiveFrom: string }; // ISO date

/** Rate in force on `asOf` (ISO date): latest entry with effectiveFrom <= asOf. Null if none yet. */
export function resolveRate(entries: RateEntry[], roleLabel: string, asOf: string): number | null {
  let best: RateEntry | undefined;
  for (const e of entries) {
    if (e.roleLabel !== roleLabel || e.effectiveFrom > asOf) continue;
    if (!best || e.effectiveFrom > best.effectiveFrom) best = e;
  }
  return best ? best.ratePaise : null;
}
