-- Client portal, invitations, plans/subscriptions/entitlements, platform admin, support access.

-- ============================ Client portal
create table public.client_users (
  business_id uuid not null,
  client_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  can_approve boolean not null default false,
  can_see_finance boolean not null default false,
  primary key (client_id, user_id),
  foreign key (client_id, business_id) references public.clients (id, business_id) on delete cascade
);

create function app.my_client_ids() returns setof uuid language sql stable security definer set search_path = public as $$
  select cu.client_id from public.client_users cu
  join public.memberships m on m.business_id = cu.business_id and m.user_id = cu.user_id and m.status = 'active' and m.role = 'customer'
  where cu.user_id = auth.uid() $$;

create function app.portal_project(p uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.projects pr join public.engagements e on e.id = pr.engagement_id
                 where pr.id = p and e.client_id in (select app.my_client_ids())) $$;

create table public.deliverables (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  project_id uuid not null,
  name text not null check (length(trim(name)) > 0),
  foreign key (project_id, business_id) references public.projects (id, business_id) on delete cascade,
  unique (id, business_id)
);

create table public.deliverable_versions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  deliverable_id uuid not null,
  version int not null check (version > 0),
  file_path text,
  shared boolean not null default false, -- visible to the client only once shared
  status text not null default 'pending' check (status in ('pending', 'approved', 'changes_requested')),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  comment text,
  foreign key (deliverable_id, business_id) references public.deliverables (id, business_id) on delete cascade,
  unique (deliverable_id, version),
  unique (id, business_id)
);

-- Viewing is recorded but is never treated as acceptance.
create table public.portal_views (
  version_id uuid not null references public.deliverable_versions (id) on delete cascade,
  user_id uuid not null references auth.users (id),
  viewed_at timestamptz not null default now(),
  primary key (version_id, user_id)
);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  project_id uuid not null,
  author uuid not null references auth.users (id),
  body text not null check (length(trim(body)) > 0),
  internal boolean not null default true, -- internal and client-visible discussion are kept apart
  created_at timestamptz not null default now(),
  foreign key (project_id, business_id) references public.projects (id, business_id) on delete cascade
);

create function app.guard_version_decision() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.status <> 'pending' and (new.status, new.file_path) is distinct from (old.status, old.file_path) then
    raise exception 'a decided version is final; upload a new version';
  end if;
  return new;
end $$;
create trigger guard_version_decision before update on public.deliverable_versions for each row execute function app.guard_version_decision();
create trigger audit after insert or update on public.deliverable_versions for each row execute function app.audit();

-- The only way a client decides: must be an approver for that project's client; changes need a comment.
create function public.decide_version(p_version uuid, p_approve boolean, p_comment text) returns void
language plpgsql security definer set search_path = public as $$
declare v public.deliverable_versions; pr uuid; c uuid;
begin
  select * into v from public.deliverable_versions where id = p_version;
  select d.project_id into pr from public.deliverables d where d.id = v.deliverable_id;
  select e.client_id into c from public.projects p join public.engagements e on e.id = p.engagement_id where p.id = pr;
  if v.id is null or not v.shared or not exists (select 1 from public.client_users where client_id = c and user_id = auth.uid() and can_approve)
     or c not in (select app.my_client_ids()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v.status <> 'pending' then raise exception 'already decided'; end if;
  if not p_approve and coalesce(trim(p_comment), '') = '' then raise exception 'say what needs to change'; end if;
  update public.deliverable_versions set status = case when p_approve then 'approved' else 'changes_requested' end,
         decided_by = auth.uid(), decided_at = now(), comment = p_comment where id = p_version;
end $$;

create function public.record_view(p_version uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.portal_views (version_id, user_id)
  select dv.id, auth.uid() from public.deliverable_versions dv join public.deliverables d on d.id = dv.deliverable_id
  where dv.id = p_version and dv.shared and app.portal_project(d.project_id)
  on conflict do nothing;
end $$;

-- ============================ Invitations and member removal
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  email text not null,
  role public.member_role not null,
  token_hash bytea not null unique,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

create function public.create_invitation(p_business uuid, p_email text, p_role public.member_role, p_token text) returns uuid
language plpgsql security definer set search_path = public as $$
declare i uuid;
begin
  if not app.has_role(p_business, 'owner') then raise exception 'only an owner can invite' using errcode = '42501'; end if;
  if length(p_token) < 24 then raise exception 'token too short'; end if;
  insert into public.invitations (business_id, email, role, token_hash, created_by)
  values (p_business, lower(trim(p_email)), p_role, sha256(convert_to(p_token, 'utf8')), auth.uid()) returning id into i;
  return i;
end $$;

create function public.accept_invitation(p_token text) returns uuid language plpgsql security definer set search_path = public as $$
declare inv public.invitations; mail text;
begin
  select * into inv from public.invitations where token_hash = sha256(convert_to(p_token, 'utf8'));
  select lower(email) into mail from auth.users where id = auth.uid();
  if inv.id is null or inv.revoked_at is not null or inv.accepted_at is not null or inv.expires_at < now() then
    raise exception 'this invitation is invalid, expired or revoked';
  end if;
  if mail is distinct from inv.email then raise exception 'this invitation was sent to a different email address'; end if;
  insert into public.memberships (business_id, user_id, role) values (inv.business_id, auth.uid(), inv.role)
  on conflict (business_id, user_id) do update set role = excluded.role, status = 'active';
  update public.invitations set accepted_at = now() where id = inv.id;
  return inv.business_id;
end $$;

create function public.revoke_invitation(p_invitation uuid) returns void language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  select business_id into b from public.invitations where id = p_invitation;
  if b is null or not app.has_role(b, 'owner') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.invitations set revoked_at = now() where id = p_invitation and accepted_at is null;
end $$;

-- Removing access suspends the membership and ends the person's sessions where the auth schema has them.
create function public.suspend_member(p_membership uuid) returns void language plpgsql security definer set search_path = public as $$
declare m public.memberships;
begin
  select * into m from public.memberships where id = p_membership;
  if m.id is null or not app.has_role(m.business_id, 'owner') then raise exception 'not allowed' using errcode = '42501'; end if;
  if m.role = 'owner' and (select count(*) from public.memberships where business_id = m.business_id and role = 'owner' and status = 'active') <= 1 then
    raise exception 'a business needs at least one active owner';
  end if;
  update public.memberships set status = 'suspended' where id = m.id;
  if to_regclass('auth.sessions') is not null then execute 'delete from auth.sessions where user_id = $1' using m.user_id; end if;
end $$;

-- ============================ Plans, subscriptions, entitlements
create table public.plans (id uuid primary key default gen_random_uuid(), code text not null unique, name text not null);
create table public.plan_versions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans (id),
  version int not null,
  monthly_paise bigint not null check (monthly_paise >= 0),
  max_users int not null check (max_users > 0),
  max_branches int not null check (max_branches > 0),
  effective_from date not null,
  unique (plan_id, version)
);
create table public.subscriptions (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  plan_version_id uuid not null references public.plan_versions (id), -- old versions keep billing history
  status text not null default 'trial' check (status in ('trial', 'active', 'past_due', 'cancelled')),
  trial_ends_on date,
  current_period_end date,
  grace_until date
);
create table public.platform_staff (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'billing', 'support', 'ops'))
);
create table public.support_access (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  staff_user_id uuid not null references public.platform_staff (user_id),
  reason text not null check (length(trim(reason)) > 0),
  approved_by uuid not null references auth.users (id),
  expires_at timestamptz not null check (expires_at <= now() + interval '24 hours'),
  created_at timestamptz not null default now()
);

create function app.is_platform(variadic roles text[]) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = any (roles) from public.platform_staff where user_id = auth.uid()), false) $$;
create function app.has_support_access(b uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.support_access where business_id = b and staff_user_id = auth.uid() and expires_at > now()) $$;

create function app.limits(b uuid) returns table (max_users int, max_branches int) language sql stable security definer set search_path = public as $$
  select pv.max_users, pv.max_branches from public.subscriptions s join public.plan_versions pv on pv.id = s.plan_version_id
  where s.business_id = b and s.status <> 'cancelled' $$;

create function app.guard_seats() returns trigger language plpgsql security definer set search_path = public as $$
declare lim int; n int;
begin
  if new.status = 'active' and new.role <> 'customer' then
    select max_users into lim from app.limits(new.business_id);
    if lim is not null then
      select count(*) into n from public.memberships where business_id = new.business_id and status = 'active' and role <> 'customer' and id <> new.id;
      if n + 1 > lim then raise exception 'plan limit reached: % of % users in use', n, lim using errcode = '53400'; end if;
    end if;
  end if;
  return new;
end $$;
create trigger guard_seats before insert or update on public.memberships for each row execute function app.guard_seats();

create function public.change_plan(p_business uuid, p_plan_version uuid) returns void language plpgsql security definer set search_path = public as $$
declare pv public.plan_versions; users int; branches int;
begin
  if not (app.has_role(p_business, 'owner') or app.is_platform('owner', 'billing')) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into pv from public.plan_versions where id = p_plan_version;
  select count(*) into users from public.memberships where business_id = p_business and status = 'active' and role <> 'customer';
  select count(*) into branches from public.branches where business_id = p_business;
  if users > pv.max_users then raise exception 'cannot move to this plan: % active users exceed its limit of %; suspend % first', users, pv.max_users, users - pv.max_users; end if;
  if branches > pv.max_branches then raise exception 'cannot move to this plan: % branches exceed its limit of %', branches, pv.max_branches; end if;
  insert into public.subscriptions (business_id, plan_version_id, status) values (p_business, p_plan_version, 'active')
  on conflict (business_id) do update set plan_version_id = excluded.plan_version_id;
end $$;

create function app.guard_branch_limit() returns trigger language plpgsql security definer set search_path = public as $$
declare lim int; n int;
begin
  select max_branches into lim from app.limits(new.business_id);
  select count(*) into n from public.branches where business_id = new.business_id;
  if lim is not null and n + 1 > lim then raise exception 'plan limit reached: % of % branches', n, lim using errcode = '53400'; end if;
  return new;
end $$;
create trigger guard_branch_limit before insert on public.branches for each row execute function app.guard_branch_limit();

create trigger audit after insert or update or delete on public.subscriptions for each row execute function app.audit();
create trigger audit after insert on public.support_access for each row execute function app.audit();

-- ============================ RLS
alter table public.client_users enable row level security;
alter table public.deliverables enable row level security;
alter table public.deliverable_versions enable row level security;
alter table public.portal_views enable row level security;
alter table public.comments enable row level security;
alter table public.invitations enable row level security;
alter table public.plans enable row level security;
alter table public.plan_versions enable row level security;
alter table public.subscriptions enable row level security;
alter table public.platform_staff enable row level security;
alter table public.support_access enable row level security;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert, update, delete on public.audit_log from authenticated;
revoke all on function public.create_invitation(uuid, text, public.member_role, text), public.accept_invitation(text), public.revoke_invitation(uuid),
  public.suspend_member(uuid), public.change_plan(uuid, uuid), public.decide_version(uuid, boolean, text), public.record_view(uuid) from public, anon;
grant execute on function public.create_invitation(uuid, text, public.member_role, text), public.accept_invitation(text), public.revoke_invitation(uuid),
  public.suspend_member(uuid), public.change_plan(uuid, uuid), public.decide_version(uuid, boolean, text), public.record_view(uuid) to authenticated;

create policy cu_select on public.client_users for select to authenticated
  using (user_id = auth.uid() or app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy cu_write on public.client_users for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));

-- Customers read only their own client's shared material.
create policy projects_portal on public.projects for select to authenticated using (app.portal_project(id));
create policy deliv_staff on public.deliverables for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff')) with check (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy deliv_portal on public.deliverables for select to authenticated using (app.portal_project(project_id));
create policy dv_staff on public.deliverable_versions for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff')) with check (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy dv_portal on public.deliverable_versions for select to authenticated
  using (shared and exists (select 1 from public.deliverables d where d.id = deliverable_id and app.portal_project(d.project_id)));
create policy views_select on public.portal_views for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.deliverable_versions v where v.id = version_id and app.has_role(v.business_id, 'owner', 'manager', 'staff')));
create policy comments_staff on public.comments for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff')) with check (app.has_role(business_id, 'owner', 'manager', 'staff') and author = auth.uid());
create policy comments_portal_select on public.comments for select to authenticated using (not internal and app.portal_project(project_id));
create policy comments_portal_insert on public.comments for insert to authenticated
  with check (not internal and author = auth.uid() and app.portal_project(project_id));
create policy inv_portal on public.invoices for select to authenticated
  using (status = 'issued' and client_id in (select app.my_client_ids())
         and exists (select 1 from public.client_users cu where cu.client_id = invoices.client_id and cu.user_id = auth.uid() and cu.can_see_finance));

create policy invitations_owner on public.invitations for select to authenticated using (app.has_role(business_id, 'owner'));
create policy plans_read on public.plans for select to authenticated using (true);
create policy planv_read on public.plan_versions for select to authenticated using (true);
create policy plans_admin on public.plans for all to authenticated using (app.is_platform('owner', 'billing')) with check (app.is_platform('owner', 'billing'));
create policy planv_admin on public.plan_versions for all to authenticated using (app.is_platform('owner', 'billing')) with check (app.is_platform('owner', 'billing'));
create policy sub_select on public.subscriptions for select to authenticated
  using (app.has_role(business_id, 'owner', 'manager') or app.is_platform('owner', 'billing', 'support', 'ops'));
create policy sub_admin on public.subscriptions for all to authenticated
  using (app.is_platform('owner', 'billing')) with check (app.is_platform('owner', 'billing'));
create policy ps_select on public.platform_staff for select to authenticated using (user_id = auth.uid() or app.is_platform('owner'));
create policy ps_write on public.platform_staff for all to authenticated using (app.is_platform('owner')) with check (app.is_platform('owner'));
-- Support access: granted by the business owner (not by platform staff), time limited, read by both.
create policy sa_select on public.support_access for select to authenticated
  using (staff_user_id = auth.uid() or app.has_role(business_id, 'owner') or app.is_platform('owner'));
create policy sa_insert on public.support_access for insert to authenticated
  with check (app.has_role(business_id, 'owner') and approved_by = auth.uid());
-- Platform staff see tenants' basic records only while an approved grant is live.
create policy businesses_platform on public.businesses for select to authenticated
  using (app.is_platform('owner', 'billing', 'ops') or app.has_support_access(id));
create policy clients_support on public.clients for select to authenticated using (app.has_support_access(business_id));
