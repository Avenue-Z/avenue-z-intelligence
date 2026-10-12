# Avenue Z production deployment

The independent backend was activated on October 12, 2026 in the Avenue Z Technology Vercel team. The existing owner-private Sites URL remains the dashboard during the frontend transition and reads the same company database. The rejected ChatGPT hourly task remains paused. Native Vercel cron routes run provider sync and daily-review checks without a browser, developer computer, or assistant session.

## Organization-owned services

Use the Avenue Z Technology Vercel team and company-managed service accounts. Create or attach a Turso/libSQL database and a **private** Vercel Blob store in the application's region. The app uses the existing SQLite schema through its libSQL adapter; blobs archive provider snapshots and never expose public download URLs.

Set the server-only values named in [the environment template](../config/vercel.env.example). Transfer the validated Kind Patches configuration and existing OpenAI project key directly between secure server environments. Do not paste values into chat, put them in source, or prefix them with NEXT_PUBLIC_. Never copy Sites service bearer tokens or PRIVATE_SITE_RUNNER_ENABLED into Vercel. Provider credentials must support server-to-server access; a personal OAuth refresh token is not an appropriate permanent production dependency. Use company-managed credentials and retain provider access when an employee leaves.

Google OIDC uses a company-owned OAuth application. Its authorized redirect URI is `https://<production-host>/api/auth/callback/google`. AUTH_URL must exactly match that HTTPS host. Auth.js handles encrypted sessions, CSRF protection, and the OAuth checks. Verified email plus an explicit app membership determines access; a signed-in stranger cannot create an admin account. APP_BOOTSTRAP_ADMIN_EMAIL selects the first administrator on an empty database. Existing memberships are preserved and linked to the user's stable Google account ID when signing in. Team invitations grant only the configured clients.

## Database and existing records

Run `npm run db:migrate:vercel` against a **fresh database**, with its service credentials supplied securely. The script applies each migration transactionally, records checksums, skips unchanged applied migrations, and refuses changed history. It must run once before production traffic; do not run migrations on every cron tick.

To preserve current preview data, first migrate the fresh destination, then copy **data only** for organizations, clients, members, connections, qualifications, observations, snapshots, current snapshots, notes, findings, reviews, and audit/AI history. Preserve identifiers, review revisions, source contracts, and current pointers. APP_ORGANIZATION_ID must match the imported organization ID (`avenue-z` for the current preview). Do not replay a whole D1 schema export into that fresh schema. Do not import D1's migration history into `_avenue_migrations`. Keep the destination scheduler disabled during import and validate row counts, per-brand aggregates, authorizations, and a representative review. Copy archived snapshot objects privately and preserve their object keys. Verify or requalify providers before enabling sources. The data transfer completed on October 12: two clients, 139,123 observations, 29 review revisions, six findings, seven validated connections and 26 private snapshot archives were copied with their identifiers and current pointers preserved. The original D1 data remains intact. Kind Patches subsequently gained a separately reconciled hourly Shopify feed; current source counts and coverage are read from the database.

## Runtime and schedules

Vercel uses `npm run build:vercel` (standard Next.js Node runtime). Sites continues to use `npm run build`. Their runtime bindings are selected by separate TypeScript paths; a Vercel build does not load Cloudflare bindings or trust Sites identity headers.

`vercel.json` registers two production cron routes:

- `/api/cron/sync` every five minutes: enqueue due sources at their configured cadence and drain persistent jobs. A tick is not a promise that every provider publishes new data every five minutes.
- `/api/cron/reviews` every five minutes, offset by two minutes: check each brand's reporting time/timezone, fresh qualified core coverage, and persistent daily job state. Process one due review per invocation using the existing evidence-grounded OpenAI pipeline.

Both routes require `Authorization: Bearer <CRON_SECRET>` before database access and work without cookies, browser tabs, ChatGPT dispatch credentials, or a user's login. Vercel supplies this header for its cron requests. Frequent crons require a Vercel plan that supports these schedules; verify the Avenue Z team's plan before enabling them. The tick processes a bounded batch within a 300-second function limit. Persistent leases prevent overlaps; expired leases recover after crashes. Source and report retries use backoff, with a maximum of three failed attempts per job. Waiting for fresh data does not consume a report attempt. Terminal source failures remain visible in app connection settings and persisted job records; a later source cadence can enqueue a fresh attempt. Cron failures return a non-success status for hosting logs, while the next tick drains persisted retries.

Report store dates are anchored to the configured reporting slot, including DST and the Stockholm/New York difference. Each scheduled client/date/mode is unique. Saving a generated report atomically completes its job; retries adopt an existing report tagged with the same schedule job. Manual revisions remain separate. Closed-day retries can recover until the next reporting slot. Partial-day jobs expire at the selected store-day midnight to prevent the next day's clock from changing their comparison window. Failed/expired jobs remain in `scheduled_reviews`; inspect that table and hosting logs during operations. Missing Beam connections do not trigger invented daily reports.

## Activation verification

Verification uses the production deployment and company service credentials:

1. Confirm anonymous, spoofed-header, and uninvited-user requests cannot read client data; verify admin/analyst client access.
2. Invoke each cron with only its service credential, no user cookie. Confirm provider jobs persist and the app's current snapshots advance. An unsigned cron request must return 401.
3. Check independently reconciled revenue/spend and dimensional totals for both connected brands. Keep provider scope, timezone, and freshness visible.
4. Invoke a daily review, confirm the saved report and source citations, invoke again, and verify no duplicate scheduled report.
5. Close all browsers and end the assistant session. Observe a later **native Vercel cron** in hosting logs, fresh provider coverage in the database, and the next configured brand review. Only this confirms autonomous production scheduling.

The company project, Turso database, private Blob store, server credentials and native cron routes are active. Native cron dispatch and cookie-free provider refresh have been observed in production. Google OAuth registration for the eventual Vercel frontend is still pending; the current private dashboard uses its existing authentication and shared database. Beam live provider credentials have not been supplied, so its imported reports remain dated reference evidence. Daily-review generation must be checked against a saved report and its persistent scheduled job, rather than inferred from a successful deployment.
