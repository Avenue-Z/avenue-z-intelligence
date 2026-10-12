# Independent application runtime

The app must refresh providers and generate brand reviews when every browser is closed and no assistant is running. ChatGPT tasks, local computers, browser sessions, and connector sessions are not production infrastructure.

Vercel will host standard Next.js route handlers. A five-minute native cron tick drains due provider jobs using each source's configured cadence; another tick checks brand-local daily review times. Both endpoints authenticate a server-held CRON_SECRET before touching data. Persistent leases prevent overlapping executions and recover after crashes. Provider credentials and the OpenAI key belong to the organization's server environment.

The existing SQLite Store stays intact through a Turso/libSQL adapter. Snapshot archives use private Vercel Blob storage. The current Sites preview retains D1/R2 through a separate runtime adapter. A Vercel build must never import Cloudflare bindings or trust Sites identity headers.

Team sign-in uses Auth.js Google OIDC, verified email, and existing app memberships. An explicitly configured bootstrap admin is the only person who can initialize an empty standalone workspace. Scheduled jobs use an app service identity, independent of any team member's login.

Daily reviews run once per client/store date/mode after the configured reporting time. Only brands with fresh qualified core data are eligible; missing providers remain disclosed by the evidence-driven review. Retries and report IDs persist. Manual review revisions remain available separately.

Implementation: add failing persistence/security/timezone tests; add portable bindings and Next.js build; add protected cron handlers and durable daily jobs; add organization-owned authentication; verify both builds and production-style requests without browser identity; document secure setup and the remaining Vercel activation steps. Keep the current preview private and do not provision external production resources without the selected deployment target.

## Verification on October 12, 2026

154 tests pass, including timezone/DST scheduling, stale source coverage, invalid configuration isolation, report deduplication/recovery, atomic report completion, stable Google identity, tenant scope, and forged/tampered authentication rejection. TypeScript checks and both the standard Next.js Vercel build and Sites preview build pass. The built Vercel server was exercised over HTTP with an isolated libSQL database: repeat migrations, service-only sync/review requests, team-session authorization, persisted shared-note writes, unsigned cron rejection, spoofed Sites-header rejection, and disabled legacy runner all passed. The two compiled runtime bundles were checked for platform isolation.

This verifies the prepared backend locally. It does not activate production cron, provision Vercel services, migrate private preview records, or complete the organization's Google OAuth registration. Those are part of the user-selected later deployment.
