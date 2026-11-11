-- Credit notes and statements, job queue (email/webhooks) with retries, notifications, API keys and webhooks,
-- saved views, custom fields, templates/checklists, tickets, leave & schedules, offboarding,
-- platform operations (coupons, refunds, charges, incidents, announcements), files with scan gate, export & closure.

-- ===================================================================== A. credit notes, statements
create table public.credit_notes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  invoice_id uuid not null,
  number text,
  amount_paise bigint not null check (amount_paise > 0),
  reason text not null check (length(trim(reason)) > 0),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  foreign key (invoice_id, business_id) references public.invoices (id, business_id)
);
create function app.invoice_credited(i uuid) returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount_paise), 0)::bigint from public.credit_notes where invoice_id = i $$;

create function app.guard_credit() returns trigger language plpgsql security definer set search_path = public as $$
declare st text;
begin
  select status into st from public.invoices where id = new.invoice_id;
  if st <> 'issued' then raise exception 'credit notes apply to issued invoices only'; end if;
  if app.invoice_paid(new.invoice_id) + app.invoice_credited(new.invoice_id) + new.amount_paise > app.invoice_total(new.invoice_id) then
    raise exception 'credit exceeds the outstanding balance';
  end if;
  new.number := app.next_number(new.business_id, 'CN');
  new.created_by := auth.uid();
  return new;
end $$;
create trigger guard_credit before insert on public.credit_notes for each row execute function app.guard_credit();
create trigger audit after insert on public.credit_notes for each row execute function app.audit();

create or replace function app.guard_payment() returns trigger language plpgsql security definer set search_path = public as $$
declare st text;
begin
  select status into st from public.invoices where id = new.invoice_id;
  if st <> 'issued' then raise exception 'payments are only recorded on issued invoices'; end if;
  if app.invoice_paid(new.invoice_id) + app.invoice_credited(new.invoice_id) + new.amount_paise > app.invoice_total(new.invoice_id) then
    raise exception 'payment exceeds the outstanding balance';
  end if;
  return new;
end $$;

drop view public.receivables;
create view public.receivables with (security_invoker = true) as
select i.id, i.business_id, i.client_id, i.number, i.status, i.disputed, i.due_on,
       app.invoice_total(i.id) as billed_paise, app.invoice_paid(i.id) as collected_paise,
       app.invoice_credited(i.id) as credited_paise,
       app.invoice_total(i.id) - app.invoice_paid(i.id) - app.invoice_credited(i.id) as outstanding_paise,
       case when i.status <> 'issued' or app.invoice_total(i.id) = app.invoice_paid(i.id) + app.invoice_credited(i.id) then 'n/a'
            when current_date <= i.due_on then 'current'
            when current_date - i.due_on <= 30 then '1-30'
            when current_date - i.due_on <= 60 then '31-60' else '60+' end as ageing
from public.invoices i;

-- Client statement: invoices (debit), payments and credit notes (credit) with running balance. Runs under the caller's RLS.
create function public.client_statement(p_client uuid, p_from date, p_to date)
returns table (on_date date, document text, debit_paise bigint, credit_paise bigint, balance_paise bigint)
language sql stable security invoker as $$
  with ev as (
    select i.issued_on as d, i.number as doc, app.invoice_total(i.id) as debit, 0::bigint as credit, 1 as ord
      from public.invoices i where i.client_id = p_client and i.status = 'issued' and i.issued_on <= p_to
    union all
    select p.received_on, 'Payment ' || coalesce(nullif(p.reference, ''), i.number), 0, p.amount_paise, 2
      from public.payments p join public.invoices i on i.id = p.invoice_id where i.client_id = p_client and p.received_on <= p_to
    union all
    select c.created_at::date, c.number, 0, c.amount_paise, 3
      from public.credit_notes c join public.invoices i on i.id = c.invoice_id where i.client_id = p_client and c.created_at::date <= p_to
  ), run as (select d, doc, debit, credit, ord, sum(debit - credit) over (order by d, ord, doc) as bal from ev)
  select d, doc, debit, credit, bal from run where d >= p_from order by d, ord, doc $$;

-- ===================================================================== B. job queue, notifications
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid,
  kind text not null check (kind in ('email', 'webhook')),
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'dead')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  run_after timestamptz not null default now(),
  last_error text,
  dedupe_key text unique,           -- a retried callback or double click cannot enqueue the same work twice
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index jobs_due on public.jobs (run_after) where status in ('queued', 'failed');

create function app.enqueue(p_business uuid, p_kind text, p_payload jsonb, p_dedupe text) returns void
language sql security definer set search_path = public as $$
  insert into public.jobs (business_id, kind, payload, dedupe_key) values (p_business, p_kind, p_payload, p_dedupe) on conflict (dedupe_key) do nothing $$;

-- Worker API (service role only): claim, complete, fail with exponential backoff, dead-letter after max attempts.
create function public.claim_jobs(p_limit int) returns setof public.jobs language sql security definer set search_path = public as $$
  update public.jobs j set status = 'running', attempts = attempts + 1
  where j.id in (select id from public.jobs where status in ('queued', 'failed') and run_after <= now() order by run_after limit p_limit for update skip locked)
  returning j.* $$;
create function public.complete_job(p_id uuid) returns void language sql security definer set search_path = public as $$
  update public.jobs set status = 'done', finished_at = now(), last_error = null where id = p_id $$;
create function public.fail_job(p_id uuid, p_error text) returns void language sql security definer set search_path = public as $$
  update public.jobs set last_error = left(p_error, 500),
    status = case when attempts >= max_attempts then 'dead' else 'failed' end,
    run_after = now() + (interval '1 minute' * power(2, attempts)) where id = p_id $$;
-- Safe manual retry by platform ops: only failed/dead jobs, one more bounded round.
create function public.retry_job(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not app.is_platform('owner', 'ops') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.jobs set status = 'queued', run_after = now(), max_attempts = attempts + 3, last_error = null where id = p_id and status in ('failed', 'dead');
end $$;

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user on public.notifications (user_id, created_at desc);

create function app.notify(p_business uuid, p_user uuid, p_title text, p_link text, p_key text) returns void
language plpgsql security definer set search_path = public as $$
declare mail text;
begin
  if p_user is null or p_user = auth.uid() then return; end if;
  insert into public.notifications (business_id, user_id, title, link) values (p_business, p_user, p_title, p_link);
  select email into mail from public.profiles where id = p_user;
  if coalesce(mail, '') <> '' then
    perform app.enqueue(p_business, 'email', jsonb_build_object('to', mail, 'subject', p_title, 'text', p_title || coalesce(' — ' || p_link, '')), p_key || ':' || p_user);
  end if;
end $$;

create function app.notify_managers(p_business uuid, p_title text, p_link text, p_key text) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  for u in select user_id from public.memberships where business_id = p_business and status = 'active' and role in ('owner', 'manager') loop
    perform app.notify(p_business, u, p_title, p_link, p_key);
  end loop;
end $$;

create function app.on_time_submitted() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'submitted' and (tg_op = 'INSERT' or old.status <> 'submitted') then
    perform app.notify_managers(new.business_id, 'Time submitted for review', '/w/' || new.business_id || '/time', 'time:' || new.id);
  elsif new.status in ('approved', 'rejected') and tg_op = 'UPDATE' and old.status <> new.status then
    perform app.notify(new.business_id, new.user_id, 'Your time was ' || new.status, '/w/' || new.business_id || '/time', 'timed:' || new.id || new.status);
  end if;
  return new;
end $$;
create trigger notify_time after insert or update on public.time_entries for each row execute function app.on_time_submitted();

create function app.on_estimate_pending() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'pending_approval' and (tg_op = 'INSERT' or old.status <> 'pending_approval') then
    perform app.notify_managers(new.business_id, 'Estimate awaiting approval', '/w/' || new.business_id || '/estimates/' || new.estimate_id, 'est:' || new.id);
  end if;
  return new;
end $$;
create trigger notify_estimate after insert or update on public.estimate_versions for each row execute function app.on_estimate_pending();

create function app.on_change_request() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform app.notify_managers(new.business_id, 'Change request: ' || new.title, '/w/' || new.business_id || '/projects/' || new.project_id, 'cr:' || new.id);
  end if;
  return new;
end $$;
create trigger notify_change after insert on public.change_requests for each row execute function app.on_change_request();

create function app.on_proof_decided() returns trigger language plpgsql security definer set search_path = public as $$
declare pr uuid;
begin
  if new.status <> 'pending' and old.status = 'pending' then
    select project_id into pr from public.deliverables where id = new.deliverable_id;
    perform app.notify_managers(new.business_id, 'Client ' || replace(new.status, '_', ' ') || ' a proof', '/w/' || new.business_id || '/projects/' || pr, 'proof:' || new.id);
  end if;
  return new;
end $$;
create trigger notify_proof after update on public.deliverable_versions for each row execute function app.on_proof_decided();

-- Review delays: proofs waiting on clients and time waiting on managers (viewing is never treated as acceptance).
alter table public.deliverable_versions add column shared_at timestamptz;
alter table public.time_entries add column submitted_at timestamptz;
create function app.stamp_share() returns trigger language plpgsql as $$
begin
  if new.shared and (tg_op = 'INSERT' or not old.shared) then new.shared_at := now(); end if;
  return new;
end $$;
create function app.stamp_submit() returns trigger language plpgsql as $$
begin
  if new.status = 'submitted' and (tg_op = 'INSERT' or old.status <> 'submitted') then new.submitted_at := now(); end if;
  return new;
end $$;
create trigger stamp_dv before insert or update on public.deliverable_versions for each row execute function app.stamp_share();
create trigger stamp_te before insert or update on public.time_entries for each row execute function app.stamp_submit();
create function public.review_delays(p_business uuid, p_days int default 5)
returns table (kind text, ref text, waiting_days int) language sql stable security invoker as $$
  select 'client proof', d.name || ' v' || v.version, (current_date - v.shared_at::date)
    from public.deliverable_versions v join public.deliverables d on d.id = v.deliverable_id
    where v.business_id = p_business and v.shared and v.status = 'pending' and v.shared_at::date <= current_date - p_days
  union all
  select 'timesheet', t.work_date::text, (current_date - t.submitted_at::date)
    from public.time_entries t where t.business_id = p_business and t.status = 'submitted' and t.submitted_at::date <= current_date - p_days $$;

-- ===================================================================== C. API keys, webhooks
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  prefix text not null,
  key_hash bytea not null unique,
  created_by uuid references auth.users (id),
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create function public.create_api_key(p_business uuid, p_name text, p_key text) returns uuid
language plpgsql security definer set search_path = public as $$
declare i uuid;
begin
  if not app.has_role(p_business, 'owner') then raise exception 'only an owner can create API keys' using errcode = '42501'; end if;
  if length(p_key) < 32 then raise exception 'key too short'; end if;
  insert into public.api_keys (business_id, name, prefix, key_hash, created_by)
  values (p_business, p_name, left(p_key, 8), sha256(convert_to(p_key, 'utf8')), auth.uid()) returning id into i;
  return i;
end $$;
create function public.revoke_api_key(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  select business_id into b from public.api_keys where id = p_id;
  if b is null or not app.has_role(b, 'owner') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.api_keys set revoked_at = now() where id = p_id;
end $$;
-- Used only by the server-side API route (service role) to resolve a presented key.
create function public.resolve_api_key(p_key text) returns uuid language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  update public.api_keys set last_used_at = now() where key_hash = sha256(convert_to(p_key, 'utf8')) and revoked_at is null returning business_id into b;
  return b;
end $$;

create table public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  url text not null check (url ~ '^https://'),
  secret text not null check (length(secret) >= 24),
  events text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.webhook_logs (
  id bigint generated always as identity primary key,
  business_id uuid not null,
  endpoint_id uuid not null,
  event text not null,
  status_code int,
  ok boolean not null,
  error text,
  at timestamptz not null default now()
);

create function app.emit(p_business uuid, p_event text, p_row uuid, p_data jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare e record;
begin
  for e in select id from public.webhook_endpoints where business_id = p_business and active and (events = '{}' or p_event = any (events)) loop
    perform app.enqueue(p_business, 'webhook', jsonb_build_object('endpoint', e.id, 'event', p_event, 'data', p_data || jsonb_build_object('id', p_row)), 'wh:' || e.id || ':' || p_event || ':' || p_row);
  end loop;
end $$;
create function app.emit_invoice() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'issued' and old.status <> 'issued' then perform app.emit(new.business_id, 'invoice.issued', new.id, jsonb_build_object('number', new.number)); end if;
  return new;
end $$;
create trigger emit_invoice after update on public.invoices for each row execute function app.emit_invoice();
create function app.emit_payment() returns trigger language plpgsql security definer set search_path = public as $$
begin perform app.emit(new.business_id, 'payment.received', new.id, jsonb_build_object('invoice', new.invoice_id, 'amount_paise', new.amount_paise)); return new; end $$;
create trigger emit_payment after insert on public.payments for each row execute function app.emit_payment();
create function app.emit_accept() returns trigger language plpgsql security definer set search_path = public as $$
begin perform app.emit(new.business_id, 'estimate.accepted', new.id, jsonb_build_object('version', new.version_id)); return new; end $$;
create trigger emit_accept after insert on public.estimate_acceptances for each row execute function app.emit_accept();

-- ===================================================================== D. saved views, custom fields
create table public.saved_views (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  screen text not null,
  name text not null check (length(trim(name)) > 0),
  params jsonb not null default '{}',
  unique (user_id, business_id, screen, name)
);

create table public.custom_fields (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  entity text not null check (entity in ('client', 'project')),
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text not null,
  type text not null check (type in ('text', 'number', 'date')),
  required boolean not null default false,
  unique (business_id, entity, key)
);
alter table public.clients add column custom jsonb not null default '{}';
alter table public.projects add column custom jsonb not null default '{}';

create function app.guard_custom() returns trigger language plpgsql security definer set search_path = public as $$
declare ent text := tg_argv[0]; k text; f record; v jsonb;
begin
  for k in select jsonb_object_keys(new.custom) loop
    select * into f from public.custom_fields where business_id = new.business_id and entity = ent and key = k;
    if f.id is null then raise exception 'unknown custom field %', k; end if;
    v := new.custom -> k;
    if f.type = 'number' and jsonb_typeof(v) <> 'number' then raise exception 'custom field % must be a number', k; end if;
    if f.type = 'text' and jsonb_typeof(v) <> 'string' then raise exception 'custom field % must be text', k; end if;
    if f.type = 'date' and (jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$') then raise exception 'custom field % must be a date (YYYY-MM-DD)', k; end if;
  end loop;
  for f in select * from public.custom_fields where business_id = new.business_id and entity = ent and required loop
    if not (new.custom ? f.key) then raise exception 'custom field % is required', f.key; end if;
  end loop;
  return new;
end $$;
create trigger guard_custom before insert or update on public.clients for each row execute function app.guard_custom('client');
create trigger guard_custom before insert or update on public.projects for each row execute function app.guard_custom('project');

-- ===================================================================== E. templates, checklists, tickets
create table public.templates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  kind text not null check (kind in ('sop', 'delivery', 'review')),
  title text not null check (length(trim(title)) > 0),
  body text not null default '',
  unique (id, business_id)
);
create table public.template_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  template_id uuid not null,
  position int not null default 0,
  text text not null check (length(trim(text)) > 0),
  foreign key (template_id, business_id) references public.templates (id, business_id) on delete cascade
);
create table public.check_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  project_id uuid not null,
  text text not null,
  done boolean not null default false,
  done_by uuid references auth.users (id),
  done_at timestamptz,
  foreign key (project_id, business_id) references public.projects (id, business_id) on delete cascade
);
create function public.apply_template(p_template uuid, p_project uuid) returns int
language plpgsql security definer set search_path = public as $$
declare b uuid; n int;
begin
  select business_id into b from public.projects where id = p_project;
  if b is null or not app.has_role(b, 'owner', 'manager', 'staff') or not exists (select 1 from public.templates where id = p_template and business_id = b) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.check_items (business_id, project_id, text) select b, p_project, text from public.template_items where template_id = p_template order by position;
  get diagnostics n = row_count;
  return n;
end $$;
create function app.stamp_check() returns trigger language plpgsql as $$
begin
  if new.done and not old.done then new.done_by := auth.uid(); new.done_at := now(); end if;
  return new;
end $$;
create trigger stamp_check before update on public.check_items for each row execute function app.stamp_check();

create or replace function public.close_project(p_project uuid) returns void language plpgsql security definer set search_path = public as $$
declare b uuid; problems text[] := '{}';
begin
  select business_id into b from public.projects where id = p_project;
  if b is null or not app.has_role(b, 'owner', 'manager') then raise exception 'not allowed' using errcode = '42501'; end if;
  if exists (select 1 from public.change_requests where project_id = p_project and status = 'pending') then problems := array_append(problems, 'pending change requests'::text); end if;
  if exists (select 1 from public.time_entries where project_id = p_project and status in ('draft', 'submitted')) then problems := array_append(problems, 'unapproved time'::text); end if;
  if exists (select 1 from public.expenses where project_id = p_project and status in ('draft', 'submitted')) then problems := array_append(problems, 'unapproved expenses'::text); end if;
  if exists (select 1 from public.invoices where project_id = p_project and status in ('draft', 'approved')) then problems := array_append(problems, 'unissued invoices'::text); end if;
  if exists (select 1 from public.milestones where project_id = p_project and not done) then problems := array_append(problems, 'open milestones'::text); end if;
  if exists (select 1 from public.check_items where project_id = p_project and not done) then problems := array_append(problems, 'open checklist items'::text); end if;
  if array_length(problems, 1) > 0 then raise exception 'cannot close: %', array_to_string(problems, ', '); end if;
  update public.projects set status = 'closed' where id = p_project;
end $$;

-- Tickets distinguish included work from change requests; clients raise them from the portal.
create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  client_id uuid not null,
  project_id uuid,
  title text not null check (length(trim(title)) > 0),
  body text not null default '',
  kind text not null default 'unclassified' check (kind in ('unclassified', 'included', 'change')),
  status text not null default 'open' check (status in ('open', 'escalated', 'resolved')),
  escalated_to uuid references auth.users (id),
  change_request_id uuid references public.change_requests (id),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  foreign key (client_id, business_id) references public.clients (id, business_id),
  foreign key (project_id, business_id) references public.projects (id, business_id)
);
create function app.on_ticket() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform app.notify_managers(new.business_id, 'New ticket: ' || new.title, '/w/' || new.business_id || '/tickets', 'ticket:' || new.id);
  return new;
end $$;
create trigger notify_ticket after insert on public.tickets for each row execute function app.on_ticket();

create function public.ticket_to_change(p_ticket uuid, p_budget bigint, p_minutes int, p_days int) returns uuid
language plpgsql security definer set search_path = public as $$
declare t public.tickets; c uuid;
begin
  select * into t from public.tickets where id = p_ticket;
  if t.id is null or not app.has_role(t.business_id, 'owner', 'manager', 'staff') then raise exception 'not allowed' using errcode = '42501'; end if;
  if t.project_id is null then raise exception 'link the ticket to a project first'; end if;
  if t.change_request_id is not null then raise exception 'already converted'; end if;
  insert into public.change_requests (business_id, project_id, title, reason, budget_delta_paise, effort_delta_minutes, deadline_delta_days)
  values (t.business_id, t.project_id, t.title, 'Client ticket: ' || t.body, p_budget, p_minutes, p_days) returning id into c;
  update public.tickets set kind = 'change', change_request_id = c where id = t.id;
  return c;
end $$;

-- ===================================================================== F. leave, schedules, capacity
alter table public.resources add column weekly_minutes int[] check (weekly_minutes is null or array_length(weekly_minutes, 1) = 7); -- Mon..Sun; null = Mon-Fri at daily capacity
create table public.leave (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  resource_id uuid not null,
  starts_on date not null,
  ends_on date not null,
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected')),
  decided_by uuid references auth.users (id),
  check (ends_on >= starts_on),
  foreign key (resource_id, business_id) references public.resources (id, business_id) on delete cascade
);
create function app.guard_leave() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status <> 'requested' and (tg_op = 'INSERT' or old.status <> new.status) then
    if not app.has_role(new.business_id, 'owner', 'manager') then raise exception 'only an owner or manager can decide leave' using errcode = '42501'; end if;
    new.decided_by := auth.uid();
  end if;
  return new;
end $$;
create trigger guard_leave before insert or update on public.leave for each row execute function app.guard_leave();

-- Capacity of a resource on a date: working pattern minus approved leave.
create function app.day_capacity(p_resource uuid, p_day date) returns int language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from public.leave l where l.resource_id = p_resource and l.status = 'approved' and p_day between l.starts_on and l.ends_on) then 0
              else coalesce(r.weekly_minutes[extract(isodow from p_day)::int], case when extract(isodow from p_day) <= 5 then r.daily_capacity_minutes else 0 end) end
  from public.resources r where r.id = p_resource $$;

create or replace function app.guard_allocation() returns trigger language plpgsql security definer set search_path = public as $$
declare d date; cap int; booked int; bad date[] := '{}';
begin
  if new.status = 'confirmed' and coalesce(trim(new.override_reason), '') = '' then
    for d in select generate_series(new.starts_on, new.ends_on, interval '1 day')::date loop
      cap := app.day_capacity(new.resource_id, d);
      select coalesce(sum(minutes_per_day), 0) into booked from public.allocations a
        where a.resource_id = new.resource_id and a.status = 'confirmed' and a.id <> new.id and d between a.starts_on and a.ends_on;
      if booked + new.minutes_per_day > cap then bad := bad || d; end if;
    end loop;
    if array_length(bad, 1) > 0 then
      raise exception 'allocation conflict on % day(s), first %: working capacity (after leave and non-working days) is exceeded; give an override reason', array_length(bad, 1), bad[1];
    end if;
  end if;
  return new;
end $$;

-- Offboarding: reassign owned briefs and future bookings, drop client access, suspend and end sessions.
create function public.offboard_member(p_membership uuid, p_reassign_to uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.memberships; r_from uuid; r_to uuid; nb int; na int;
begin
  select * into m from public.memberships where id = p_membership;
  if m.id is null or not app.has_role(m.business_id, 'owner') then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.memberships where business_id = m.business_id and user_id = p_reassign_to and status = 'active' and role in ('owner', 'manager', 'staff')) then
    raise exception 'reassign to an active team member';
  end if;
  update public.briefs set owner_id = p_reassign_to where business_id = m.business_id and owner_id = m.user_id and status <> 'closed';
  get diagnostics nb = row_count;
  select id into r_from from public.resources where business_id = m.business_id and user_id = m.user_id;
  select id into r_to from public.resources where business_id = m.business_id and user_id = p_reassign_to;
  na := 0;
  if r_from is not null then
    if r_to is null then raise exception 'the replacement has no resource profile to take over bookings'; end if;
    update public.allocations set resource_id = r_to, status = 'tentative' where resource_id = r_from and ends_on >= current_date; -- must be re-confirmed against the new person's capacity
    get diagnostics na = row_count;
  end if;
  delete from public.client_users where business_id = m.business_id and user_id = m.user_id;
  perform public.suspend_member(p_membership);
  return jsonb_build_object('briefs_reassigned', nb, 'bookings_returned_to_tentative', na);
end $$;

-- ===================================================================== H. platform operations
create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code = upper(code)),
  percent_bps int not null check (percent_bps between 1 and 10000),
  valid_until date,
  max_redemptions int check (max_redemptions is null or max_redemptions > 0),
  redeemed int not null default 0
);
create table public.coupon_redemptions (
  coupon_id uuid not null references public.coupons (id),
  business_id uuid not null references public.businesses (id) on delete cascade,
  at timestamptz not null default now(),
  primary key (coupon_id, business_id)
);
create function public.redeem_coupon(p_business uuid, p_code text) returns int language plpgsql security definer set search_path = public as $$
declare c public.coupons;
begin
  if not app.has_role(p_business, 'owner') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into c from public.coupons where code = upper(trim(p_code)) for update;
  if c.id is null or (c.valid_until is not null and c.valid_until < current_date) or (c.max_redemptions is not null and c.redeemed >= c.max_redemptions) then
    raise exception 'this coupon is invalid or no longer available';
  end if;
  insert into public.coupon_redemptions (coupon_id, business_id) values (c.id, p_business); -- PK blocks a second use by the same business
  update public.coupons set redeemed = redeemed + 1 where id = c.id;
  return c.percent_bps;
end $$;

create table public.saas_charges (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,           -- no FK: charges stay traceable after closure
  plan_version_id uuid references public.plan_versions (id),
  amount_paise bigint not null check (amount_paise >= 0),
  status text not null check (status in ('pending', 'succeeded', 'failed', 'disputed', 'refunded')),
  provider_ref text not null unique,   -- reconciliation reference; also makes provider retries idempotent
  created_at timestamptz not null default now()
);
create table public.platform_audit (
  id bigint generated always as identity primary key,
  actor uuid,
  table_name text not null,
  action text not null,
  new_row jsonb,
  at timestamptz not null default now()
);
create function app.audit_platform() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.platform_audit (actor, table_name, action, new_row) values (auth.uid(), tg_table_name, tg_op, to_jsonb(new));
  return null;
end $$;
create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  charge_id uuid not null references public.saas_charges (id),
  amount_paise bigint not null check (amount_paise > 0),
  reason text not null check (length(trim(reason)) > 0),
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected')),
  requested_by uuid not null references auth.users (id),
  decided_by uuid references auth.users (id)
);
create function app.guard_refund() returns trigger language plpgsql security definer set search_path = public as $$
declare ch public.saas_charges;
begin
  if tg_op = 'INSERT' then
    select * into ch from public.saas_charges where id = new.charge_id;
    if ch.status not in ('succeeded', 'disputed') then raise exception 'only a collected charge can be refunded'; end if;
    if new.amount_paise + coalesce((select sum(amount_paise) from public.refunds where charge_id = new.charge_id and status <> 'rejected'), 0) > ch.amount_paise then
      raise exception 'refunds would exceed the charge';
    end if;
    new.requested_by := auth.uid();
  elsif new.status <> old.status then
    if old.status <> 'requested' then raise exception 'a decided refund is final'; end if;
    if new.requested_by = auth.uid() then raise exception 'a different person must decide the refund'; end if;
    new.decided_by := auth.uid();
    if new.status = 'approved' and new.amount_paise = (select amount_paise from public.saas_charges where id = new.charge_id) then
      update public.saas_charges set status = 'refunded' where id = new.charge_id;
    end if;
  end if;
  return new;
end $$;
create trigger guard_refund before insert or update on public.refunds for each row execute function app.guard_refund();
create trigger audit_refund after insert or update on public.refunds for each row execute function app.audit_platform();
create trigger audit_charge after insert or update on public.saas_charges for each row execute function app.audit();

-- Called by the verified payment-callback route (service role). Idempotent on provider_ref; applies grace rules.
create function public.record_saas_charge(p_business uuid, p_ref text, p_amount bigint, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.saas_charges (business_id, amount_paise, status, provider_ref, plan_version_id)
  values (p_business, p_amount, p_status, p_ref, (select plan_version_id from public.subscriptions where business_id = p_business))
  on conflict (provider_ref) do update set status = excluded.status
  where public.saas_charges.status <> 'refunded';
  if p_status = 'succeeded' then
    update public.subscriptions set status = 'active', current_period_end = coalesce(current_period_end, current_date) + 30, grace_until = null where business_id = p_business;
  elsif p_status = 'failed' then
    update public.subscriptions set status = 'past_due', grace_until = coalesce(grace_until, current_date + 7) where business_id = p_business and status <> 'cancelled';
  end if;
end $$;

-- Access state after trial end / failed renewals: ok | grace | blocked.
create function public.entitlement_state(p_business uuid) returns text language sql stable security definer set search_path = public as $$
  select case
    when s.status = 'cancelled' then 'blocked'
    when s.status = 'trial' then case when coalesce(s.trial_ends_on, current_date) >= current_date then 'ok' else 'blocked' end
    when s.status = 'past_due' then case when coalesce(s.grace_until, current_date - 1) >= current_date then 'grace' else 'blocked' end
    else 'ok' end
  from public.subscriptions s where s.business_id = p_business and app.role_in(p_business) is not null $$;

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) > 0),
  severity text not null check (severity in ('minor', 'major', 'critical')),
  status text not null default 'open' check (status in ('open', 'monitoring', 'resolved')),
  owner uuid references auth.users (id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  starts_at timestamptz not null default now(),
  ends_at timestamptz
);
create trigger audit_inc after insert or update on public.incidents for each row execute function app.audit_platform();
create trigger audit_coupon after insert or update on public.coupons for each row execute function app.audit_platform();
create trigger audit_ann after insert or update on public.announcements for each row execute function app.audit_platform();

-- ===================================================================== I. files with a scan gate
create table public.files (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  project_id uuid not null,
  path text not null unique,
  mime text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  scan_status text not null default 'pending' check (scan_status in ('pending', 'clean', 'infected')),
  uploaded_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  foreign key (project_id, business_id) references public.projects (id, business_id) on delete cascade,
  unique (id, business_id)
);
alter table public.deliverable_versions add column file_id uuid;
alter table public.deliverable_versions add foreign key (file_id, business_id) references public.files (id, business_id);
-- A file can reach the client only after a scanner has marked it clean.
create function app.guard_share() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.shared and (tg_op = 'INSERT' or not old.shared) and new.file_id is not null
     and (select scan_status from public.files where id = new.file_id) <> 'clean' then
    raise exception 'the file has not passed malware screening yet';
  end if;
  return new;
end $$;
create trigger guard_share before insert or update on public.deliverable_versions for each row execute function app.guard_share();
create function public.set_scan_result(p_file uuid, p_status text) returns void language sql security definer set search_path = public as $$
  update public.files set scan_status = p_status where id = p_file and p_status in ('clean', 'infected') $$;

-- ===================================================================== J. export and closure
create table public.closure_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,           -- no FK: the record outlives the business
  requested_by uuid not null references auth.users (id),
  requested_at timestamptz not null default now(),
  exported_at timestamptz,
  status text not null default 'requested' check (status in ('requested', 'deleted', 'failed')),
  error text
);
create function public.export_business(p_business uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare out jsonb := '{}'; t text; v jsonb;
begin
  if not app.has_role(p_business, 'owner') then raise exception 'only an owner can export' using errcode = '42501'; end if;
  foreach t in array array['branches','clients','contacts','briefs','estimates','estimate_versions','estimate_lines','estimate_acceptances','engagements','projects','milestones','change_requests','time_entries','time_adjustments','expenses','invoices','invoice_lines','payments','credit_notes','retainers','retainer_periods','deliverables','deliverable_versions','tickets'] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]'') from public.%I x where business_id = $1', t) into v using p_business;
    out := out || jsonb_build_object(t, v);
  end loop;
  return out;
end $$;

create function public.request_closure(p_business uuid, p_confirm text) returns uuid language plpgsql security definer set search_path = public as $$
declare r uuid;
begin
  if not app.has_role(p_business, 'owner') then raise exception 'only an owner can close the business' using errcode = '42501'; end if;
  if p_confirm <> 'DELETE' then raise exception 'type DELETE to confirm'; end if;
  insert into public.closure_requests (business_id, requested_by) values (p_business, auth.uid()) returning id into r;
  update public.subscriptions set status = 'cancelled' where business_id = p_business;
  return r;
end $$;
create function public.mark_exported(p_business uuid) returns void language sql security definer set search_path = public as $$
  update public.closure_requests set exported_at = now() where business_id = p_business and status = 'requested' and app.has_role(p_business, 'owner') $$;

-- Permanent deletion: platform ops only, after the 30-day retention window and a completed export.
-- Failures are recorded on the request instead of being lost. Audit rows are kept for traceability.
create function public.delete_business(p_request uuid) returns void language plpgsql security definer set search_path = public as $$
declare r public.closure_requests; t text;
begin
  if not app.is_platform('owner', 'ops') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into r from public.closure_requests where id = p_request and status in ('requested', 'failed');
  if r.id is null then raise exception 'no open closure request'; end if;
  if r.requested_at > now() - interval '30 days' then raise exception 'retention window has not elapsed'; end if;
  if r.exported_at is null then raise exception 'the owner has not exported the data yet'; end if;
  begin
    foreach t in array array['tickets','portal_views','comments','payments','credit_notes','invoice_lines','invoices','time_adjustments','time_entries','expenses','commitments','suppliers','allocations','retainer_periods','retainers','check_items','deliverable_versions','files','deliverables','milestones','change_requests'] loop
      if to_regclass('public.' || t) is not null then
        if t = 'portal_views' then
          delete from public.portal_views where version_id in (select id from public.deliverable_versions where business_id = r.business_id);
        else execute format('delete from public.%I where business_id = $1', t) using r.business_id; end if;
      end if;
    end loop;
    delete from public.projects where business_id = r.business_id;
    delete from public.engagements where business_id = r.business_id;
    delete from public.estimate_acceptances where business_id = r.business_id;
    delete from public.estimate_line_costs where business_id = r.business_id;
    delete from public.estimate_lines where business_id = r.business_id;
    delete from public.estimate_versions where business_id = r.business_id;
    delete from public.estimates where business_id = r.business_id;
    delete from public.brief_questions where business_id = r.business_id;
    delete from public.briefs where business_id = r.business_id;
    delete from public.client_users where business_id = r.business_id;
    delete from public.contacts where business_id = r.business_id;
    delete from public.clients where business_id = r.business_id;
    update public.closure_requests set status = 'deleted', error = null where id = r.id;
    delete from public.businesses where id = r.business_id;
  exception when others then
    update public.closure_requests set status = 'failed', error = left(sqlerrm, 500) where id = p_request;
  end;
end $$;

-- ===================================================================== grants and RLS
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
alter table public.credit_notes enable row level security;
alter table public.jobs enable row level security;
alter table public.notifications enable row level security;
alter table public.api_keys enable row level security;
alter table public.webhook_endpoints enable row level security;
alter table public.webhook_logs enable row level security;
alter table public.saved_views enable row level security;
alter table public.custom_fields enable row level security;
alter table public.templates enable row level security;
alter table public.template_items enable row level security;
alter table public.check_items enable row level security;
alter table public.tickets enable row level security;
alter table public.leave enable row level security;
alter table public.coupons enable row level security;
alter table public.coupon_redemptions enable row level security;
alter table public.saas_charges enable row level security;
alter table public.refunds enable row level security;
alter table public.incidents enable row level security;
alter table public.announcements enable row level security;
alter table public.platform_audit enable row level security;
alter table public.files enable row level security;
alter table public.closure_requests enable row level security;

grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert, update, delete on public.audit_log, public.platform_audit, public.webhook_logs from authenticated;
revoke all on public.jobs from authenticated;           -- queue is written only by definer functions and the worker
grant select on public.jobs to authenticated;           -- RLS limits reads to platform ops
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage on schema public, app to service_role;
grant execute on all functions in schema app to authenticated, service_role;
revoke execute on function app.enqueue(uuid, text, jsonb, text), app.notify(uuid, uuid, text, text, text), app.notify_managers(uuid, text, text, text) from authenticated;
revoke all on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
-- Worker/server-only entry points are not callable by signed-in users.
revoke execute on function public.claim_jobs(int), public.complete_job(uuid), public.fail_job(uuid, text), public.resolve_api_key(text),
  public.record_saas_charge(uuid, text, bigint, text), public.set_scan_result(uuid, text) from authenticated;
grant execute on function public.claim_jobs(int), public.complete_job(uuid), public.fail_job(uuid, text), public.resolve_api_key(text),
  public.record_saas_charge(uuid, text, bigint, text), public.set_scan_result(uuid, text) to service_role;
-- The pricing page needs anon read of plans only; other public functions stay closed to anon.
grant select on public.plans, public.plan_versions to anon;

create policy credit_all on public.credit_notes for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));
create policy credit_portal on public.credit_notes for select to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id and i.client_id in (select app.my_client_ids())
         and exists (select 1 from public.client_users cu where cu.client_id = i.client_id and cu.user_id = auth.uid() and cu.can_see_finance)));
create policy payments_portal on public.payments for select to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id and i.client_id in (select app.my_client_ids())
         and exists (select 1 from public.client_users cu where cu.client_id = i.client_id and cu.user_id = auth.uid() and cu.can_see_finance)));
create policy jobs_platform on public.jobs for select to authenticated using (app.is_platform('owner', 'ops'));
create policy notif_own on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notif_mark on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy apikeys_owner on public.api_keys for select to authenticated using (app.has_role(business_id, 'owner'));
create policy wh_owner on public.webhook_endpoints for all to authenticated using (app.has_role(business_id, 'owner')) with check (app.has_role(business_id, 'owner'));
create policy whlog_owner on public.webhook_logs for select to authenticated using (app.has_role(business_id, 'owner', 'manager'));
create policy views_own on public.saved_views for all to authenticated
  using (user_id = auth.uid() and app.role_in(business_id) is not null) with check (user_id = auth.uid() and app.role_in(business_id) is not null);
create policy cf_select on public.custom_fields for select to authenticated using (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy cf_write on public.custom_fields for all to authenticated using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));
create policy tpl_select on public.templates for select to authenticated using (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy tpl_write on public.templates for all to authenticated using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));
create policy tpli_select on public.template_items for select to authenticated using (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy tpli_write on public.template_items for all to authenticated using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));
create policy chk_all on public.check_items for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff')) with check (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy tickets_staff on public.tickets for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff')) with check (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy tickets_portal_select on public.tickets for select to authenticated using (client_id in (select app.my_client_ids()));
create policy tickets_portal_insert on public.tickets for insert to authenticated
  with check (client_id in (select app.my_client_ids()) and created_by = auth.uid() and kind = 'unclassified' and status = 'open'
              and (project_id is null or app.portal_project(project_id)));
create policy leave_select on public.leave for select to authenticated
  using (app.has_role(business_id, 'owner', 'manager') or exists (select 1 from public.resources r where r.id = resource_id and r.user_id = auth.uid()));
create policy leave_insert on public.leave for insert to authenticated
  with check (app.has_role(business_id, 'owner', 'manager') or (status = 'requested' and exists (select 1 from public.resources r where r.id = resource_id and r.user_id = auth.uid())));
create policy leave_update on public.leave for update to authenticated using (app.has_role(business_id, 'owner', 'manager')) with check (app.has_role(business_id, 'owner', 'manager'));
create policy coupons_platform on public.coupons for all to authenticated using (app.is_platform('owner', 'billing')) with check (app.is_platform('owner', 'billing'));
create policy redemptions_platform on public.coupon_redemptions for select to authenticated using (app.is_platform('owner', 'billing') or app.has_role(business_id, 'owner'));
create policy charges_select on public.saas_charges for select to authenticated using (app.is_platform('owner', 'billing') or app.has_role(business_id, 'owner'));
create policy refunds_platform on public.refunds for all to authenticated using (app.is_platform('owner', 'billing')) with check (app.is_platform('owner', 'billing'));
create policy incidents_platform on public.incidents for all to authenticated using (app.is_platform('owner', 'ops', 'support')) with check (app.is_platform('owner', 'ops'));
create policy ann_read on public.announcements for select to authenticated using (starts_at <= now() and (ends_at is null or ends_at > now()) or app.is_platform('owner', 'ops', 'support'));
create policy ann_write on public.announcements for all to authenticated using (app.is_platform('owner', 'ops')) with check (app.is_platform('owner', 'ops'));
create policy paudit_select on public.platform_audit for select to authenticated using (app.is_platform('owner'));
create policy files_staff on public.files for all to authenticated
  using (app.has_role(business_id, 'owner', 'manager', 'staff')) with check (app.has_role(business_id, 'owner', 'manager', 'staff'));
create policy files_portal on public.files for select to authenticated
  using (scan_status = 'clean' and exists (select 1 from public.deliverable_versions v where v.file_id = files.id and v.shared and app.portal_project(files.project_id)));
create policy closure_select on public.closure_requests for select to authenticated using (app.has_role(business_id, 'owner') or app.is_platform('owner', 'ops'));
revoke execute on function app.next_number(uuid, text), app.emit(uuid, text, uuid, jsonb) from authenticated;
-- Supabase's service_role bypasses RLS; these explicit policies make the same worker access work on plain Postgres too.
create policy jobs_service on public.jobs for all to service_role using (true) with check (true);
create policy charges_service on public.saas_charges for all to service_role using (true) with check (true);
create policy subs_service on public.subscriptions for all to service_role using (true) with check (true);
