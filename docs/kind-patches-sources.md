# Kind Patches source connections

The credential source is the Script Properties of the Kind Patches — Daily Blended ROAS Automation project bound to the supplied Google Sheet. Values live only in the hosted `SOURCE_KIND_PATCHES_SCRIPT` secret. The application never changes the sheet, its script, or provider accounts.

| Feed | Evidence and reporting scope |
| --- | --- |
| Triple Whale | Store-hour web non-recurring revenue excluding shipping/tax, orders, new-customer orders, five-channel spend, billing-country revenue, tagged recurring orders/revenue/refund/cancellation counts. Initial history: 60 days. |
| Shopify sales | Closed store-day net sales, gross sales, discounts, returns and orders by sales channel. This all-channel revenue differs from the efficiency headline. |
| Shopify pages | Human sessions, cart additions, reached/completed checkout sessions by landing page and country. Historical dates are read and persisted independently; current snapshot dates establish available coverage. Customer/order tokens and query strings are redacted. Public-page totals reconcile within 0.01%; overview uses authoritative ungrouped human-session totals. |
| Shopify products | Product/channel net sales, gross, discounts, returns and product order counts. Initial history: 30 days. Product order counts overlap. |
| Meta | Current active ad and distinct creative counts, with account currency/timezone validation. No historical inventory is invented. |
| AppLovin | Campaign/country cost in UTC, up to the provider's 45-day history. `platform_spend` stays separate from store-day MER. |
| Recharge | Current raw active customers. This is neither active subscriptions nor the sheet's baseline-adjusted count. No Recharge currency conversion is inferred. |
| Shopify hourly pages | Human overview and public-page/country session funnel counts by completed store hour. Human totals reconcile exactly; public-page totals reconcile within 0.01%. Used for partial-day comparisons. |
| Shopify traffic | Separate `traffic` dataset with human sessions, cart additions, reached/completed checkouts by public landing page, country, device, referrer source, UTM source/medium/campaign. Refreshes only the latest closed store day, its previous day and its same-weekday comparison. Each day accepts at most 9,999 raw groups; the 10,000th group is an overflow sentinel, reconciled to an independent public-page daily total, and persisted independently. It adds no headline revenue or paid attribution. |
| Triple Whale summary cross-check | Supplied Summary API key reads five platform-spend metrics for the latest closed store day. Separate SQL totals and signed summary-minus-SQL differences remain visible in Media as `summary_spend`, `sql_spend` and `summary_spend_delta`. Differences do not replace or gate efficiency headline spend. |
| Meta per-ad performance | Separate `creatives` dataset with latest closed account-day ad IDs/names, campaign IDs/names, spend, impressions, clicks and pixel purchase counts/values. Uses explicit account attribution. Complete pagination is bounded below 5,000 ads; ad spend/impressions/clicks reconcile to an independent account query. The actual Graph account timezone is verified and retained in `reporting_timezone`; missing purchase reporting stays unknown. |


| Recharge calendar cancellations | Currently cancelled subscription records grouped by cancelled_at converted from UTC into the store calendar day/hour. Complete bounded pagination and unique-record reconciliation are required. Reactivated or deleted subscriptions can remove historical records; this is not a complete cancellation-event ledger. Separate from renewal-order cohort cancellations. |
| Triple Whale order diagnostics | One-time/first-subscription/unclassified web order cohorts; tagged renewal billed/refunded amounts, units and reported order-currency mix; ONBRAND zero-value/cancelled order cohorts and AOV including/excluding that code. Initial history: 60 days, with independent classification and hourly/daily reconciliation. No order IDs or customer details retained. |

Diagnostic acquisition revenue uses positive-value web orders excluding recurring tags. Renewal billed/refunded amounts are both in the reporting currency and include shipping/tax; the currency group describes the original order mix. Refund amounts mature against the original order-date cohort. Promotion cancelled-order/unit counts belong to their original order cohort, rather than the calendar cancellation date or Shopify net items after returns.

Triple Whale hourly revenue and spend must reconcile to independently queried daily totals. Transient moving-data mismatches trigger bounded retries; unresolved failures retain the last valid snapshot. Repeated local DST hours remain one combined provider bucket spanning two UTC hours; skipped hours are never invented. Complete source/channel identity and registered metric grains are required before activation. Live observations replace overlapping historical metrics in analysis; original report archives remain immutable.

Daily, hourly and traffic page queries share the same public-page filter: customer orders, checkout, account, cart checkout links and Recharge account/portal routes are excluded. Unexpected private routes returned by a provider cause the read to fail. URL parameters, email addresses and long token-like attribution values are redacted before persistence. Country names and recognized ISO aliases share a canonical market key, retaining the application's `UK` convention; unrecognized names remain as supplied.

The supplied credentials do not include Intelligems experiments, Motion, GA4/Amplitude or Beam provider access. Full historical cancellation events require an event ledger/webhook history beyond currently cancelled Recharge records. Platform attribution cannot establish incremental revenue or Shopify revenue by UTM. Captured dates establish available history; uncaptured comparison dates remain unknown. Available supplied provider access can supply further qualified cuts without duplicating credentials.

## Supplied property audit

Every supplied provider credential has a fixed server-side consumer. Adding the three bounded cuts uses the existing `SOURCE_KIND_PATCHES_SCRIPT` secret and the existing connection/qualification workflow; no new provider credential or database migration is required.

| Supplied property names | Fixed consumer |
| --- | --- |
| `SHOPIFY_ADMIN_TOKEN`, `SHOP_DOMAIN` | Shopify Admin GraphQL/ShopifyQL sales, products, daily pages, hourly pages and closed traffic cuts |
| `TRIPLE_WHALE_SQL_KEY` | Triple Whale SQL commerce, recurring orders, billing-country/channel spend, order diagnostics and independent spend cross-check |
| `TRIPLE_WHALE_SUMMARY_KEY` | Triple Whale Summary Page platform-spend cross-check |
| `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_API_VERSION`, `META_TIME_ZONE` | Meta account identity, current active ad/creative inventory and closed-day per-ad Insights; shared store timezone validation |
| `APPLOVIN_REPORT_KEY` | Authenticated advertiser campaign/country cost report |
| `RECHARGE_ADMIN_TOKEN` | Recharge store identity, current raw active-customer count and reported calendar cancellations |

Other supplied properties are sheet/automation metadata, rather than additional provider connections: `AUTOMATION_START_DATE`, `SPREADSHEET_ID`, `RECHARGE_BASELINE_DATE`, `RECHARGE_BASELINE_RAW_ACTIVE`, `RECHARGE_BASELINE_SHEET_VALUE`, `RECHARGE_RAW_SNAPSHOTS`. Their values are not copied into dashboards or prompts. The application reports the actual Recharge raw count with its definition, rather than silently applying the original sheet's baseline adjustment.

Source activation uses the canonical administrator connection service and is idempotent. The registered feeds retain their separate definitions and reconciliation checks. Actual enabled status, retrieval/coverage timestamps, jobs and current snapshot dates are read from production records.

## Unattended production updater

The Avenue Z Technology Vercel backend owns provider refresh and daily reviews. Native `/api/cron/sync` and `/api/cron/reviews` authenticate with the company service secret and persist leases, retries, snapshots and report revisions. Provider polling respects each configured cadence and provider reporting timezone. The dashboard reads these persisted snapshots; switching a tab does not call the providers.

The old private Sites updater and its migration export are disabled. Routine production work uses neither an assistant automation, a Sites bearer token, connected-account session nor a user browser. The existing private dashboard authorizes its user and forwards heavy workspace, chat and manual-review computation to the company backend. The fixed HTTPS bridge uses a server-held HMAC, purpose-bound requests, short expiry and a current native membership/client-grant check. It retains the existing private audience and Vercel deployment protection. See [independent runtime](independent-runtime.md) and [deployment verification](vercel-deployment.md).

Source setup is an administrator operation, not a recurring refresh. The three additional fixed feeds use the same server secret and registered qualification workflow. Failed jobs use bounded backoff; authorization/configuration failures remain visible in settings. Read persisted timestamps and coverage to verify a run. Unavailable data remains unknown and never becomes a business action solely because access is missing.

Charts and tables receive compact prepared aggregates. Opening a landing page retrieves only its source/funnel cohort. Complete source evidence remains on authorized server report/AI and evidence paths. Store-local dates, DST handling, exact filters and confirmed source coverage remain part of every comparison.

Workspace frames are shared in the company database and retained in a bounded compressed warm-instance cache. Source snapshots and qualification/configuration versions invalidate corrected data. Current user scope, source headers, notes, findings, reviews and schedule state are attached independently. The native updater warms common closed scopes; a repeated prepared range survives a function restart. An uncached arbitrary range can still require calculation. Caches never establish coverage or invent missing dates.
