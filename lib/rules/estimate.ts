import { applyBps, assertPaise, divRound, type Paise } from "./money";

export type EstimateLine = {
  kind: "labour" | "external";
  /** labour: hours x 100. external: ignored. */
  hoursCenti?: number;
  /** external: units x 100 (default 100 = one unit). */
  quantityCenti?: number;
  /** customer rate per hour (labour) or per unit (external), paise. */
  ratePaise: Paise;
  /** internal cost per hour / unit, paise. Optional: absent when the caller may not see costs. */
  costRatePaise?: Paise;
};

export type EstimateTotals = {
  subtotal: Paise;
  discount: Paise;
  total: Paise;
  /** null when any line lacks a cost assumption (never present a partial margin as complete). */
  internalCost: Paise | null;
  /** margin on discounted total, in basis points; null when cost unknown or total is zero. */
  marginBps: number | null;
};

function units(l: EstimateLine): number {
  const u = l.kind === "labour" ? l.hoursCenti : (l.quantityCenti ?? 100);
  if (u === undefined || !Number.isInteger(u) || u <= 0) throw new RangeError("line quantity must be a positive integer (x100)");
  return u;
}

export const lineAmount = (l: EstimateLine): Paise => divRound(units(l) * assertPaise(l.ratePaise), 100);
export const lineCost = (l: EstimateLine): Paise | null =>
  l.costRatePaise === undefined ? null : divRound(units(l) * assertPaise(l.costRatePaise), 100);

export function computeEstimate(lines: EstimateLine[], discountBps: number): EstimateTotals {
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10_000) throw new RangeError("discount must be 0..10000 bps");
  const subtotal = lines.reduce((s, l) => s + lineAmount(l), 0);
  const discount = applyBps(subtotal, discountBps);
  const total = subtotal - discount;
  const costs = lines.map(lineCost);
  const internalCost = lines.length > 0 && costs.every((c) => c !== null) ? costs.reduce<number>((s, c) => s + (c ?? 0), 0) : null;
  const marginBps = internalCost === null || total === 0 ? null : divRound((total - internalCost) * 10_000, total);
  return { subtotal, discount, total, internalCost, marginBps };
}
