const { chromium } = require("playwright"); const AxeBuilder = require("@axe-core/playwright").default;
const B = "http://localhost:3000";
(async () => {
  const b = await chromium.launch(); const p = await (await b.newContext()).newPage(); const t = Date.now();
  const go = async (u) => { await p.goto(u); await p.waitForLoadState("networkidle"); await p.waitForTimeout(500); };
  await go(B + "/signup"); await p.fill("input[name=name]", "U"); await p.fill("input[name=email]", `a${t}@test.dev`); await p.fill("input[name=password]", "correct-horse-battery"); await p.click("button"); await p.waitForURL("**/workspaces");
  await p.fill("input[name=name]", "Biz"); await p.click('button:has-text("Create")'); await p.waitForURL(/\/w\//); const ws = p.url().match(/\/w\/([0-9a-f-]{36})/)[1];
  const bad = {};
  for (const path of ["clients", "briefs", "projects", "time", "capacity", "expenses", "invoices", "retainers", "tickets", "templates", "team", "settings", "notifications", "estimates"]) {
    await go(`${B}/w/${ws}/${path}`);
    const r = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    for (const v of r.violations) (bad[v.id] ??= { help: v.help, pages: new Set(), sample: v.nodes[0].html.slice(0, 110) }).pages.add(path);
  }
  for (const [id, v] of Object.entries(bad)) console.log(id, "|", v.help, "|", [...v.pages].join(","), "|", v.sample);
  if (!Object.keys(bad).length) console.log("no violations");
  await b.close();
})();
