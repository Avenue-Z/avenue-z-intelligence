# Avenue Z Intelligence

Shared portfolio and detailed client analytics for Avenue Z. Kind Patches and Beam are editable client records imported from the supplied prompts. Performance values come exclusively from source observations; disconnected metrics are unavailable.

## Implemented

Portfolio, nine client views, store-local date comparisons, interactive revenue/spend charts with range selection, searchable/sortable tables and CSV, evidence details, Monday-start subscription comparisons with contaminated benchmark warnings, shared notes and follow-ups, immutable daily review revisions, historical imports, editable client/source configuration, signed-in membership and client-scoped authorization, persistent D1 records and R2 snapshots, and a bounded source job runner.

## Current activation status

Kind Patches has seven qualified feeds from Triple Whale, Shopify, Meta, AppLovin, and Recharge. Its current provider data powers the charts and client views. OpenAI reviews and contextual chat are configured in the private preview. Beam's historical reviews are available; its live providers still need to be connected. Metric scope, provider coverage, and retrieval times remain explicit.

The app's independent Vercel backend is prepared. The current Sites preview is retained, and Vercel deployment is deferred at the user's request. The previous ChatGPT refresh task is paused. Production scheduling is defined in the application's `vercel.json`; it activates with the later Vercel production deployment. See [independent runtime](docs/independent-runtime.md) and [Vercel setup and activation](docs/vercel-deployment.md).

See [source contract](docs/source-contract.md), [activation/runbook](docs/runbook.md), [design](docs/design.md), and [implementation plan](docs/implementation-plan.md).

## Local development

Node 24 recommended (minimum 22.13). `npm install`, `npm test`, `npm run typecheck`, `npm run dev`. Preserve the Sites portable starter scripts. Local preview authentication is mock-only; deployed authentication uses the platform signed identity. Database migrations live under `drizzle/`; generate additive migrations with `npm run db:generate`. Never replace a migration already applied to a shared database.

## Hosted synchronization

Vercel Cron invokes `/api/cron/sync` and `/api/cron/reviews` using the application's server-held `CRON_SECRET`. Database-backed leases, retries, and daily report IDs survive worker restarts. The standalone runtime uses Turso/libSQL, private Vercel Blob archives, and Auth.js Google OIDC with app memberships. It requires no assistant task, personal computer, browser session, or ChatGPT connector session. `scripts/sync-cloud.mjs` and the manual GitHub workflow are operational probes; no GitHub cron remains. A browser view refresh reads current persisted data and does not ingest provider data.

## Sharing

In the current owner-private preview, first entry initializes the owner's workspace. Later users require both Site access and an app membership grant. On Vercel, only the explicitly configured bootstrap admin can initialize an empty workspace; verified Google accounts also require app membership. Memberships can limit clients. Adding an email in Team & settings records the allowance; it does not send an email or grant preview platform access. Keep the preview private until the intended team has been granted access through platform sharing controls.
