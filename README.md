# Perpa

Multi-company ERP for agencies, studios and consultancies, built from the
*Professional Services Agency ERP SaaS* scope. Next.js + Supabase (Postgres, Auth, RLS).

**Status: Phase 2.** Built: everything in Phase 1 (workspaces, roles, RLS, clients, briefs, rates,
versioned estimates, acceptance, engagements, audit) plus:

- Estimate screen: add/remove lines, discount, submit → approve → send → record acceptance → create
  engagement and project, new revisions. Internal cost and margin appear only to owner/manager.
- Brief creation, projects list, timesheet (log, submit, manager approve/reject with reason).
- Database: projects, resources, allocations (tentative/confirmed, over-capacity needs an override reason),
  timesheets (16h/day cap, no self-approval, approved time immutable, adjustments with reason, locked
  billing periods).

**Not built yet** (per the scope): subscriptions/plans and platform super admin, public marketing site,
invitations/2FA, client portal, change control and milestones, capacity calendar UI, expenses and freelancers,
retainers, billing and receivables, profitability reports, imports/integrations, notifications.
Screens were checked by type-check and build only; they have not been exercised in a browser.

## Rules enforced in the database (see `supabase/migrations/`)
- Every business-owned row carries `business_id`; RLS scopes all reads and writes. Composite foreign keys
  stop a row in one business referencing another's.
- Cost rates and per-line internal costs are readable only by owner/manager.
- Only owner/manager can approve an estimate revision; approved/sent/accepted revisions are frozen
  (terms and lines), so changes need a new version.
- Acceptance needs a *sent* revision and an authorised approver contact of that estimate's client;
  an engagement can only be created from an accepted revision, once.
- A brief cannot request an estimate without an owner or with unanswered questions.
- Client names are unique per business (case/space-insensitive) among live clients.
- Money is integer paise; rates never rewrite history (new rows with an effective date).

## Run it
Needs Node 22 and Docker.

```bash
npm install
npm run db:start                 # local Supabase
cp .env.example .env.local       # paste the anon key from `npx supabase status`
npm run dev
```

## Tests
```bash
npm run test:unit    # pure rules (money, estimate totals/margin, rate dates, permissions)
npm run db:reset && npm run test:db   # RLS, triggers and audit against local Supabase
npm run typecheck
```
`test:db` defaults to the local Supabase Postgres (`:54322`); override with `SUPABASE_DB_URL`. On plain
Postgres, apply `tests/db/bootstrap.sql` (auth stub) and then the migrations first.

Open decisions from the scope (providers, retention, recovery targets, screen register) are still to be
settled in discovery.
