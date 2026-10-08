# Avenue Z Intelligence

Shared portfolio and detailed client analytics for Avenue Z. Kind Patches and Beam are editable client records imported from the supplied prompts. Performance values come exclusively from source observations; disconnected metrics are unavailable.

## Implemented

Portfolio, nine client views, store-local date comparisons, interactive revenue/spend charts with range selection, searchable/sortable tables and CSV, evidence details, Monday-start subscription comparisons with contaminated benchmark warnings, shared notes and follow-ups, immutable daily review revisions, historical imports, editable client/source configuration, signed-in membership and client-scoped authorization, persistent D1 records and R2 snapshots, and a bounded source job runner.

## Current activation status

No live source has been connected or qualified. No unattended schedule is active. Daily summaries currently use deterministic, evidence-based calculations; no LLM provider is configured. Full brand configs, provider transports and dimensional reconciliation remain part of source activation. This is a private working app, not a claim that live analytics are ready.

See [source contract](docs/source-contract.md), [activation/runbook](docs/runbook.md), [design](docs/design.md), and [implementation plan](docs/implementation-plan.md).

## Local development

Node 24 recommended (minimum 22.13). `npm install`, `npm test`, `npm run typecheck`, `npm run dev`. Preserve the Sites portable starter scripts. Local preview authentication is mock-only; deployed authentication uses the platform signed identity. Database migrations live under `drizzle/`; generate additive migrations with `npm run db:generate`. Never replace a migration already applied to a shared database.

## Hosted synchronization

`POST /api/internal/sync` requires both the private Sites dispatch credential and the app's hosted `RUNNER_SECRET`. `scripts/sync-cloud.mjs` can run on an authorized hosted scheduler. A portable GitHub Actions workflow is included but gated by `SOURCE_SYNC_ENABLED`; the Sites source registry does not execute GitHub Actions. Move source to an authorized GitHub repository or use the authorized Sites cloud updater only after sources and unattended writes are verified. Set up one scheduler, not both. A browser view refresh does not ingest new provider data.

## Sharing

First entry into the new owner-private site initializes the owner's workspace. Later users require both Site access and an app membership grant. Memberships can limit clients. Adding an email in Team & settings records the allowance; it does not send an email or grant platform-level Site access. Keep the site private until the intended team has been granted access through the platform sharing controls.
