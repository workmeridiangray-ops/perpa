import { describe, expect, it } from "vitest";
import { checkWebhookUrl, sign, verifySignature } from "./webhooks";
import { cell, dayCapacity, daysFrom } from "./capacity";

describe("signatures", () => {
  it("verifies a correct signature (with or without prefix) and rejects tampering", () => {
    const sig = sign("secret", '{"a":1}');
    expect(verifySignature("secret", '{"a":1}', sig)).toBe(true);
    expect(verifySignature("secret", '{"a":1}', `sha256=${sig}`)).toBe(true);
    expect(verifySignature("secret", '{"a":2}', sig)).toBe(false);
    expect(verifySignature("other", '{"a":1}', sig)).toBe(false);
    expect(verifySignature("secret", "x", null)).toBe(false);
    expect(verifySignature("", "x", sig)).toBe(false);
  });
});

describe("webhook URL safety", () => {
  it.each([["http://example.com/h"], ["https://localhost/h"], ["https://127.0.0.1/h"], ["https://10.1.2.3/h"], ["https://192.168.0.5/h"], ["https://172.20.1.1/h"], ["https://169.254.169.254/latest"], ["https://[::1]/h"], ["https://user:pw@example.com/"], ["https://db.internal/h"], ["not a url"], ["https://2130706433/h"]])("rejects %s", (u) => {
    expect(checkWebhookUrl(u)).not.toBeNull();
  });
  it("accepts a public https URL", () => { expect(checkWebhookUrl("https://hooks.example.com/perpa")).toBeNull(); });
});

describe("capacity grid", () => {
  const r = { id: "r", dailyMinutes: 480, weeklyMinutes: null };
  it("uses Mon–Fri by default, honours patterns and approved leave only", () => {
    expect(dayCapacity(r, [], "2026-12-04")).toBe(480); // Friday
    expect(dayCapacity(r, [], "2026-12-05")).toBe(0);   // Saturday
    expect(dayCapacity({ ...r, weeklyMinutes: [240, 240, 240, 240, 0, 0, 0] }, [], "2026-12-04")).toBe(0);
    const lv = (status: string) => [{ resourceId: "r", startsOn: "2026-12-04", endsOn: "2026-12-04", status }];
    expect(dayCapacity(r, lv("approved"), "2026-12-04")).toBe(0);
    expect(dayCapacity(r, lv("requested"), "2026-12-04")).toBe(480);
  });
  it("reports tentative vs confirmed load and overbooking", () => {
    const b = (status: "tentative" | "confirmed", m: number) => ({ resourceId: "r", startsOn: "2026-12-01", endsOn: "2026-12-01", minutesPerDay: m, status });
    expect(cell(r, [], [b("tentative", 200)], "2026-12-01").state).toBe("ok");
    expect(cell(r, [], [b("confirmed", 480)], "2026-12-01").state).toBe("full");
    expect(cell(r, [], [b("confirmed", 500)], "2026-12-01").state).toBe("over");
    expect(cell(r, [], [], "2026-12-05").state).toBe("off");
    expect(cell(r, [], [], "2026-12-01").state).toBe("free");
  });
  it("lists consecutive days", () => { expect(daysFrom("2026-12-30", 3)).toEqual(["2026-12-30", "2026-12-31", "2027-01-01"]); });
});
