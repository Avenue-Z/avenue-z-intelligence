# Avenue Z Intelligence

Shared portfolio and detailed client analytics for Avenue Z. Kind Patches and Beam are editable client records imported from the supplied prompts. Performance values come exclusively from source observations; disconnected metrics are unavailable.

## Implemented

Portfolio and detailed client views, store-local comparisons, interactive charts, searchable tables and CSV exports, landing-page drilldowns, subscription cohorts, shared notes and follow-ups, immutable daily reviews, historical imports, and client-scoped authorization. The independent production runtime persists data in Turso and private Vercel Blob archives; the original Sites adapters remain available.

## Current activation status

Kind Patches is live at https://avenue-z-intelligence.vercel.app with 13 scheduled feeds from Triple Whale, Shopify, Meta, AppLovin, and Recharge, plus OpenAI reviews and contextual chat. As verified on October 15, 2026, the core detailed feeds cover all 30 closed store days from September 15 through October 14. Stock metrics retain their actual observation dates; historical customer counts are never invented. Beam's historical reviews are available; its live providers still need to be connected.

Production Vercel scheduling is active and independent of an assistant or personal computer. Hourly captures supply Today and the matching hour yesterday; closed days are retained for reuse and repaired when a provider publishes qualified corrections. Detailed retention is 30 closed store days plus Today. See [independent runtime](docs/independent-runtime.md) and [Vercel setup and activation](docs/vercel-deployment.md).

The optional Recharge webhook retains original subscription creation timestamps so a subscription created and deleted between hourly polls can still enter the cancellation cohort. Activation requires the existing Recharge API Client Secret in `RECHARGE_WEBHOOK_CLIENT_SECRET`, the exact store domain in `RECHARGE_WEBHOOK_STORE_DOMAIN`, and created/cancelled/deleted subscriptions registered to `/api/webhooks/recharge`. The receiver returns 503 until its secret is configured. It does not infer missing historical creation dates from event timestamps.

See [source contract](docs/source-contract.md), [activation/runbook](docs/runbook.md), [design](docs/design.md), and [implementation plan](docs/implementation-plan.md).

## Local development

Node 24 recommended (minimum 22.13). `npm install`, `npm test`, `npm run typecheck`, `npm run dev`. Preserve the Sites portable starter scripts. Local preview authentication is mock-only; deployed authentication uses the platform signed identity. Database migrations live under `drizzle/`; generate additive migrations with `npm run db:generate`. Never replace a migration already applied to a shared database.

## Hosted synchronization

Vercel Cron invokes `/api/cron/sync`, `/api/cron/reviews`, `/api/cron/history`, and `/api/cron/cache` on staggered five-minute schedules using the server-held `CRON_SECRET`. The dispatcher respects each source's hourly due time. Daily reviews are scheduled for 08:00 America/New_York. Database-backed leases, retries, and report IDs survive restarts. The runtime uses Turso/libSQL, private Vercel Blob archives, and Auth.js Google OIDC. It requires no assistant task, personal computer, browser session, or ChatGPT connector session. `scripts/sync-cloud.mjs` and the manual GitHub workflow are operational probes; no GitHub cron remains. Dashboard navigation reads persisted data and does not ingest provider data.

## Sharing

The Vercel app accepts verified Google Workspace accounts whose Google hosted-domain claim and email domain both match `avenuez.com`. Automatic onboarding grants analyst access to Kind Patches only; administrators and other client access require explicit membership. The bootstrap administrator is configured separately. Team settings record access allowances without sending email. The original Sites preview has separate platform-sharing controls.
