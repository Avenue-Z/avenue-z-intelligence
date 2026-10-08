# Avenue Z Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Execution method still requires the user's selection; this plan does not authorize delegation by itself.

**Goal:** Build the approved shared analytics app with verified source-backed updates for Kind Patches and Beam, detailed client analysis, and consistent team reporting.

**Architecture:** A private server-rendered app reads normalized, versioned analytics snapshots and shared records from persistent storage. Source adapters ingest existing authorized API or warehouse data through server-only jobs; dated reviews reference fixed snapshots. A cloud scheduler invokes an authenticated, bounded sync runner, so updates continue when the browser and strategist's laptop are closed.

**Tech Stack:** Sites' supported Vinext/React/TypeScript starter, Tailwind and existing shadcn primitives; ECharts for linked interactive charts; D1 and schema-only Drizzle migrations for shared state; R2 for source snapshots and report artifacts; Vitest for contract tests. Reuse source-owned APIs and BigQuery through HTTPS where qualification establishes coverage. Use a GitHub Actions cloud schedule for the authenticated runner if a reusable existing scheduler is not available. Provider access and unattended writer access must both be proven before scheduling.

**Spec:** [Approved design](avenue-z-analytics-design.md).

**Methodology source:** User-supplied archive, avenuez-strategy 0.3.1, commit 3beea6b69cc7ce613411e6ea3ffc60528566a92f. Source inspection is complete; backend data access and full brand configs remain to be qualified.

## Global Constraints

- “Begin with Kind Patches and Beam.”
- “Core analytics must not depend on a personal browser being open.”
- “Never substitute zero for an unavailable channel.”
- “Do not infer complete source coverage solely from a successful fetch.”
- “Brand-configured action thresholds and maximum findings govern action versus watch-list placement.”
- “A same-day rerun creates a revision under the same client/date with a current pointer and prior versions available.”
- “A disconnected source displays a truthful connection/availability state; development fixtures do not enter production views.”
- Performance values, client definitions, mappings, thresholds, incidents, and findings are persistent records or verified source data. UI components have no client-name branches.
- Credentials remain server-side. Every reader, writer, export, and job has explicit organization/client scope.
- Compare only matching metric definitions, spend coverage, currencies, and windows. Label legacy client ratios explicitly.
- Efficient growth requires revenue growth at least as fast as spend growth and flat or better spend per new-customer order. Show channel changes and the last approximately seven closed days of MER; preserve Beam's configured Meta-only scope.
- Cloud refresh targets begin at 5 minutes for current analytics and 15 minutes for spend/experiments, subject to measured provider limits. Keep 7-day spend and 60-day refund backfills configurable.
- Do not alter the existing reporting repository, warehouse SQL, source integrations, or legacy Claude schedules during the new app build.

## Review Focus

1. A refreshed response may have a current fetch timestamp and incomplete source coverage: preserve the coverage limit and suppress an unjustified live verdict. Owned by Task 3.
2. An allowed teammate may request another client's export or record directly: scope each route and record mutation on the server. Owned by Tasks 2 and 7.
3. A source has renamed/missing fields, partial pagination, or new breakdown grains: fail qualification or mark incomplete instead of silently replacing values with zero. Owned by Tasks 1 and 3.
4. A filter requests a dimension unsupported by one source: return explicit unavailable coverage and avoid changing the metric's population silently. Owned by Tasks 4 and 6.
5. A worker is retried or crashes after writing source data: resume through idempotent job/snapshot keys without duplicate sums, review revisions, or findings. Owned by Tasks 3 and 7.

## File Structure

Create the new app in work/avenue-z-analytics. Put final source/package deliverables in outputs/ only at handoff. Retain the supported starter structure and scripts; implementation may use a package alias for the test runner instead of replacing starter commands.

| Files | Responsibility |
| --- | --- |
| docs/source-qualification.md; docs/methodology.md | Verified endpoint/warehouse coverage, schema/grain/auth references, and current pinned strategy mapping |
| db/schema.ts; drizzle/ | Organizations, memberships, clients, connections, configurations, snapshots, jobs, incidents, reviews, findings, notes, audit history |
| lib/server/db.ts; lib/server/access.ts | Storage boundary and authenticated organization/client authorization |
| lib/analytics/contracts.ts; lib/analytics/windows.ts; lib/analytics/metrics.ts; lib/analytics/diagnostics.ts | Typed evidence and deterministic time/metric/analysis calculations |
| lib/sources/types.ts; lib/sources/qualification.ts; lib/sources/registry.ts; lib/sources/shopify.ts; lib/sources/triple-whale.ts; lib/sources/motion.ts; lib/sources/intelligems.ts; lib/sources/amplitude.ts; lib/sources/warehouse.ts | Qualified adapters, source coverage, and normalization; implement only transports established in Task 1 |
| lib/jobs/sync.ts; lib/jobs/leases.ts; app/api/internal/sync/route.ts | Durable sync queue, lease/retry handling, incremental cursors, and service-authorized cloud runner |
| lib/server/analytics.ts; app/api/clients/route.ts; app/api/clients/[clientId]/analytics/route.ts; app/api/clients/[clientId]/export/route.ts | Filtered query API, evidence, totals, availability, and exports |
| app/page.tsx; app/clients/[clientId]/page.tsx; components/analytics/ | Portfolio, client views, global filters, charts, tables, and evidence panels |
| lib/reviews/build.ts; lib/reviews/import.ts; lib/server/findings.ts; app/api/clients/[clientId]/reviews/route.ts; app/api/clients/[clientId]/findings/route.ts; app/api/clients/[clientId]/notes/route.ts | Reproducible reviews, historical migration, attributable shared records |
| scripts/run-sync.mjs; .github/workflows/analytics-sync.yml; README.md | Cloud runner configuration, startup/deployment, verified refresh runbook |
| tests/ | Source contracts, analytics correctness, job replay, shared records, and server authorization |

## Shared Interfaces

Use these names across tasks. Exact provider field mappings are filled from qualified responses, not invented from report prose.

- AccessScope: organizationId, actorId, permittedClientIds, role = admin/analyst/service.
- ClientConfig: clientId, store timezone/currency, markets, connection references, query registry, recurring/channel mappings, thresholds, benchmark preferences, schedule, and version.
- TimeWindow: start/end ISO timestamps, IANA timezone, granularity, durationHours, reporting date, closed/partial mode, and comparison kind.
- MetricEvidence: metric-definition ID/version, source/snapshot ID, numeric value or null, numerator/denominator when present, scope/dimensions, window, currency, precision, retrievedAt, coverageThrough or null, quality state, exclusions and annotations.
- SourceRequest: AccessScope, ClientConfig, logical query ID, TimeWindow, cursor or null.
- SourceBatch: normalized observations, nextCursor or null, coverage, grain, schema version, retrievedAt, completeness and diagnostics.
- QueryFilters: clientIds, window/comparison, market/stream/source/device selectors, supported-dimension requirements, pagination, sort.
- AnalyticsResult: metrics, chart series, detail rows, complete filtered totals, evidence index, availability and warnings.
- AnalysisResult: verdicts (growth = efficient/inefficient/inconclusive/unavailable; spendComparison = faster/slower/proportional/unavailable), ranked opportunities, watch items, stream/mix decomposition, annotations, and evidence references.
- ReviewRecord: client/date/revision, methodology/config versions, input snapshot IDs, cutoff, AnalysisResult, narrative, generatedAt and correction metadata.
- QualificationRecord: client/query identity, connection reference, schema/grain including hourlyGrain, supported/required dimensions and channels, timezone/currency, pagination completion, measured coverage, and reconciliation results. QualifiedQuery adds status = qualified; QualificationFailure has status = unqualified, explicit reasons and unavailable query identity.
- ComparisonWindows: current/comparison TimeWindow, matched cutoff, recurring current/four-weeks-earlier windows, optional clean alternate and comparability warnings. WindowSelection is QueryFilters' date/mode/comparison selection; SourceCoverage contains available interval and complete-hour boundaries per source.
- MetricObservation: source/snapshot identity, window, dimensions, counts/amounts and quality. MetricDefinition: versioned formula, required inputs and compatible scope. AnalysisContext: config, incidents, benchmark candidates, experiments and closed-day history.
- JobIds = string[]. SyncRunResult: attempted/completed/retried job IDs, source-specific failures and remaining count. SyncBudget: maximum jobs and wall-clock deadline.
- Finding: scoped identity, evidence IDs, observed date, owner, status, history and version. FindingUpdate: permitted changes plus finding ID. ReviewImport: original dated content, client, source URL, correction labels and verified config; ImportResult: imported/reused record IDs and rejected inputs.

**Verification commands:** Each task with new logic runs `pnpm exec vitest run` against its listed test files before and after implementation; before implementation expect a missing-interface or failed behavior assertion, afterwards expect all listed tests to pass. Use labeled test-only fixture builders for the cases below; fixtures are never application data. At delivery run `pnpm exec vitest run`, the starter's typecheck script when present, and its supported production build script. A passing build alone does not qualify a live source.

Representative exact assertions for the critical contracts (fixture builders vary only the named input):

```ts
expect(validateQualification(qualification({ hourlyGrain: false })).status).toBe('unqualified');
expect(analyzeClient(efficiencyMetrics({ spend: [100, 110], revenue: [200, 240], newOrders: [10, 12] }), context).verdicts.growth).toBe('efficient');
expect(analyzeClient(efficiencyMetrics({ spend: [100, 110], revenue: [200, 240], newOrders: [10, 9] }), context).verdicts.growth).not.toBe('efficient');
expect(analyzeClient(efficiencyMetrics({ missingChannel: 'TikTok' }), context).verdicts.spendComparison).toBe('unavailable');
expect(resolveWindows(newYorkConfig, closedDay('2026-11-01'), completeCoverage).current.durationHours).toBe(25);
```

These assertions pin qualification statuses, verdict labels, and durationHours on TimeWindow; every remaining listed test pins its named behavior in the owning task.

### Task 1: Qualify current methodology and existing source access

**Files:** docs/source-qualification.md; docs/methodology.md; lib/analytics/contracts.ts; lib/sources/qualification.ts; tests/sources/qualification.test.ts.

**Consumes:** Approved spec, current avenuez-strategy, real client configurations/notes, authorized API/warehouse connections.
**Produces:** Qualification records for each client/logical query: source endpoint or table, authentication reference, schema/grain, dimensions, reporting definitions, timezone/currency, coverage, pagination, and measured freshness. Methodology mapping pinned to the actual repository revision.

- [x] Inspect the supplied ZIP and pin the strategy source. Read its daily-review skill and diagnostic references; no AGENTS.md or CLAUDE.md was present. Reconcile 0.3.1's spend-efficiency requirement with the older copy and supplied brand prompts. Treat legacy Claude execution/publishing instructions as migration material.
- [ ] Retrieve actual brand configs and running notes through supported artifact/file access. Import source identifiers from those records and the supplied prompts; verify their account/store identity.
- [ ] Write the qualification contract test. Assert missing channel coverage, unknown timezone, partial pagination, absent human-session filtering, and unsupported hourly grain prevent the affected logical query from being declared qualified.
- [ ] Run the contract test and confirm it fails before adding validateQualification(record).
- [ ] Define Shared Interfaces in lib/analytics/contracts.ts and implement validateQualification(record: QualificationRecord): QualifiedQuery | QualificationFailure in lib/sources/qualification.ts with explicit failure reasons.
- [ ] Query authorized sources for a closed day and a current interval; reconcile Shopify/report totals, spend grain/account totals, subscription flags, and experiment status. Check BigQuery datasets read-only; daily GA4 does not substitute for Shopify human-session funnel metrics.
- [ ] Run the contract test and record reconciliation results and access gaps. Commit the qualification and methodology documents in the new app source when the checkout exists. Missing connections remain named prerequisites, not fake adapters.

### Task 2: Persistent client configuration and team authorization

**Files:** db/schema.ts; drizzle/; lib/server/db.ts; lib/server/access.ts; app/api/clients/route.ts; tests/server/access.test.ts; tests/server/configuration.test.ts.

**Consumes:** Qualified ClientConfig and authenticated platform identity.
**Produces:** requireClientAccess(clientId: string): Promise<AccessScope>; getClientConfig(scope: AccessScope, clientId: string): Promise<ClientConfig>; saveClientConfig(scope: AccessScope, config: ClientConfig, expectedVersion: number): Promise<ClientConfig>.

- [ ] Initialize the supported private Sites app with D1/R2 and a site-specific favicon. Preserve starter auth/build integration. Authoritative state never goes into browser storage.
- [ ] Write tests asserting anonymous requests are rejected, client permissions apply to direct IDs, a new client needs no frontend edit, secrets are absent from returned config, and concurrent config edits reject stale expectedVersion.
- [ ] Run these tests and confirm failure before implementing the interfaces.
- [ ] Implement schema-only migrations, DB helpers, membership checks, and versioned configuration writes. Authentication identifies a user; explicit membership determines access. Do not automatically enroll every signed-in visitor.
- [ ] Import the verified Kind Patches and Beam configurations through an authorized configuration operation; store dated incidents as data. Seed/backfill data is separate from migrations.
- [ ] Run the tests and generate/inspect migrations; commit the persistence and access boundary.

### Task 3: Source ingestion, snapshot history, and durable sync

**Files:** lib/sources/; lib/jobs/; app/api/internal/sync/route.ts; tests/sources/adapters.test.ts; tests/jobs/sync.test.ts.

**Consumes:** QualifiedQuery records, AccessScope, ClientConfig, TimeWindow.
**Produces:** SourceAdapter.fetch(request: SourceRequest): Promise<SourceBatch>; enqueueDue(scope: AccessScope, now: string): Promise<JobIds>; runSyncBatch(scope: AccessScope, budget: SyncBudget): Promise<SyncRunResult>.

- [ ] Write contract tests using labeled test-only fixtures: renamed required fields fail; new breakdown rows do not double spend; partial pagination cannot publish complete totals; fetchedAt does not advance coverageThrough; retry/replay and crash-resume preserve one logical snapshot/update.
- [ ] Run tests to confirm failure before implementation.
- [ ] Implement only qualified transports and schema mappings. Store provider secrets in runtime secret storage. Queries use registered source endpoints and query IDs, never arbitrary visitor-supplied URLs or SQL.
- [ ] Implement source snapshots in R2 with scoped D1 metadata, lease-based jobs, versioned cursors, idempotent writes, retry/backoff, and configured recent-period backfills. Keep previous observations for corrections.
- [ ] Add the service-authorized runner. An authenticated viewer alone does not authorize a sync job; service scope is limited to registered clients/sources.
- [ ] Run contract/job tests and a supported source ingestion; read persisted data back and reconcile it. Commit the adapters and sync runner.

### Task 4: Time windows, metric definitions, and strategy diagnostics

**Files:** lib/analytics/; tests/analytics/windows.test.ts; tests/analytics/metrics.test.ts; tests/analytics/diagnostics.test.ts.

**Consumes:** ClientConfig, validated source snapshots, TimeWindow and scoped counts/amounts.
**Produces:** resolveWindows(config: ClientConfig, selection: WindowSelection, coverage: SourceCoverage[]): ComparisonWindows; calculateMetrics(observations: MetricObservation[], definitions: MetricDefinition[]): MetricEvidence[]; analyzeClient(metrics: MetricEvidence[], context: AnalysisContext): AnalysisResult.

- [ ] Write tests asserting New York's November 1, 2026 closed day spans 25 hours; Stockholm's October 25, 2026 closed day spans 25 hours; comparisons stop at the shared complete-hour cutoff; recurring weeks start Monday and shift exactly four calendar weeks.
- [ ] Add metric tests: 1,000 sessions with CVR 0.03 and benchmark 0.04 give an opportunity of 10; above-benchmark opportunity is zero; zero denominators return null; rates use summed counts; overlapping product counts do not become unique orders.
- [ ] Add diagnostic tests: spend 100→110 and matching revenue 200→240 yields slower spend growth; new-customer orders 10→12 permit efficient growth, while 10→9 prevent it and missing counts leave efficiency unavailable. Missing channels suppress the verdict; Beam/Kind Patches legacy MER scopes are incompatible; rising actual orders with falling CVR is not automatically lost revenue or a broken checkout.
- [ ] Test channel-change attribution and a seven-closed-day MER series against scoped source evidence; current partial days never enter the closed-day trend. Test experiment intervals crossing zero or not-ready status cannot become a declared win.
- [ ] Add incident/filter tests: Sep22 bounce/ATC comparisons are invalid across the measurement change; contaminated renewal benchmarks include a clean alternate; unsupported dimensions return unavailable; delayed refunds revise cohort metrics with preserved history.
- [ ] Run tests to confirm failure, then implement the three interfaces. Preserve benchmark hierarchy, action thresholds, order streams, mix/media diagnostics, and experiment readiness from the qualified methodology.
- [ ] Run the analytics suite and reconcile outputs with real source calculations. Commit the analysis engine.

### Task 5: Data API and first meaningful portfolio preview

**Files:** lib/server/analytics.ts; analytics API route; app/page.tsx; components/analytics/portfolio.tsx; components/analytics/filters.tsx; tests/server/analytics-query.test.ts.

**Consumes:** Scoped snapshots, metric engine, QueryFilters.
**Produces:** queryAnalytics(scope: AccessScope, filters: QueryFilters): Promise<AnalyticsResult>; a working portfolio route with real configured clients, truthful availability, and links into client views.

- [ ] Write API tests asserting organization/client scope, compatible portfolio totals, full filtered totals across pagination, stable evidence IDs, and preservation of source freshness.
- [ ] Run tests to confirm failure, then implement queryAnalytics and the API boundary.
- [ ] Build the compact portfolio working surface: client table, trend/comparison chart, impact queue, date/comparison controls, and explicit data status. Use installed primitives; every control changes URL/query state.
- [ ] Serve the route successfully with verified source records or explicit missing-source states. Open the first meaningful preview at this point, before broadening product-source edits.
- [ ] Run API tests; verify table/chart selection and client navigation in the browser; commit the first working surface.

### Task 6: Complete client analysis views and evidence drilldowns

**Files:** app/clients/[clientId]/page.tsx; components/analytics/{client-overview,revenue,funnels,markets,products,subscriptions,media-experiments,reviews,settings,chart,detail-table,evidence-panel,data-status}.tsx.

**Consumes:** AnalyticsResult, AnalysisResult, QueryFilters.
**Produces:** The nine spec views, linked filter/chart/table state, evidence inspection, and source/config settings.

- [ ] Implement shared chart/table/evidence components with exact hover values, comparison overlays, zoom/brush, legend toggles, sorting, pagination, and accessible table alternatives.
- [ ] Implement Overview, Revenue/acquisition, Pages/funnels, Markets, Products/offers, Subscriptions, Media/experiments, Reviews/follow-ups, and Data/settings. Enable dimensions from source capability metadata; mark unsupported ones explicitly.
- [ ] Verify filters apply to chart, table, totals, and evidence simultaneously. Inspect both clients' legacy ratio labels, partial/closed modes, experiment confidence/status, and dated incident annotations.
- [ ] Check desktop and narrow-screen layouts, keyboard operation, and error/loading states. Fix any blocking discrepancy; commit the complete analysis workspace.

### Task 7: Shared records, reproducible reviews, historical import, and exports

**Files:** lib/reviews/; lib/server/findings.ts; review/finding/note/export API routes; tests/reviews/revisions.test.ts; tests/server/shared-records.test.ts; tests/server/export.test.ts.

**Consumes:** Scoped fixed snapshots, AnalysisResult, methodology/config versions, verified historical artifacts, authenticated team identity.
**Produces:** buildReview(scope: AccessScope, clientId: string, storeDate: string, cutoff: string): Promise<ReviewRecord>; importReview(scope: AccessScope, input: ReviewImport): Promise<ImportResult>; updateFinding(scope: AccessScope, input: FindingUpdate, expectedVersion: number): Promise<Finding>; exportAnalytics(scope: AccessScope, filters: QueryFilters): Promise<Response>.

- [ ] Write tests: same-day reruns have one current pointer and immutable prior revisions; a source correction retains the original review; failed/replayed jobs do not duplicate revisions or findings; concurrent human edits preserve attribution and reject stale versions.
- [ ] Add tests for cross-client direct mutations/exports, historical prose without invented hourly points, corrected Motion creative evidence, distinct order shares, and CSV quoting/formula-safe text fields.
- [ ] Run tests to confirm failure, then implement the four interfaces and shared notes. Persist owners, status, evidence and resolution/reopen suggestions without hiding human history.
- [ ] Build deterministic review inputs first, including the 30-second read, spend-versus-revenue table, impact-ranked actions/watch list, recurring/mix/media notes, detail tables and 4–6 headlines including spend versus revenue. Integrate a server-side explanation provider only after supported API access is established; narrative numbers must reference validated evidence. Provider failure preserves the computed report and marks narrative availability accurately.
- [ ] Import actual dated reviews/config notes, preserve correction labels, and link to source artifacts. Add the review picker, revision view, and shared editing UI.
- [ ] Run tests and verify a second authorized browser session reads the same shared record. Commit shared reporting and exports.

### Task 8: Unattended cloud updates and end-to-end delivery

**Files:** scripts/run-sync.mjs; .github/workflows/analytics-sync.yml if needed; README.md; docs/verification.md.

**Consumes:** Qualified server source access, deployed private app, service-authorized runner, configured schedules.
**Produces:** A hosted app with verified background sync and daily reviews, plus source/configuration and refresh runbooks.

- [ ] Verify that existing source credentials and app writer access work from the intended cloud execution environment without browser identity or the authoring laptop. Record each missing prerequisite precisely.
- [ ] Reuse an authorized existing scheduler if it can invoke the runner with the required scope/cadence. Otherwise set up a cloud GitHub Actions schedule and secret references in the app's own source repository. Treat scheduled intervals as targets and show actual last runs.
- [ ] Configure source refresh and timezone-aware daily-review jobs. Coalesce overlapping runs, retain stale timestamps on failure, and record source-specific backfill outcomes.
- [ ] Run required test suites and the supported production build. Publish privately with persistent bindings and scoped team access.
- [ ] Trigger the cloud runner; confirm source retrieval, persisted changes, visible app updates, review history, and job completion. Exercise a failed source and a replay without writing disposable merchant records.
- [ ] Verify a second teammate session and both clients' full views. Record unresolved source gaps if any; do not describe the app as complete/live for a source that has not passed this verification.
- [ ] Save the user-facing source package and runbook under outputs/, provide the private app link, and retain the continuous preview for follow-up work.

## Plan review and execution

This plan is prepared for review. The supplied ZIP resolves skill-repository access. Task 1's remaining dependencies are full brand configs/notes and identifying the existing authorized API or warehouse connections. No production dataset or live source connection has yet been queried.

Recommended execution method: Native — implement tasks in this chat, with explicit interface tests and source reconciliation. The tasks share one source and metric contract, so keeping implementation together reduces handoff overhead. Subagent-driven execution is also available if the user prefers separate implementers/reviewers.

Before implementation, the user reviews this plan and selects Native or Subagent-driven execution, as required by the writing-plans workflow.

Self-review completed October 8: every spec section maps to Tasks 1–8; the five Review Focus failures have owning tests; shared interface names and source provenance were reconciled; missing source access remains explicit. The app is not yet implemented.
