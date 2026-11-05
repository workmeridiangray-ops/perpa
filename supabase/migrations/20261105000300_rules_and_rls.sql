-- Helper functions, business rules (triggers), audit, and row-level security.

-- ---------------------------------------------------------------- helpers
create function app.role_in(b uuid) returns public.member_role
language sql stable security definer set search_path = public as $$
  select role from public.memberships
  where business_id = b and user_id = auth.uid() and status = 'active'
$$;

create function app.has_role(b uuid, variadic roles public.member_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(app.role_in(b) = any (roles), false)
$$;

-- Branch scoping: no membership_branches rows = all branches; null branch = business-wide.
create function app.can_see_branch(b uuid, br uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select br is null
    or not exists (
      select 1 from public.membership_branches mb join public.memberships m on m.id = mb.membership_id
      where m.business_id = b and m.user_id = auth.uid())
    or exists (
      select 1 from public.membership_branches mb join public.memberships m on m.id = mb.membership_id
      where m.business_id = b and m.user_id = auth.uid() and mb.branch_id = br)
$$;

create function app.next_number(b uuid, p text) returns text
language plpgsql security definer set search_path = public, app as $$
declare n int;
begin
  insert into app.counters (business_id, prefix, last_value) values (b, p, 1)
  on conflict (business_id, prefix) do update set last_value = app.counters.last_value + 1
  returning last_value into n;
  return p || '-' || lpad(n::text, 4, '0');
end $$;

-- Sign-up: a user creates a business and becomes its owner, with a default branch.
create function public.create_business(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.businesses (name) values (p_name) returning id into b;
  insert into public.memberships (business_id, user_id, role) values (b, auth.uid(), 'owner');
  insert into public.branches (business_id, name) values (b, 'Main');
  return b;
end $$;

create function public.new_estimate(p_client uuid, p_brief uuid, p_title text) returns uuid
language plpgsql security definer set search_path = public as $$
declare b uuid; e uuid;
begin
  select business_id into b from public.clients where id = p_client;
  if b is null or not app.has_role(b, 'owner', 'manager', 'staff') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.estimates (business_id, client_id, brief_id, number, title, created_by)
  values (b, p_client, p_brief, app.next_number(b, 'EST'), p_title, auth.uid()) returning id into e;
  insert into public.estimate_versions (business_id, estimate_id, version) values (b, e, 1);
  return e;
end $$;

-- ------------------------------------------------------------ rule triggers
-- Only owner/manager may approve; approval stamps who/when. Approved+ versions are frozen.
create function app.guard_version() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if old.status in ('approved', 'sent', 'accepted', 'rejected')
       and (new.discount_bps, new.exclusions) is distinct from (old.discount_bps, old.exclusions) then
      raise exception 'version % is locked; create a new version', old.version;
    end if;
    if new.status = 'approved' and old.status <> 'approved' then
      if not app.has_role(new.business_id, 'owner', 'manager') then
        raise exception 'only an owner or manager can approve' using errcode = '42501';
      end if;
      new.approved_by := auth.uid();
      new.approved_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger guard_version before update on public.estimate_versions
  for each row execute function app.guard_version();

create function app.guard_line() returns trigger language plpgsql security definer set search_path = public as $$
declare st public.estimate_status; v uuid;
begin
  v := coalesce(new.version_id, old.version_id);
  select status into st from public.estimate_versions where id = v;
  if st <> 'draft' and st <> 'pending_approval' then
    raise exception 'version is locked; create a new version';
  end if;
  return coalesce(new, old);
end $$;
create trigger guard_line before insert or update or delete on public.estimate_lines
  for each row execute function app.guard_line();

-- Acceptance: contact must belong to the estimate's client and be an authorised approver;
-- version must have been approved internally and sent; records move the version to accepted.
create function app.guard_acceptance() returns trigger language plpgsql security definer set search_path = public as $$
declare v public.estimate_versions; c public.contacts; est public.estimates;
begin
  select * into v from public.estimate_versions where id = new.version_id;
  select * into est from public.estimates where id = v.estimate_id;
  select * into c from public.contacts where id = new.contact_id;
  if v.status <> 'sent' then raise exception 'only a sent revision can be accepted'; end if;
  if c.client_id <> est.client_id then raise exception 'contact does not belong to this client'; end if;
  if not c.is_authorised_approver then raise exception 'contact is not an authorised approver'; end if;
  update public.estimate_versions set status = 'accepted' where id = v.id;
  return new;
end $$;
create trigger guard_acceptance before insert on public.estimate_acceptances
  for each row execute function app.guard_acceptance();

-- Engagements come only from an accepted revision, for that estimate's client.
create function app.guard_engagement() returns trigger language plpgsql security definer set search_path = public as $$
declare v public.estimate_versions; est public.estimates;
begin
  select * into v from public.estimate_versions where id = new.version_id;
  select * into est from public.estimates where id = v.estimate_id;
  if v.status <> 'accepted' then raise exception 'engagement requires an accepted revision'; end if;
  if est.client_id <> new.client_id then raise exception 'client does not match the accepted estimate'; end if;
  return new;
end $$;
create trigger guard_engagement before insert on public.engagements
  for each row execute function app.guard_engagement();

-- Briefs cannot request an estimate without an owner or while questions are open.
create function app.guard_brief() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'estimate_requested' and (tg_op = 'INSERT' or old.status <> 'estimate_requested') then
    if new.owner_id is null then raise exception 'assign an owner before requesting an estimate'; end if;
    if exists (select 1 from public.brief_questions q where q.brief_id = new.id and q.answer is null) then
      raise exception 'resolve open questions before requesting an estimate';
    end if;
  end if;
  return new;
end $$;
create trigger guard_brief before insert or update on public.briefs
  for each row execute function app.guard_brief();

-- ------------------------------------------------------------------ audit
create function app.audit() returns trigger language plpgsql security definer set search_path = public as $$
declare r jsonb; b uuid;
begin
  r := to_jsonb(coalesce(new, old));
  b := (r ->> 'business_id')::uuid;
  if tg_table_name = 'businesses' then b := (r ->> 'id')::uuid; end if;
  insert into public.audit_log (business_id, actor, table_name, row_id, action, old_row, new_row)
  values (b, auth.uid(), tg_table_name, (r ->> 'id')::uuid, tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end $$;
create trigger audit after insert or update or delete on public.memberships for each row execute function app.audit();
create trigger audit after insert or update or delete on public.estimate_versions for each row execute function app.audit();
create trigger audit after insert or update or delete on public.bill_rates for each row execute function app.audit();
create trigger audit after insert or update or delete on public.cost_rates for each row execute function app.audit();
create trigger audit after insert or update or delete on public.estimate_acceptances for each row execute function app.audit();
create trigger audit after insert or update or delete on public.engagements for each row execute function app.audit();

-- -------------------------------------------------------------------- RLS
revoke all on all tables in schema public from anon;
revoke truncate on all tables in schema public from authenticated;
revoke all on schema app from public, anon;
grant usage on schema app to authenticated;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;
revoke execute on function app.next_number(uuid, text) from authenticated;
revoke all on app.counters from public, anon, authenticated;
revoke all on function public.create_business(text), public.new_estimate(uuid, uuid, text) from public, anon;
grant execute on function public.create_business(text), public.new_estimate(uuid, uuid, text) to authenticated;

-- audit_log is append-only via triggers; nobody can write it directly.
revoke insert, update, delete on public.audit_log from authenticated;
grant select on public.audit_log to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert, update, delete on public.audit_log from authenticated;
-- businesses/branches are created through create_business / owner-only policies.

alter table public.profiles enable row level security;
alter table public.businesses enable row level security;
alter table public.branches enable row level security;
alter table public.memberships enable row level security;
alter table public.membership_branches enable row level security;
alter table public.audit_log enable row level security;
alter table public.clients enable row level security;
alter table public.contacts enable row level security;
alter table public.briefs enable row level security;
alter table public.brief_questions enable row level security;
alter table public.bill_rates enable row level security;
alter table public.cost_rates enable row level security;
alter table public.estimates enable row level security;
alter table public.estimate_versions enable row level security;
alter table public.estimate_lines enable row level security;
alter table public.estimate_line_costs enable row level security;
alter table public.estimate_acceptances enable row level security;
alter table public.engagements enable row level security;
alter table app.counters enable row level security;

create policy profiles_self on public.profiles for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy businesses_select on public.businesses for select to authenticated
  using (app.role_in(id) is not null);
create policy businesses_update on public.businesses for update to authenticated
  using (app.has_role(id, 'owner')) with check (app.has_role(id, 'owner'));

create policy branches_select on public.branches for select to authenticated
  using (app.role_in(business_id) is not null);
create policy branches_write on public.branches for all to authenticated
  using (app.has_role(business_id, 'owner')) with check (app.has_role(business_id, 'owner'));

create policy memberships_select on public.memberships for select to authenticated
  using (user_id = auth.uid() or app.has_role(business_id, 'owner', 'manager'));
create policy memberships_write on public.memberships for all to authenticated
  using (app.has_role(business_id, 'owner')) with check (app.has_role(business_id, 'owner'));

create policy mb_select on public.membership_branches for select to authenticated
  using (exists (select 1 from public.memberships m where m.id = membership_id
                 and (m.user_id = auth.uid() or app.has_role(m.business_id, 'owner', 'manager'))));
create policy mb_write on public.membership_branches for all to authenticated
  using (exists (select 1 from public.memberships m where m.id = membership_id and app.has_role(m.business_id, 'owner')))
  with check (exists (select 1 from public.memberships m where m.id = membership_id and app.has_role(m.business_id, 'owner')));

create policy audit_select on public.audit_log for select to authenticated
  using (app.has_role(business_id, 'owner', 'manager'));

-- Staff-facing records: owner/manager/staff read; customers never see internal tables.
create policy clients_select on public.clients for select to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff') and app.can_see_branch(business_id, branch_id));
create policy clients_write on public.clients for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff') and app.can_see_branch(business_id, branch_id))
  with check (app.has_role(business_id, 'owner', 'manager', 'staff') and app.can_see_branch(business_id, branch_id));

create policy contacts_all on public.contacts for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff'))
  with check (app.has_role(business_id, 'owner', 'manager', 'staff'));

create policy briefs_select on public.briefs for select to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff') and app.can_see_branch(business_id, branch_id));
create policy briefs_write on public.briefs for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff') and app.can_see_branch(business_id, branch_id))
  with check (app.has_role(business_id, 'owner', 'manager', 'staff') and app.can_see_branch(business_id, branch_id));

create policy bq_all on public.brief_questions for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff'))
  with check (app.has_role(business_id, 'owner', 'manager', 'staff'));

create policy bill_rates_select on public.bill_rates for select to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy bill_rates_write on public.bill_rates for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));

-- Cost rates and per-line internal cost: owner/manager only (staff cannot even read).
create policy cost_rates_all on public.cost_rates for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));
create policy line_costs_all on public.estimate_line_costs for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));

create policy estimates_all on public.estimates for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff'))
  with check (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy versions_all on public.estimate_versions for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff'))
  with check (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy lines_all on public.estimate_lines for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff'))
  with check (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy acceptances_all on public.estimate_acceptances for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff'))
  with check (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy engagements_all on public.engagements for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff'))
  with check (app.has_role(business_id, 'owner', 'manager', 'staff'));
