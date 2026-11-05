import { describe, expect, it } from "vitest";
import { resolveRate } from "./rates";

const e = [
  { roleLabel: "Designer", ratePaise: 400_000, effectiveFrom: "2026-01-01" },
  { roleLabel: "Designer", ratePaise: 450_000, effectiveFrom: "2026-07-01" },
  { roleLabel: "Dev", ratePaise: 500_000, effectiveFrom: "2026-03-01" },
];
describe("resolveRate", () => {
  it("uses the rate in force on the date, not the latest", () => {
    expect(resolveRate(e, "Designer", "2026-06-30")).toBe(400_000);
    expect(resolveRate(e, "Designer", "2026-07-01")).toBe(450_000);
  });
  it("returns null before any rate applies or for unknown roles", () => {
    expect(resolveRate(e, "Dev", "2026-02-28")).toBeNull();
    expect(resolveRate(e, "PM", "2026-12-31")).toBeNull();
  });
});
