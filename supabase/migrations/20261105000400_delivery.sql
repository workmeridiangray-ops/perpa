-- Delivery: projects, resources, allocations (tentative/confirmed, conflict-checked),
-- timesheets (approval, locked periods, adjustments).

alter table public.engagements add constraint engagements_id_business_uq unique (id, business_id);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  engagement_id uuid not null unique,
  name text not null check (length(trim(name)) > 0),
  status text not null default 'active' check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  foreign key (engagement_id, business_id) references public.engagements (id, business_id),
  unique (id, business_id)
);

create table public.resources (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid references auth.users (id),
  name text not null check (length(trim(name)) > 0),
  daily_capacity_minutes int not null default 480 check (daily_capacity_minutes between 0 and 1440),
  unique (id, business_id)
);

create table public.allocations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  project_id uuid not null,
  resource_id uuid not null,
  starts_on date not null,
  ends_on date not null,
  minutes_per_day int not null check (minutes_per_day > 0),
  status text not null default 'tentative' check (status in ('tentative', 'confirmed')),
  override_reason text,
  check (ends_on >= starts_on),
  foreign key (project_id, business_id) references public.projects (id, business_id),
  foreign key (resource_id, business_id) references public.resources (id, business_id)
);

-- Confirmed bookings may not exceed a resource's daily capacity unless a reason is recorded.
-- Conservative: sums all overlapping confirmed bookings. Tentative bookings never block.
create function app.guard_allocation() returns trigger language plpgsql security definer set search_path = public as $$
declare cap int; booked int;
begin
  if new.status = 'confirmed' then
    select daily_capacity_minutes into cap from public.resources where id = new.resource_id;
    select coalesce(sum(minutes_per_day), 0) into booked from public.allocations a
      where a.resource_id = new.resource_id and a.status = 'confirmed' and a.id <> new.id
        and a.starts_on <= new.ends_on and a.ends_on >= new.starts_on;
    if booked + new.minutes_per_day > cap and coalesce(trim(new.override_reason), '') = '' then
      raise exception 'allocation conflict: % of % minutes/day already confirmed; give an override reason', booked, cap;
    end if;
  end if;
  return new;
end $$;
create trigger guard_allocation before insert or update on public.allocations
  for each row execute function app.guard_allocation();

create table public.billing_periods (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  locked boolean not null default false,
  check (ends_on >= starts_on)
);

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  project_id uuid not null,
  user_id uuid not null references auth.users (id),
  work_date date not null,
  minutes int not null check (minutes > 0),
  billable boolean not null default true,
  note text not null default '',
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected')),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  reject_reason text,
  foreign key (project_id, business_id) references public.projects (id, business_id),
  unique (id, business_id)
);
create index time_entries_user_date on public.time_entries (business_id, user_id, work_date);

-- Corrections to approved/locked time are separate signed deltas with a mandatory reason.
create table public.time_adjustments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  entry_id uuid not null,
  minutes_delta int not null check (minutes_delta <> 0),
  reason text not null check (length(trim(reason)) > 0),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  foreign key (entry_id, business_id) references public.time_entries (id, business_id)
);

create function app.guard_time() returns trigger language plpgsql security definer set search_path = public as $$
declare total int; locked_period boolean;
begin
  if tg_op = 'UPDATE' and old.status = 'approved' then
    raise exception 'approved time is immutable; add an adjustment';
  end if;
  select exists (select 1 from public.billing_periods p where p.business_id = new.business_id and p.locked
                 and new.work_date between p.starts_on and p.ends_on) into locked_period;
  if locked_period then raise exception 'billing period is locked; add an adjustment'; end if;
  select coalesce(sum(minutes), 0) into total from public.time_entries
    where business_id = new.business_id and user_id = new.user_id and work_date = new.work_date and id <> new.id;
  if total + new.minutes > 960 then raise exception 'more than 16h logged for one day'; end if;
  if new.status in ('approved', 'rejected') and (tg_op = 'INSERT' or old.status <> new.status) then
    if not app.has_role(new.business_id, 'owner', 'manager') then raise exception 'only an owner or manager can decide time' using errcode = '42501'; end if;
    if new.user_id = auth.uid() then raise exception 'you cannot decide your own time'; end if;
    if new.status = 'rejected' and coalesce(trim(new.reject_reason), '') = '' then raise exception 'a rejection needs a reason'; end if;
    new.decided_by := auth.uid(); new.decided_at := now();
  end if;
  return new;
end $$;
create trigger guard_time before insert or update on public.time_entries
  for each row execute function app.guard_time();

create function app.guard_time_delete() returns trigger language plpgsql as $$
begin
  if old.status in ('submitted', 'approved') then raise exception 'only draft or rejected time can be deleted'; end if;
  return old;
end $$;
create trigger guard_time_delete before delete on public.time_entries
  for each row execute function app.guard_time_delete();

create trigger audit after insert or update or delete on public.allocations for each row execute function app.audit();
create trigger audit after insert or update or delete on public.time_entries for each row execute function app.audit();
create trigger audit after insert or update or delete on public.time_adjustments for each row execute function app.audit();
create trigger audit after insert or update or delete on public.billing_periods for each row execute function app.audit();

grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert, update, delete on public.audit_log from authenticated;

alter table public.projects enable row level security;
alter table public.resources enable row level security;
alter table public.allocations enable row level security;
alter table public.billing_periods enable row level security;
alter table public.time_entries enable row level security;
alter table public.time_adjustments enable row level security;

create policy projects_all on public.projects for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff')) with check (app.has_role(business_id, 'owner', 'manager'));
create policy resources_select on public.resources for select to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy resources_write on public.resources for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));
create policy alloc_select on public.allocations for select to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy alloc_write on public.allocations for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));
create policy periods_select on public.billing_periods for select to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy periods_write on public.billing_periods for all to authenticated
  using (app.has_role(business_id, 'owner')) with check (app.has_role(business_id, 'owner'));
-- Staff see and edit only their own time; owner/manager see all.
create policy time_select on public.time_entries for select to authenticated
  using (user_id = auth.uid() and app.role_in(business_id) is not null and app.role_in(business_id) <> 'customer'
         or app.has_role(business_id, 'owner', 'manager'));
create policy time_insert on public.time_entries for insert to authenticated
  with check (app.has_role(business_id, 'owner', 'manager', 'staff') and (user_id = auth.uid() or app.has_role(business_id, 'owner', 'manager')));
create policy time_update on public.time_entries for update to authenticated
  using (user_id = auth.uid() and status in ('draft', 'rejected') or app.has_role(business_id, 'owner', 'manager'))
  with check (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy time_delete on public.time_entries for delete to authenticated
  using (user_id = auth.uid() or app.has_role(business_id, 'owner', 'manager'));
create policy adj_select on public.time_adjustments for select to authenticated
  using (app.has_role(business_id, 'owner', 'manager'));
create policy adj_write on public.time_adjustments for insert to authenticated
  with check (app.has_role(business_id, 'owner', 'manager'));
