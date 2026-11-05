import { afterAll, describe, expect, it } from "vitest";
import { A, CL_A, U, as, pool, type Q } from "./helpers";

afterAll(() => pool.end());
async function become(raw: Q, user: keyof typeof U) {
  await raw("reset role"); await raw("set local role authenticated");
  await raw("select set_config('request.jwt.claim.sub',$1,true)", [U[user]]);
}

describe("scope acceptance flow", () => {
  it("brief → approved estimate → engagement → allocation → time and expense approval → deliverable approval → invoice → payment → profitability", async () => {
    await as("staffA", async (q, raw) => {
      const CT_OK = "aaaaaaaa-3000-4000-8000-000000000001";
      // Brief, owned and with its question answered.
      const brief = (await q("insert into briefs (business_id,client_id,title,owner_id) values ($1,$2,'Rebrand',$3) returning id", [A, CL_A, U.staffA])).rows[0].id;
      await q("update briefs set status='estimate_requested' where id=$1", [brief]);
      // Estimate with a labour line (₹4,000/h × 10h), internal cost recorded by the manager.
      const est = (await q("select public.new_estimate($1,$2,'Rebrand') as id", [CL_A, brief])).rows[0].id;
      const ver = (await q("select id from estimate_versions where estimate_id=$1", [est])).rows[0].id;
      const line = (await q("insert into estimate_lines (business_id,version_id,kind,description,role_label,hours_centi,rate_paise) values ($1,$2,'labour','Design','Designer',1000,400000) returning id", [A, ver])).rows[0].id;
      await q("update estimate_versions set status='pending_approval' where id=$1", [ver]);
      await become(raw, "managerA");
      await q("insert into estimate_line_costs (line_id,business_id,cost_rate_paise) values ($1,$2,250000)", [line, A]);
      await q("update estimate_versions set status='approved' where id=$1", [ver]);
      await q("update estimate_versions set status='sent' where id=$1", [ver]);
      await q("insert into estimate_acceptances (business_id,version_id,contact_id,recorded_by) values ($1,$2,$3,$4)", [A, ver, CT_OK, U.managerA]);
      const eng = (await q("insert into engagements (business_id,client_id,version_id,name) values ($1,$2,$3,'Rebrand') returning id", [A, CL_A, ver])).rows[0].id;
      const prj = (await q("select public.start_project($1) as id", [eng])).rows[0].id;
      // Capacity: a resource for staff, role Designer; confirmed booking.
      const res = (await q("insert into resources (business_id,user_id,name,role_label) values ($1,$2,'Sam','Designer') returning id", [A, U.staffA])).rows[0].id;
      await q("insert into allocations (business_id,project_id,resource_id,starts_on,ends_on,minutes_per_day,status) values ($1,$2,$3,'2026-12-01','2026-12-04',240,'confirmed')", [A, prj, res]);
      // Staff log and submit 4h; manager approves. Expense likewise.
      await become(raw, "staffA");
      const t = (await q("insert into time_entries (business_id,project_id,user_id,work_date,minutes) values ($1,$2,$3,'2026-12-02',240) returning id", [A, prj, U.staffA])).rows[0].id;
      await q("update time_entries set status='submitted' where id=$1", [t]);
      const ex = (await q("insert into expenses (business_id,project_id,user_id,description,amount_paise,incurred_on,status) values ($1,$2,$3,'Fonts',100000,'2026-12-02','submitted') returning id", [A, prj, U.staffA])).rows[0].id;
      await become(raw, "managerA");
      await q("update time_entries set status='approved' where id=$1", [t]);
      await q("update expenses set status='approved' where id=$1", [ex]);
      // Deliverable shared; client approver approves.
      const d = (await q("insert into deliverables (business_id,project_id,name) values ($1,$2,'Logo') returning id", [A, prj])).rows[0].id;
      const dv = (await q("insert into deliverable_versions (business_id,deliverable_id,version,shared) values ($1,$2,1,true) returning id", [A, d])).rows[0].id;
      await raw("reset role");
      await raw("insert into client_users (business_id,client_id,user_id,can_approve) values ($1,$2,$3,true)", [A, CL_A, U.customerA]);
      await become(raw, "customerA");
      await q("select public.decide_version($1,true,null)", [dv]);
      expect((await q("select status from deliverable_versions where id=$1", [dv])).rows[0].status).toBe("approved");
      // Invoice the approved time at ₹4,000/h, issue, part-pay.
      await become(raw, "managerA");
      const inv = (await q("insert into invoices (business_id,client_id,project_id,kind) values ($1,$2,$3,'time') returning id", [A, CL_A, prj])).rows[0].id;
      await q("insert into invoice_lines (business_id,invoice_id,description,amount_paise,source_type,source_id) values ($1,$2,'4h design',1600000,'time',$3)", [A, inv, t]);
      await q("update invoices set status='approved' where id=$1", [inv]);
      await q("update invoices set status='issued' where id=$1", [inv]);
      await q("insert into payments (business_id,invoice_id,amount_paise,received_on) values ($1,$2,1000000,'2026-12-20')", [A, inv]);
      // Profitability: estimated 40,000 revenue / 25,000 cost; actual labour 4h × 2,500 = 10,000; expenses 1,000.
      const f = (await q("select * from project_financials($1)", [prj])).rows[0];
      expect(f).toMatchObject({ estimated_revenue_paise: 4000000, estimated_cost_paise: 2500000, actual_labour_paise: 1000000, actual_expense_paise: 100000, invoiced_paise: 1600000, collected_paise: 1000000 });
    });
  });
});
