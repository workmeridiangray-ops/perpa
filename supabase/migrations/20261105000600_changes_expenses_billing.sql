-- Change control, expenses, suppliers/freelancers, commitments, invoices, payments.

create table public.milestones (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  project_id uuid not null,
  name text not null check (length(trim(name)) > 0),
  due_on date,
  amount_paise bigint check (amount_paise is null or amount_paise >= 0),
  done boolean not null default false,
  foreign key (project_id, business_id) references public.projects (id, business_id) on delete cascade,
  unique (id, business_id)
);

create table public.change_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  project_id uuid not null,
  title text not null check (length(trim(title)) > 0),
  reason text not null check (length(trim(reason)) > 0),
  budget_delta_paise bigint not null,
  effort_delta_minutes int not null,
  deadline_delta_days int not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decision_note text,
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (project_id, business_id) references public.projects (id, business_id) on delete cascade
);

create function app.guard_change() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.status <> 'pending' then raise exception 'a decided change request is final'; end if;
  if tg_op = 'UPDATE' and new.status <> 'pending' then
    if not app.has_role(new.business_id, 'owner', 'manager') then raise exception 'only an owner or manager can decide changes' using errcode = '42501'; end if;
    if new.status = 'rejected' and coalesce(trim(new.decision_note), '') = '' then raise exception 'a rejection needs a reason'; end if;
    new.decided_by := auth.uid(); new.decided_at := now();
  end if;
  return new;
end $$;
create trigger guard_change before update on public.change_requests for each row execute function app.guard_change();
create trigger audit after insert or update on public.change_requests for each row execute function app.audit();

-- Expenses: approved is not paid.
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  is_freelancer boolean not null default false,
  hourly_rate_paise bigint check (hourly_rate_paise is null or hourly_rate_paise >= 0),
  unique (id, business_id)
);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  project_id uuid not null,
  user_id uuid not null references auth.users (id),
  description text not null check (length(trim(description)) > 0),
  amount_paise bigint not null check (amount_paise > 0),
  incurred_on date not null,
  receipt_path text,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected')),
  reject_reason text,
  decided_by uuid references auth.users (id),
  paid_at timestamptz,
  foreign key (project_id, business_id) references public.projects (id, business_id),
  unique (id, business_id)
);

create function app.guard_expense() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if old.status = 'approved' and (new.amount_paise, new.description, new.project_id) is distinct from (old.amount_paise, old.description, old.project_id) then
      raise exception 'approved expenses are immutable';
    end if;
    if new.paid_at is not null and old.paid_at is null then
      if new.status <> 'approved' then raise exception 'only approved expenses can be paid'; end if;
      if not app.has_role(new.business_id, 'owner', 'manager') then raise exception 'not allowed' using errcode = '42501'; end if;
    end if;
    if new.status in ('approved', 'rejected') and old.status <> new.status then
      if not app.has_role(new.business_id, 'owner', 'manager') then raise exception 'only an owner or manager can decide expenses' using errcode = '42501'; end if;
      if new.user_id = auth.uid() then raise exception 'you cannot decide your own expense'; end if;
      if new.status = 'rejected' and coalesce(trim(new.reject_reason), '') = '' then raise exception 'a rejection needs a reason'; end if;
      new.decided_by := auth.uid();
    end if;
  end if;
  return new;
end $$;
create trigger guard_expense before insert or update on public.expenses for each row execute function app.guard_expense();
create trigger audit after insert or update or delete on public.expenses for each row execute function app.audit();

-- Commitments: committed cost (open) versus actual (once the supplier bill is received).
create table public.commitments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  project_id uuid not null,
  supplier_id uuid not null,
  description text not null check (length(trim(description)) > 0),
  committed_paise bigint not null check (committed_paise >= 0),
  actual_paise bigint check (actual_paise is null or actual_paise >= 0),
  due_on date,
  foreign key (project_id, business_id) references public.projects (id, business_id),
  foreign key (supplier_id, business_id) references public.suppliers (id, business_id)
);

-- Invoices ------------------------------------------------------------------
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  client_id uuid not null,
  project_id uuid,
  number text,
  kind text not null check (kind in ('fixed', 'milestone', 'time', 'retainer')),
  status text not null default 'draft' check (status in ('draft', 'approved', 'issued', 'void')),
  disputed boolean not null default false,
  issued_on date,
  due_on date,
  approved_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  foreign key (client_id, business_id) references public.clients (id, business_id),
  foreign key (project_id, business_id) references public.projects (id, business_id),
  unique (business_id, number),
  unique (id, business_id)
);

create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  invoice_id uuid not null,
  description text not null check (length(trim(description)) > 0),
  amount_paise bigint not null,
  source_type text check (source_type in ('time', 'expense', 'milestone', 'retainer')),
  source_id uuid,
  released boolean not null default false, -- true once the invoice is voided: the source may be billed again
  foreign key (invoice_id, business_id) references public.invoices (id, business_id) on delete cascade,
  check ((source_type is null) = (source_id is null))
);
-- The same time entry / expense / milestone cannot be on two live invoices.
create unique index invoice_lines_source_uq on public.invoice_lines (business_id, source_type, source_id)
  where source_id is not null and not released;

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  invoice_id uuid not null,
  amount_paise bigint not null check (amount_paise > 0),
  received_on date not null,
  reference text not null default '',
  recorded_by uuid references auth.users (id),
  foreign key (invoice_id, business_id) references public.invoices (id, business_id)
);

create function app.invoice_total(i uuid) returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount_paise), 0)::bigint from public.invoice_lines where invoice_id = i $$;
create function app.invoice_paid(i uuid) returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount_paise), 0)::bigint from public.payments where invoice_id = i $$;

create function app.guard_invoice() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.number := coalesce(new.number, app.next_number(new.business_id, 'INV'));
    return new;
  end if;
  if old.status = 'void' then raise exception 'a void invoice is final'; end if;
  if new.status <> old.status then
    if new.status = 'approved' then
      if old.status <> 'draft' then raise exception 'only a draft can be approved'; end if;
      if app.invoice_total(new.id) <= 0 then raise exception 'an invoice needs a positive total'; end if;
      if not app.has_role(new.business_id, 'owner', 'manager') then raise exception 'only an owner or manager can approve' using errcode = '42501'; end if;
      new.approved_by := auth.uid();
    elsif new.status = 'issued' then
      if old.status <> 'approved' then raise exception 'approve before issuing'; end if;
      new.issued_on := coalesce(new.issued_on, current_date);
      new.due_on := coalesce(new.due_on, new.issued_on + 30);
    elsif new.status = 'void' then
      if app.invoice_paid(new.id) > 0 then raise exception 'cannot void an invoice with payments; issue a credit instead'; end if;
      update public.invoice_lines set released = true where invoice_id = new.id;
    end if;
  end if;
  return new;
end $$;
create trigger guard_invoice before insert or update on public.invoices for each row execute function app.guard_invoice();

create function app.guard_invoice_line() returns trigger language plpgsql security definer set search_path = public as $$
declare st text; inv uuid;
begin
  inv := coalesce(new.invoice_id, old.invoice_id);
  select status into st from public.invoices where id = inv;
  if st <> 'draft' and not (tg_op = 'UPDATE' and st = 'void') then raise exception 'only a draft invoice can change lines'; end if;
  return coalesce(new, old);
end $$;
create trigger guard_invoice_line before insert or update or delete on public.invoice_lines for each row execute function app.guard_invoice_line();

create function app.guard_payment() returns trigger language plpgsql security definer set search_path = public as $$
declare st text;
begin
  select status into st from public.invoices where id = new.invoice_id;
  if st <> 'issued' then raise exception 'payments are only recorded on issued invoices'; end if;
  if app.invoice_paid(new.invoice_id) + new.amount_paise > app.invoice_total(new.invoice_id) then
    raise exception 'payment exceeds the outstanding balance';
  end if;
  return new;
end $$;
create trigger guard_payment before insert on public.payments for each row execute function app.guard_payment();

create trigger audit after insert or update or delete on public.invoices for each row execute function app.audit();
create trigger audit after insert or update or delete on public.payments for each row execute function app.audit();

-- Receivables with billed / collected / outstanding and ageing bucket.
create view public.receivables with (security_invoker = true) as
select i.id, i.business_id, i.client_id, i.number, i.status, i.disputed, i.due_on,
       app.invoice_total(i.id) as billed_paise, app.invoice_paid(i.id) as collected_paise,
       app.invoice_total(i.id) - app.invoice_paid(i.id) as outstanding_paise,
       case when i.status <> 'issued' or app.invoice_total(i.id) = app.invoice_paid(i.id) then 'n/a'
            when current_date <= i.due_on then 'current'
            when current_date - i.due_on <= 30 then '1-30'
            when current_date - i.due_on <= 60 then '31-60' else '60+' end as ageing
from public.invoices i;

-- Closing a project checks incomplete work, approvals, invoices and expenses.
create function public.close_project(p_project uuid) returns void language plpgsql security definer set search_path = public as $$
declare b uuid; problems text[] := '{}';
begin
  select business_id into b from public.projects where id = p_project;
  if b is null or not app.has_role(b, 'owner', 'manager') then raise exception 'not allowed' using errcode = '42501'; end if;
  if exists (select 1 from public.change_requests where project_id = p_project and status = 'pending') then problems := array_append(problems, 'pending change requests'::text); end if;
  if exists (select 1 from public.time_entries where project_id = p_project and status in ('draft', 'submitted')) then problems := array_append(problems, 'unapproved time'::text); end if;
  if exists (select 1 from public.expenses where project_id = p_project and status in ('draft', 'submitted')) then problems := array_append(problems, 'unapproved expenses'::text); end if;
  if exists (select 1 from public.invoices where project_id = p_project and status in ('draft', 'approved')) then problems := array_append(problems, 'unissued invoices'::text); end if;
  if exists (select 1 from public.milestones where project_id = p_project and not done) then problems := array_append(problems, 'open milestones'::text); end if;
  if array_length(problems, 1) > 0 then raise exception 'cannot close: %', array_to_string(problems, ', '); end if;
  update public.projects set status = 'closed' where id = p_project;
end $$;
revoke all on function public.close_project(uuid) from public, anon;
grant execute on function public.close_project(uuid) to authenticated;

-- RLS
alter table public.milestones enable row level security;
alter table public.change_requests enable row level security;
alter table public.suppliers enable row level security;
alter table public.expenses enable row level security;
alter table public.commitments enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_lines enable row level security;
alter table public.payments enable row level security;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert, update, delete on public.audit_log from authenticated;

create policy ms_all on public.milestones for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff')) with check (app.has_role(business_id, 'owner', 'manager'));
create policy cr_select on public.change_requests for select to authenticated using (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy cr_insert on public.change_requests for insert to authenticated with check (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy cr_update on public.change_requests for update to authenticated using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));
-- Suppliers and freelancer rates are restricted to owner/manager.
create policy sup_all on public.suppliers for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));
create policy com_all on public.commitments for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));
create policy exp_select on public.expenses for select to authenticated
  using (user_id = auth.uid() and app.role_in(business_id) in ('owner', 'manager', 'staff') or app.has_role(business_id, 'owner', 'manager'));
create policy exp_insert on public.expenses for insert to authenticated
  with check (user_id = auth.uid() and app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy exp_update on public.expenses for update to authenticated
  using (user_id = auth.uid() and status in ('draft', 'rejected') or app.has_role(business_id, 'owner', 'manager'))
  with check (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy exp_delete on public.expenses for delete to authenticated
  using (user_id = auth.uid() and status in ('draft', 'rejected'));
create policy inv_select on public.invoices for select to authenticated using (app.has_role(business_id, 'owner', 'manager'));
create policy inv_write on public.invoices for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));
create policy invl_all on public.invoice_lines for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));
create policy pay_all on public.payments for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));
