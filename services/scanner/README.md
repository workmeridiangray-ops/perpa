# Malware scanner

Scans uploaded deliverables with ClamAV before they can be shared with clients.

```
app upload ──► files.scan_status = 'pending'  (cannot be shared)
scanner ──► lists pending files (service role) ──► downloads from private storage
        ──► clamd INSTREAM ──► POST /api/webhooks/scan (HMAC-signed) ──► 'clean' | 'infected'
```

Safety rules built in: a file is marked clean **only** when ClamAV answers `OK`. Any error (clamd down, timeout, download
failure, oversize) leaves the file `pending`, so it stays unshareable and is retried on the next poll.

## Run
```bash
cp .env.example .env   # fill in
docker compose up -d   # ClamAV (auto-updates signatures) + scanner
```
Needs the app's `SCAN_WEBHOOK_SECRET` to match. Single run for cron/CI: `node scanner.mjs --once`.

## Tests
`npm run test:unit` (protocol framing and reply parsing against a fake clamd) and `node tests/e2e/08-scanner.cjs`
(real clamd, real Supabase storage, real app callback; uses an EICAR test signature).
