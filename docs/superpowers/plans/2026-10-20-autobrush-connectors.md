# Autobrush Connectors Implementation Plan

> **For agentic workers:** Use the parallel-agent workflow for the independent provider clients; the controller owns readiness verification and integration review.

**Goal:** Prepare the missing Loop and Northbeam server-side connectors and a truthful Autobrush readiness check while authenticated browser access is unavailable.

**Architecture:** Extend the existing source-adapter directory with independent provider clients. Preserve existing KP/Beam flows and keep source activation dependent on actual authorization and reconciliation. This plan implements the code work that can be verified without inventing source access.

**Tech Stack:** Existing TypeScript, fetch, Zod, Temporal, Node crypto and Vitest; no new dependencies.

**Spec:** docs/autobrush-connectors.md

## Global constraints

- Autobrush Shopify domain is ama-brushh.myshopify.com; authenticated currency/timezone are not yet verified.
- Do not expose credentials, raw customer PII or private export URLs in logs or UI.
- No production source activation, cloned OAuth refresh grants, plan changes or made-up performance values.
- Preserve existing brand definitions, scope isolation and provider coverage semantics.
- Use official current provider documentation and record genuine source uncertainties.

## Review focus

- A missing final page/cursor must never produce a complete subscription history.
- Reactivation must not erase an original creation-day cancellation event.
- Current active inventory must not become historical active-customer counts.
- A Northbeam timeout after export creation must not cause a blind duplicate POST.
- Cached provider-date reports and export completion times must not become matched-hour coverage claims.

## Task 1: Loop data and signature client

**Files:** Create lib/sources/autobrush-loop.ts and tests/sources/autobrush-loop.test.ts only.

**Interfaces:** Consume standard fetch and explicit config/identity/window inputs. Export typed readLoopSubscriptions, readLoopActivityLogs, summarizeLoopSubscriptions and verifyLoopWebhookSignature functions. The implementation report states the exact signatures/types and which live checks remain necessary.

- [x] Write failing tests for the provider's documented envelopes, pagination/deadlines, minimization and the required subscription metrics.
- [x] Implement strict read-only API access plus deterministic analytics and raw-body signature verification; never register or mutate a live source.
- [x] Run the focused tests and report their output, then review against the spec.

## Task 2: Northbeam discovery/export client

**Files:** Create lib/sources/autobrush-northbeam.ts and tests/sources/autobrush-northbeam.test.ts only.

**Interfaces:** Export typed discoverNorthbeamOptions, createNorthbeamExport and readNorthbeamExport functions with explicit credentials/config, account identity, validated immutable request and injected fetcher/deadline. Persisting jobs, fetching private download URLs and mapping arbitrary CSV metrics into existing revenue metrics are outside this protocol client's responsibility.

- [x] Write failing tests for discovery option validation, identity, pending/success/error envelopes, timeout and credential-safe errors.
- [x] Implement the minimal documented async API protocol, returning an export ID for resume and all result files only on success.
- [x] Run focused tests and report output; review against the spec.

## Task 3: Operational readiness and release verification

**Files:** Create scripts/verify-autobrush-readiness.mjs; update only the private access audit and these plan status records as needed.

- [x] Read actual Autobrush client/connection/qualification/sync/history records using the existing server credentials without modifying them.
- [x] Report provider-by-provider evidence and explicit unverified/blocked states; do not print secrets or invent store metadata.
- [x] Independently review both source clients and correct important findings.
- [x] Run all tests and the native build in the existing exact-release verification workflow.
- [x] Record completed code work and the concrete remaining browser/authentication blocker. Publish only verified behavior; do not claim live ingestion for unauthenticated sources.

## Verified outcome — October 20, 2026

- Loop: 51 focused tests; Northbeam: 56; stored-setup diagnostic: 10. Independent review findings resolved.
- Exact current-production source baseline plus the scoped additions: 196 test files and 2,901 tests passed; native Next.js webpack production build passed. Targeted strict TypeScript and ESLint passed.
- Actual read-only production check: Autobrush is not registered and no provider ingestion sources are activated. The diagnostic exits 2 and explicitly leaves handover unverified.
- No production deployment, credentials, existing pipelines or billing changed. These are protocol clients, not completed live integrations.
- Computer Use reports the Mac locked and its supported automatic unlock failed. Authenticated Chrome/Shopify installed-app inspection and provider grants remain blocked; restarting Codex is not the required action. Live identity, authorization, source registration, reconciliation, rolling-month backfill and UI verification remain necessary before handover.
