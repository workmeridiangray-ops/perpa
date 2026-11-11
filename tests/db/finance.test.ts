import { afterAll, describe, expect, it } from "vitest";
import { A, CL_A, U, as, fails, pool, type Q } from "./helpers";
import { project } from "./fixtures";

afterAll(() => pool.end());

/** Switch the session identity (keeps the authenticated role). */
async function become(raw: Q, user: keyof typeof U) {
  await raw("reset role"); await raw("set local role authenticated");
  await raw("select set_config('request.jwt.claim.sub',$1,true)", [U[user]]);
}
const tm = "insert into time_entries (business_id,project_id,user_id,work_date,minutes,status) values ($1,$2,$3,$4,$5,'draft') returning id";

describe("change control", () => {
  it("needs a reason; only managers decide; rejection needs a note; decisions are final", async () => {
    await as("staffA", async (q, raw) => {
      const { prj } = await project(raw);
      await fails(q, "insert into change_requests (business_id,project_id,title,reason,budget_delta_paise,effort_delta_minutes,deadline_delta_days) values ($1,$2,'More pages',' ',1,1,1)", [A, prj]);
      const id = (await q("insert into change_requests (business_id,project_id,title,reason,budget_delta_paise,effort_delta_minutes,deadline_delta_days) values ($1,$2,'More pages','Client asked',5000000,2400,7) returning id", [A, prj])).rows[0].id;
      expect((await q("update change_requests set status='approved' where id=$1", [id])).rowCount).toBe(0); // RLS: staff can't update
      await become(raw, "managerA");
      await fails(q, "update change_requests set status='rejected' where id=$1", [id]);
      await q("update change_requests set status='approved' where id=$1", [id]);
      await fails(q, "update change_requests set status='rejected', decision_note='x' where id=$1", [id]);
    });
  });
  it("closing a project is blocked by open obligations", async () => {
    await as("managerA", async (q, raw) => {
      const { prj } = await project(raw);
      await q(tm, [A, prj, U.managerA, "2026-12-01", 60]);
      expect(await fails(q, "select public.close_project($1)", [prj])).toBe("cannot close: unapproved time");
      await q("delete from time_entries where project_id=$1", [prj]);
      await q("select public.close_project($1)", [prj]);
      expect((await q("select status from projects where id=$1", [prj])).rows[0].status).toBe("closed");
    });
  });
});

describe("expenses and freelancers", () => {
  it("approved is not paid; no self-approval; approved is immutable; rejection needs a reason", async () => {
    await as("staffA", async (q, raw) => {
      const { prj } = await project(raw);
      const id = (await q("insert into expenses (business_id,project_id,user_id,description,amount_paise,incurred_on,status) values ($1,$2,$3,'Stock photos',250000,'2026-12-01','submitted') returning id", [A, prj, U.staffA])).rows[0].id;
      await become(raw, "managerA");
      await fails(q, "update expenses set paid_at=now() where id=$1", [id]); // not approved yet
      await fails(q, "update expenses set status='rejected' where id=$1", [id]);
      await q("update expenses set status='approved' where id=$1", [id]);
      await fails(q, "update expenses set amount_paise=1 where id=$1", [id]);
      await q("update expenses set paid_at=now() where id=$1", [id]);
    });
    await as("managerA", async (q, raw) => {
      const { prj } = await project(raw);
      const id = (await q("insert into expenses (business_id,project_id,user_id,description,amount_paise,incurred_on,status) values ($1,$2,$3,'Own',100,'2026-12-01','submitted') returning id", [A, prj, U.managerA])).rows[0].id;
      await fails(q, "update expenses set status='approved' where id=$1", [id]);
    });
  });
  it("staff cannot see suppliers, freelancer rates or commitments", async () => {
    await as("managerA", async (q, raw) => {
      const { prj } = await project(raw);
      const s = (await q("insert into suppliers (business_id,name,is_freelancer,hourly_rate_paise) values ($1,'Free Lancer',true,300000) returning id", [A])).rows[0].id;
      await q("insert into commitments (business_id,project_id,supplier_id,description,committed_paise) values ($1,$2,$3,'Illustration',900000)", [A, prj, s]);
      await become(raw, "staffA");
      expect((await q("select * from suppliers")).rowCount).toBe(0);
      expect((await q("select * from commitments")).rowCount).toBe(0);
    });
  });
});

describe("billing", () => {
  async function draft(q: Q, prj: string) {
    return (await q("insert into invoices (business_id,client_id,project_id,kind) values ($1,$2,$3,'time') returning id, number", [A, CL_A, prj])).rows[0];
  }
  it("numbers invoices, requires approval before issue, and freezes lines once approved", async () => {
    await as("managerA", async (q, raw) => {
      const { prj } = await project(raw);
      const inv = await draft(q, prj);
      expect(inv.number).toBe("INV-0001");
      await fails(q, "update invoices set status='approved' where id=$1", [inv.id]); // empty
      await q("insert into invoice_lines (business_id,invoice_id,description,amount_paise) values ($1,$2,'Fee',1000000)", [A, inv.id]);
      await fails(q, "update invoices set status='issued' where id=$1", [inv.id]); // not approved
      await q("update invoices set status='approved' where id=$1", [inv.id]);
      await fails(q, "insert into invoice_lines (business_id,invoice_id,description,amount_paise) values ($1,$2,'Sneaky',1)", [A, inv.id]);
      await q("update invoices set status='issued' where id=$1", [inv.id]);
      expect((await q("select due_on - issued_on d from invoices where id=$1", [inv.id])).rows[0].d).toBe(30);
    });
  });
  it("staff cannot see or approve invoices", async () => {
    await as("managerA", async (q, raw) => {
      const { prj } = await project(raw);
      await draft(q, prj);
      await become(raw, "staffA");
      expect((await q("select * from invoices")).rowCount).toBe(0);
    });
  });
  it("prevents billing the same time entry twice, until the first invoice is voided", async () => {
    await as("managerA", async (q, raw) => {
      const { prj } = await project(raw);
      const t = (await q(tm, [A, prj, U.managerA, "2026-12-01", 60])).rows[0].id;
      const a = await draft(q, prj), b = await draft(q, prj);
      const line = "insert into invoice_lines (business_id,invoice_id,description,amount_paise,source_type,source_id) values ($1,$2,'1h',500000,'time',$3)";
      await q(line, [A, a.id, t]);
      await fails(q, line, [A, b.id, t]);
      await q("update invoices set status='void' where id=$1", [a.id]);
      await q(line, [A, b.id, t]);
    });
  });
  it("tracks partial payments, rejects overpayment, and reports ageing", async () => {
    await as("managerA", async (q, raw) => {
      const { prj } = await project(raw);
      const inv = await draft(q, prj);
      await q("insert into invoice_lines (business_id,invoice_id,description,amount_paise) values ($1,$2,'Fee',1000000)", [A, inv.id]);
      await fails(q, "insert into payments (business_id,invoice_id,amount_paise,received_on) values ($1,$2,1,'2026-12-01')", [A, inv.id]); // draft
      await q("update invoices set status='approved' where id=$1", [inv.id]);
      await q("update invoices set status='issued', issued_on='2026-01-01', due_on='2026-01-31' where id=$1", [inv.id]);
      await q("insert into payments (business_id,invoice_id,amount_paise,received_on) values ($1,$2,400000,'2026-02-01')", [A, inv.id]);
      await fails(q, "insert into payments (business_id,invoice_id,amount_paise,received_on) values ($1,$2,600001,'2026-02-02')", [A, inv.id]);
      const r = (await q("select billed_paise, collected_paise, outstanding_paise, ageing from receivables where id=$1", [inv.id])).rows[0];
      expect(r).toEqual({ billed_paise: 1000000, collected_paise: 400000, outstanding_paise: 600000, ageing: "60+" });
      await fails(q, "update invoices set status='void' where id=$1", [inv.id]); // has payments
      await q("update invoices set disputed=true where id=$1", [inv.id]);
    });
  });
});

describe("retainers", () => {
  it("blocks overage until approved; carries over only when allowed", async () => {
    await as("managerA", async (q, raw) => {
      const { prj } = await project(raw);
      const mk = async (carry: boolean) => (await q("insert into retainers (business_id,client_id,project_id,name,included_minutes,carryover) values ($1,$2,$3,'R',600,$4) returning id", [A, CL_A, prj, carry])).rows[0].id;
      const r = await mk(true);
      const p1 = (await q("select public.roll_retainer($1) as id", [r])).rows[0].id;
      const dates = (await q("select starts_on::text s from retainer_periods where id=$1", [p1])).rows[0].s;
      const ins = "insert into time_entries (business_id,project_id,user_id,work_date,minutes,retainer_period_id) values ($1,$2,$3,$4,$5,$6)";
      await q(ins, [A, prj, U.managerA, dates, 400, p1]);
      await fails(q, ins, [A, prj, U.managerA, dates, 300, p1]); // 700 > 600
      await fails(q, ins, [A, prj, U.managerA, "2020-01-01", 10, p1]); // outside period
      await q("update retainer_periods set overage_approved=true where id=$1", [p1]);
      await q(ins, [A, prj, U.managerA, dates, 300, p1]);
      await q("update retainer_periods set overage_approved=false where id=$1", [p1]);
      // second period: 200 unused? used=700 > 600, so nothing carries
      const p2 = (await q("select public.roll_retainer($1) as id", [r])).rows[0].id;
      expect((await q("select carried_minutes c from retainer_periods where id=$1", [p2])).rows[0].c).toBe(0);
    });
    await as("managerA", async (q, raw) => {
      const { prj } = await project(raw);
      const mk = async (carry: boolean) => (await q("insert into retainers (business_id,client_id,project_id,name,included_minutes,carryover) values ($1,$2,$3,'R',600,$4) returning id", [A, CL_A, prj, carry])).rows[0].id;
      for (const [carry, expected] of [[true, 400], [false, 0]] as const) {
        const r = await mk(carry);
        const p1 = (await q("select public.roll_retainer($1) as id", [r])).rows[0].id;
        const d = (await q("select starts_on::text s from retainer_periods where id=$1", [p1])).rows[0].s;
        await q("insert into time_entries (business_id,project_id,user_id,work_date,minutes,retainer_period_id) values ($1,$2,$3,$4,200,$5)", [A, prj, U.managerA, d, p1]);
        const p2 = (await q("select public.roll_retainer($1) as id", [r])).rows[0].id;
        expect((await q("select carried_minutes c from retainer_periods where id=$1", [p2])).rows[0].c).toBe(expected);
      }
    });
  });
  it("staff cannot approve overage; cancellation needs approved time", async () => {
    await as("managerA", async (q, raw) => {
      const { prj } = await project(raw);
      const r = (await q("insert into retainers (business_id,client_id,project_id,name,included_minutes) values ($1,$2,$3,'R',60) returning id", [A, CL_A, prj])).rows[0].id;
      const p = (await q("select public.roll_retainer($1) as id", [r])).rows[0].id;
      const d = (await q("select starts_on::text s from retainer_periods where id=$1", [p])).rows[0].s;
      await q("insert into time_entries (business_id,project_id,user_id,work_date,minutes,retainer_period_id) values ($1,$2,$3,$4,30,$5)", [A, prj, U.managerA, d, p]);
      expect(await fails(q, "select public.cancel_retainer($1)", [r])).toMatch(/unapproved/);
      await become(raw, "staffA");
      expect((await q("update retainer_periods set overage_approved=true where id=$1", [p])).rowCount).toBe(0);
    });
  });
});

describe("profitability", () => {
  it("labels estimated, committed and actual figures and uses the rate in force on each date", async () => {
    await as("managerA", async (q, raw) => {
      const { prj, res } = await project(raw);
      await raw("reset role");
      await raw("update resources set role_label='Designer' where id=$1", [res]);
      await raw("update resources set user_id=$1 where id=$2", [U.staffA, res]);
      await raw("insert into cost_rates (business_id,role_label,rate_paise,effective_from) values ($1,'Designer',300000,'2026-12-15')", [A]);
      // fixture cost rate: Designer 250000 from 2026-01-01
      await become(raw, "managerA");
      const mk = async (d: string, mins: number) => {
        await raw("reset role");
        await raw("insert into time_entries (business_id,project_id,user_id,work_date,minutes,status,decided_by) values ($1,$2,$3,$4,$5,'approved',$6)", [A, prj, U.staffA, d, mins, U.managerA]);
        await become(raw, "managerA");
      };
      await mk("2026-12-01", 120); // 2h @ 2500 = 5000
      await mk("2026-12-20", 60);  // 1h @ 3000 = 3000
      const s = (await q("insert into suppliers (business_id,name) values ($1,'S') returning id", [A])).rows[0].id;
      await q("insert into commitments (business_id,project_id,supplier_id,description,committed_paise) values ($1,$2,$3,'Open',700000)", [A, prj, s]);
      const f = (await q("select * from project_financials($1)", [prj])).rows[0];
      expect(f.actual_labour_paise).toBe(800000);
      expect(f.committed_open_paise).toBe(700000);
      expect(f.actual_supplier_paise).toBe(0);
      expect(f.invoiced_paise).toBe(0);
    });
  });
  it("is hidden from staff", async () => {
    await as("staffA", async (q, raw) => {
      const { prj } = await project(raw);
      await fails(q, "select * from project_financials($1)", [prj]);
    });
  });
});
