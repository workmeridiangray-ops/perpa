-- Retainers (versioned allowances, carryover, overage approval) and project profitability.

create table public.retainers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  client_id uuid not null,
  project_id uuid not null,
  name text not null check (length(trim(name)) > 0),
  included_minutes int not null check (included_minutes > 0),
  carryover boolean not null default false,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  foreign key (client_id, business_id) references public.clients (id, business_id),
  foreign key (project_id, business_id) references public.projects (id, business_id),
  unique (id, business_id)
);

create table public.retainer_periods (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  retainer_id uuid not null,
  starts_on date not null,
  ends_on date not null,
  included_minutes int not null,   -- frozen from the retainer at period creation (rule versioning)
  carried_minutes int not null default 0,
  overage_approved boolean not null default false,
  check (ends_on >= starts_on),
  foreign key (retainer_id, business_id) references public.retainers (id, business_id) on delete cascade,
  unique (id, business_id)
);

alter table public.time_entries add column retainer_period_id uuid;
alter table public.time_entries add foreign key (retainer_period_id, business_id) references public.retainer_periods (id, business_id);
alter table public.resources add column role_label text;

create function app.period_used(p uuid) returns int language sql stable security definer set search_path = public as $$
  select coalesce(sum(minutes), 0)::int from public.time_entries where retainer_period_id = p and status <> 'rejected' $$;

-- Logging beyond the allowance needs the period's overage to have been approved.
create function app.guard_retainer_time() returns trigger language plpgsql security definer set search_path = public as $$
declare per public.retainer_periods; used int;
begin
  if new.retainer_period_id is null then return new; end if;
  select * into per from public.retainer_periods where id = new.retainer_period_id;
  if new.work_date not between per.starts_on and per.ends_on then raise exception 'entry date is outside the retainer period'; end if;
  select coalesce(sum(minutes), 0) into used from public.time_entries where retainer_period_id = per.id and status <> 'rejected' and id <> new.id;
  if used + new.minutes > per.included_minutes + per.carried_minutes and not per.overage_approved then
    raise exception 'retainer allowance exceeded; an owner or manager must approve overage';
  end if;
  return new;
end $$;
create trigger guard_retainer_time before insert or update on public.time_entries for each row execute function app.guard_retainer_time();

create function app.guard_period() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.overage_approved and not old.overage_approved and not app.has_role(new.business_id, 'owner', 'manager') then
    raise exception 'only an owner or manager can approve overage' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_period before update on public.retainer_periods for each row execute function app.guard_period();
create trigger audit after insert or update on public.retainer_periods for each row execute function app.audit();

-- Roll to the next period: carry unused time only if the retainer allows it; cancellation reviews open work.
create function public.roll_retainer(p_retainer uuid) returns uuid language plpgsql security definer set search_path = public as $$
declare r public.retainers; last public.retainer_periods; carry int; n uuid;
begin
  select * into r from public.retainers where id = p_retainer;
  if r.id is null or not app.has_role(r.business_id, 'owner', 'manager') then raise exception 'not allowed' using errcode = '42501'; end if;
  if r.status <> 'active' then raise exception 'retainer is cancelled'; end if;
  select * into last from public.retainer_periods where retainer_id = r.id order by ends_on desc limit 1;
  carry := case when r.carryover and last.id is not null
                then greatest(0, last.included_minutes + last.carried_minutes - app.period_used(last.id)) else 0 end;
  insert into public.retainer_periods (business_id, retainer_id, starts_on, ends_on, included_minutes, carried_minutes)
  values (r.business_id, r.id, coalesce(last.ends_on + 1, date_trunc('month', current_date)::date),
          (coalesce(last.ends_on + 1, date_trunc('month', current_date)::date) + interval '1 month - 1 day')::date,
          r.included_minutes, carry) returning id into n;
  return n;
end $$;

create function public.cancel_retainer(p_retainer uuid) returns void language plpgsql security definer set search_path = public as $$
declare r public.retainers;
begin
  select * into r from public.retainers where id = p_retainer;
  if r.id is null or not app.has_role(r.business_id, 'owner', 'manager') then raise exception 'not allowed' using errcode = '42501'; end if;
  if exists (select 1 from public.time_entries t where t.retainer_period_id in (select id from public.retainer_periods where retainer_id = r.id) and t.status in ('draft', 'submitted')) then
    raise exception 'cannot cancel: unapproved retainer time remains';
  end if;
  update public.retainers set status = 'cancelled' where id = r.id;
end $$;

-- Profitability: every figure is labelled estimated / committed / actual. Owner/manager only.
create function public.project_financials(p_project uuid)
returns table (estimated_revenue_paise bigint, estimated_cost_paise bigint, committed_open_paise bigint,
               actual_labour_paise bigint, actual_expense_paise bigint, actual_supplier_paise bigint,
               invoiced_paise bigint, collected_paise bigint)
language plpgsql stable security definer set search_path = public as $$
declare b uuid; v uuid; sub bigint; disc int;
begin
  select business_id into b from public.projects where id = p_project;
  if b is null or not app.has_role(b, 'owner', 'manager') then raise exception 'not allowed' using errcode = '42501'; end if;
  select e.version_id into v from public.projects p join public.engagements e on e.id = p.engagement_id where p.id = p_project;
  select coalesce(sum(round((case when l.kind = 'labour' then l.hours_centi else l.quantity_centi end)::numeric * l.rate_paise / 100)), 0),
         min(ev.discount_bps)
    into sub, disc from public.estimate_lines l join public.estimate_versions ev on ev.id = l.version_id where l.version_id = v;
  estimated_revenue_paise := sub - round(sub::numeric * coalesce(disc, 0) / 10000);
  select coalesce(sum(round((case when l.kind = 'labour' then l.hours_centi else l.quantity_centi end)::numeric * c.cost_rate_paise / 100)), 0)
    into estimated_cost_paise from public.estimate_lines l join public.estimate_line_costs c on c.line_id = l.id where l.version_id = v;
  select coalesce(sum(committed_paise), 0) into committed_open_paise from public.commitments where project_id = p_project and actual_paise is null;
  select coalesce(sum(actual_paise), 0) into actual_supplier_paise from public.commitments where project_id = p_project;
  select coalesce(sum(amount_paise), 0) into actual_expense_paise from public.expenses where project_id = p_project and status = 'approved';
  -- Labour at the cost rate in force on each work date (effective-dated; history is never rewritten).
  select coalesce(sum(round((t.minutes + coalesce(adj.d, 0))::numeric / 60 * coalesce(cr.rate_paise, 0))), 0) into actual_labour_paise
  from public.time_entries t
  left join lateral (select sum(minutes_delta) d from public.time_adjustments a where a.entry_id = t.id) adj on true
  left join public.resources r on r.business_id = t.business_id and r.user_id = t.user_id
  left join lateral (select rate_paise from public.cost_rates c where c.business_id = t.business_id and c.role_label = r.role_label
                     and c.effective_from <= t.work_date order by c.effective_from desc limit 1) cr on true
  where t.project_id = p_project and t.status = 'approved';
  select coalesce(sum(il.amount_paise), 0) into invoiced_paise from public.invoice_lines il join public.invoices i on i.id = il.invoice_id
    where i.project_id = p_project and i.status = 'issued';
  select coalesce(sum(pm.amount_paise), 0) into collected_paise from public.payments pm join public.invoices i on i.id = pm.invoice_id where i.project_id = p_project;
  return next;
end $$;

revoke all on function public.roll_retainer(uuid), public.cancel_retainer(uuid), public.project_financials(uuid) from public, anon;
grant execute on function public.roll_retainer(uuid), public.cancel_retainer(uuid), public.project_financials(uuid) to authenticated;

alter table public.retainers enable row level security;
alter table public.retainer_periods enable row level security;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert, update, delete on public.audit_log from authenticated;
create policy ret_select on public.retainers for select to authenticated using (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy ret_write on public.retainers for all to authenticated using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));
create policy per_select on public.retainer_periods for select to authenticated using (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy per_write on public.retainer_periods for all to authenticated using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));
