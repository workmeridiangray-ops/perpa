const { chromium } = require("playwright");
const B = "http://localhost:3000";
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => m.type() === "error" && errs.push("console: " + m.text()));
  const step = async (name, fn) => { try { await fn(); console.log("OK  ", name); } catch (e) { console.log("FAIL", name, "-", e.message.split("\n")[0]); await page.screenshot({ path: `fail-${name.replace(/\W+/g, "_")}.png` }); } };
  const email = `owner${Date.now()}@test.dev`;
  await step("sign up", async () => {
    await page.goto(B + "/signup");
    await page.fill('input[name=name]', "Olive Owner"); await page.fill('input[name=email]', email); await page.fill('input[name=password]', "correct-horse-battery");
    await page.click("button"); await page.waitForURL("**/workspaces", { timeout: 15000 });
  });
  await step("create business", async () => {
    await page.fill('input[name=name]', "Acme Agency"); await page.click('button:has-text("Create")'); await page.waitForURL(/\/w\/[0-9a-f-]{36}\/clients/, { timeout: 15000 });
  });
  const ws = () => page.url().match(/\/w\/([0-9a-f-]{36})/)[1];
  await step("add client", async () => {
    await page.fill('input[name=name]', "Globex Corp"); await page.click('button:has-text("Add")'); await page.waitForSelector("text=Globex Corp");
  });
  await step("duplicate client rejected", async () => {
    await page.fill('input[name=name]', "  globex   corp "); await page.click('button:has-text("Add")'); await page.waitForSelector("text=already exists");
  });
  await step("new estimate + line", async () => {
    await page.goto(`${B}/w/${ws()}/estimates`);
    await page.fill('input[name=title]', "Website rebuild"); await page.click('button:has-text("New estimate")'); await page.waitForURL(/estimates\/[0-9a-f-]{36}/);
    await page.selectOption('select[name=kind]', "labour"); await page.fill('input[name=description]', "Design"); await page.fill('input[name=qty]', "10"); await page.fill('input[name=rate]', "4000"); await page.fill('input[name=cost]', "2500");
    await page.click('button:has-text("Add line")'); await page.waitForSelector("text=₹40,000.00");
  });
  await step("margin visible to owner", async () => { await page.waitForSelector("text=margin 37.5%"); });
  await step("submit/approve/send", async () => {
    for (const label of ["Submit for approval", "Approve (manager)", "Mark as sent"]) { await page.click(`button:has-text("${label}")`); await page.waitForLoadState("networkidle"); }
    await page.waitForSelector("text=sent");
  });
  await step("pages render", async () => {
    for (const p of ["briefs", "projects", "time", "capacity", "expenses", "invoices", "retainers", "tickets", "templates", "team", "settings", "notifications"]) {
      const r = await page.goto(`${B}/w/${ws()}/${p}`); if (r.status() >= 400) throw new Error(p + " " + r.status());
      await page.waitForSelector("h1");
    }
  });
  await step("pricing + portal gate", async () => { await page.goto(B + "/pricing"); await page.waitForSelector("h1"); await page.goto(B + "/platform"); if (!/404|could not be found/i.test(await page.content())) throw new Error("platform not hidden"); });
  console.log("ERRORS:", errs.length ? errs.slice(0, 8) : "none");
  await browser.close();
})();
