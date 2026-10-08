# Avenue Z Analytics: proposed product and data design

Prepared October 8, 2026. Status: approved by the user on October 8; implementation planning in progress.

## Outcome

Create a shared internal web app where Avenue Z can monitor all clients, identify changes that deserve attention, and investigate each client in detail. Begin with Kind Patches and Beam. The app must preserve the depth of the current daily reviews while replacing dependence on each strategist's personal Claude schedule and local folders.

Success means a teammate can answer: How are our clients doing? Which client needs attention? What changed, where did it change, what evidence supports the finding, and what should we check next?

Confirmed requirements: multiple views, a portfolio overview, detailed client views, interactive charts and tables, automatic updates from real sources, and no hardcoded performance data. The supplied daily prompts establish additional brand-specific analysis requirements.

Proposed assumptions: this is an internal team app; authorized teammates share findings and notes; daily reports remain useful alongside live exploration. External client portals, automatic campaign edits, and storefront changes are outside this first app.

## Source material and limits of this draft

The published [Kind Patches Daily Review](https://claude.ai/artifact/KtrN5kzcTr3hkXjDs7MBRH) and [Beam Daily Review](https://claude.ai/artifact/G4zLdqcoVA4oGQW53rTcMS) were read in the browser. The latest displayed reviews were October 8 for Kind Patches and October 7 for Beam. These are published historical reports, not direct queries of the underlying stores.

The requested repository is [V-Partners/avenuez-skills](https://github.com/V-Partners/avenuez-skills). The user supplied its ZIP after GitHub repository access failed. The archive identifies commit 3beea6b69cc7ce613411e6ea3ffc60528566a92f and avenuez-strategy version 0.3.1; its SHA-256 is 6c7a9e2e5adcf72cdc15852f6ffa61dddb012e20f08829c4552d44c387166d47. The strategy README, daily-brand-review skill, diagnostic framework, and Triple Whale diagnostics have been read. Version 0.3.1 adds the required spend-versus-revenue analysis to the older 0.3.0 copy. Repository access is no longer a prerequisite for this build. The Shopify development plugin is outside the requested methodology. The separate kind-patches-daily-analytics skill named in the prompt is absent from this archive; its supplied prompt and visible reports provide the additional brand guidance available so far.

The artifacts' embedded brand-config JSON and Beam's local config.json and notes.md have not been retrieved. The draft uses the supplied prompts and visible reports; it does not claim their complete configuration has been imported.

No live client API connection, credential, background scheduler, or deployed app has been verified or created in this draft.

The user confirmed existing API or warehouse access is available to reuse. Read-only GitHub discovery found Avenue-Z/avenue-z-warehouse and Avenue-Z/avenue-z-reporting. The warehouse documentation describes BigQuery fed by Supermetrics and daily scheduled pipelines; current pipeline status and actual data were not queried. Its client mapping includes Kind Patches entries but the inspected file has no Beam match, and its documented Shopify coverage is one shop. The existing reporting app documents Next.js, server-side Supermetrics, and code-defined client configuration. These are integration candidates, not proof that all required client datasets or live windows are already available. No existing repository or warehouse was modified.

## Architecture choice

| Approach | What it provides | Tradeoff |
| --- | --- | --- |
| Shared ingestion service and analytics database — recommended | Consistent numbers for the team, source history, corrections, automatic refresh, reproducible reviews | Requires source connections and a backend |
| Query providers directly on every page visit | Fresh provider responses with less stored data | Slow or unavailable providers affect every view; concurrent teammates consume rate limits; previous findings are difficult to reproduce |
| Use an existing Avenue Z warehouse | Reuse established source access and data infrastructure | Suitable if one exists and exposes the required hourly and dimensional data; availability has not been established |

Use the first approach unless an existing warehouse already satisfies the data contracts below. Source adapters remain replaceable so a future warehouse can feed the same app.

Data flow: source APIs and permitted event feeds → background sync jobs → validated source snapshots → normalized metrics → analysis rules → app views and daily review records.

Use a TypeScript/React frontend with a server API, persistent relational storage, durable background jobs, and a chart library that supports linked filters and zooming. Choose the concrete hosting and database implementation during planning based on available infrastructure and source authentication. Core analytics must not depend on a personal browser being open.

The review engine ports the strategy methodology into a server workflow. Calculate metrics and comparisons deterministically; use a language model to explain the verified results and propose hypotheses. Store the methodology version, configuration version, input snapshot IDs, and generation time with each review.

## Portfolio view

Open directly on the team's working dashboard. Keep the layout dense and readable, with tabular numbers, compact controls, and clear visual hierarchy.

The primary client table includes client, reporting date/window, revenue, orders, spend coverage, spend change versus revenue change, comparable efficiency ratios, sessions, CVR, recurring sales, actionable findings, and source freshness. Clicking a client opens its analysis workspace with the selected date and comparison preserved.

Show revenue and spend trends, a client comparison chart, and an impact-ranked queue of findings. Chart selections filter the relevant table. Each finding links to the client, exact segment, comparison window, and evidence behind it.

Client performance and data availability are separate statuses. Missing data cannot make a client appear healthy or deteriorating. Avoid an unexplained composite score; show which measurements caused the status.

The default portfolio comparison uses the latest completed day in each store's timezone and states that convention. Offer an explicit common UTC-window option only for datasets with sufficient timestamp precision. A separate Latest view may show different client windows, with their dates and cutoffs clearly displayed and combined totals disabled.

Portfolio totals require compatible revenue definitions, currencies, and time conventions. Show native currency by default; aggregate only after verified currency normalization and display the FX source/date. Ratios are calculated from summed compatible numerators and denominators, never averaged from client percentages.

## Client workspace

| View | Information and interactions |
| --- | --- |
| Overview | KPI trends, 30-second read, spend-versus-revenue verdict, impact-ranked opportunities, open items, and significant changes since the previous review |
| Revenue and acquisition | Online Store and other sales channels; one-time, first-subscription, and renewal streams; new/returning customers where available; revenue, orders, AOV, spend, and labeled efficiency ratios |
| Pages and funnels | Landing page → market → traffic source → device/browser, where supported; sessions, converting sessions, CVR, ATC, reached checkout, completion, benchmarks, order gaps, and actual order change |
| Markets | Country comparisons, localized page comparisons, funnel steps, traffic mix, currency context, and customer-service/internal-traffic annotations |
| Products and offers | Product revenue, units, discounts, refunds, gross per unit, bundles, freebies, and exclusion rules; distinguish product-level order counts from unique store orders |
| Subscriptions | Monday-start weeks versus four weeks earlier; matched elapsed periods; orders/day, AOV, renewal revenue, refunds and cancellations; clean alternate benchmarks and cohort maturity notes |
| Media and experiments | Channel/account/campaign/ad spend; creative evidence where available; connected landing pages; experiment variants, exposure, sample sizes, confidence intervals, status, and launch dates |
| Reviews and follow-ups | Date-indexed review archive, revisions and correction notes, persistent findings with owners/status/history, and shared brand notes |
| Data and settings | Source connection status, query/report coverage, last success, coverage through time, delayed data, reconciliation failures, and editable client reporting configuration |

Global controls include time mode, date range, comparison, market, revenue stream, and available source/device filters. Filter state is represented in the URL for repeatable team investigation. Unsupported dimensions are explicitly unavailable rather than fabricated.

Charts support exact-value hover, comparison overlays, zoom/brush, legend toggles, and selection into underlying rows. Event annotations mark measurement changes, promos, media changes, and experiments. Tables support sorting, search, column choice, pagination, and export of the actual filtered dataset. Aggregates cover all matching records, not just the displayed page.

Each metric has an evidence panel showing its definition, source, scope, time window, comparison window, numerator/denominator, exclusions, precision, freshness, and relevant caveats. Show a tabular alternative to charts and keyboard-accessible controls.

## Reporting and metric contracts

Every value carries client/store identity, metric-definition version, reporting timezone, currency where relevant, dimensional scope, start/end timestamps, retrieved-at time, source coverage-through time when available, and quality status. Do not infer complete source coverage solely from a successful fetch.

Revenue labels distinguish Shopify net sales, revenue before refunds, shipping/tax exclusions, acquisition revenue, renewal revenue, and all-channel revenue. Shopify remains authoritative for its report-defined sales metrics; alternative sources are reconciled with their own definitions rather than silently substituted.

Spend coverage identifies included channels and accounts. A Meta-only source cannot produce an all-channel spend total. Never substitute zero for an unavailable channel.

The existing MER values are not directly comparable. Kind Patches uses web non-recurring revenue excluding shipping and tax against all-channel spend. Beam's displayed headline uses all-channel net sales, including renewals, against Meta spend. Preserve those client-specific historical ratios with explicit labels. Add a common acquisition-efficiency definition only where both clients have verified data for the same revenue and spend scope. Until then, exclude incompatible ratios from portfolio rankings.

The verdict compares spend change and revenue change over identical complete windows and compatible scopes. It states spend grew faster, slower, or proportionally, with a configurable tolerance. Version 0.3.1 permits an efficient-growth verdict only when revenue grows at least as fast as spend and spend per new-customer order is flat or better. Show channel changes and approximately seven closed days of MER alongside the verdict, and include it in the 30-second read and daily headline bullets. Cover falling revenue as well. If coverage is incomplete, report that the verdict cannot yet be established; missing new-customer counts prevent the efficient-growth label. Reported values and any analyst estimates are separate; an estimate never overwrites a source value.

CVR uses the source's verified converting-session numerator and session denominator for the same filters. Do not divide all-country order counts by US-only human sessions. Product-level order counts may overlap across products; use distinct order IDs for unique-order shares. Compute rates and monetary ratios from raw counts/amounts where available. Return unavailable for zero denominators and label approximations made from rounded report values.

Order opportunity = sessions × max(0, benchmark CVR − current CVR), with rates expressed as fractions. Record the benchmark and its selection reason. This is an estimated opportunity at the observed traffic volume, not proof that orders were lost or a full-day forecast. Show actual orders and traffic changes alongside it to distinguish dilution from regression.

Keep the strategy's benchmark hierarchy: same page in the configured benchmark market, then the page's own comparison period, then a justified comparable page. Brand-configured action thresholds and maximum findings govern action versus watch-list placement. Correlation supports a hypothesis; a page CVR decline alone does not establish a checkout failure.

Split AOV movements into one-time orders, first subscription orders, and renewals where source flags reconcile. Analyze page-family mix and media spend/click efficiency before attributing changes to onsite behavior. Subscription order flags, channel mappings, and exclusions must be verified per store.

Use IANA timezones and timezone-aware period boundaries across daylight-saving changes. Intraday comparisons end at the last mutually available complete hour; closed-day comparisons use complete local store days. Recompute Monday-start weeks explicitly rather than relying on a provider's default week field. Partial recurring weeks compare matched weekdays/elapsed periods; any full-week projection is labeled and accounts for renewal batching.

## Brand configuration

Store client definitions in the database: timezone, reporting currency, markets, benchmark hierarchy, sources/account identifiers, saved report/query registry, recurring classification, channel mappings, exclusions, action thresholds, KPI preferences, schedule, and historical incidents. Adding a client must not require editing chart components or brand-name conditionals.

Kind Patches starts from Europe/Stockholm and the bright-patches store, pending verification of source metadata. Preserve its 09:00 America/New_York review schedule, matched-hour spend checks, closed-day context, recurring comparisons, and the configured saved-report set.

Carry the September 22 measurement change as a dated comparability rule for bounce and ATC. Carry the August 26–September 8 renewal-pricing incident as a contaminated benchmark period and the August 17 clean week as an alternate comparison. Resolve contaminated comparisons by actual date overlap; the October 12 week should then compare cleanly to September 14. Store ONBRAND detection as a data-hygiene rule, and reconcile anomalous units/cancellations with orders instead of declaring a price change.

Import Kind Patches' open-item history, including page/market/source context and resolved/reopened states. Use the newest review to establish current state; do not seed the app from an old prompt's open list alone.

Beam starts with America/New_York, closed prior-day reviews, previous-day and same-weekday comparisons, US human sessions, and Loop recurring revenue. Verify the supplied Intelligems organization, Motion organization/workspace, and Amplitude project against authorized source accounts before storing them as active connections.

Beam's October 8 correction establishes a required spend reconciliation: account totals must be derived from verified ad-level data and reconciled before creative aggregation. Historical creative breakdowns marked as understated remain flagged until re-pulled. Preserve experiment readiness and confidence information; a changing estimate or a confidence interval crossing zero cannot become a declared win.

All incidents and brand quirks are records with effective dates, evidence, and status. Generic analysis code evaluates these records. They are not permanent special cases embedded in frontend code.

## Source connections and automatic updates

| Source | Required coverage | What must be verified |
| --- | --- | --- |
| Shopify / ShopifyQL | Report-defined sales, sessions/funnels, markets, products, discounts, recurring channels; order/refund events where permitted | Correct store, scopes, historical access, available dimensions, query semantics, and report reconciliation |
| Triple Whale — Kind Patches | Matched-hour channel/campaign spend, web non-recurring revenue, new customers, renewal refund/cancel checks, ONBRAND investigation | Authorized server access to the required tables, actual schema and grain, complete channel coverage, and timezone/currency settings |
| Intelligems — Beam | Existing ShopifyQL access and live experiment data | Whether the team's present tool access can be used by a deployed backend; organization authorization and experiment dimensions |
| Motion — Beam | Meta account/ad spend, creative grouping and diagnostics | Server authentication, workspace/account coverage, correct grouping, pagination, and total reconciliation |
| Amplitude — Beam | Checkout-completion cross-check | Server access, project, event definitions, timezones, and count semantics |

Claude-connected tools are not automatically credentials or callable endpoints for a hosted app. Prove backend access to each required source before describing that connector as live. A generic Triple Whale summary API alone does not establish SQL-table access for the required analysis. Its public API documentation describes scoped authentication and a limited set of personal-key endpoints. [Triple Whale API documentation](https://github.com/Triple-Whale/triple-whale-public-apis).

ShopifyQL can return structured analytics for a custom dashboard; its current documentation specifies reporting scope and protected-data requirements. Check the installed app's actual grants during setup. [ShopifyQL through the Admin API](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api).

Proposed initial sync cadence: event-driven order/refund updates where supported, current-day analytics every 5 minutes, spend/experiments every 15 minutes, and scheduled reconciliation/backfill. These are configurable polling targets, not guaranteed provider latency. Validate cadence against each provider's access, rate limits, and observed delay before activation. Shopify's guidance supports fetch-time labels and short caching for live reporting periods. [ShopifyQL freshness and caching](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api/errors-limits-and-performance).

A verified event is published to viewers after it is persisted. The UI can receive updates via server events or refetch after an update notification. A refresh requests or observes a real sync; a timer cannot relabel existing data as freshly sourced.

Sync jobs run without a strategist's laptop. Use durable scheduling, per-client/source concurrency limits, retry/backoff, idempotent upserts, incremental cursors, and pagination. Authentication failures pause the affected connector and create a visible reconnect task. Keep the last successful data with its original timestamp and stale status. Other clients and sources continue.

Rerun recent dates for delayed spend and refunds. Start with a rolling 7-day spend backfill and 60-day refund reconciliation, adjustable to source capabilities, plus explicit longer backfills. Keep previous snapshots and correction history. Triple Whale books order-table refund amounts against the original order date, so refund-date and order-cohort analyses require different handling. [Triple Whale Orders Table](https://triplewhale.readme.io/docs/orders-table).

Validate source grains before sums and joins. The supplied strategy's Triple Whale diagnostics specify a country-breakdown filter for spend; the current public table guide describes additional breakdown rows for Facebook. Treat this as a schema/connector verification requirement rather than blindly reusing one filter across every channel. Reconcile account/channel totals to prevent duplicate spend or excluded channels. [Triple Whale Ads Table](https://triplewhale.readme.io/docs/ads-table).

Browser reading can help migrate saved report definitions. If a required dataset is available only through an interactive passkey session, mark that source as blocked for unattended operation until a supported server connection is established. Do not make a personal browser the default app backend.

## Shared reviews, findings, and access

Live dashboards and daily reviews share validated metrics. Daily reviews are reproducible snapshots at a recorded cutoff; later refreshes do not rewrite the original reasoning invisibly. A same-day rerun creates a revision under the same client/date with a current pointer and prior versions available.

Import historical reviews as dated archive records and source links. Preserve their correction notes and measurement caveats. Do not turn prose or rounded historical tables into invented hourly series. Historical data missing from the sources remains unavailable.

Findings have a stable identity, client, affected segment, evidence, estimated impact, observed date, owner, status, and history. Suggested diagnoses are labeled. Automatic observations update the evidence and may suggest resolution or reopening; human edits remain attributable. No messages to external teams are sent by this app's reporting workflow unless that is explicitly added later.

Team identity and server-enforced client access protect shared records. Every query, export, background task, and update stream is scoped by organization/client. Keep credentials server-side in managed secret storage; configuration holds only connection references. Record source/config changes and report revisions. Return only fields needed for analysis, with aggregate-first views.

## Delivery sequence and acceptance

1. Use the inspected strategy archive, obtain the actual brand configurations/notes, and identify authorized backend connections. Confirm metric definitions against closed-day source queries for each client.
2. Implement persistent client configuration, source adapters, sync jobs, metric contracts, time-window handling, reconciliation, and evidence records. Use verified source data from the first client to validate the full pipeline.
3. Build the portfolio and client overview, then all detailed views from the same data API. A disconnected source displays a truthful connection/availability state; development fixtures do not enter production views.
4. Add daily review generation, historical import, shared findings, correction history, and scheduled operation. Validate both clients through an unattended run and a subsequent source refresh.

Acceptance checks must establish:

- A change observed in an authorized source flows into persisted metrics and the app without editing product code.
- A second teammate sees the same snapshots, reviews, and shared edits.
- A new client can be configured without brand-specific frontend branches.
- Same-hour, previous-day, same-weekday, Monday-start recurring, and DST-boundary comparisons use the intended windows.
- Filters update both chart and table results; evidence and exports match the selected scope.
- Missing spend, incompatible MER definitions, contaminated benchmarks, and stale sources suppress misleading conclusions.
- Spend aggregation handles duplicate breakdowns, pagination, and creative reuse; the Beam correction scenario cannot recur silently.
- ONBRAND/freebie handling, overlapping product order counts, zero denominators, rounded values, and refund revisions produce correct labels and totals.
- Job retry/replay and same-day review revisions do not duplicate orders, spend, findings, or review dates.
- Client access isolation and server secret handling hold for API queries, exports, and update streams.

The app is complete only after required views and source-backed refreshes work for both clients. Any unavailable source must be identified precisely; a visual preview or historical report import alone does not satisfy the live-data requirement.
