import { describe, expect, it } from "vitest";
import { applyBps, divRound, formatINR } from "./money";

describe("money", () => {
  it("rounds half away from zero", () => {
    expect(divRound(5, 2)).toBe(3);
    expect(divRound(-5, 2)).toBe(-3);
    expect(divRound(4, 3)).toBe(1);
  });
  it("applies basis points", () => {
    expect(applyBps(100_000, 1250)).toBe(12_500);
    expect(applyBps(1, 5000)).toBe(1); // 0.5 paise rounds up
  });
  it("formats INR with lakh grouping", () => {
    expect(formatINR(320000000)).toBe("₹32,00,000.00");
  });
  it("rejects unsafe integers", () => {
    expect(() => applyBps(Number.MAX_SAFE_INTEGER + 2, 1)).toThrow();
  });
});
