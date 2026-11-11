const { chromium } = require("playwright");
const B = "http://localhost:3000";
(async () => {
  const browser = await chromium.launch();
  const mk = async () => (await browser.newContext()).newPage();
  const owner = await mk(), cust = await mk(), staff = await mk();
  const step = async (name, fn) => { try { await fn(); console.log("OK  ", name); } catch (e) { console.log("FAIL", name, "-", e.message.split("\n")[0]); } };
  const t = Date.now(), ce = `cus${t}@test.dev`, se = `stf${t}@test.dev`;
  const signup = async (p, email, name) => { await p.goto(B + "/signup"); await p.fill("input[name=name]", name); await p.fill("input[name=email]", email); await p.fill("input[name=password]", "correct-horse-battery"); await p.click("button"); await p.waitForURL("**/workspaces", { timeout: 15000 }); };
  const settle = (p) => p.waitForLoadState("networkidle");
  const go = async (p, u) => { await p.goto(u); await p.waitForLoadState("networkidle"); await p.waitForTimeout(600); };
  let ws, clientUrl, estUrl, projUrl;
  const warm = await mk(); await warm.goto(B + "/signup"); await warm.waitForLoadState("networkidle");
  await step("owner + business + client", async () => {
    await signup(owner, `own${t}@test.dev`, "Owner"); await owner.fill("input[name=name]", "Biz"); await owner.click('button:has-text("Create")'); await owner.waitForURL(/\/w\//); ws = owner.url().match(/\/w\/([0-9a-f-]{36})/)[1];
    await owner.fill("input[name=name]", "Initech"); await owner.click('button:has-text("Add")'); await owner.click("a:has-text('Initech')"); await owner.waitForURL(/clients\/[0-9a-f-]{36}/); clientUrl = owner.url();
  });
  await step("add authorised contact", async () => {
    await owner.fill("input[name=name]", "Priya"); await owner.check("input[name=approver]"); await owner.click('button:has-text("Add contact")'); await owner.waitForSelector("td:has-text('Yes')");
  });
  await step("estimate to sent, record acceptance, engagement+project", async () => {
    await go(owner, `${B}/w/${ws}/estimates`); await owner.fill("input[name=title]", "Portal build"); await owner.click('button:has-text("New estimate")'); await owner.waitForURL(/estimates\/[0-9a-f-]{36}/); estUrl = owner.url();
    await owner.fill("input[name=description]", "Dev"); await owner.fill("input[name=qty]", "10"); await owner.fill("input[name=rate]", "5000"); await owner.fill("input[name=cost]", "3000"); await owner.click('button:has-text("Add line")'); await owner.waitForSelector("text=₹50,000.00");
    for (const l of ["Submit for approval", "Approve (manager)", "Mark as sent"]) { await owner.click(`button:has-text("${l}")`); await settle(owner); }
    await owner.click('button:has-text("Record acceptance")'); await owner.waitForSelector("strong:has-text('accepted')");
    await owner.click('button:has-text("Create engagement and project")'); await settle(owner); await owner.waitForSelector("text=Engagement and project created");
  });
  await step("project page + financials", async () => {
    await go(owner, `${B}/w/${ws}/projects`); await owner.click("a:has-text('Portal build')"); await owner.waitForURL(/projects\/[0-9a-f-]{36}/); projUrl = owner.url();
    await owner.waitForSelector("text=Estimated revenue"); await owner.waitForSelector("text=₹50,000.00");
  });
  await step("customer invited, signs up, accepts", async () => {
    await go(owner, `${B}/w/${ws}/team`); await owner.fill("input[name=email]", ce); await owner.selectOption("select[name=role]", "customer"); await owner.click('button:has-text("Create invitation")'); await owner.waitForSelector("code");
    const link = await owner.textContent("code"); await signup(cust, ce, "Cara Client"); await go(cust, B + link); await cust.click('button:has-text("Accept invitation")'); await cust.waitForURL("**/workspaces");
  });
  await step("owner links customer to client", async () => {
    await go(owner, clientUrl); await owner.check("input[name=approve]"); await owner.check("input[name=finance]"); await owner.click('button:has-text("Link")'); await owner.waitForSelector("text=can approve proofs");
  });
  await step("customer sent to portal, sees project", async () => {
    await go(cust, `${B}/w/${ws}/clients`); await cust.waitForURL("**/portal"); await cust.waitForSelector("text=Portal build");
  });
  const addDeliv = async (name) => { await go(owner, projUrl); const f = owner.locator("form:has(input[name=name]):has(label:has-text('New deliverable'))"); await f.locator("input[name=name]").fill(name); await f.locator("button").click(); await settle(owner); await owner.waitForSelector(`li:has-text("${name}")`); };
  await step("owner shares a deliverable; customer approves it", async () => {
    await addDeliv("Logo"); await owner.locator("li:has-text('Logo') button:has-text('Share with client')").click(); await owner.waitForSelector("li:has-text('Logo') >> text=/^shared$/");
    await go(cust, B + "/portal"); await cust.waitForSelector("text=Logo"); await cust.locator("li:has-text('Logo') button:has-text('Approve')").click(); await settle(cust); await cust.waitForSelector("li:has-text('Logo') >> text=approved");
  });
  await step("customer requests change needs a comment", async () => {
    await addDeliv("Brochure"); await owner.locator("li:has-text('Brochure') button:has-text('Share with client')").click(); await owner.waitForSelector("li:has-text('Brochure') >> text=/^shared$/");
    await go(cust, B + "/portal"); await cust.locator("li:has-text('Brochure') button:has-text('Request changes')").click(); await settle(cust); await cust.waitForSelector("[role=alert]");
    await cust.fill("li:has-text('Brochure') input[name=comment]", "Use brand blue"); await cust.locator("li:has-text('Brochure') button:has-text('Request changes')").click(); await settle(cust); await cust.waitForSelector("text=Use brand blue");
  });
  await step("customer raises a ticket; staff see it; convert to change", async () => {
    await go(cust, B + "/portal"); await cust.selectOption("select[name=project]", { label: "Portal build" }); await cust.fill("input[name=title]", "Add blog"); await cust.click("button:has-text('Send request')"); await settle(cust);
    await go(owner, `${B}/w/${ws}/tickets`); await owner.waitForSelector("text=Add blog");
    await owner.fill("input[name=budget]", "20000"); await owner.fill("input[name=hours]", "8"); await owner.fill("input[name=days]", "3"); await owner.click("button:has-text('Convert to change')"); await settle(owner);
    await go(owner, projUrl); await owner.waitForSelector("td:has-text('Add blog')");
  });
  await step("invoice: draft fixed fee, approve, issue, pay, credit", async () => {
    await go(owner, `${B}/w/${ws}/invoices`);
    const f = owner.locator("form:has(select[name=kind])"); await f.locator("input[name=description]").fill("Phase 1"); await f.locator("input[name=amount]").fill("10000"); await f.locator("button").click(); await settle(owner);
    for (const l of ["Approve", "Issue"]) { await owner.locator(`button:has-text("${l}")`).first().click(); await settle(owner); }
    const pay = owner.locator("form:has(input[name=ref])"); await pay.locator("input[name=amount]").fill("4000"); await pay.locator("input[name=date]").fill("2026-11-10"); await pay.locator("button").click(); await settle(owner);
    const cr = owner.locator("form:has(input[name=reason])"); await cr.locator("input[name=amount]").fill("1000"); await cr.locator("input[name=reason]").fill("Goodwill"); await cr.locator("button").click(); await settle(owner);
    await owner.waitForSelector("text=₹5,000.00"); // outstanding
  });
  await step("statement renders running balance", async () => { await owner.click("a:has-text('Statement') >> nth=0"); await owner.waitForSelector("text=CN-0001"); });
  await step("customer sees issued invoice in portal", async () => { await go(cust, B + "/portal"); await cust.waitForSelector("text=INV-0001"); });
  await step("close project blocked by open items", async () => { await go(owner, projUrl); await owner.click("button:has-text('Close project')"); await owner.waitForSelector("[role=alert]:has-text('cannot close')"); });
  await step("capacity page grid", async () => { await go(owner, `${B}/w/${ws}/capacity`); await owner.waitForSelector("table[aria-label='Capacity calendar']"); });
  await browser.close();
})();
