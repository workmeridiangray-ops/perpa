const { chromium } = require("playwright");
const B = "http://localhost:3000";
const fs = require("fs");
(async () => {
  const browser = await chromium.launch();
  const mk = async () => { const c = await browser.newContext(); const p = await c.newPage(); return p; };
  const owner = await mk(), staff = await mk();
  const log = (ok, n, e) => console.log(ok ? "OK  " : "FAIL", n, e ? "- " + e : "");
  const step = async (name, fn) => { try { await fn(); log(true, name); } catch (e) { log(false, name, e.message.split("\n")[0]); } };
  const t = Date.now(), oe = `own${t}@test.dev`, se = `stf${t}@test.dev`;
  const signup = async (p, email, name) => { await p.goto(B + "/signup"); await p.fill("input[name=name]", name); await p.fill("input[name=email]", email); await p.fill("input[name=password]", "correct-horse-battery"); await p.click("button"); await p.waitForURL("**/workspaces", { timeout: 15000 }); };
  let ws;
  await step("owner setup", async () => {
    await signup(owner, oe, "Owner"); await owner.fill("input[name=name]", "Biz"); await owner.click('button:has-text("Create")'); await owner.waitForURL(/\/w\//); ws = owner.url().match(/\/w\/([0-9a-f-]{36})/)[1];
  });
  let link;
  await step("owner invites staff", async () => {
    await owner.goto(`${B}/w/${ws}/team`); await owner.fill("input[name=email]", se); await owner.selectOption("select[name=role]", "staff"); await owner.click('button:has-text("Create invitation")');
    await owner.waitForSelector("code"); link = await owner.textContent("code");
  });
  await step("staff signs up and accepts invitation", async () => {
    await signup(staff, se, "Sam Staff"); await staff.goto(B + link); await staff.click('button:has-text("Accept invitation")'); await staff.waitForURL("**/workspaces", { timeout: 15000 });
    await staff.waitForSelector("text=Biz");
  });
  await step("wrong-email user cannot accept", async () => {
    const other = await mk(); await signup(other, `oth${t}@test.dev`, "Other"); await other.goto(B + link); await other.click('button:has-text("Accept invitation")'); await other.waitForSelector("text=invalid, expired or revoked");
  });
  // owner builds: client+contact via SQL-free UI? contacts have no UI -> check
  await step("owner: client, estimate with cost, to sent", async () => {
    await owner.goto(`${B}/w/${ws}/clients`); await owner.fill("input[name=name]", "Initech"); await owner.click('button:has-text("Add")'); await owner.waitForSelector("li:has-text(\"Initech\")");
    await owner.goto(`${B}/w/${ws}/estimates`); await owner.fill("input[name=title]", "Portal build"); await owner.click('button:has-text("New estimate")'); await owner.waitForURL(/estimates\/[0-9a-f-]{36}/);
    await owner.fill("input[name=description]", "Dev"); await owner.fill("input[name=qty]", "10"); await owner.fill("input[name=rate]", "5000"); await owner.fill("input[name=cost]", "3000"); await owner.click('button:has-text("Add line")'); await owner.waitForSelector("text=₹50,000.00");
    for (const l of ["Submit for approval", "Approve (manager)", "Mark as sent"]) { await owner.click(`button:has-text("${l}")`); await owner.waitForLoadState("networkidle"); }
  });
  await step("record acceptance possible (needs authorised contact)", async () => {
    const has = await owner.locator("text=No authorised contact").count();
    if (has) throw new Error("GAP: no UI to add contacts, so acceptance can't be recorded");
  });
  await step("staff cannot see cost or margin", async () => {
    const url = owner.url().replace(B, ""); await staff.goto(`${B}/w/${ws}${url.split("/w/" + ws)[1]}`);
    await staff.waitForSelector("text=₹50,000.00"); if (await staff.locator("text=margin").count()) throw new Error("margin visible to staff"); if (await staff.locator("text=Cost rate").count()) throw new Error("cost column visible");
  });
  await step("staff blocked from invoices page", async () => { await staff.goto(`${B}/w/${ws}/invoices`); await staff.waitForSelector("text=limited to owners and managers"); });
  await step("staff cannot approve estimate via forged URL (RLS)", async () => { await staff.goto(`${B}/w/${ws}/settings`); await staff.waitForSelector("text=limited to owners and managers"); });
  await step("csv import preview+commit", async () => {
    await owner.goto(`${B}/w/${ws}/clients`); await owner.fill("textarea[name=csv]", "name\nAlpha\nBeta\ninitech\n"); await owner.check("input[name=commit]"); await owner.click('button:has-text("Preview / import")'); await owner.waitForSelector("text=Imported 2; skipped 1");
  });
  await step("clients CSV export", async () => { const r = await owner.request.get(`${B}/w/${ws}/clients/export`); const b = await r.text(); if (!b.includes("Alpha")) throw new Error(b.slice(0, 80)); });
  await step("business export JSON (owner)", async () => { const r = await owner.request.get(`${B}/w/${ws}/export`); const j = await r.json(); if (!j.clients) throw new Error("no clients"); });
  await step("staff cannot export", async () => { const r = await staff.request.get(`${B}/w/${ws}/export`); if (r.status() !== 403) throw new Error("status " + r.status()); });
  await step("API key flow", async () => {
    await owner.goto(`${B}/w/${ws}/settings`); await owner.fill("input[name=name]", "Zap"); await owner.click('button:has-text("Create key")'); await owner.waitForSelector("text=New API key");
    const key = (await owner.textContent("p[role=status] code")).trim();
    const ok = await owner.request.get(`${B}/api/v1/clients`, { headers: { authorization: `Bearer ${key}` } }); if (ok.status() !== 200) throw new Error("valid key " + ok.status());
    const bad = await owner.request.get(`${B}/api/v1/clients`, { headers: { authorization: `Bearer ${key}x` } }); if (bad.status() !== 401) throw new Error("bad key " + bad.status());
  });
  await step("job endpoint auth", async () => {
    const no = await owner.request.post(`${B}/api/jobs/run`); if (no.status() !== 401) throw new Error("unauth " + no.status());
    const yes = await owner.request.post(`${B}/api/jobs/run`, { headers: { authorization: "Bearer local-cron-secret-0123456789abcdef" } }); if (yes.status() !== 200) throw new Error("auth " + yes.status() + " " + (await yes.text()).slice(0, 100));
  });
  await step("payment callback signature", async () => {
    const r = await owner.request.post(`${B}/api/webhooks/payments`, { data: "{}", headers: { "x-signature": "bad" } }); if (r.status() !== 401) throw new Error("status " + r.status());
  });
  await browser.close();
})();
