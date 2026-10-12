# Activation and operations

## Kind Patches activated connections

The supplied Apps Script has provided five provider credentials used by thirteen registered feeds. See [Kind Patches source operations](kind-patches-sources.md) for current scopes and company-native source operations. API values are hosted secrets. Beam still needs its own source access.

## Other clients and generic source activation

1. Identify the actual authorized existing API/warehouse connection and deployment location. Research found a possible BigQuery project `avenue-z-data-warehouse-prod`; its existence in reporting code does not establish app access. Do not paste credentials into chat or client config.
2. Obtain the full Beam brand config and notes plus Kind Patches skill/config where available. Confirm revenue definitions, spend coverage, markets, human-session population, subscription classifications, store currencies/time zones, and incidents. Current defaults are editable interpretations of the supplied prompts.
3. Map a read-only aggregation service to [the source contract](source-contract.md), backed by authorized APIs or the warehouse. Provider transports are not invented in this app. Preserve source latency and incomplete channel flags.
4. Configure `SOURCE_...` as a server secret in Sites and add its HTTPS endpoint/reference in the appropriate client's source settings. Save disabled, reconcile a real sample, register its source qualification, and only then enable. Do not configure a site service credential as a source credential.
5. Pull a real sample covering initial history, closed prior/day-before/weekday, same store-hour, dimensional breakdowns, recurring weeks, and experiment states. Verify counts and financial totals against provider records. Record query versions and coverage. Test error, retry, and empty-date correction behavior.
6. Routine jobs use the Avenue Z Technology Vercel backend and company service identity described in the source operations document. Never broaden access or rotate credentials during a routine update. A public publication requires an independently authorized writer; keep PRIVATE_SITE_RUNNER_ENABLED disabled there.
7. Read Site ownership, active publication, and linked automations before scheduling; ensure no duplicate updater. Use the native Vercel cron routes; the old Sites updater and local assistant automation are disabled. The included workflow is inactive in the Sites source registry. Enable the five-minute trigger only after the preceding checks pass. Individual connection cadence defaults to 15 minutes and can be changed in settings. Daily report time is editable and currently 09:00 America/New_York.
8. Verify one real scheduled run updates the source retrieval/coverage, writes one snapshot and one fixed review, and displays results to an authorized teammate. Keep source-specific retrieval and coverage visible; a schedule being saved is separate from a successful source run.

## Operations

Connection status shows last successful retrieval, confirmed coverage and the latest error. View refresh is a separate timestamp. Ingestion pulls initial 60 days and subsequently reconciles a rolling 7 days; longer refund corrections currently require an explicit historical/backfill import or fresh source connection. Transient failures retry twice after the initial attempt; authentication or absent credentials fail for operator attention. An interrupted lease can be reclaimed after five minutes. Requests have a bounded deadline and at most seven jobs per invocation.

Snapshot content keys and date pointers avoid duplicate observation sums. Corrected data creates a new snapshot; old raw snapshots remain in object storage. Fixed reviews are versioned by content/config evidence; identical reruns reuse the revision. Notes, client config, source config and findings use optimistic versions, so stale edits need reload rather than overwriting a teammate.

Historical imported observations are explicitly marked historical; they do not prove live freshness. CSV exports inherit the selected date/time/dimension scope and protect spreadsheet formula cells. Monetary sums reject mixed definitions/currencies; rates use matching populations and counts. Product-level orders may overlap and must not be read as unique store orders.

## Access and sharing

Owner-private publication is the default. The first protected owner entry claims the initial agency workspace; never broaden platform access before this initialization. For later users, grant platform Site access and the app's allowed email/role/client list. Admins edit source/config/access; analysts view assigned clients and collaborate on their notes/follow-ups. No invitation messages are sent automatically. Verify direct URL and export access denial using a separate limited member at activation.

## Known limits before activation

Kind Patches provider reads, initial snapshot persistence and source reconciliation have been exercised through the hosted private service access. Provider totals now drive charts. Beam remains a historical reference until its access is provided. Source-side distinctness/additive grains, full refunds/cancellations history, volume sizing, and every brand-specific diagnostic need validation against actual source data. Daily reviews use the strategy minimum, dated numeric tables and sourced business actions. Unsupported providers or missing comparison dates remain explicit limitations; AI prose cannot replace qualified source measurements.

CSV uses global date and dimension filters; table text search currently narrows the displayed rows only. Use a global dimension filter when the export must have the same scope.
