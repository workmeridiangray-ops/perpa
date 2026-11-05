/** Money is integer paise. Never floats. */
export type Paise = number;

export function assertPaise(n: number): Paise {
  if (!Number.isSafeInteger(n)) throw new RangeError(`not a safe integer amount: ${n}`);
  return n;
}

/** Round half away from zero for a/b where b > 0. */
export function divRound(a: number, b: number): number {
  if (b <= 0) throw new RangeError("divisor must be positive");
  const q = Math.abs(a) / b;
  const r = Math.floor(q + 0.5);
  return a < 0 ? -r : r;
}

/** amount x (bps / 10000), rounded half-up. */
export function applyBps(amount: Paise, bps: number): Paise {
  return divRound(assertPaise(amount) * bps, 10_000);
}

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });
export function formatINR(p: Paise): string {
  return inr.format(p / 100);
}
