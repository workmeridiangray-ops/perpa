import { describe, expect, it } from "vitest";
import { can } from "./permissions";

describe("permissions", () => {
  it("keeps cost rates and approval away from staff", () => {
    expect(can("staff", "rate.cost.read")).toBe(false);
    expect(can("staff", "estimate.approve")).toBe(false);
    expect(can("manager", "estimate.approve")).toBe(true);
  });
  it("gives customers nothing internal and unknown roles nothing", () => {
    expect(can("customer", "client.read")).toBe(false);
    expect(can(null, "client.read")).toBe(false);
  });
  it("reserves member management for owners", () => {
    expect(can("manager", "member.manage")).toBe(false);
    expect(can("owner", "member.manage")).toBe(true);
  });
});
