import { describe, expect, it } from "vitest";
import { computeEstimate } from "./estimate";

const lab = (h: number, rate: number, cost?: number) => ({ kind: "labour" as const, hoursCenti: h, ratePaise: rate, costRatePaise: cost });

describe("computeEstimate", () => {
  it("totals labour and external lines with discount and margin", () => {
    const t = computeEstimate(
      [lab(1050, 500_000, 300_000), { kind: "external", ratePaise: 2_000_000, costRatePaise: 1_500_000 }],
      1000,
    );
    // 10.5h x 5000.00 = 52,500.00 ; + 20,000.00 = 72,500.00
    expect(t.subtotal).toBe(7_250_000);
    expect(t.discount).toBe(725_000);
    expect(t.total).toBe(6_525_000);
    // cost = 31,500 + 15,000 = 46,500.00 ; margin = (65,250-46,500)/65,250
    expect(t.internalCost).toBe(4_650_000);
    expect(t.marginBps).toBe(2874);
  });
  it("does not report a margin when any line lacks a cost assumption", () => {
    const t = computeEstimate([lab(100, 100_000, 50_000), lab(100, 100_000)], 0);
    expect(t.internalCost).toBeNull();
    expect(t.marginBps).toBeNull();
  });
  it("rejects bad quantities and discounts", () => {
    expect(() => computeEstimate([lab(0, 1)], 0)).toThrow();
    expect(() => computeEstimate([lab(100, 1)], 10_001)).toThrow();
  });
  it("handles an empty estimate", () => {
    expect(computeEstimate([], 0)).toEqual({ subtotal: 0, discount: 0, total: 0, internalCost: null, marginBps: null });
  });
});
