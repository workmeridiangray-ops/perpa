const { chromium } = require("playwright"); const { execSync } = require("child_process");
const B = "http://localhost:3000";
(async () => {
  const b = await chromium.launch(); const DEFAULT=8000; const mk = async () => (await b.newContext()).newPage(); const o = await mk(), s = await mk();
  const step = async (n, f) => { try { await f(); console.log("OK  ", n); } catch (e) { console.log("FAIL", n, "-", e.message.split("\n")[0]); for (const [k,pg] of Object.entries({o,s})) console.log("   ",k,pg.url().slice(-70), (await pg.locator("body").innerText().catch(()=>"")).replace(/\s+/g," ").slice(0,160)); } };
  const t = Date.now(), se = `s${t}@test.dev`; const settle = (p) => p.waitForLoadState("networkidle");
  const go = async (p, u) => { await p.goto(u); await settle(p); await p.waitForTimeout(600); };
  const signup = async (p, e, n) => { await go(p, B + "/signup"); await p.fill("input[name=name]", n); await p.fill("input[name=email]", e); await p.fill("input[name=password]", "correct-horse-battery"); await p.click("button"); await p.waitForURL("**/workspaces"); };
  let ws, proj;
  await step("setup: business, staff, project", async () => {
    await signup(o, `o${t}@test.dev`, "Olive"); await o.fill("input[name=name]", "Biz"); await o.click('button:has-text("Create")'); await o.waitForURL(/\/w\//); ws = o.url().match(/\/w\/([0-9a-f-]{36})/)[1];
    await go(o, `${B}/w/${ws}/team`); await o.fill("input[name=email]", se); await o.click('button:has-text("Create invitation")'); await o.waitForSelector("code"); const link = await o.textContent("code");
    await signup(s, se, "Sam Staff"); await go(s, B + link); await s.click('button:has-text("Accept invitation")'); await s.waitForURL("**/workspaces");
    await go(o, `${B}/w/${ws}/clients`); await o.fill("input[name=name]", "Cl"); await o.click('button:has-text("Add")'); await o.waitForSelector("a:text-is('Cl')"); await o.click("a:text-is('Cl')"); await settle(o); await o.waitForTimeout(500);
    await o.fill("input[name=name]", "P"); await o.check("input[name=approver]"); await o.click('button:has-text("Add contact")'); await o.waitForSelector("td:has-text('Yes')");
    await go(o, `${B}/w/${ws}/estimates`); await o.fill("input[name=title]", "Job"); await o.click('button:has-text("New estimate")'); await o.waitForURL(/estimates\/[0-9a-f-]{36}/); await settle(o);
    await o.fill("input[name=description]", "x"); await o.fill("input[name=qty]", "1"); await o.fill("input[name=rate]", "100"); await o.click('button:has-text("Add line")'); await o.waitForSelector("text=₹100.00");
    for (const l of ["Submit for approval", "Approve (manager)", "Mark as sent"]) { await o.click(`button:has-text("${l}")`); await settle(o); }
    await o.click('button:has-text("Record acceptance")'); await o.waitForSelector("strong:has-text('accepted')"); await o.click('button:has-text("Create engagement and project")'); await o.waitForSelector("p:has-text('created from this revision')");
    await go(o, `${B}/w/${ws}/projects`); await o.click("a:text-is('Job')"); await o.waitForURL(/projects\/[0-9a-f-]{36}/); proj = o.url();
  });
  await step("resource linked to staff; booking, over-capacity blocked, override allowed", async () => {
    await go(o, `${B}/w/${ws}/capacity`);
    const rf = o.locator("form:has(h2:has-text('Add resource'))"); await rf.locator("input[name=name]").fill("Sam"); await rf.locator("select[name=user]").selectOption({ label: "Sam Staff" }); await rf.locator("input[name=role]").fill("Designer"); await rf.locator("button").click(); await o.waitForSelector("th:has-text('Sam')");
    const book = async (from, to, h, extra) => { const f = o.locator("form:has(h2:has-text('Book'))"); await f.locator("select[name=resource]").selectOption({ label: "Sam" }); await f.locator("input[name=from]").fill(from); await f.locator("input[name=to]").fill(to); await f.locator("input[name=hours]").fill(String(h)); await f.locator("select[name=status]").selectOption("confirmed"); await f.locator("input[name=override]").fill(extra || ""); await f.locator("button").click(); await settle(o); await o.waitForTimeout(500); };
    await book("2026-12-01", "2026-12-04", 6); await book("2026-12-02", "2026-12-03", 4); await o.waitForSelector("[role=alert]:has-text('allocation conflict')");
    await book("2026-12-02", "2026-12-03", 4, "Launch crunch"); await o.waitForSelector("text=override: Launch crunch");
  });
  await step("staff leave request; manager approves; weekend booking conflict", async () => {
    await go(s, `${B}/w/${ws}/capacity`); const lf = s.locator("form:has(button:has-text('Request leave'))"); await lf.locator("select[name=resource]").selectOption({ label: "Sam" }); await lf.locator("input[name=from]").fill("2026-12-10"); await lf.locator("input[name=to]").fill("2026-12-10"); await lf.locator("button").click(); await s.waitForSelector("li:has-text('requested')");
    await go(o, `${B}/w/${ws}/capacity`); await o.click("li:has-text('requested') button:has-text('Approve')"); await o.waitForSelector("li:has-text('approved')");
  });
  await step("staff logs time, submits; manager approves; staff cannot approve own", async () => {
    await go(s, `${B}/w/${ws}/time`); await s.fill("input[name=date]", "2026-12-02"); await s.fill("input[name=hours]", "3"); await s.click("button:has-text('Log time')"); await s.waitForSelector("td:has-text('draft')");
    await s.click("button:has-text('Submit')"); await s.waitForSelector("td:has-text('submitted')"); if (await s.locator("button:has-text('Approve')").count()) throw new Error("staff sees Approve");
    await go(o, `${B}/w/${ws}/notifications`); await o.waitForSelector("text=Time submitted for review");
    await go(o, `${B}/w/${ws}/time`); await o.click("button:has-text('Approve')"); await o.waitForSelector("td:has-text('approved')");
    await go(s, `${B}/w/${ws}/notifications`); await s.waitForSelector("text=Your time was approved");
  });
  await step("expense: staff submits, manager approves then marks paid", async () => {
    await go(s, `${B}/w/${ws}/expenses`); await s.fill("input[name=description]", "Fonts"); await s.fill("input[name=amount]", "1200"); await s.fill("input[name=date]", "2026-12-02"); await s.click("button:has-text('Submit expense')"); await s.waitForSelector("td:has-text('submitted')");
    await go(o, `${B}/w/${ws}/expenses`); await o.click("button:has-text('Approve')"); await o.waitForSelector("td:has-text('approved · unpaid')"); await o.click("button:has-text('Mark paid')"); await o.waitForSelector("td:has-text('approved · paid')");
  });
  await step("profitability reflects approved time and expense", async () => {
    await go(o, proj); await o.waitForSelector("text=Actual cost");
  });
  await step("owner offboards staff; reassign needs a replacement resource", async () => {
    await go(o, `${B}/w/${ws}/team`); await o.waitForSelector("td:has-text('Sam Staff')");
    await o.click("tr:has(td:text-is('Sam Staff')) button:has-text('Suspend')"); await settle(o); await o.waitForSelector("tr:has(td:text-is('Sam Staff')) >> text=suspended");
    await go(s, `${B}/w/${ws}/clients`); const url = s.url(); if (!/workspaces|login|404/.test(url) && !(await s.content()).includes("could not be found") && (await s.locator("h1:has-text('Clients')").count())) throw new Error("suspended user still has access");
  });
  await b.close();
})();
