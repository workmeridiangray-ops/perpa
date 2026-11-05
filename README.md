# Perpa

Multi-company ERP for agencies, studios and consultancies, built from the
*Professional Services Agency ERP SaaS* scope. Next.js + Supabase (Postgres, Auth, RLS).

**Status: every module in the scope has an implementation except the items listed under “What is not built, and why”** (database rules, tests and
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

## Added in the latest pass
Credit notes and client statements; job queue (email + webhooks) with deduplication, exponential backoff, dead-letter
and platform-ops retry; in-app notifications and overdue-review report; API keys (hashed) and a read-only
`/api/v1/clients`; signed webhooks with HTTPS/SSRF checks and delivery logs; saved views; custom fields;
SOP/delivery/review templates and project checklists that block close; client tickets (included vs change, convert,
escalate); capacity calendar, leave and part-time patterns; offboarding with reassignment; coupons, charges,
four-eyes refunds, incidents and announcements; payment-callback receiver with grace-period handling; file upload
with a malware-scan gate; MFA (TOTP) enrolment and a required second factor for platform staff; JSON export and
a closure request with 30-day retention and logged deletion failures; signup and invitations.

## What is not built, and why
| Not built | Reason |
|---|---|
| **Taking payments**: hosted checkout, payment links on invoices, automatic recurring card/UPI charging, proration | Needs a chosen payment provider (Razorpay, Stripe, …), a merchant account and API credentials, and a decision on proration rules (the scope says to settle these in discovery). What *is* built is the provider-neutral receiver for signed callbacks (`/api/webhooks/payments`), idempotent charge recording, and failed-renewal grace handling, so a provider adapter only has to create the checkout and post callbacks. |
| **Email actually leaving the system** | Needs a provider account and a verified sending domain. The worker sends through any HTTPS email API configured via `EMAIL_API_URL/KEY/FROM`; until set, jobs retry and then dead-letter visibly in the ops console. It is untested against a real provider. |
| **Malware scanning engine** | Scanning is an external service (ClamAV host or a vendor); I cannot ship or verify one here. Files are quarantined as `pending` and cannot be shared with clients until a scanner calls `/api/webhooks/scan`. Without a scanner nothing reaches clients, which is the safe default. |
| **SMS and WhatsApp** | Need provider accounts, approved sender IDs and message templates (WhatsApp Business approval). |
| **Enterprise SSO / custom identity providers** | Configured in the Supabase project with a customer’s IdP (a paid-plan feature), not application code; the scope lists it as explicit opt-in. |
| **E-signatures and legal drafting** | Scope calls these selected integrations; they need a signature provider. Acceptance by an authorised contact for a specific revision is recorded instead. |
| **Native mobile apps and advanced offline mode** | Excluded by the scope document itself. The web UI is responsive. |
| **Automated staffing optimisation, payroll, contractor payouts, formal revenue accounting, bespoke accounting connectors, advanced creative proofing, extra currencies** | Excluded by the scope as separately estimated work; accounting connectors also need a named provider and posting rules. Baseline CSV/JSON export and a read-only API exist. |
| **Load, recovery, browser-matrix and accessibility testing** | Need a running environment: I could not start the local Supabase stack here (container registry rate-limited), so nothing was run in a browser. Targets (volumes, RPO/RTO, browsers) are decisions the scope leaves to discovery. |
| **Backups and restore drills** | Infrastructure concern of the hosting plan chosen (Supabase backups/PITR); nothing in the repo to build until a plan is picked. |
| **Two-way sync mappings and a connector catalogue UI** | Each connector must be defined by provider, objects, direction and source of truth (scope §18); none is named yet. |

## Testing status
109 automated tests pass (pure rules plus database rules on Postgres 16). The Next.js app type-checks and builds, but no
screen has been exercised in a browser or against real Supabase Auth/PostgREST/Storage, so UI wiring (especially
storage upload, MFA and the signed-in flows) is unverified.

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
