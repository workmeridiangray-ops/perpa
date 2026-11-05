-- Client directory, briefs, rate cards, estimates (versioned), acceptance, engagements.

create type public.brief_status as enum ('draft', 'qualified', 'in_review', 'estimate_requested', 'closed');
create type public.estimate_status as enum ('draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected');
create type public.line_kind as enum ('labour', 'external');

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  branch_id uuid,
  name text not null check (length(trim(name)) > 0),
  name_norm text generated always as (lower(regexp_replace(trim(name), '\s+', ' ', 'g'))) stored,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (branch_id, business_id) references public.branches (id, business_id),
  unique (id, business_id)
);
-- No duplicate live clients per business (case/space-insensitive).
create unique index clients_name_live_uq on public.clients (business_id, name_norm) where not archived;

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  client_id uuid not null,
  name text not null check (length(trim(name)) > 0),
  email text,
  phone text,
  is_authorised_approver boolean not null default false,
  foreign key (client_id, business_id) references public.clients (id, business_id) on delete cascade,
  unique (id, business_id)
);

create table public.briefs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  branch_id uuid,
  client_id uuid not null,
  title text not null check (length(trim(title)) > 0),
  requirements text not null default '',
  budget_paise bigint check (budget_paise is null or budget_paise >= 0),
  due_date date,
  status public.brief_status not null default 'draft',
  owner_id uuid references auth.users (id),
  created_at timestamptz not null default now(),
  foreign key (client_id, business_id) references public.clients (id, business_id),
  foreign key (branch_id, business_id) references public.branches (id, business_id),
  unique (id, business_id)
);

create table public.brief_questions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  brief_id uuid not null,
  question text not null check (length(trim(question)) > 0),
  answer text,
  foreign key (brief_id, business_id) references public.briefs (id, business_id) on delete cascade
);

-- Rates are effective-dated; changes add rows, never rewrite history.
-- Customer-facing bill rates and internal cost rates are separate tables so
-- cost rates can carry stricter access.
create table public.bill_rates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  role_label text not null check (length(trim(role_label)) > 0),
  rate_paise bigint not null check (rate_paise >= 0),
  effective_from date not null,
  unique (business_id, role_label, effective_from)
);
create table public.cost_rates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  role_label text not null check (length(trim(role_label)) > 0),
  rate_paise bigint not null check (rate_paise >= 0),
  effective_from date not null,
  unique (business_id, role_label, effective_from)
);

create table public.estimates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  client_id uuid not null,
  brief_id uuid,
  number text not null,
  title text not null check (length(trim(title)) > 0),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  foreign key (client_id, business_id) references public.clients (id, business_id),
  foreign key (brief_id, business_id) references public.briefs (id, business_id),
  unique (business_id, number),
  unique (id, business_id)
);

create table public.estimate_versions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  estimate_id uuid not null,
  version int not null check (version > 0),
  status public.estimate_status not null default 'draft',
  discount_bps int not null default 0 check (discount_bps between 0 and 10000),
  exclusions text not null default '',
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (estimate_id, business_id) references public.estimates (id, business_id) on delete cascade,
  unique (estimate_id, version),
  unique (id, business_id)
);

-- Customer-visible line (no internal cost here).
create table public.estimate_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  version_id uuid not null,
  kind public.line_kind not null,
  description text not null check (length(trim(description)) > 0),
  role_label text,
  hours_centi int check (hours_centi is null or hours_centi > 0), -- hours x 100
  rate_paise bigint not null check (rate_paise >= 0),             -- per hour (labour) or per unit (external)
  quantity_centi int not null default 100 check (quantity_centi > 0), -- external units x 100
  foreign key (version_id, business_id) references public.estimate_versions (id, business_id) on delete cascade,
  unique (id, business_id),
  check ((kind = 'labour' and hours_centi is not null) or kind = 'external')
);

-- Internal cost assumption per line: separate table, owner/manager only.
create table public.estimate_line_costs (
  line_id uuid primary key,
  business_id uuid not null,
  cost_rate_paise bigint not null check (cost_rate_paise >= 0),
  foreign key (line_id, business_id) references public.estimate_lines (id, business_id) on delete cascade
);

-- Acceptance identifies the exact revision and an authorised contact of that estimate's client.
create table public.estimate_acceptances (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  version_id uuid not null unique,
  contact_id uuid not null,
  accepted_at timestamptz not null default now(),
  recorded_by uuid references auth.users (id),
  foreign key (version_id, business_id) references public.estimate_versions (id, business_id),
  foreign key (contact_id, business_id) references public.contacts (id, business_id)
);

create table public.engagements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  client_id uuid not null,
  version_id uuid not null unique, -- one engagement per accepted revision
  name text not null check (length(trim(name)) > 0),
  status text not null default 'setup' check (status in ('setup', 'active', 'closed')),
  created_at timestamptz not null default now(),
  foreign key (client_id, business_id) references public.clients (id, business_id),
  foreign key (version_id, business_id) references public.estimate_versions (id, business_id)
);
