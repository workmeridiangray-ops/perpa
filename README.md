# Perpa

Multi-company ERP for agencies, studios and consultancies, built from the
*Professional Services Agency ERP SaaS* scope. Next.js + Supabase (Postgres, Auth, RLS).

**Status: Phase 1 foundation.** Built: sign-in, workspace (business) switching, business/branch/membership
model, roles (owner, manager, staff, customer), client directory and contacts, briefs with open questions,
effective-dated bill and cost rates, versioned estimates with internal cost kept separate, approval,
acceptance by an authorised contact, engagements from accepted revisions, append-only audit log.

**Not built yet** (per the scope): subscriptions/plans and platform super admin, public marketing site,
invitations/2FA, client portal, projects and change control, capacity, timesheets, expenses/freelancers,
retainers, billing and receivables, profitability, imports/integrations. The estimate editor UI is not
built; estimates are created and managed through the database functions and covered by tests.

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
