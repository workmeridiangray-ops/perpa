-- Core multi-company model: businesses, branches, memberships, audit.
-- Every business-owned table carries business_id; RLS (0003) scopes on it.

create schema if not exists app;

create type public.member_role as enum ('owner', 'manager', 'staff', 'customer');
create type public.member_status as enum ('invited', 'active', 'suspended');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  email text not null default '',
  created_at timestamptz not null default now()
);

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  currency text not null default 'INR' check (currency = 'INR'), -- launch assumption: INR only
  created_at timestamptz not null default now()
);

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  unique (business_id, name),
  unique (id, business_id)
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null,
  status public.member_status not null default 'active',
  created_at timestamptz not null default now(),
  unique (business_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

-- No rows for a membership = access to every branch of the business.
create table public.membership_branches (
  membership_id uuid not null references public.memberships (id) on delete cascade,
  branch_id uuid not null references public.branches (id) on delete cascade,
  primary key (membership_id, branch_id)
);

-- Per-business, per-prefix gapless-ish counters (EST-0001). Definer-only.
create table app.counters (
  business_id uuid not null references public.businesses (id) on delete cascade,
  prefix text not null,
  last_value int not null default 0,
  primary key (business_id, prefix)
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  business_id uuid not null,
  actor uuid,
  table_name text not null,
  row_id uuid,
  action text not null,
  old_row jsonb,
  new_row jsonb,
  at timestamptz not null default now()
);
create index audit_business_idx on public.audit_log (business_id, at desc);
