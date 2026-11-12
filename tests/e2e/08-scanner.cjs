// Real end-to-end check of the malware scanner: real clamd (EICAR test signature), real Supabase storage, real app callback.
// Needs: clamd on 127.0.0.1:3310, `npm run dev`, local Supabase, and SCAN_WEBHOOK_SECRET / keys in .env.local.
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");
const B = "http://localhost:3000";
const env = Object.fromEntries(fs.readFileSync(`${__dirname}/../../.env.local`, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const sql = (q) => execSync(`PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -Atc "${q}"`).toString().trim();
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const scan = () => execSync("node services/scanner/scanner.mjs --once", { cwd: `${__dirname}/../..`, env: { ...process.env, SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY, APP_URL: B, SCAN_WEBHOOK_SECRET: env.SCAN_WEBHOOK_SECRET }, encoding: "utf8" });
(async () => {
  const b = await chromium.launch(); const o = await (await b.newContext()).newPage(); const t = Date.now();
  const step = async (n, f) => { try { await f(); console.log("OK  ", n); } catch (e) { console.log("FAIL", n, "-", e.message.split("\n")[0]); } };
  const settle = () => o.waitForLoadState("networkidle"); const go = async (u) => { await o.goto(u); await settle(); await o.waitForTimeout(600); };
  let ws, proj;
  await step("setup project", async () => {
    await go(B + "/signup"); await o.fill("input[name=name]", "U"); await o.fill("input[name=email]", `sc${t}@test.dev`); await o.fill("input[name=password]", "correct-horse-battery"); await o.click("button"); await o.waitForURL("**/workspaces");
    await o.fill("input[name=name]", "Biz"); await o.click('button:has-text("Create")'); await o.waitForURL(/\/w\//); ws = o.url().match(/\/w\/([0-9a-f-]{36})/)[1];
    await go(`${B}/w/${ws}/clients`); await o.fill("input[name=name]", "Cl"); await o.click('button:has-text("Add")'); await o.waitForSelector("a:text-is('Cl')"); await o.click("a:text-is('Cl')"); await settle(); await o.waitForTimeout(500);
    await o.fill("input[name=name]", "P"); await o.check("input[name=approver]"); await o.click('button:has-text("Add contact")'); await o.waitForSelector("td:has-text('Yes')");
    await go(`${B}/w/${ws}/estimates`); await o.fill("input[name=title]", "Job"); await o.click('button:has-text("New estimate")'); await o.waitForURL(/estimates\/[0-9a-f-]{36}/); await settle();
    await o.fill("input[name=description]", "x"); await o.fill("input[name=qty]", "1"); await o.fill("input[name=rate]", "100"); await o.click('button:has-text("Add line")'); await o.waitForSelector("text=₹100.00");
    for (const l of ["Submit for approval", "Approve (manager)", "Mark as sent"]) { await o.click(`button:has-text("${l}")`); await settle(); }
    await o.click('button:has-text("Record acceptance")'); await o.waitForSelector("strong:has-text('accepted')"); await o.click('button:has-text("Create engagement and project")'); await o.waitForSelector("p:has-text('created from this revision')");
    await go(`${B}/w/${ws}/projects`); await o.click("a:text-is('Job')"); await o.waitForURL(/projects\/[0-9a-f-]{36}/); proj = o.url();
  });
  const upload = async (name, body) => { await go(proj); await o.setInputFiles("input[type=file]", { name, mimeType: "application/pdf", buffer: Buffer.from(body) }); await o.click("button:has-text('Upload')"); await o.waitForSelector(`li:has-text('${name}')`); };
  await step("upload a clean file and an EICAR test file", async () => { await upload("clean.pdf", "%PDF-1.4 harmless"); await upload("virus.pdf", EICAR); });
  await step("both are pending and unshareable before scanning", async () => {
    if (sql("select count(*) from files where scan_status='pending'") !== "2") throw new Error("expected 2 pending");
    await go(proj); await o.click("li:has-text('clean.pdf') button:has-text('Share with client')"); await o.waitForSelector("[role=alert]:has-text('malware screening')");
  });
  await step("scanner marks the clean file clean and the EICAR file infected", async () => {
    const out = scan(); if (!out.includes('"result":"clean"') || !out.includes('"result":"infected"')) throw new Error(out.slice(-300));
    const rows = sql("select split_part(path,'.',2)||':'||scan_status from files order by created_at");
    const st = Object.fromEntries(sql("select mime||'|'||scan_status||'|'||size_bytes from files order by created_at").split("\n").map((r, i) => [i, r]));
    if (!st[0].includes("|clean|") || !st[1].includes("|infected|")) throw new Error(JSON.stringify(st) + rows);
  });
  await step("clean file can now be shared; infected file never can", async () => {
    await go(proj); await o.click("li:has-text('clean.pdf') button:has-text('Share with client')"); await o.waitForSelector("li:has-text('clean.pdf') >> text=/^shared$/");
    await o.click("li:has-text('virus.pdf') button:has-text('Share with client')"); await o.waitForSelector("[role=alert]:has-text('malware screening')");
  });
  await step("an unreachable clamd leaves new files pending (never clean)", async () => {
    await upload("later.pdf", "%PDF-1.4 later");
    let out = ""; try { out = execSync("node services/scanner/scanner.mjs --once", { cwd: `${__dirname}/../..`, env: { ...process.env, SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY, APP_URL: B, SCAN_WEBHOOK_SECRET: env.SCAN_WEBHOOK_SECRET, CLAMD_PORT: "1" }, encoding: "utf8" }); } catch (e) { out = String(e.stdout); }
    if (!out.includes("clamd is not answering")) throw new Error(out.slice(-200));
    if (sql("select scan_status from files where path like '%' order by created_at desc limit 1") !== "pending") throw new Error("not pending");
  });
  await b.close();
})();
