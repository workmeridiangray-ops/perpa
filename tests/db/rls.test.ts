import { afterAll, describe, expect, it } from "vitest";
import { A, B, BR_A2, CL_A, CL_A2, CL_B, U, as, fails, pool } from "./helpers";

afterAll(() => pool.end());

describe("company isolation", () => {
  it("a user sees only their own business's data, everywhere", async () => {
    await as("ownerA", async (q) => {
      expect((await q("select id from businesses")).rows.map((r) => r.id)).toEqual([A]);
      const clients = (await q("select id from clients")).rows.map((r) => r.id);
      expect(clients).toContain(CL_A);
      expect(clients).not.toContain(CL_B);
      expect((await q("select * from memberships where business_id = $1", [B])).rowCount).toBe(0);
      expect((await q("select * from cost_rates where business_id = $1", [B])).rowCount).toBe(0);
    });
  });
  it("guessed identifiers from another business are invisible and unwritable", async () => {
    await as("ownerA", async (q) => {
      expect((await q("select * from clients where id = $1", [CL_B])).rowCount).toBe(0);
      expect((await q("update clients set name = 'x' where id = $1", [CL_B])).rowCount).toBe(0);
      expect((await q("delete from clients where id = $1", [CL_B])).rowCount).toBe(0);
      await fails(q, "insert into clients (business_id, name) values ($1, 'Sneaky')", [B]);
    });
  });
  it("cross-business references are rejected by composite foreign keys", async () => {
    await as("ownerA", async (q, raw) => {
      await fails(raw, "insert into briefs (business_id, client_id, title) values ($1, $2, 'x')", [A, CL_B]);
    });
  });
  it("anonymous users get nothing", async () => {
    await as(null, async (q) => {
      await fails(q, "select * from clients");
    });
  });
});

describe("roles", () => {
  it("customers see no internal records", async () => {
    await as("customerA", async (q) => {
      expect((await q("select * from clients")).rowCount).toBe(0);
      expect((await q("select * from bill_rates")).rowCount).toBe(0);
      await fails(q, "insert into clients (business_id, name) values ($1, 'Nope')", [A]);
    });
  });
  it("staff cannot read cost rates or per-line costs; managers can", async () => {
    await as("staffA", async (q) => {
      expect((await q("select * from cost_rates")).rowCount).toBe(0);
      expect((await q("select * from bill_rates")).rowCount).toBe(1);
      await fails(q, "insert into cost_rates (business_id, role_label, rate_paise, effective_from) values ($1,'X',1,'2026-01-01')", [A]);
    });
    await as("managerA", async (q) => {
      expect((await q("select * from cost_rates")).rowCount).toBe(1);
    });
  });
  it("only owners manage memberships; managers can read them", async () => {
    await as("managerA", async (q) => {
      expect((await q("select * from memberships")).rowCount).toBe(5);
      // RLS hides the row from the write policy: zero rows change, no error.
      expect((await q("update memberships set role = 'owner' where user_id = $1", [U.managerA])).rowCount).toBe(0);
      expect((await q("select role from memberships where user_id = $1", [U.managerA])).rows[0].role).toBe("manager");
    });
    await as("staffA", async (q) => {
      expect((await q("select * from memberships")).rows.map((r) => r.user_id)).toEqual([U.staffA]);
    });
  });
  it("branch-restricted staff see only their branch's clients", async () => {
    await as("staffA2", async (q) => {
      expect((await q("select id from clients")).rows.map((r) => r.id)).toEqual([CL_A2]);
      await fails(q, "insert into clients (business_id, branch_id, name) values ($1,$2,'Elsewhere')", [A, "aaaaaaaa-1000-4000-8000-000000000001"]);
    });
    await as("staffA", async (q) => {
      expect((await q("select id from clients")).rowCount).toBe(2);
    });
  });
});

describe("clients", () => {
  it("rejects case/space-insensitive duplicates among live clients but allows after archive", async () => {
    await as("staffA", async (q) => {
      await fails(q, "insert into clients (business_id, name) values ($1, '  acme   STUDIO')", [A]);
      await q("update clients set archived = true where id = $1", [CL_A]);
      await q("insert into clients (business_id, name) values ($1, 'Acme Studio')", [A]);
    });
  });
});

describe("briefs", () => {
  it("needs an owner and no open questions before requesting an estimate", async () => {
    await as("staffA", async (q) => {
      const b = (await q("insert into briefs (business_id, client_id, title) values ($1,$2,'Site') returning id", [A, CL_A])).rows[0].id;
      await fails(q, "update briefs set status = 'estimate_requested' where id = $1", [b]);
      await q("update briefs set owner_id = $2 where id = $1", [b, U.staffA]);
      await q("insert into brief_questions (business_id, brief_id, question) values ($1,$2,'Budget?')", [A, b]);
      await fails(q, "update briefs set status = 'estimate_requested' where id = $1", [b]);
      await q("update brief_questions set answer = '5L' where brief_id = $1", [b]);
      await q("update briefs set status = 'estimate_requested' where id = $1", [b]);
    });
  });
});

describe("estimate lifecycle", () => {
  async function newEstimate(q: Parameters<Parameters<typeof as>[1]>[0]) {
    const e = (await q("select public.new_estimate($1,null,'Brand site') as id", [CL_A])).rows[0].id;
    const v = (await q("select id from estimate_versions where estimate_id = $1", [e])).rows[0].id;
    return { e, v };
  }

  it("numbers estimates per business", async () => {
    await as("staffA", async (q) => {
      const { e } = await newEstimate(q);
      expect((await q("select number from estimates where id = $1", [e])).rows[0].number).toBe("EST-0001");
      const e2 = (await q("select public.new_estimate($1,null,'Two') as id", [CL_A])).rows[0].id;
      expect((await q("select number from estimates where id = $1", [e2])).rows[0].number).toBe("EST-0002");
    });
  });
  it("cannot create an estimate for another business's client", async () => {
    await as("ownerA", async (q) => {
      await fails(q, "select public.new_estimate($1,null,'x')", [CL_B]);
    });
  });
  it("staff cannot approve; manager can, and approval is stamped and audited", async () => {
    await as("staffA", async (q, raw) => {
      const { v } = await newEstimate(q);
      await fails(q, "update estimate_versions set status = 'approved' where id = $1", [v]);
      await raw("reset role");
      await raw("set local role authenticated");
      await raw("select set_config('request.jwt.claim.sub', $1, true)", [U.managerA]);
      await q("update estimate_versions set status = 'approved' where id = $1", [v]);
      const row = (await q("select approved_by, approved_at from estimate_versions where id = $1", [v])).rows[0];
      expect(row.approved_by).toBe(U.managerA);
      expect(row.approved_at).not.toBeNull();
      const audit = await q("select action from audit_log where table_name = 'estimate_versions' and row_id = $1 order by id", [v]);
      expect(audit.rows.map((r) => r.action)).toEqual(["INSERT", "UPDATE"]);
    });
  });
  it("freezes lines and terms once approved", async () => {
    await as("managerA", async (q) => {
      const { v } = await newEstimate(q);
      await q("insert into estimate_lines (business_id, version_id, kind, description, hours_centi, rate_paise) values ($1,$2,'labour','Design',1000,400000)", [A, v]);
      await q("update estimate_versions set status = 'approved' where id = $1", [v]);
      await fails(q, "insert into estimate_lines (business_id, version_id, kind, description, hours_centi, rate_paise) values ($1,$2,'labour','More',100,1)", [A, v]);
      await fails(q, "update estimate_lines set rate_paise = 1 where version_id = $1", [v]);
      await fails(q, "delete from estimate_lines where version_id = $1", [v]);
      await fails(q, "update estimate_versions set discount_bps = 500 where id = $1", [v]);
    });
  });
  it("keeps per-line internal cost away from staff", async () => {
    await as("managerA", async (q, raw) => {
      const { v } = await newEstimate(q);
      const l = (await q("insert into estimate_lines (business_id, version_id, kind, description, hours_centi, rate_paise) values ($1,$2,'labour','Dev',500,400000) returning id", [A, v])).rows[0].id;
      await q("insert into estimate_line_costs (line_id, business_id, cost_rate_paise) values ($1,$2,250000)", [l, A]);
      await raw("reset role");
      await raw("set local role authenticated");
      await raw("select set_config('request.jwt.claim.sub', $1, true)", [U.staffA]);
      expect((await q("select * from estimate_lines where id = $1", [l])).rowCount).toBe(1);
      expect((await q("select * from estimate_line_costs")).rowCount).toBe(0);
    });
  });
  it("acceptance needs a sent revision and an authorised contact of that client; then one engagement", async () => {
    await as("managerA", async (q) => {
      const { v } = await newEstimate(q);
      const CT_OK = "aaaaaaaa-3000-4000-8000-000000000001";
      const CT_NO = "aaaaaaaa-3000-4000-8000-000000000002";
      await fails(q, "insert into estimate_acceptances (business_id, version_id, contact_id) values ($1,$2,$3)", [A, v, CT_OK]); // not sent
      await q("update estimate_versions set status = 'sent' where id = $1", [v]);
      await fails(q, "insert into estimate_acceptances (business_id, version_id, contact_id) values ($1,$2,$3)", [A, v, CT_NO]);
      await fails(q, "insert into engagements (business_id, client_id, version_id, name) values ($1,$2,$3,'Too early')", [A, CL_A, v]);
      await q("insert into estimate_acceptances (business_id, version_id, contact_id, recorded_by) values ($1,$2,$3,$4)", [A, v, CT_OK, U.managerA]);
      expect((await q("select status from estimate_versions where id = $1", [v])).rows[0].status).toBe("accepted");
      await fails(q, "insert into engagements (business_id, client_id, version_id, name) values ($1,$2,$3,'Wrong client')", [A, CL_A2, v]);
      await q("insert into engagements (business_id, client_id, version_id, name) values ($1,$2,$3,'Brand site')", [A, CL_A, v]);
      await fails(q, "insert into engagements (business_id, client_id, version_id, name) values ($1,$2,$3,'Dup')", [A, CL_A, v]);
    });
  });
});

describe("audit trail", () => {
  it("is readable by owner/manager, hidden from staff, and cannot be written or edited", async () => {
    await as("ownerA", async (q) => {
      await q("insert into bill_rates (business_id, role_label, rate_paise, effective_from) values ($1,'Dev',1,'2026-01-01')", [A]);
      expect((await q("select * from audit_log where table_name = 'bill_rates'")).rowCount).toBeGreaterThan(0);
      await fails(q, "insert into audit_log (business_id, table_name, action) values ($1,'x','x')", [A]);
      await fails(q, "update audit_log set action = 'x'");
      await fails(q, "delete from audit_log");
    });
    await as("staffA", async (q) => {
      expect((await q("select * from audit_log")).rowCount).toBe(0);
    });
  });
});

describe("sign-up", () => {
  it("create_business makes the caller an owner with a default branch", async () => {
    await as("staffA", async (q) => {
      const b = (await q("select public.create_business('New Co') as id")).rows[0].id;
      expect((await q("select role from memberships where business_id = $1", [b])).rows[0].role).toBe("owner");
      expect((await q("select name from branches where business_id = $1", [b])).rows[0].name).toBe("Main");
    });
    await as(null, async (q) => {
      await fails(q, "select public.create_business('x')");
    });
  });
});
