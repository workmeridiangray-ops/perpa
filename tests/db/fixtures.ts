import { A, CL_A, U, type Q } from "./helpers";

/** Accepted estimate -> engagement -> project plus one resource, written as superuser; role and identity restored after. */
export async function project(raw: Q) {
  const est = "eeeeeeee-0000-4000-8000-000000000001", ver = "eeeeeeee-0000-4000-8000-000000000002", eng = "eeeeeeee-0000-4000-8000-000000000003";
  const prj = "eeeeeeee-0000-4000-8000-000000000004", res = "eeeeeeee-0000-4000-8000-000000000005";
  // Fixtures are written as the superuser, then the caller's role and identity are restored.
  const sub = (await raw("select current_setting('request.jwt.claim.sub', true) as s")).rows[0].s as string;
  const role = (await raw("select current_user as r")).rows[0].r as string;
  await raw("reset role");
  await raw("insert into estimates (id,business_id,client_id,number,title) values ($1,$2,$3,'EST-9','P')", [est, A, CL_A]);
  await raw("insert into estimate_versions (id,business_id,estimate_id,version,status) values ($1,$2,$3,1,'accepted')", [ver, A, est]);
  await raw("insert into engagements (id,business_id,client_id,version_id,name) values ($1,$2,$3,$4,'E')", [eng, A, CL_A, ver]);
  await raw("insert into projects (id,business_id,engagement_id,name) values ($1,$2,$3,'Proj')", [prj, A, eng]);
  await raw("insert into resources (id,business_id,user_id,name,daily_capacity_minutes) values ($1,$2,$3,'Sam',480)", [res, A, U.staffA]);
  await raw(`set local role ${role}`);
  await raw("select set_config('request.jwt.claim.sub',$1,true)", [sub]);
  return { prj, res };
}
