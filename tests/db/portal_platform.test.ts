import { afterAll, describe, expect, it } from "vitest";
import { A, B, CL_A, U, as, fails, pool, type Q } from "./helpers";
import { project } from "./fixtures";

afterAll(() => pool.end());
async function become(raw: Q, user: keyof typeof U) {
  await raw("reset role"); await raw("set local role authenticated");
  await raw("select set_config('request.jwt.claim.sub',$1,true)", [U[user]]);
}
const D = "dddddddd-0000-4000-8000-000000000001", V = "dddddddd-0000-4000-8000-000000000002", V2 = "dddddddd-0000-4000-8000-000000000003";

async function portalFixture(raw: Q, approver: boolean, finance = false) {
  const { prj } = await project(raw);
  const sub = (await raw("select current_setting('request.jwt.claim.sub', true) as s")).rows[0].s;
  await raw("reset role");
  await raw("insert into client_users (business_id,client_id,user_id,can_approve,can_see_finance) values ($1,$2,$3,$4,$5)", [A, CL_A, U.customerA, approver, finance]);
  await raw("insert into deliverables (id,business_id,project_id,name) values ($1,$2,$3,'Logo')", [D, A, prj]);
  await raw("insert into deliverable_versions (id,business_id,deliverable_id,version,shared) values ($1,$2,$3,1,true),($4,$2,$3,2,false)", [V, A, D, V2]);
  await raw("insert into comments (business_id,project_id,author,body,internal) values ($1,$2,$3,'secret',true),($1,$2,$3,'hello client',false)", [A, prj, U.managerA]);
  await raw("set local role authenticated");
  await raw("select set_config('request.jwt.claim.sub',$1,true)", [sub]);
  return prj;
}

describe("client portal", () => {
  it("customers see only shared versions and non-internal comments of their own client", async () => {
    await as("customerA", async (q, raw) => {
      await portalFixture(raw, true);
      expect((await q("select id from deliverable_versions")).rows.map((r) => r.id)).toEqual([V]);
      expect((await q("select body from comments")).rows.map((r) => r.body)).toEqual(["hello client"]);
      expect((await q("select * from projects")).rowCount).toBe(1);
      expect((await q("select * from clients")).rowCount).toBe(0);
    });
  });
  it("a customer of another client sees nothing", async () => {
    await as("customerA", async (q, raw) => {
      await portalFixture(raw, true);
      await raw("reset role");
      await raw("delete from client_users");
      await raw("set local role authenticated");
      expect((await q("select * from deliverable_versions")).rowCount).toBe(0);
      expect((await q("select * from projects")).rowCount).toBe(0);
    });
  });
  it("viewing is recorded but is not approval", async () => {
    await as("customerA", async (q, raw) => {
      await portalFixture(raw, true);
      await q("select public.record_view($1)", [V]);
      expect((await q("select status from deliverable_versions where id=$1", [V])).rows[0].status).toBe("pending");
      expect((await q("select * from portal_views")).rowCount).toBe(1);
    });
  });
  it("only approvers decide; changes need a comment; decisions are final; unshared versions are off limits", async () => {
    await as("customerA", async (q, raw) => {
      await portalFixture(raw, false);
      await fails(q, "select public.decide_version($1,true,null)", [V]);
    });
    await as("customerA", async (q, raw) => {
      await portalFixture(raw, true);
      await fails(q, "select public.decide_version($1,true,null)", [V2]); // not shared
      await fails(q, "select public.decide_version($1,false,' ')", [V]);
      await q("select public.decide_version($1,false,'Make it blue')", [V]);
      await fails(q, "select public.decide_version($1,true,null)", [V]);
      expect((await q("update deliverable_versions set status='approved' where id=$1", [V])).rowCount).toBe(0);
    });
  });
  it("customers cannot write internal comments, and invoices need the finance permission", async () => {
    await as("customerA", async (q, raw) => {
      const prj = await portalFixture(raw, true, false);
      await fails(q, "insert into comments (business_id,project_id,author,body,internal) values ($1,$2,$3,'x',true)", [A, prj, U.customerA]);
      await q("insert into comments (business_id,project_id,author,body,internal) values ($1,$2,$3,'thanks',false)", [A, prj, U.customerA]);
    });
    for (const finance of [false, true]) {
      await as("customerA", async (q, raw) => {
        const prj = await portalFixture(raw, true, finance);
        await raw("reset role");
        await raw("insert into invoices (business_id,client_id,project_id,kind,status) values ($1,$2,$3,'fixed','issued')", [A, CL_A, prj]);
        await raw("set local role authenticated");
        expect((await q("select * from invoices")).rowCount).toBe(finance ? 1 : 0);
      });
    }
  });
});

describe("invitations", () => {
  const token = "t".repeat(32);
  it("owner invites; the matching email accepts once; wrong email, revoked and expired fail", async () => {
    await as("ownerA", async (q, raw) => {
      await raw("reset role");
      await raw("insert into auth.users (id,email) values ('99999999-0000-4000-8000-000000000001','new@a.test'),('99999999-0000-4000-8000-000000000002','other@a.test')");
      await become(raw, "ownerA");
      await fails(q, "select public.create_invitation($1,'new@a.test','staff','short')", [A]);
      const id = (await q("select public.create_invitation($1,'New@A.test','staff',$2) as id", [A, token])).rows[0].id;
      expect((await q("select token_hash from invitations")).rows[0].token_hash.toString()).not.toContain(token); // only a hash is stored
      await raw("select set_config('request.jwt.claim.sub','99999999-0000-4000-8000-000000000002',true)");
      await fails(q, "select public.accept_invitation($1)", [token]); // wrong email
      await raw("select set_config('request.jwt.claim.sub','99999999-0000-4000-8000-000000000001',true)");
      expect((await q("select public.accept_invitation($1) as b", [token])).rows[0].b).toBe(A);
      await fails(q, "select public.accept_invitation($1)", [token]); // single use
      await become(raw, "ownerA");
      const t2 = "u".repeat(32);
      const id2 = (await q("select public.create_invitation($1,'new@a.test','staff',$2) as id", [A, t2])).rows[0].id;
      await q("select public.revoke_invitation($1)", [id2]);
      await raw("select set_config('request.jwt.claim.sub','99999999-0000-4000-8000-000000000001',true)");
      await fails(q, "select public.accept_invitation($1)", [t2]);
      expect(id).toBeTruthy();
    });
  });
  it("managers cannot invite", async () => {
    await as("managerA", async (q) => {
      await fails(q, "select public.create_invitation($1,'x@a.test','staff',$2)", [A, token]);
    });
  });
  it("suspending a member needs an owner and never leaves a business without one", async () => {
    await as("ownerA", async (q) => {
      const m = (id: string) => `c0000000-0000-4000-8000-00000000000${id}`;
      await q("select public.suspend_member($1)", [m("3")]);
      expect((await q("select status from memberships where id=$1", [m("3")])).rows[0].status).toBe("suspended");
      await fails(q, "select public.suspend_member($1)", [m("1")]); // last owner
    });
    await as("managerA", async (q) => {
      await fails(q, "select public.suspend_member('c0000000-0000-4000-8000-000000000003')");
    });
  });
});

describe("plans and entitlements", () => {
  async function plans(raw: Q) {
    await raw("reset role");
    await raw("insert into plans (id,code,name) values ('f0000000-0000-4000-8000-000000000001','starter','Starter')");
    await raw("insert into plan_versions (id,plan_id,version,monthly_paise,max_users,max_branches,effective_from) values ('f0000000-0000-4000-8000-0000000000a1','f0000000-0000-4000-8000-000000000001',1,500000,3,2,'2026-01-01'),('f0000000-0000-4000-8000-0000000000a2','f0000000-0000-4000-8000-000000000001',2,900000,10,5,'2026-06-01')");
    await raw("insert into subscriptions (business_id,plan_version_id,status) values ($1,'f0000000-0000-4000-8000-0000000000a2','active')", [A]);
  }
  it("enforces seat limits on new members and explains downgrades", async () => {
    await as("ownerA", async (q, raw) => {
      await plans(raw); await become(raw, "ownerA");
      // A has 4 non-customer active members (owner, manager, 2 staff)
      await fails(q, "select public.change_plan($1,'f0000000-0000-4000-8000-0000000000a1')", [A]).then((m) => expect(m).toMatch(/4 active users exceed its limit of 3; suspend 1/));
      await q("select public.suspend_member('c0000000-0000-4000-8000-000000000003')");
      await q("select public.change_plan($1,'f0000000-0000-4000-8000-0000000000a1')", [A]);
      expect((await q("select plan_version_id from subscriptions where business_id=$1", [A])).rows[0].plan_version_id).toMatch(/a1$/);
      await raw("reset role");
      await raw("insert into auth.users (id,email) values ('99999999-0000-4000-8000-000000000009','x@a.test')");
      await become(raw, "ownerA");
      await fails(q, "insert into memberships (business_id,user_id,role) values ($1,'99999999-0000-4000-8000-000000000009','staff')", [A]); // already 3 of 3
      await q("insert into memberships (business_id,user_id,role) values ($1,'99999999-0000-4000-8000-000000000009','customer')", [A]); // customers don't use seats
      await raw("reset role");
      await raw("insert into auth.users (id,email) values ('99999999-0000-4000-8000-00000000000a','y@a.test')");
      await become(raw, "ownerA");
      await fails(q, "insert into memberships (business_id,user_id,role) values ($1,'99999999-0000-4000-8000-00000000000a','staff')", [A]);
      await fails(q, "insert into branches (business_id,name) values ($1,'Third')", [A]); // 2 of 2 branches used
    });
  });
  it("only owners/billing manage subscriptions; platform staff see tenants only with a live grant", async () => {
    await as("ownerA", async (q, raw) => {
      await plans(raw);
      await raw("reset role");
      await raw("insert into platform_staff (user_id, role) values ($1,'support')", [U.staffA]);
      await become(raw, "ownerB");
      expect((await q("select * from clients")).rowCount).toBe(1);
      await become(raw, "staffA");
      await raw("reset role"); await raw("delete from memberships where user_id=$1", [U.staffA]); await become(raw, "staffA");
      expect((await q("select * from clients")).rowCount).toBe(0); // no grant
      await fails(q, "insert into support_access (business_id,staff_user_id,reason,approved_by,expires_at) values ($1,$2,'x',$2,now()+interval '1 hour')", [A, U.staffA]); // can't self-approve
      await become(raw, "ownerA");
      await fails(q, "insert into support_access (business_id,staff_user_id,reason,approved_by,expires_at) values ($1,$2,'x',$3,now()+interval '3 days')", [A, U.staffA, U.ownerA]); // too long
      await q("insert into support_access (business_id,staff_user_id,reason,approved_by,expires_at) values ($1,$2,'Debug import',$3,now()+interval '2 hours')", [A, U.staffA, U.ownerA]);
      await become(raw, "staffA");
      expect((await q("select * from clients")).rowCount).toBe(2);
      expect((await q("select * from invoices")).rowCount).toBe(0); // grant exposes only basic records
      await become(raw, "ownerA");
      expect((await q("update subscriptions set status='cancelled' where business_id=$1", [A])).rowCount).toBe(0);
    });
  });
});
