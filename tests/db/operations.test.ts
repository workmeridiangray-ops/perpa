import { afterAll, describe, expect, it } from "vitest";
import { A, B, CL_A, U, as, fails, pool, type Q } from "./helpers";
import { project } from "./fixtures";

afterAll(() => pool.end());
async function become(raw: Q, user: keyof typeof U | null) {
  await raw("reset role"); await raw(user ? "set local role authenticated" : "set local role anon");
  await raw("select set_config('request.jwt.claim.sub',$1,true)", [user ? U[user] : ""]);
}
async function asRole(raw: Q, role: string) { await raw("reset role"); await raw(`set local role ${role}`); }
async function superuser<T>(raw: Q, back: keyof typeof U, fn: () => Promise<T>) { await raw("reset role"); const r = await fn(); await become(raw, back); return r; }

async function issued(q: Q, prj: string, amount = 1000000) {
  const inv = (await q("insert into invoices (business_id,client_id,project_id,kind) values ($1,$2,$3,'fixed') returning id", [A, CL_A, prj])).rows[0].id;
  await q("insert into invoice_lines (business_id,invoice_id,description,amount_paise) values ($1,$2,'Fee',$3)", [A, inv, amount]);
  await q("update invoices set status='approved' where id=$1", [inv]);
  await q("update invoices set status='issued', issued_on='2026-01-10', due_on='2026-02-09' where id=$1", [inv]);
  return inv as string;
}

describe("credit notes and statements", () => {
  it("credits reduce the balance, need a reason, cannot exceed it, and appear on the statement", async () => {
    await as("managerA", async (q, raw) => {
      const { prj } = await project(raw);
      const inv = await issued(q, prj);
      await fails(q, "insert into credit_notes (business_id,invoice_id,amount_paise,reason) values ($1,$2,100,' ')", [A, inv]);
      await q("insert into credit_notes (business_id,invoice_id,amount_paise,reason) values ($1,$2,300000,'Scope reduced')", [A, inv]);
      await q("insert into payments (business_id,invoice_id,amount_paise,received_on) values ($1,$2,500000,'2026-02-01')", [A, inv]);
      await fails(q, "insert into credit_notes (business_id,invoice_id,amount_paise,reason) values ($1,$2,200001,'Too much')", [A, inv]);
      await fails(q, "insert into payments (business_id,invoice_id,amount_paise,received_on) values ($1,$2,200001,'2026-02-02')", [A, inv]);
      const r = (await q("select credited_paise, outstanding_paise from receivables where id=$1", [inv])).rows[0];
      expect(r).toEqual({ credited_paise: 300000, outstanding_paise: 200000 });
      const st = (await q("select document, debit_paise, credit_paise, balance_paise from client_statement($1,'2026-01-01','2026-12-31')", [CL_A])).rows;
      expect(st.map((x) => x.balance_paise)).toEqual([1000000, 500000, 200000]);
      expect(st[2].document).toBe("CN-0001");
    });
  });
  it("credits require an issued invoice", async () => {
    await as("managerA", async (q, raw) => {
      const { prj } = await project(raw);
      const inv = (await q("insert into invoices (business_id,client_id,project_id,kind) values ($1,$2,$3,'fixed') returning id", [A, CL_A, prj])).rows[0].id;
      await fails(q, "insert into credit_notes (business_id,invoice_id,amount_paise,reason) values ($1,$2,1,'x')", [A, inv]);
    });
  });
});

describe("job queue", () => {
  it("notifications go to managers, not to the actor, and enqueue deduplicated email", async () => {
    await as("staffA", async (q, raw) => {
      const { prj } = await project(raw);
      const t = (await q("insert into time_entries (business_id,project_id,user_id,work_date,minutes) values ($1,$2,$3,'2026-12-02',60) returning id", [A, prj, U.staffA])).rows[0].id;
      await q("update time_entries set status='submitted' where id=$1", [t]);
      await become(raw, "managerA");
      expect((await q("select title from notifications")).rows.map((r) => r.title)).toContain("Time submitted for review");
      await q("update notifications set read_at=now()");
      await become(raw, "staffA");
      expect((await q("select * from notifications")).rowCount).toBe(0);
      await superuser(raw, "staffA", async () => {
        // profiles exist via the auth trigger, so each manager/owner got exactly one email job
        const n = (await raw("select count(*)::int c from jobs where kind='email' and payload->>'subject'='Time submitted for review'")).rows[0].c;
        expect(n).toBe(2);
        await raw("select app.enqueue($1,'email','{}'::jsonb,'dup')", [A]);
        await raw("select app.enqueue($1,'email','{}'::jsonb,'dup')", [A]);
        expect((await raw("select count(*)::int c from jobs where dedupe_key='dup'")).rows[0].c).toBe(1);
      });
    });
  });
  it("workers back off, dead-letter after max attempts, and only platform ops may retry; users cannot touch the queue", async () => {
    await as("ownerA", async (q, raw) => {
      await raw("reset role");
      await raw("insert into jobs (kind,payload,dedupe_key,max_attempts) values ('email','{}','j1',2)");
      await asRole(raw, "service_role");
      let j = (await q("select * from claim_jobs(5)")).rows;
      expect(j).toHaveLength(1);
      await q("select fail_job($1,'smtp down')", [j[0].id]);
      expect((await q("select status, attempts from jobs where id=$1", [j[0].id])).rows[0]).toEqual({ status: "failed", attempts: 1 });
      expect((await q("select * from claim_jobs(5)")).rowCount).toBe(0); // backoff: not due yet
      await raw("reset role"); await raw("update jobs set run_after = now()"); await asRole(raw, "service_role");
      j = (await q("select * from claim_jobs(5)")).rows;
      await q("select fail_job($1,'still down')", [j[0].id]);
      expect((await q("select status from jobs where id=$1", [j[0].id])).rows[0].status).toBe("dead");
      await become(raw, "ownerA");
      await fails(q, "select * from claim_jobs(1)");
      expect((await q("select * from jobs")).rowCount).toBe(0); // RLS: only platform ops can read the queue
      await fails(q, "select retry_job($1)", [j[0].id]);
      await raw("reset role"); await raw("insert into platform_staff values ($1,'ops')", [U.staffA]); await become(raw, "staffA");
      await q("select retry_job($1)", [j[0].id]);
      expect((await q("select status from jobs where id=$1", [j[0].id])).rows[0].status).toBe("queued");
    });
  });
});

describe("API keys and webhooks", () => {
  it("stores only a hash, resolves while active, and rejects after revocation; owners only", async () => {
    const key = "pk_" + "k".repeat(40);
    await as("ownerA", async (q, raw) => {
      await fails(q, "select create_api_key($1,'x','short')", [A]);
      const id = (await q("select create_api_key($1,'Zapier',$2) as id", [A, key])).rows[0].id;
      expect((await q("select key_hash::text h from api_keys")).rows[0].h).not.toContain("kkkk");
      await asRole(raw, "service_role");
      expect((await q("select resolve_api_key($1) as b", [key])).rows[0].b).toBe(A);
      expect((await q("select resolve_api_key('nope') as b")).rows[0].b).toBeNull();
      await become(raw, "ownerA");
      await fails(q, "select resolve_api_key($1)", [key]); // server-only
      await q("select revoke_api_key($1)", [id]);
      await asRole(raw, "service_role");
      expect((await q("select resolve_api_key($1) as b", [key])).rows[0].b).toBeNull();
    });
    await as("managerA", async (q) => { await fails(q, "select create_api_key($1,'x',$2)", [A, key]); });
  });
  it("issuing an invoice or recording a payment enqueues one webhook per matching endpoint, https only", async () => {
    await as("ownerA", async (q, raw) => {
      await fails(q, "insert into webhook_endpoints (business_id,url,secret) values ($1,'http://x.test/h',$2)", [A, "s".repeat(24)]);
      await q("insert into webhook_endpoints (business_id,url,secret,events) values ($1,'https://x.test/h',$2,'{invoice.issued}')", [A, "s".repeat(24)]);
      const { prj } = await project(raw);
      const inv = await issued(q, prj);
      await q("insert into payments (business_id,invoice_id,amount_paise,received_on) values ($1,$2,100,'2026-02-01')", [A, inv]);
      await superuser(raw, "ownerA", async () => {
        const r = (await raw("select payload->>'event' e from jobs where kind='webhook'")).rows.map((x) => x.e);
        expect(r).toEqual(["invoice.issued"]); // payment.received filtered out by the endpoint's event list
      });
    });
  });
});

describe("custom fields, saved views", () => {
  it("validates custom fields by type, requires required ones, rejects unknown keys", async () => {
    await as("managerA", async (q) => {
      await q("insert into custom_fields (business_id,entity,key,label,type,required) values ($1,'client','gstin','GSTIN','text',true),($1,'client','since','Client since','date',false),($1,'client','seats','Seats','number',false)", [A]);
      await fails(q, "insert into clients (business_id,name) values ($1,'NoGst')", [A]);
      await fails(q, `insert into clients (business_id,name,custom) values ($1,'Bad','{"gstin":"x","seats":"ten"}')`, [A]);
      await fails(q, `insert into clients (business_id,name,custom) values ($1,'Bad2','{"gstin":"x","since":"yesterday"}')`, [A]);
      await fails(q, `insert into clients (business_id,name,custom) values ($1,'Bad3','{"gstin":"x","nope":1}')`, [A]);
      await q(`insert into clients (business_id,name,custom) values ($1,'Good','{"gstin":"29ABC","since":"2026-01-02","seats":5}')`, [A]);
    });
  });
  it("saved views are private to their owner", async () => {
    await as("staffA", async (q, raw) => {
      await q("insert into saved_views (business_id,user_id,screen,name,params) values ($1,$2,'clients','Mine','{\"q\":\"a\"}')", [A, U.staffA]);
      await fails(q, "insert into saved_views (business_id,user_id,screen,name) values ($1,$2,'clients','Theirs')", [A, U.managerA]);
      await become(raw, "managerA");
      expect((await q("select * from saved_views")).rowCount).toBe(0);
    });
  });
});

describe("templates, checklists, tickets", () => {
  it("applying a template creates checklist items that block project close until done", async () => {
    await as("managerA", async (q, raw) => {
      const { prj } = await project(raw);
      const t = (await q("insert into templates (business_id,kind,title) values ($1,'review','Launch QA') returning id", [A])).rows[0].id;
      await q("insert into template_items (business_id,template_id,position,text) values ($1,$2,1,'Links work'),($1,$2,2,'Contrast checked')", [A, t]);
      expect((await q("select apply_template($1,$2) as n", [t, prj])).rows[0].n).toBe(2);
      expect(await fails(q, "select close_project($1)", [prj])).toBe("cannot close: open checklist items");
      await q("update check_items set done = true where project_id=$1", [prj]);
      expect((await q("select done_by from check_items limit 1")).rows[0].done_by).toBe(U.managerA);
      await q("select close_project($1)", [prj]);
    });
  });
  it("clients raise tickets; staff convert them into change requests once", async () => {
    await as("customerA", async (q, raw) => {
      const { prj } = await project(raw);
      await superuser(raw, "customerA", async () => { await raw("insert into client_users (business_id,client_id,user_id) values ($1,$2,$3)", [A, CL_A, U.customerA]); });
      await fails(q, "insert into tickets (business_id,client_id,title,created_by,kind) values ($1,$2,'Hack',$3,'included')", [A, CL_A, U.customerA]);
      const t = (await q("insert into tickets (business_id,client_id,project_id,title,body,created_by) values ($1,$2,$3,'Add blog','Need a blog',$4) returning id", [A, CL_A, prj, U.customerA])).rows[0].id;
      await become(raw, "staffA");
      const cr = (await q("select ticket_to_change($1,5000000,1200,5) as id", [t])).rows[0].id;
      expect((await q("select kind, change_request_id from tickets where id=$1", [t])).rows[0]).toEqual({ kind: "change", change_request_id: cr });
      await fails(q, "select ticket_to_change($1,1,1,1)", [t]);
    });
  });
});

describe("leave and working patterns", () => {
  it("non-working days and approved leave count against capacity; override reason bypasses", async () => {
    await as("managerA", async (q, raw) => {
      const { prj, res } = await project(raw);
      const book = (from: string, to: string, reason: string | null = null) =>
        q("insert into allocations (business_id,project_id,resource_id,starts_on,ends_on,minutes_per_day,status,override_reason) values ($1,$2,$3,$4,$5,120,'confirmed',$6)", [A, prj, res, from, to, reason]);
      expect(await fails(q, "insert into allocations (business_id,project_id,resource_id,starts_on,ends_on,minutes_per_day,status) values ($1,$2,$3,'2026-12-05','2026-12-05',120,'confirmed')", [A, prj, res])).toMatch(/conflict/); // Saturday
      await q("insert into leave (business_id,resource_id,starts_on,ends_on,status) values ($1,$2,'2026-12-02','2026-12-02','approved')", [A, res]);
      expect(await fails(q, "insert into allocations (business_id,project_id,resource_id,starts_on,ends_on,minutes_per_day,status) values ($1,$2,$3,'2026-12-01','2026-12-03',120,'confirmed')", [A, prj, res])).toMatch(/1 day/);
      await book("2026-12-01", "2026-12-01");
      await book("2026-12-05", "2026-12-05", "Launch weekend");
      expect((await q("select app.day_capacity($1,'2026-12-02') c", [res])).rows[0].c).toBe(0);
      await q("update resources set weekly_minutes='{240,240,240,240,240,0,0}' where id=$1", [res]);
      expect((await q("select app.day_capacity($1,'2026-12-03') c", [res])).rows[0].c).toBe(240);
    });
  });
  it("staff request leave for themselves; only managers decide", async () => {
    await as("staffA", async (q, raw) => {
      const { res } = await project(raw);
      await q("insert into leave (business_id,resource_id,starts_on,ends_on) values ($1,$2,'2026-12-10','2026-12-11')", [A, res]);
      expect(await fails(q, "insert into leave (business_id,resource_id,starts_on,ends_on,status) values ($1,$2,'2026-12-12','2026-12-12','approved')", [A, res])).toMatch(/decide leave|row-level/);
      expect((await q("update leave set status='approved'")).rowCount).toBe(0);
    });
  });
});

describe("offboarding", () => {
  it("reassigns briefs, returns bookings to tentative, removes client access and suspends", async () => {
    await as("ownerA", async (q, raw) => {
      const { prj, res } = await project(raw); // resource belongs to staffA
      await superuser(raw, "ownerA", async () => {
        await raw("insert into resources (business_id,user_id,name) values ($1,$2,'Manager')", [A, U.managerA]);
        await raw("insert into allocations (business_id,project_id,resource_id,starts_on,ends_on,minutes_per_day,status,override_reason) values ($1,$2,$3,current_date+1,current_date+2,60,'confirmed','seed')", [A, prj, res]);
        await raw("insert into briefs (business_id,client_id,title,owner_id) values ($1,$2,'B',$3)", [A, CL_A, U.staffA]);
      });
      const out = (await q("select offboard_member('c0000000-0000-4000-8000-000000000003',$1) as r", [U.managerA])).rows[0].r;
      expect(out).toEqual({ briefs_reassigned: 1, bookings_returned_to_tentative: 1 });
      expect((await q("select owner_id from briefs")).rows[0].owner_id).toBe(U.managerA);
      expect((await q("select status from allocations")).rows[0].status).toBe("tentative");
      expect((await q("select status from memberships where user_id=$1", [U.staffA])).rows[0].status).toBe("suspended");
      await fails(q, "select offboard_member('c0000000-0000-4000-8000-000000000002',$1)", [U.customerA]); // not a team member
    });
  });
});

describe("platform operations", () => {
  it("coupons: single use per business, limits and expiry", async () => {
    await as("ownerA", async (q, raw) => {
      await superuser(raw, "ownerA", async () => { await raw("insert into coupons (code,percent_bps,max_redemptions) values ('LAUNCH',2000,1),('OLD',1000,null)"); await raw("update coupons set valid_until='2020-01-01' where code='OLD'"); });
      expect((await q("select redeem_coupon($1,' launch') as p", [A])).rows[0].p).toBe(2000);
      await fails(q, "select redeem_coupon($1,'LAUNCH')", [A]);
      await fails(q, "select redeem_coupon($1,'OLD')", [A]);
      await fails(q, "select redeem_coupon($1,'NOPE')", [A]);
    });
  });
  it("provider callbacks are idempotent; failures start grace, success clears it; blocked after grace", async () => {
    await as("ownerA", async (q, raw) => {
      await raw("reset role");
      await raw("insert into plans (id,code,name) values ('f0000000-0000-4000-8000-000000000001','p','P')");
      await raw("insert into plan_versions (id,plan_id,version,monthly_paise,max_users,max_branches,effective_from) values ('f0000000-0000-4000-8000-0000000000a1','f0000000-0000-4000-8000-000000000001',1,100,10,5,'2026-01-01')");
      await raw("insert into subscriptions (business_id,plan_version_id,status,trial_ends_on) values ($1,'f0000000-0000-4000-8000-0000000000a1','trial','2020-01-01')", [A]);
      await become(raw, "ownerA");
      expect((await q("select entitlement_state($1) s", [A])).rows[0].s).toBe("blocked"); // trial over
      await asRole(raw, "service_role");
      await q("select record_saas_charge($1,'pay_1',100,'failed')", [A]);
      await q("select record_saas_charge($1,'pay_1',100,'failed')", [A]);
      expect((await q("select count(*)::int c from saas_charges")).rows[0].c).toBe(1);
      await become(raw, "ownerA");
      expect((await q("select entitlement_state($1) s", [A])).rows[0].s).toBe("grace");
      await asRole(raw, "service_role");
      await q("select record_saas_charge($1,'pay_1',100,'succeeded')", [A]);
      await become(raw, "ownerA");
      expect((await q("select status, grace_until from subscriptions")).rows[0]).toEqual({ status: "active", grace_until: null });
      expect((await q("select entitlement_state($1) s", [A])).rows[0].s).toBe("ok");
      await raw("reset role"); await raw("update subscriptions set status='past_due', grace_until=current_date-1"); await become(raw, "ownerA");
      expect((await q("select entitlement_state($1) s", [A])).rows[0].s).toBe("blocked");
      await fails(q, "select record_saas_charge($1,'x',1,'succeeded')", [A]); // service only
    });
  });
  it("refunds need a collected charge, stay within the amount, and a different person decides", async () => {
    await as("ownerA", async (q, raw) => {
      await raw("reset role");
      await raw("insert into platform_staff values ($1,'billing'),($2,'billing')", [U.staffA, U.managerA]);
      const ch = (await raw("insert into saas_charges (business_id,amount_paise,status,provider_ref) values ($1,1000,'succeeded','r1') returning id", [A])).rows[0].id;
      const pend = (await raw("insert into saas_charges (business_id,amount_paise,status,provider_ref) values ($1,1000,'pending','r2') returning id", [A])).rows[0].id;
      await become(raw, "staffA");
      await fails(q, "insert into refunds (charge_id,amount_paise,reason) values ($1,100,'x')", [pend]);
      await fails(q, "insert into refunds (charge_id,amount_paise,reason) values ($1,1001,'x')", [ch]);
      const rf = (await q("insert into refunds (charge_id,amount_paise,reason) values ($1,1000,'Duplicate charge') returning id", [ch])).rows[0].id;
      await fails(q, "update refunds set status='approved' where id=$1", [rf]);
      await become(raw, "managerA");
      await q("update refunds set status='approved' where id=$1", [rf]);
      expect((await q("select status from saas_charges where id=$1", [ch])).rows[0].status).toBe("refunded");
      await fails(q, "update refunds set status='rejected' where id=$1", [rf]);
    });
  });
});

describe("files, export and closure", () => {
  it("a shared proof needs a clean file", async () => {
    await as("managerA", async (q, raw) => {
      const { prj } = await project(raw);
      const f = (await q("insert into files (business_id,project_id,path,mime,size_bytes) values ($1,$2,'a/b.pdf','application/pdf',100) returning id", [A, prj])).rows[0].id;
      const d = (await q("insert into deliverables (business_id,project_id,name) values ($1,$2,'Doc') returning id", [A, prj])).rows[0].id;
      const v = (await q("insert into deliverable_versions (business_id,deliverable_id,version,file_id) values ($1,$2,1,$3) returning id", [A, d, f])).rows[0].id;
      expect(await fails(q, "update deliverable_versions set shared=true where id=$1", [v])).toMatch(/malware/);
      await fails(q, "insert into files (business_id,project_id,path,mime,size_bytes) values ($1,$2,'big','application/pdf',20000000)", [A, prj]);
      await asRole(raw, "service_role");
      await q("select set_scan_result($1,'infected')", [f]);
      await become(raw, "managerA");
      await fails(q, "update deliverable_versions set shared=true where id=$1", [v]);
      await asRole(raw, "service_role");
      await q("select set_scan_result($1,'clean')", [f]);
      await become(raw, "managerA");
      await q("update deliverable_versions set shared=true where id=$1", [v]);
    });
  });
  it("export is owner-only and scoped to the business", async () => {
    await as("ownerA", async (q) => {
      const out = (await q("select export_business($1) as j", [A])).rows[0].j;
      expect(out.clients.map((c: { name: string }) => c.name)).toContain("Acme Studio");
      expect(JSON.stringify(out)).not.toContain("Zed Ltd");
      await fails(q, "select export_business($1)", [B]);
    });
    await as("managerA", async (q) => { await fails(q, "select export_business($1)", [A]); });
  });
  it("closure needs confirmation; deletion needs platform ops, the retention window and an export", async () => {
    await as("ownerB", async (q, raw) => {
      const BB = "bbbbbbbb-0000-4000-8000-000000000000";
      await fails(q, "select request_closure($1,'yes')", [BB]);
      const r = (await q("select request_closure($1,'DELETE') as id", [BB])).rows[0].id;
      await fails(q, "select delete_business($1)", [r]); // not platform staff
      await raw("reset role"); await raw("insert into platform_staff values ($1,'ops')", [U.staffA]); await become(raw, "staffA");
      expect(await fails(q, "select delete_business($1)", [r])).toMatch(/retention/);
      await raw("reset role"); await raw("update closure_requests set requested_at = now() - interval '31 days'"); await become(raw, "staffA");
      expect(await fails(q, "select delete_business($1)", [r])).toMatch(/exported/);
      await raw("reset role"); await raw("update closure_requests set exported_at = now()"); await become(raw, "staffA");
      await q("select delete_business($1)", [r]);
      await raw("reset role");
      expect((await raw("select status, error from closure_requests where id=$1", [r])).rows[0]).toEqual({ status: "deleted", error: null });
      expect((await raw("select count(*)::int c from businesses where id=$1", [BB])).rows[0].c).toBe(0);
      expect((await raw("select count(*)::int c from clients where business_id=$1", [BB])).rows[0].c).toBe(0);
    });
  });
});
