/**
 * Runs queries as a given user inside a transaction (always rolled back), switching to the
 * `authenticated` role and setting the JWT subject exactly as PostgREST does, so auth.uid()
 * and every RLS policy behave as in production. Fixtures are inserted as the superuser in the
 * same transaction before switching role.
 */
import pg from "pg";

pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
export const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });

export const U = {
  ownerA: "a0000000-0000-4000-8000-000000000001",
  managerA: "a0000000-0000-4000-8000-000000000002",
  staffA: "a0000000-0000-4000-8000-000000000003",
  staffA2: "a0000000-0000-4000-8000-000000000005", // restricted to branch A2
  customerA: "a0000000-0000-4000-8000-000000000004",
  ownerB: "b0000000-0000-4000-8000-000000000001",
} as const;
export type UserKey = keyof typeof U;

export const A = "aaaaaaaa-0000-4000-8000-000000000000";
export const B = "bbbbbbbb-0000-4000-8000-000000000000";
export const BR_A1 = "aaaaaaaa-1000-4000-8000-000000000001";
export const BR_A2 = "aaaaaaaa-1000-4000-8000-000000000002";
export const CL_A = "aaaaaaaa-2000-4000-8000-000000000001"; // client, branch A1
export const CL_A2 = "aaaaaaaa-2000-4000-8000-000000000002"; // client, branch A2
export const CL_B = "bbbbbbbb-2000-4000-8000-000000000001";
export const CT_OK = "aaaaaaaa-3000-4000-8000-000000000001"; // authorised approver of CL_A
export const CT_NO = "aaaaaaaa-3000-4000-8000-000000000002"; // not an approver

const FIXTURE = `
insert into auth.users (id, email) values
  ('${U.ownerA}','owner@a.test'),('${U.managerA}','mgr@a.test'),('${U.staffA}','staff@a.test'),
  ('${U.staffA2}','staff2@a.test'),('${U.customerA}','cust@a.test'),('${U.ownerB}','owner@b.test');
insert into businesses (id, name) values ('${A}','Agency A'),('${B}','Agency B');
insert into branches (id, business_id, name) values
  ('${BR_A1}','${A}','North'),('${BR_A2}','${A}','South');
insert into memberships (id, business_id, user_id, role) values
  ('c0000000-0000-4000-8000-000000000001','${A}','${U.ownerA}','owner'),
  ('c0000000-0000-4000-8000-000000000002','${A}','${U.managerA}','manager'),
  ('c0000000-0000-4000-8000-000000000003','${A}','${U.staffA}','staff'),
  ('c0000000-0000-4000-8000-000000000005','${A}','${U.staffA2}','staff'),
  ('c0000000-0000-4000-8000-000000000004','${A}','${U.customerA}','customer'),
  ('c0000000-0000-4000-8000-000000000006','${B}','${U.ownerB}','owner');
insert into membership_branches values ('c0000000-0000-4000-8000-000000000005','${BR_A2}');
insert into clients (id, business_id, branch_id, name) values
  ('${CL_A}','${A}','${BR_A1}','Acme Studio'),('${CL_A2}','${A}','${BR_A2}','Birch & Co'),('${CL_B}','${B}',null,'Zed Ltd');
insert into contacts (id, business_id, client_id, name, is_authorised_approver) values
  ('${CT_OK}','${A}','${CL_A}','Priya',true),('${CT_NO}','${A}','${CL_A}','Intern',false);
insert into bill_rates (business_id, role_label, rate_paise, effective_from) values ('${A}','Designer',400000,'2026-01-01');
insert into cost_rates (business_id, role_label, rate_paise, effective_from) values ('${A}','Designer',250000,'2026-01-01');
`;

export type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;

/** Run `fn` as `user` (or anonymous when null) against freshly inserted fixtures; always rolls back. */
export async function as<T>(user: UserKey | null, fn: (q: Q, raw: Q) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(FIXTURE);
    const raw: Q = (s, p) => c.query(s, p);
    await c.query(user ? "set local role authenticated" : "set local role anon");
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [user ? U[user] : ""]);
    const q: Q = (s, p) => c.query(s, p);
    return await fn(q, raw);
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}

/** Run a statement expected to fail; returns the error message (and rolls back to a savepoint). */
export async function fails(q: Q, sql: string, params?: unknown[]): Promise<string> {
  await q("savepoint s");
  try {
    await q(sql, params);
  } catch (e) {
    await q("rollback to savepoint s");
    return (e as Error).message;
  }
  throw new Error(`expected failure but succeeded: ${sql}`);
}
