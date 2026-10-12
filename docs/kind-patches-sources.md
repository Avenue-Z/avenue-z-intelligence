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

Triple Whale hourly revenue and spend must reconcile to independently queried daily totals. Transient moving-data mismatches trigger bounded retries; unresolved failures retain the last valid snapshot. Repeated local DST hours remain one combined provider bucket spanning two UTC hours; skipped hours are never invented. Complete source/channel identity and registered metric grains are required before activation. Live observations replace overlapping historical metrics in analysis; original report archives remain immutable.

Not yet included: traffic/device/UTM detail, Meta creative performance/attribution, experiments, a dedicated ONBRAND zero-order reconciliation view, and external analytics cross-checks. Available provider API access can supply further breakdowns without duplicating these connections. Beam has no credentials from this sheet.

## Unattended updater

`PRIVATE_SITE_RUNNER_ENABLED=true` enables the shared writer **only for the confirmed owner-private Site**. Keep it disabled if the Site becomes public. Native Sites dispatch supplies the platform access boundary. Signed-in visitors still need administrator membership and Kind Patches access.

A cloud run gets the linked Site with native Sites `get_site`, confirms owner-private access, then obtains its `siwc_bypass_bearer_token`. Send the token only to the returned live Site origin in `OAI-Sites-Authorization: Bearer ...`. Never save a token or put one in a prompt. If native service access is unavailable, report the blocker; never create or rotate a bypass token during routine refreshes.

- `POST /api/internal/sync` refreshes due, enabled feeds using existing server-held credentials and persists source snapshots. It does not republish or generate an AI review.
- `GET /api/internal/kind-sources?from=YYYY-MM-DD&to=YYYY-MM-DD&mode=closed` reads persisted connections and calculated metrics. `mode=partial` reads matched store-hour metrics.
- `POST /api/internal/sync?review=true` additionally generates the configured daily review, using the same authorized evidence and existing OpenAI secret. Run once at the configured daily review time, separately from source polling.
- `POST /api/internal/kind-sources` with `{ "provider": "kind-…" }` verifies and initially connects one of the fixed known feeds. It is idempotent for a successfully connected feed; routine schedules must not repeatedly run setup.

Runtime source reads/writes require no user browser session. Do not use connected Google accounts or Apps Script in routine refreshes. Failed jobs use bounded backoff; authorization/configuration failures remain visible until corrected. Read back timestamps and coverage after a run. Never report unavailable sources as zero or create business alerts for missing access.
