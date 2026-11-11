const { chromium } = require("playwright");
const { createHmac } = require("crypto");
const AxeBuilder = require("@axe-core/playwright").default;
const { execSync } = require("child_process");
const B = "http://localhost:3000";
const sql = (q) => execSync(`PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -Atc "${q}"`).toString().trim();
(async () => {
  const browser = await chromium.launch(); const mk = async () => (await browser.newContext()).newPage();
  const o = await mk(), c = await mk();
  const step = async (n, f) => { try { await f(); console.log("OK  ", n); } catch (e) { console.log("FAIL", n, "-", e.message.split("\n")[0]); } };
  const t = Date.now(); const settle = (p) => p.waitForLoadState("networkidle");
  const go = async (p, u) => { await p.goto(u); await settle(p); await p.waitForTimeout(600); };
  const signup = async (p, e) => { await go(p, B + "/signup"); await p.fill("input[name=name]", "U"); await p.fill("input[name=email]", e); await p.fill("input[name=password]", "correct-horse-battery"); await p.click("button"); await p.waitForURL("**/workspaces"); };
  let ws, proj;
  await step("setup project", async () => {
    await signup(o, `o${t}@test.dev`); await o.fill("input[name=name]", "Biz"); await o.click('button:has-text("Create")'); await o.waitForURL(/\/w\//); ws = o.url().match(/\/w\/([0-9a-f-]{36})/)[1];
    await go(o, `${B}/w/${ws}/clients`); await o.fill("input[name=name]", "Cl"); await o.click('button:has-text("Add")'); await o.waitForSelector("a:text-is('Cl')"); await o.click("a:text-is('Cl')"); await settle(o); await o.waitForTimeout(500);
    await o.fill("input[name=name]", "P"); await o.check("input[name=approver]"); await o.click('button:has-text("Add contact")'); await o.waitForSelector("td:has-text('Yes')");
    await go(o, `${B}/w/${ws}/estimates`); await o.fill("input[name=title]", "Job"); await o.click('button:has-text("New estimate")'); await o.waitForURL(/estimates\/[0-9a-f-]{36}/); await settle(o);
    await o.fill("input[name=description]", "x"); await o.fill("input[name=qty]", "1"); await o.fill("input[name=rate]", "100"); await o.click('button:has-text("Add line")'); await o.waitForSelector("text=₹100.00");
    for (const l of ["Submit for approval", "Approve (manager)", "Mark as sent"]) { await o.click(`button:has-text("${l}")`); await settle(o); }
    await o.click('button:has-text("Record acceptance")'); await o.waitForSelector("strong:has-text('accepted')"); await o.click('button:has-text("Create engagement and project")'); await o.waitForSelector("p:has-text(\"created from this revision\")");
    await go(o, `${B}/w/${ws}/projects`); await o.click("a:text-is('Job')"); await o.waitForURL(/projects\/[0-9a-f-]{36}/); proj = o.url(); await settle(o);
  });
  await step("upload rejects disallowed type", async () => {
    await go(o, proj); 
    await o.evaluate(() => { const i = document.querySelector("input[type=file]"); const dt = new DataTransfer(); dt.items.add(new File(["x"], "evil.exe", { type: "application/x-msdownload" })); i.files = dt.files; });
    await o.click("button:has-text('Upload')"); await o.waitForSelector("[role=alert]:has-text('not allowed')");
  });
  await step("upload pdf, held until scanned", async () => {
    await go(o, proj); await o.setInputFiles("input[type=file]", "proof.pdf"); await o.click("button:has-text('Upload')"); await o.waitForSelector("li:has-text('proof.pdf')");
    await o.click("li:has-text('proof.pdf') button:has-text('Share with client')"); await o.waitForSelector("[role=alert]:has-text('malware screening')");
  });
  await step("scanner callback: bad signature refused, good one marks clean", async () => {
    const id = sql("select id from files order by created_at desc limit 1");
    const body = JSON.stringify({ file_id: id, status: "clean" });
    const bad = await o.request.post(`${B}/api/webhooks/scan`, { data: body, headers: { "x-signature": "nope" } }); if (bad.status() !== 401) throw new Error("bad sig " + bad.status());
    const sig = createHmac("sha256", "scan-secret-0123456789abcdef").update(body).digest("hex");
    const ok = await o.request.post(`${B}/api/webhooks/scan`, { data: body, headers: { "x-signature": sig } }); if (ok.status() !== 200) throw new Error("good sig " + ok.status());
    if (sql(`select scan_status from files where id='${id}'`) !== "clean") throw new Error("not clean");
  });
  await step("clean file can be shared and opened via signed URL", async () => {
    await go(o, proj); await o.click("li:has-text('proof.pdf') button:has-text('Share with client')"); await o.waitForSelector("li:has-text('proof.pdf') >> text=/^shared$/");
    const [resp] = await Promise.all([o.waitForResponse((r) => r.url().includes("/storage/v1/object/sign/")), o.click("li:has-text('proof.pdf') button:has-text('Open')")]);
    if (resp.status() !== 200) throw new Error("signed url " + resp.status());
  });
  await step("job worker: unconfigured email -> failed with backoff, then visible", async () => {
    sql("insert into jobs (kind,payload,dedupe_key) values ('email','{\\\"to\\\":\\\"a@b.c\\\",\\\"subject\\\":\\\"s\\\",\\\"text\\\":\\\"t\\\"}','e2e-"+t+"')");
    const r = await o.request.post(`${B}/api/jobs/run`, { headers: { authorization: "Bearer local-cron-secret-0123456789abcdef" } }); const j = await r.json();
    if (!(j.failed >= 1)) throw new Error(JSON.stringify(j));
    const row = sql(`select status||'/'||attempts||'/'||left(last_error,40) from jobs where dedupe_key='e2e-${t}'`); if (!row.startsWith("failed/1/Email provider is not configured")) throw new Error(row);
  });
  await step("accessibility (axe, WCAG A/AA) on key pages", async () => {
    const pages = ["/", "/pricing", "/login", "/signup", `/w/${ws}/clients`, `/w/${ws}/estimates`, `/w/${ws}/capacity`, `/w/${ws}/invoices`, `/w/${ws}/settings`, `/portal`];
    const bad = [];
    for (const p of pages) { await go(o, B + p); const r = await new AxeBuilder({ page: o }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); for (const v of r.violations) bad.push(`${p}: ${v.id} (${v.nodes.length})`); }
    if (bad.length) throw new Error("\n" + bad.join("\n"));
  });
  await browser.close();
})();
