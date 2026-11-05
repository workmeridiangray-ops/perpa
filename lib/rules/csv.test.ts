import { describe, expect, it } from "vitest";
import { parseCsv, previewClientImport, toCsv } from "./csv";
import { checkUpload } from "./uploads";
import { summarize } from "./profit";

describe("csv", () => {
  it("parses quotes, escaped quotes and embedded newlines", () => {
    expect(parseCsv('name,note\r\n"Acme, Inc","say ""hi""\nbye"\n')).toEqual([["name", "note"], ["Acme, Inc", 'say "hi"\nbye']]);
  });
  it("previews a client import: errors by line, duplicates, existing names", () => {
    const p = previewClientImport("Name\nAcme\n\n  acme  \nBeta\n,x\nZed", ["zed"]);
    expect(p.valid.map((v) => v.name)).toEqual(["Acme", "Beta"]);
    expect(p.errors.map((e) => e.line)).toEqual([3, 5, 6]) // row numbers, blank rows not counted;
  });
  it("requires a name header", () => {
    expect(previewClientImport("title\nx", []).errors[0]?.message).toMatch(/name/);
  });
  it("neutralises spreadsheet formulas on export", () => {
    expect(toCsv([["=SUM(A1)", 5, null, 'a"b']])).toBe("'=SUM(A1),5,,\"a\"\"b\"\r\n");
  });
});

describe("uploads", () => {
  it("accepts a matching pdf and rejects svg, mismatches, empty and oversize", () => {
    expect(checkUpload({ name: "a.pdf", type: "application/pdf", size: 10 })).toBeNull();
    expect(checkUpload({ name: "a.svg", type: "image/svg+xml", size: 10 })).not.toBeNull();
    expect(checkUpload({ name: "a.exe", type: "application/pdf", size: 10 })).not.toBeNull();
    expect(checkUpload({ name: "a.pdf", type: "application/pdf", size: 0 })).not.toBeNull();
    expect(checkUpload({ name: "a.pdf", type: "application/pdf", size: 11 * 1024 * 1024 })).not.toBeNull();
  });
});

describe("profit summary", () => {
  it("keeps committed cost out of actual and labels margins", () => {
    const s = summarize({ estimated_revenue_paise: 1_000_000, estimated_cost_paise: 600_000, committed_open_paise: 100_000, actual_labour_paise: 300_000, actual_expense_paise: 50_000, actual_supplier_paise: 50_000, invoiced_paise: 500_000, collected_paise: 200_000 });
    expect(s.actualCost).toBe(400_000);
    expect(s.forecastCost).toBe(500_000);
    expect(s.estimatedMarginBps).toBe(4000);
    expect(s.billedMarginBps).toBe(2000);
    expect(s.forecastMarginBps).toBe(5000);
    expect(s.unbilled).toBe(500_000);
    expect(s.outstanding).toBe(300_000);
  });
  it("returns null margins when revenue is zero", () => {
    expect(summarize({ estimated_revenue_paise: 0, estimated_cost_paise: 0, committed_open_paise: 0, actual_labour_paise: 0, actual_expense_paise: 0, actual_supplier_paise: 0, invoiced_paise: 0, collected_paise: 0 }).billedMarginBps).toBeNull();
  });
});
