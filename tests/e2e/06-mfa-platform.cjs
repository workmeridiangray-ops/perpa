const { chromium } = require("playwright"); const { createHmac } = require("crypto"); const { execSync } = require("child_process");
const B = "http://localhost:3000";
const sql = (q) => execSync(`PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -Atc "${q}"`).toString().trim();
function b32(s) { const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = ""; for (const c of s.replace(/=+$/, "").toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, "0"); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
function totp(secret) { const c = Math.floor(Date.now() / 30000); const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(c)); const h = createHmac("sha1", b32(secret)).update(b).digest(); const o = h[19] & 15; return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, "0"); }
(async () => {
  const b = await chromium.launch(); const p = await (await b.newContext()).newPage(); const t = Date.now(); const email = `ps${t}@test.dev`;
  const step = async (n, f) => { try { await f(); console.log("OK  ", n); } catch (e) { console.log("FAIL", n, "-", e.message.split("\n")[0]); } };
  await step("signup", async () => { await p.goto(B + "/signup"); await p.waitForLoadState("networkidle"); await p.fill("input[name=name]", "PS"); await p.fill("input[name=email]", email); await p.fill("input[name=password]", "correct-horse-battery"); await p.click("button"); await p.waitForURL("**/workspaces"); });
  sql(`insert into platform_staff select id,'owner' from auth.users where email='${email}'`);
  await step("platform needs second factor", async () => { await p.goto(B + "/platform"); await p.waitForURL("**/security?need=platform"); await p.waitForSelector("[role=alert]:has-text('second factor')"); });
  await step("enrol TOTP and verify", async () => {
    await p.waitForLoadState("networkidle"); await p.waitForTimeout(800);
    await p.click("button:has-text('Set up an authenticator app')"); await p.waitForSelector("code");
    const secret = (await p.textContent("code")).trim(); await p.fill("input[inputmode=numeric]", totp(secret)); await p.click("button:has-text('Verify')"); await p.waitForURL("**/workspaces", { timeout: 15000 });
  });
  await step("platform console now opens", async () => { await p.goto(B + "/platform"); await p.waitForSelector("h1:has-text('Platform administration')"); await p.goto(B + "/platform/ops"); await p.waitForSelector("h1:has-text('Operations console')"); });
  await step("platform: publish a plan version, pricing page shows it", async () => {
    await p.goto(B + "/platform"); await p.waitForLoadState("networkidle"); await p.waitForTimeout(600);
    await p.fill("input[name=code]", "starter"); await p.fill("input[name=name]", "Starter"); await p.fill("input[name=price]", "4999"); await p.fill("input[name=users]", "5"); await p.fill("input[name=branches]", "2"); await p.fill("input[name=from]", "2026-01-01"); await p.click("button:has-text('Publish version')"); await p.waitForSelector("li:has-text('Starter v1')");
    const anon = await (await b.newContext()).newPage(); await anon.goto(B + "/pricing"); await anon.waitForSelector("text=Starter"); await anon.waitForSelector("text=₹4,999.00");
  });
  await b.close();
})();
