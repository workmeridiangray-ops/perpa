import { describe, expect, it } from "vitest";
import { findDuplicateClient, normalizeName } from "./clients";

describe("client duplicates", () => {
  it("ignores case and extra spaces", () => {
    expect(normalizeName("  Acme   Studio ")).toBe("acme studio");
    expect(findDuplicateClient([{ name: "Acme Studio" }], "acme  studio")).toBeDefined();
  });
  it("ignores archived clients", () => {
    expect(findDuplicateClient([{ name: "Acme", archived: true }], "Acme")).toBeUndefined();
  });
});
