# Perpa

Multi-company ERP for agencies, studios and consultancies, built from the
*Professional Services Agency ERP SaaS* scope. Next.js + Supabase (Postgres, Auth, RLS).

**Status: all modules in the scope document have a first working implementation** (database rules, tests and
screens). It has not been run in a browser or against hosted Supabase, so treat the UI as built-and-compiled,
not yet user-tested.

| Scope area | Where |
|---|---|
| Website, sign up, sign in, pricing | `app/`, `app/pricing`, `app/signup` |
| Subscriptions, plan versions, seat/branch limits, downgrade rules | migration `0008`, `app/platform` |
| Roles, invitations, suspension, audit, support access (time-limited, owner-approved) | `0003`, `0008`, Team page |
| Clients, briefs, estimates, acceptance, engagements | `0002`, `0003`, `0005`, estimate screens |
| Projects, milestones, change control, close checks | `0004`, `0006`, project page |
| Capacity, tentative/confirmed bookings, conflicts | `0004`, Capacity page |
| Timesheets, approval, locks, adjustments | `0004`, Timesheet page |
| Expenses, suppliers/freelancers, commitments | `0006`, Expenses page |
| Client portal: proofs, decisions, discussion | `0008`, `app/portal` |
| Retainers: allowance, carryover, overage approval | `0007`, Retainers page |
| Invoices, payments, ageing, no double billing | `0006`, Invoices page |
| Profitability (estimated / committed / actual) | `0007`, project page |
| CSV import (preview + commit) and export | `lib/rules/csv.ts`, Clients page |

## Known gaps — needs decisions or external accounts (not faked)
- **Payment provider / recurring subscription billing**, **transactional email** (invitation links are shown
  once in the Team page instead of emailed), SMS/WhatsApp: need provider choice and credentials.
- **File uploads and malware screening**: type/size rules exist (`lib/rules/uploads.ts`); no storage bucket or
  scanner is wired, so deliverable versions are records without files.
- **E-signatures, two-factor sign-in, SSO**: Supabase Auth supports MFA/SSO; not enabled or built into screens.
- **API keys / webhooks, bespoke accounting connectors, notifications, SOP/template library, saved views,
  custom fields, ticketing**: not built.
- **Platform super-admin** covers plans, subscriptions and billing audit only; there is no incident or
  job-retry console, coupons, refunds or announcements.
- **Capacity** is a table with conflict checks, not a calendar grid; there is no leave calendar or part-time
  schedule model, and the conflict check is conservative (sums all overlapping confirmed bookings).
- Credit notes, statements and payment links are not built; invoices can be voided only before any payment.
- Retention, backup and recovery targets, accessibility audit, load testing and browser matrix testing are
  open items from the scope.

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
npm run test:unit    # pure rules (money, estimates, rates, permissions, CSV, uploads, profit summary)
npm run db:reset && npm run test:db   # RLS, triggers and audit against local Supabase
npm run typecheck
```
`test:db` defaults to the local Supabase Postgres (`:54322`); override with `SUPABASE_DB_URL`. On plain
Postgres, apply `tests/db/bootstrap.sql` (auth stub) and then the migrations first.

Open decisions from the scope (providers, retention, recovery targets, screen register) are still to be
settled in discovery.
