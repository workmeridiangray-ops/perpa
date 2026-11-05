import { afterAll, describe, expect, it } from "vitest";
import { A, CL_A, U, as, fails, pool } from "./helpers";
import { project } from "./fixtures";

afterAll(() => pool.end());

const ins = "insert into time_entries (business_id, project_id, user_id, work_date, minutes) values ($1,$2,$3,$4,$5) returning id";

describe("allocations", () => {
  it("tentative never blocks; confirmed over capacity needs an override reason", async () => {
    await as("managerA", async (q, raw) => {
      const { prj, res } = await project(raw);
      const mk = (status: string, mins: number, reason: string | null = null) =>
        q("insert into allocations (business_id,project_id,resource_id,starts_on,ends_on,minutes_per_day,status,override_reason) values ($1,$2,$3,'2026-12-01','2026-12-05',$4,$5,$6)", [A, prj, res, mins, status, reason]);
      await mk("confirmed", 300);
      await mk("tentative", 400); // fine
      await fails(q, "insert into allocations (business_id,project_id,resource_id,starts_on,ends_on,minutes_per_day,status) values ($1,$2,$3,'2026-12-03','2026-12-04',300,'confirmed')", [A, prj, res]);
      await mk("confirmed", 300, "Client escalation, approved by ops");
      await q("insert into allocations (business_id,project_id,resource_id,starts_on,ends_on,minutes_per_day,status) values ($1,$2,$3,'2026-12-08','2026-12-09',480,'confirmed')", [A, prj, res]); // no overlap
    });
  });
  it("staff cannot book", async () => {
    await as("staffA", async (q, raw) => {
      const { prj, res } = await project(raw);
      await fails(q, "insert into allocations (business_id,project_id,resource_id,starts_on,ends_on,minutes_per_day) values ($1,$2,$3,'2026-12-01','2026-12-01',60)", [A, prj, res]);
    });
  });
});

describe("timesheets", () => {
  it("staff log their own time only, see only their own; managers see all", async () => {
    await as("staffA", async (q, raw) => {
      const { prj } = await project(raw);
      await q(ins, [A, prj, U.staffA, "2026-12-01", 120]);
      await fails(q, ins, [A, prj, U.managerA, "2026-12-01", 60]);
      await raw("reset role");
      await raw("insert into time_entries (business_id,project_id,user_id,work_date,minutes) values ($1,$2,$3,'2026-12-01',60)", [A, prj, U.managerA]);
      await raw("set local role authenticated");
      expect((await q("select user_id from time_entries")).rows.map((r) => r.user_id)).toEqual([U.staffA]);
    });
  });
  it("caps a day at 16 hours", async () => {
    await as("staffA", async (q, raw) => {
      const { prj } = await project(raw);
      await q(ins, [A, prj, U.staffA, "2026-12-01", 900]);
      await fails(q, ins, [A, prj, U.staffA, "2026-12-01", 100]);
    });
  });
  it("approval: not self, not staff, rejection needs a reason, approved is immutable, adjustments carry a reason", async () => {
    await as("staffA", async (q, raw) => {
      const { prj } = await project(raw);
      const id = (await q(ins, [A, prj, U.staffA, "2026-12-01", 120])).rows[0].id;
      await q("update time_entries set status='submitted' where id=$1", [id]);
      // Staff can't touch a submitted entry at all: RLS filters it out (0 rows, no error).
      expect((await q("update time_entries set status='approved' where id=$1", [id])).rowCount).toBe(0);
      await raw("reset role"); await raw("set local role authenticated");
      await raw("select set_config('request.jwt.claim.sub',$1,true)", [U.managerA]);
      await fails(q, "update time_entries set status='rejected' where id=$1", [id]);
      await q("update time_entries set status='rejected', reject_reason='wrong project' where id=$1", [id]);
      await q("update time_entries set status='approved', reject_reason=null where id=$1", [id]);
      await fails(q, "update time_entries set minutes=1 where id=$1", [id]);
      await fails(q, "delete from time_entries where id=$1", [id]);
      await fails(q, "insert into time_adjustments (business_id,entry_id,minutes_delta,reason) values ($1,$2,-30,' ')", [A, id]);
      await q("insert into time_adjustments (business_id,entry_id,minutes_delta,reason) values ($1,$2,-30,'billed in error')", [A, id]);
    });
  });
  it("managers cannot approve their own time", async () => {
    await as("managerA", async (q, raw) => {
      const { prj } = await project(raw);
      const id = (await q(ins, [A, prj, U.managerA, "2026-12-01", 60])).rows[0].id;
      await fails(q, "update time_entries set status='approved' where id=$1", [id]);
    });
  });
  it("locked billing periods reject direct entries", async () => {
    await as("ownerA", async (q, raw) => {
      const { prj } = await project(raw);
      await q("insert into billing_periods (business_id,starts_on,ends_on,locked) values ($1,'2026-11-01','2026-11-30',true)", [A]);
      await fails(q, ins, [A, prj, U.ownerA, "2026-11-15", 60]);
      await q(ins, [A, prj, U.ownerA, "2026-12-01", 60]);
    });
  });
});

describe("workflow functions", () => {
  it("new_version copies lines (and costs for managers) only once the latest revision is closed", async () => {
    await as("managerA", async (q) => {
      const e = (await q("select public.new_estimate($1,null,'W') as id", [CL_A])).rows[0].id;
      const v1 = (await q("select id from estimate_versions where estimate_id=$1", [e])).rows[0].id;
      const l = (await q("insert into estimate_lines (business_id,version_id,kind,description,hours_centi,rate_paise) values ($1,$2,'labour','Dev',500,400000) returning id", [A, v1])).rows[0].id;
      await q("insert into estimate_line_costs (line_id,business_id,cost_rate_paise) values ($1,$2,250000)", [l, A]);
      await fails(q, "select public.new_version($1)", [e]);
      await q("update estimate_versions set status='sent' where id=$1", [v1]);
      const v2 = (await q("select public.new_version($1) as id", [e])).rows[0].id;
      expect((await q("select count(*)::int n from estimate_lines where version_id=$1", [v2])).rows[0].n).toBe(1);
      expect((await q("select count(*)::int n from estimate_line_costs c join estimate_lines l on l.id=c.line_id where l.version_id=$1", [v2])).rows[0].n).toBe(1);
      expect((await q("select version from estimate_versions where id=$1", [v2])).rows[0].version).toBe(2);
    });
  });
  it("start_project is manager-only", async () => {
    await as("staffA", async (q) => {
      await fails(q, "select public.start_project('00000000-0000-4000-8000-000000000000')");
    });
  });
});
