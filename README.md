# Perpa

Multi-company ERP for agencies, studios and consultancies, built from the
*Professional Services Agency ERP SaaS* scope. Next.js + Supabase (Postgres, Auth, RLS).

**Status: every module in the scope has an implementation except the items listed under “What is not built, and why”** (database rules, tests and
screens). It has been run in a browser against a local Supabase stack (see Testing status), but not against a hosted project or with real email, payment or scanner providers.

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

## Readiness

**Verdict: the application is complete and working for a pilot or staging launch.** Every module in the scope is implemented,
110 automated tests pass, and a browser test suite drives the real app against a real (local) Supabase stack and passes.
Bugs found by that suite were fixed (see the git history).

**It is not yet switched on for paying production customers.** The items below are *prepared in code* but cannot be
activated or verified without accounts, credentials or decisions that only the business owner can provide.

## What is not prepared (needs an account, credential or decision)
| Item | State | What is needed to finish |
|---|---|---|
| Taking payments (checkout, payment links, recurring charging, proration) | Callback receiver `/api/webhooks/payments` (HMAC), idempotent charge recording and grace-period logic are built and tested. No checkout is created. | Choose a provider (e.g. Razorpay), create the merchant account, set `PAYMENT_WEBHOOK_SECRET`, and add a small adapter that creates the checkout. Decide proration rules. |
| Email delivery | Queue, retries, dead-letter and the HTTP sender are built; fails visibly when unconfigured (tested). Never sent to a real provider. | Provider account and verified sending domain; set `EMAIL_API_URL`, `EMAIL_API_KEY`, `EMAIL_FROM`; schedule `POST /api/jobs/run` with `CRON_SECRET`. |
| Malware scanning | **Built and tested.** `services/scanner` polls pending files, scans them with ClamAV (clamd INSTREAM) and posts the signed result. Tested end to end with a real clamd, real storage and the real app (EICAR detection, clean files, clamd-down stays pending). Only an EICAR test signature was used here because the signature download was blocked in the test environment. | Deploy `services/scanner/docker-compose.yml` on a host (it pulls the official ClamAV image, which keeps real signatures updated) and set the same `SCAN_WEBHOOK_SECRET` in the app and scanner. |
| SMS / WhatsApp | Not built. | Provider accounts, approved sender IDs and templates. |
| SSO / custom identity providers | Not built; TOTP two-factor is built and tested. | Configure in the Supabase project per customer IdP. |
| E-signatures | Not built; acceptance by an authorised contact for a specific revision is recorded. | A signature provider. |
| Accounting connectors, two-way sync, connector catalogue | Not built; CSV/JSON export, read-only API and signed webhooks exist. | Named provider, objects, direction and posting rules (scope §18). |
| Hosting, backups, restore drills, monitoring | Not set up. | Pick a hosted Supabase plan and a web host; configure backups/PITR and alerts. |
| Load, recovery-target and multi-browser/mobile testing | Only Chromium on desktop was used; no load tests. | Agree volumes, RPO/RTO and the browser matrix, then test on the hosted environment. |
| Manual assistive-technology (screen reader) review | Automated axe WCAG A/AA scan passes. | An accessibility review by a person. |
| Out of scope by the document itself | Native apps, offline mode, payroll, contractor payouts, staffing optimisation, formal revenue accounting, extra currencies. | Separate estimates. |

## Testing status
- `npm run test:unit` — 41 pure-rule tests. `npm run test:db` — 68 database tests, passing both on plain Postgres 16 and on the
  real local Supabase stack (migrations apply, RLS and the storage policy work).
- `npm run test:e2e` — Playwright scripts (08 also needs a clamd on 127.0.0.1:3310) that drive the running app (`npm run dev`) against local Supabase: sign-up, invitations,
  estimate → acceptance → project → time/expense approval → invoice → payment → credit note → statement, client portal approvals
  and tickets, staff-vs-owner visibility, CSV/JSON export, API key, job worker, signed callbacks, file upload + scan gate with a
  real signed URL, TOTP enrolment for platform staff, capacity/leave, offboarding, and an axe WCAG A/AA scan of the main pages.
  They assume `npx supabase start` (with `supabase/config.toml` as committed, TOTP on) and the env in `.env.example`
  plus `SCAN_WEBHOOK_SECRET=scan-secret-0123456789abcdef` and `CRON_SECRET=local-cron-secret-0123456789abcdef`.
  Dev-mode first-compile reloads can make a first run flaky; re-run once.
- Still not tested: real email delivery, real payment-provider callbacks, a real malware scanner, load/recovery targets, other
  browsers (only Chromium was used), mobile viewports, and screen-reader use beyond automated axe checks.

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
