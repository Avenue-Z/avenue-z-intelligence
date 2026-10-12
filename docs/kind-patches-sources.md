# Kind Patches source connections

The credential source is the Script Properties of the Kind Patches — Daily Blended ROAS Automation project bound to the supplied Google Sheet. Values live only in the hosted `SOURCE_KIND_PATCHES_SCRIPT` secret. The application never changes the sheet, its script, or provider accounts.

| Feed | Evidence and reporting scope |
| --- | --- |
| Triple Whale | Store-hour web non-recurring revenue excluding shipping/tax, orders, new-customer orders, five-channel spend, billing-country revenue, tagged recurring orders/revenue/refund/cancellation counts. Initial history: 60 days. |
| Shopify sales | Closed store-day net sales, gross sales, discounts, returns and orders by sales channel. This all-channel revenue differs from the efficiency headline. |
| Shopify pages | Human sessions, cart additions, reached/completed checkout sessions by landing page and country. First import: nine closed days, read and persisted per day. Customer/order tokens and query strings are redacted. Public-page totals reconcile within 0.01%; overview uses authoritative ungrouped human-session totals. |
| Shopify products | Product/channel net sales, gross, discounts, returns and product order counts. Initial history: 30 days. Product order counts overlap. |
| Meta | Current active ad and distinct creative counts, with account currency/timezone validation. No historical inventory is invented. |
| AppLovin | Campaign/country cost in UTC, up to the provider's 45-day history. `platform_spend` stays separate from store-day MER. |
| Recharge | Current raw active customers. This is neither active subscriptions nor the sheet's baseline-adjusted count. No Recharge currency conversion is inferred. |
| Shopify hourly pages | Human overview and public-page/country session funnel counts by completed store hour. Human totals reconcile exactly; public-page totals reconcile within 0.01%. Used for partial-day comparisons. |
| Shopify traffic | Separate `traffic` dataset with human sessions, cart additions, reached/completed checkouts by public landing page, country, device, referrer source, UTM source/medium/campaign. Refreshes only the latest closed store day, its previous day and its same-weekday comparison. Each day is limited to fewer than 5,001 raw groups, reconciled to an independent public-page daily total, and persisted independently. It adds no headline revenue or paid attribution. |
| Triple Whale summary cross-check | Supplied Summary API key reads five platform-spend metrics for the latest closed store day. Separate SQL totals and signed summary-minus-SQL differences remain visible in Media as `summary_spend`, `sql_spend` and `summary_spend_delta`. Differences do not replace or gate efficiency headline spend. |
| Meta per-ad performance | Separate `creatives` dataset with latest closed account-day ad IDs/names, campaign IDs/names, spend, impressions, clicks and pixel purchase counts/values. Uses explicit account attribution. Complete pagination is bounded below 5,000 ads; ad spend/impressions/clicks reconcile to an independent account query. The actual Graph account timezone is verified and retained in `reporting_timezone`; missing purchase reporting stays unknown. |

Triple Whale hourly revenue and spend must reconcile to independently queried daily totals. Transient moving-data mismatches trigger bounded retries; unresolved failures retain the last valid snapshot. Repeated local DST hours remain one combined provider bucket spanning two UTC hours; skipped hours are never invented. Complete source/channel identity and registered metric grains are required before activation. Live observations replace overlapping historical metrics in analysis; original report archives remain immutable.

Daily, hourly and traffic page queries share the same public-page filter: customer orders, checkout, account, cart checkout links and Recharge account/portal routes are excluded. Unexpected private routes returned by a provider cause the read to fail. URL parameters, email addresses and long token-like attribution values are redacted before persistence. Country names and recognized ISO aliases share a canonical market key, retaining the application's `UK` convention; unrecognized names remain as supplied.

Not yet included: extended historical Meta performance, ad-set-specific attribution comparisons, experiments, a dedicated ONBRAND zero-order reconciliation view, and GA4 or other external analytics cross-checks. Traffic is closed-day session evidence, so it cannot establish intraday attribution, revenue by UTM, or a complete arbitrary historical range until those days have been captured. Per-ad Meta metrics use the platform's account attribution and cannot establish incremental revenue, asset-level creative groups, or Shopify orders. Available provider API access can supply further breakdowns without duplicating these connections. Beam has no credentials from this sheet.

## Supplied property audit

Every supplied provider credential has a fixed server-side consumer. Adding the three bounded cuts uses the existing `SOURCE_KIND_PATCHES_SCRIPT` secret and the existing connection/qualification workflow; no new provider credential or database migration is required.

| Supplied property names | Fixed consumer |
| --- | --- |
| `SHOPIFY_ADMIN_TOKEN`, `SHOP_DOMAIN` | Shopify Admin GraphQL/ShopifyQL sales, products, daily pages, hourly pages and closed traffic cuts |
| `TRIPLE_WHALE_SQL_KEY` | Triple Whale SQL commerce, recurring orders, billing-country and channel-spend reads; independent spend cross-check |
| `TRIPLE_WHALE_SUMMARY_KEY` | Triple Whale Summary Page platform-spend cross-check |
| `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_API_VERSION`, `META_TIME_ZONE` | Meta account identity, current active ad/creative inventory and closed-day per-ad Insights; shared store timezone validation |
| `APPLOVIN_REPORT_KEY` | Authenticated advertiser campaign/country cost report |
| `RECHARGE_ADMIN_TOKEN` | Recharge store identity and current raw active-customer count |

Other supplied properties are sheet/automation metadata, rather than additional provider connections: `AUTOMATION_START_DATE`, `SPREADSHEET_ID`, `RECHARGE_BASELINE_DATE`, `RECHARGE_BASELINE_RAW_ACTIVE`, `RECHARGE_BASELINE_SHEET_VALUE`, `RECHARGE_RAW_SNAPSHOTS`. Their values are not copied into dashboards or prompts. The application reports the actual Recharge raw count with its definition, rather than silently applying the original sheet's baseline adjustment.

The production activation completed October 12 at 19:09:19 UTC. All eleven Kind Patches feeds are enabled with no source errors, including `kind-shopify-traffic`, `kind-triple-whale-summary` and `kind-meta-performance`. Every supplied provider credential has an active fixed consumer. Setup used the canonical administrator connection service and remains idempotent.

The confirmed traffic exports contained 4,078, 4,313 and 4,197 raw groups on October 4, 10 and 11 respectively. After privacy/country normalization and equivalent-group collapse, those day batches contained 19,760, 20,930 and 20,210 observations across the five count metrics. The independent Summary/SQL read produced 15 observations for October 11; Google's signed difference was approximately -$0.384. These qualified batches are now persisted in the company production database.

The final Meta performance read retrieved all 818 ads across two pages, plus account identity and independent account totals. It produced 4,090 observations for October 11 in the actual `Europe/Stockholm` account timezone; ad spend reconciled to $79,019.01. Twenty-six ads omitted purchase reporting, which remains null rather than being invented as zero. All three new feeds passed their registered source contracts against the live reads.

## Unattended production updater

The Avenue Z Technology Vercel backend owns provider refresh and daily reviews. Native `/api/cron/sync` and `/api/cron/reviews` authenticate with the company service secret and persist leases, retries, snapshots and report revisions. Provider polling respects each configured cadence and provider reporting timezone. The dashboard reads these persisted snapshots; switching a tab does not call the providers.

The old private Sites updater and its migration export are disabled. Routine production work uses neither an assistant automation, a Sites bearer token, connected-account session nor a user browser. The existing private dashboard remains a frontend for the company database during migration. See [independent runtime](independent-runtime.md) and [deployment verification](vercel-deployment.md).

Source setup is an administrator operation, not a recurring refresh. The three additional fixed feeds use the same server secret and registered qualification workflow. Failed jobs use bounded backoff; authorization/configuration failures remain visible in settings. Read persisted timestamps and coverage to verify a run. Unavailable data remains unknown and never becomes a business action solely because access is missing.

The native scheduler completed the final sales, funnels, products and hourly refresh jobs on October 12, each on its first attempt without a source error, and rebuilt the persistent observation caches at 19:17:39 UTC. Browser checks measured cached tab changes at 0.575 seconds (Traffic), 0.614 seconds (Media), and 0.900 seconds (Reviews), including visible content verification. These measurements concern tab switching; a new uncached date range can still require a database read.
