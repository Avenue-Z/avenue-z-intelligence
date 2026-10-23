# Autobrush Live Commerce Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish the requested Autobrush client workspace with real hourly Shopify data, qualified daily Motion reporting, independent hosted refresh/history jobs and the existing cached dashboard.

**Architecture:** Add explicit Autobrush profiles and dispatch; preserve KP and Beam implementations. Use the existing encrypted provider vault, immutable captures, qualification contracts, publication, cache and native Vercel cron. Provider-date media stays separate from store-hour commerce.

**Tech Stack:** Existing Next.js 16.3.4, TypeScript, Turso, Vercel Blob and Vercel Cron. No dependencies or new paid services.

**Spec:** `docs/autobrush-connectors.md`, plus the user's instruction to build Autobrush like KP and use the connections already supplied. Loop access is unavailable and explicitly skipped.

## Global Constraints

- Autobrush Shopify is `ama-brushh.myshopify.com`, USD, `America/New_York`; scopes are read_orders/read_products/read_reports.
- No Beam-specific Faire exclusion or US-only session restriction. Human sessions; public landing pages only.
- Company/autobrush/provider grants only. Never copy Beam grants or return credentials to the browser.
- Rolling 30 store days, today's completed-hour anchor first, exact-hour yesterday comparisons, no invented missing observations.
- The approved Avenue Z dark design, caching and existing drill-downs are reused.
- Motion account `401761026978213`, organization `699496be6f1a754daac7f10e`, workspace `6ac52fac7231e870caa82acb`, USD independently verified. Account timezone remains unverified; emit provider-date media, never hourly spend or headline MER.
- GA4 is connected separately: property 274489308, website stream 2635677328, Los Angeles/USD; never relabel its days as New York or mix Facebook Shops. Existing GA4 reporting jobs remain Beam-only until an explicit stream/timezone-aware profile is implemented.
- Keep provider limitations visible in data settings, not as fabricated business actions. No external support messages.

## Review Focus

- Closed days, midnight and DST must retain exact UTC intervals and match comparison cutoffs.
- Complete exports must reconcile independently; row-limit sentinels fail rather than publish truncated facts.
- Old captures resume with original provenance; current-hour work precedes historical repair.
- New brand dispatch must never fall through to KP credentials or Beam populations.
- Company permissions stay explicit; admin setup is authorized, analyst expansion needs its own decision.

## Task 1: Shopify adapter

**Files:** Create `lib/sources/autobrush-shopify.ts`, `lib/sources/autobrush-sources.ts`, `tests/sources/autobrush-shopify.test.ts`.

**Interfaces:** Export `AUTOBRUSH_SHOPIFY_ENDPOINT`, `fetchAutobrushShopifySource(connection,client,window,token,fetcher?,deadline?,now?):Promise<SourceBatch>`, `autobrushShopifyQualification(batch,provider):RegisteredContract`. Export `AUTOBRUSH_SOURCES`, `isAutobrushProvider`, `autobrushSourceDefinition`, `effectiveAutobrushWindow` from source definitions. Use provider names `autobrush-shopify-sales`, `autobrush-shopify-products`, `autobrush-shopify-sessions`, `autobrush-shopify-traffic`, `autobrush-shopify-markets`, `autobrush-motion`, `autobrush-intelligems`.

- [x] Test fixed identity, all-market populations, independent reconciliation, bounded exports, completed hours, public page filtering and invalid source dates.
- [x] Run failing tests, implement via shared Shopify commerce/traffic primitives, then run focused tests and TypeScript.
- [x] Read-only live qualification of closed and current-day batches; retain redacted contracts/evidence only. Ten batches / 66,683 observations reconcile across sales, products, markets and traffic; public-page private-route filter verified.

## Task 2: Provider-date media and experiments

**Files:** Create `lib/sources/autobrush-motion.ts`, `lib/sources/autobrush-intelligems.ts` and corresponding source tests. Preserve Beam files unless a narrow shared core can be extracted without changing its public behavior.

**Interfaces:** Export `fetchAutobrushMotionSource` and `autobrushMotionQualification`; export `fetchAutobrushIntelligemsSource` and `autobrushIntelligemsQualification`, matching existing Beam call signatures. Pin Intelligems organization `5740704f-c0a1-4342-a6a1-fa1c3eeb2f86` without Beam's US-only filter.

- [x] Test fixed organization/account, complete pagination, reconciliation, no hourly spend/coverage claim, experiment catalog/variant identity and no monetary outcomes with unverified currency filters.
- [ ] Implement, run focused tests, typecheck and retain independent qualification evidence.

## Task 3: Hosted dispatch, publication and month of history

**Files:** Create `lib/sources/autobrush-fetch.ts`, `lib/jobs/autobrush-captures.ts`, `lib/jobs/autobrush-history.ts`, `lib/jobs/autobrush-sync.ts`, `lib/server/autobrush-cron.ts`, native cron routes and tests. Modify `lib/analytics/contracts.ts`, `lib/jobs/sync.ts`, `lib/analytics/intraday-coverage.ts`, `lib/analytics/query.ts`, `data/initial-clients.json`, `vercel.json` and explicit client capability checks only as needed.

**Interfaces:** Dispatcher `fetchAutobrushSource` and date iterator follow Beam signatures but use fresh Autobrush vault identities; source settings are fixed server-side. `runAutobrushSync` gets its own service scope and lease; history stays bounded to 30 days and honors current-work priority.

- [x] Test brand isolation, credential failures, qualified publication/resume, failed/retried historical jobs, current-work priority and same-hour comparisons.
- [x] Implement without changing existing providers' branches or cache keys. No source enabled before a validated batch and version-bound contract.
- [x] Add Autobrush config with subscriptions disabled, no incident history copied from another client and no fabricated daily reviews.

## Task 4: Release and live verification

- [x] Stage the exact 588-file verified production baseline plus only reviewed Autobrush changes; run the complete suite and native Next build. Final manifest 615 files / 55 changed; 209 test files and 3,123 tests passed; native build passed.
- [x] Independent review of adapters and orchestration; repair findings before production activation. Fixed provider-date spend omission in Autobrush daily reviews; final independent review clear. History cap raised to 20 with unchanged 700-second deadline and current-work guard.
- [ ] Register client, sources and qualifications idempotently, preserving existing source/client versions and members.
- [ ] Publish the exact manifest, run a real hosted current-day refresh, inspect persisted facts, cutoffs, cache and UI; queue and drain the 30-day history using independent jobs.
- [ ] Verify hourly and history cron configuration, source results, matched-hour yesterday, all-market filters, pages, products, media and absence of fake subscription/review figures.

## Execution ledger

- Ruling: Continue within the user's existing authorization to build the Autobrush workspace and complete supplied integrations. Do not introduce another plan-approval stop for implementation choices already implied by that request.
- Verified baseline: production `dpl_AQ56uwV9YHF5VDhiGzr9YPqRdwSq`, 588 files, 2,914 tests and native build passed. OAuth connections and read-only provider probes are completed; source activation is not.
- Workspace: use the existing user-approved feature checkout and isolated verified release stages; preserve unrelated dirty files.

- Native release: `dpl_BdqzSQ1WVVmViKfVrXmtTCrAc5Ku` submitted October 22 at 13:06 UTC. No sources enabled before READY and protected provider qualification.
- Motion current-day qualification attempted once: provider timeout after 35 seconds; no invented zero or complete-current-day claim. Prior closed account report reconciled separately.
