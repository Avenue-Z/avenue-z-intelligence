# Autobrush GA4 Reporting Activation

Continue the user's authorized Autobrush integrations using the existing cached GA4 workspace. No new provider permissions, paid services or dependencies.

Baseline: verified native Autobrush production dpl_BdqzSQ1WVVmViKfVrXmtTCrAc5Ku, exact 615-file manifest. Work in a separate isolated stage; preserve unrelated root WIP.

Requirements:
- Fixed profile Autobrush / property 274489308 / website stream 2635677328 / America/Los_Angeles / USD. Exclude Facebook Shops stream 7869434344 with an EXACT streamId predicate on every provider report; validate returned stream IDs where included.
- Fresh Autobrush vault grant only. SOURCE_AUTOBRUSH_GA4 may reference SOURCE_BEAM_GA4 solely for the company OAuth application's client configuration. No Beam credential copy or permission expansion.
- Preserve Beam defaults, property, clock, caching and existing tests.
- Reuse total/hourly/detail cache; parameterize hardcoded client/property/clock checks. No schema migration unless demonstrably necessary.
- Reporting dates, live-period resolution, timezone labels and matched-hour comparisons use the GA4 profile's Los Angeles clock. Never relabel GA4 days as New York commerce or merge its totals with Shopify.
- Bound and fully paginate reports; retain metadata/quality limitations. Missing current hours remain missing and cannot establish a complete-hour watermark.
- Separate hosted cron and lease, hourly due planning, rolling 30 reporting days; preserve last good cache on transient failure. Views read cached data, not provider requests.
- Add Autobrush Web analytics navigation, authenticated report route, correct UI request/cache keys, and client-scoped AI context if required by the existing GA4 workspace.
- Test profile/grant isolation, exact website filter on all report kinds, different-midnight/DST live dates, no zero fill, cache separation, permission revocation, and unchanged Beam reporting.
- Run full isolated suite + native Next build; independent review. Publish only exact reviewed manifest; activate hosted sync and verify actual persisted cache and Chrome UI before claiming live.

No external support contact. No raw provider payload or credentials in logs, browser, source or proof receipts.
