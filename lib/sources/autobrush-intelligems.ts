import {z} from 'zod';
import type {Client, Observation, SourceBatch} from '../analytics/contracts';
import type {RegisteredContract} from './registered-contract';
import {dayWindow, todayIn} from '../analytics/windows';
import {observation, providerJson, sourceDates, trafficLabel} from './kind-patches';
import {validateBatch} from './qualification';

export const AUTOBRUSH_INTELLIGEMS_ORGANIZATION = '5740704f-c0a1-4342-a6a1-fa1c3eeb2f86';
const credential = z.string().min(1).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
export const autobrushIntelligemsConfiguration = z.object({
  apiKey: credential,
  organizationId: z.literal(AUTOBRUSH_INTELLIGEMS_ORGANIZATION).default(AUTOBRUSH_INTELLIGEMS_ORGANIZATION),
});
export type AutobrushIntelligemsConnection = {id: string; clientId: string};
const base = 'https://api.intelligems.io/v25-10-beta';
const definition = 'intelligems_all_countries_experiment_all_products_all_currencies_daily_visitors_zscore3';
const population = 'intelligems_exposed_experiment_visitors';
const dimensions = ['report_date', 'experiment_id', 'experiment', 'variant_id', 'variant', 'status', 'is_control', 'market', 'analysis_scope'];
const metrics = ['visitors', 'orders', 'conversion_rate', 'conversion_rate_ci_low', 'conversion_rate_ci_high',
  'conversion_rate_lift', 'conversion_rate_lift_ci_low', 'conversion_rate_lift_ci_high',
  'conversion_rate_probability_to_beat_control', 'conversion_rate_probability_best'];
const timestamp = z.number().int().nonnegative().finite();
const experimentSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1), category: z.literal('experiment'),
  status: z.enum(['pending', 'started', 'ended', 'paused']), organizationId: z.literal(AUTOBRUSH_INTELLIGEMS_ORGANIZATION),
  startedAtTs: timestamp.nullable(), endedAtTs: timestamp.nullable().optional(),
  pausedAtTs: timestamp.nullable().optional(), isDeleted: z.boolean().optional(),
});
type Experiment = z.infer<typeof experimentSchema>;
const catalogSchema = z.object({
  experiencesList: z.array(experimentSchema).max(20), page: z.number().int().min(1).max(100),
  limit: z.literal(20), total: z.number().int().min(0).max(2000), totalPages: z.number().int().min(0).max(100),
  nextCursor: z.unknown().optional(), hasNextPage: z.boolean().optional(),
});
const variantSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1), isControl: z.boolean(), experienceId: z.string().uuid().optional(),
});
const overviewSchema = z.object({
  experienceId: z.string().uuid(), datasetId: z.literal('variation_overview'),
  variations: z.array(variantSchema).min(1).max(100), metrics: z.array(z.unknown()).max(100),
  nextCursor: z.unknown().optional(), hasNextPage: z.boolean().optional(),
});
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const noCursor = (value: unknown) => value === undefined || value === null || value === '';
const present = (value: unknown) => value !== undefined && value !== null;
function finite(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('Intelligems returned invalid experiment metrics');
  return value;
}
function probability(value: unknown) {
  const n = finite(value);
  if (n < 0 || n > 1) throw Error('Intelligems returned invalid experiment probability');
  return n;
}
function count(value: unknown) {
  const n = finite(value);
  if (!Number.isSafeInteger(n) || n < 0) throw Error('Intelligems returned invalid experiment counts');
  return n;
}
function statisticalMetric(value: unknown): Record<string, unknown> | undefined {
  if (!present(value)) return;
  if (!record(value)) throw Error('Intelligems experiment metric is invalid');
  return value;
}
function identity(connection: AutobrushIntelligemsConnection, client: Client) {
  if (connection.clientId !== 'autobrush' || client.id !== 'autobrush' || client.timezone !== 'America/New_York' || client.currency !== 'USD')
    throw Error('Intelligems Autobrush identity mismatch');
}
async function request(path: string, apiKey: string, body: Record<string, unknown> | undefined, fetcher: typeof fetch, deadline: number) {
  return providerJson(fetcher, `${base}${path}`, {
    method: body ? 'POST' : 'GET', cache: 'no-store',
    headers: {'intelligems-access-token': apiKey, ...(body ? {'Content-Type': 'application/json'} : {})},
    ...(body ? {body: JSON.stringify(body)} : {}),
  }, deadline);
}

async function experimentCatalog(apiKey: string, fetcher: typeof fetch, deadline: number): Promise<Experiment[]> {
  const experiments: Experiment[] = [], seen = new Set<string>();
  let expectedTotal: number | undefined, expectedPages: number | undefined;
  for (let page = 1; page <= 100; page++) {
    const parsed = catalogSchema.safeParse(await request(`/experiences-list?category=experiment&limit=20&page=${page}`, apiKey, undefined, fetcher, deadline));
    if (!parsed.success) throw Error('Intelligems experiment identity or pagination is invalid');
    const result = parsed.data;
    const calculatedPages = Math.ceil(result.total / 20);
    if (result.page !== page || !noCursor(result.nextCursor) ||
        (result.total === 0 ? result.totalPages > 1 : result.totalPages !== calculatedPages))
      throw Error('Intelligems experiment pagination is invalid');
    if (expectedTotal === undefined) { expectedTotal = result.total; expectedPages = result.totalPages; }
    else if (expectedTotal !== result.total || expectedPages !== result.totalPages)
      throw Error('Intelligems experiment catalog changed during pagination');
    const finalPage = page >= Math.max(1, result.totalPages);
    if (result.experiencesList.length !== Math.min(20, result.total - (page - 1) * 20) ||
        result.hasNextPage !== undefined && result.hasNextPage === finalPage)
      throw Error('Intelligems experiment pagination is incomplete');
    for (const experiment of result.experiencesList) {
      if (seen.has(experiment.id)) throw Error('Intelligems experiment identity or pagination changed');
      const lifetimeEnd = experiment.status === 'paused' ? experiment.pausedAtTs : experiment.endedAtTs;
      if (experiment.status !== 'pending' && (experiment.startedAtTs === null ||
          ((experiment.status === 'paused' || experiment.status === 'ended') && lifetimeEnd == null) ||
          (lifetimeEnd != null && lifetimeEnd <= experiment.startedAtTs)))
        throw Error('Intelligems experiment lifecycle is invalid');
      seen.add(experiment.id);
      experiments.push(experiment);
    }
    if (finalPage) {
      if (experiments.length !== result.total) throw Error('Intelligems experiment pagination is incomplete');
      return experiments;
    }
  }
  throw Error('Intelligems experiment pagination is incomplete');
}

/** Global exposed visitors are distinct from Shopify human-session funnels. */
export async function fetchAutobrushIntelligemsSource(
  connection: AutobrushIntelligemsConnection, client: Client, window: {from: string; to: string}, apiKey: string,
  fetcher: typeof fetch = fetch, deadline = Date.now() + 240000, now = new Date(),
): Promise<SourceBatch> {
  identity(connection, client);
  if (!credential.safeParse(apiKey).success) throw Error('Intelligems credential is missing or invalid');
  let dates: string[], today: string;
  try {
    today = todayIn(client.timezone, now);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(window.from) || !/^\d{4}-\d{2}-\d{2}$/.test(window.to) || window.from > window.to || window.to > today)
      throw Error();
    dayWindow(window.from, client.timezone);
    dayWindow(window.to, client.timezone);
    dates = sourceDates(window);
  } catch { throw Error('Intelligems source window is invalid'); }
  const experiments = await experimentCatalog(apiKey, fetcher, deadline), rows: Observation[] = [];
  for (const date of dates) {
    const day = dayWindow(date, client.timezone), start = Date.parse(day.start), end = Math.min(Date.parse(day.end), now.getTime());
    if (start >= end) continue;
    for (const experiment of experiments) {
      const lifetimeEnd = experiment.status === 'paused' ? experiment.pausedAtTs : experiment.endedAtTs;
      if (experiment.status === 'pending' || experiment.isDeleted || experiment.startedAtTs === null ||
          experiment.startedAtTs >= end || lifetimeEnd != null && lifetimeEnd <= start) continue;
      // Intelligems' POST filter schema explicitly documents omitted countryCodes
      // as all countries: https://docs.intelligems.io/developer-resources/external-api/fetch-experience-data
      const parsed = overviewSchema.safeParse(await request(`/analytics/resource/${experiment.id}`, apiKey, {
        view: 'overview', startTs: String(Math.floor(start / 1000)), endTs: String(Math.floor(end / 1000)),
        analyticsViewType: 'sitewide_orders', filters: {experimentProductsOnly: false, maxZScore: 3},
      }, fetcher, deadline));
      if (!parsed.success || parsed.data.experienceId !== experiment.id || !noCursor(parsed.data.nextCursor) || parsed.data.hasNextPage === true)
        throw Error('Intelligems returned an incomplete experiment overview');
      const result = parsed.data, variants = new Map<string, z.infer<typeof variantSchema>>();
      for (const variant of result.variations) {
        if (variants.has(variant.id) || variant.experienceId !== undefined && variant.experienceId !== experiment.id)
          throw Error('Intelligems experiment variation identity changed');
        variants.set(variant.id, variant);
      }
      if ([...variants.values()].filter(variant => variant.isControl).length !== 1)
        throw Error('Intelligems experiment control identity is missing');
      const reported = new Set<string>();
      for (const metric of result.metrics) {
        if (!record(metric) || typeof metric.variation_id !== 'string' || !variants.has(metric.variation_id) ||
            reported.has(metric.variation_id) || metric.audience !== undefined || metric.dt !== undefined)
          throw Error('Intelligems experiment overview grain changed');
        reported.add(metric.variation_id);
        const variant = variants.get(metric.variation_id)!;
        const rowDimensions = {
          report_date: date, experiment_id: experiment.id, experiment: trafficLabel(experiment.name),
          variant_id: variant.id, variant: trafficLabel(variant.name), status: experiment.status,
          is_control: String(variant.isControl), market: 'All', analysis_scope: 'store_day_all_countries_all_products_all_currencies_zscore3',
        };
        const add = (name: string, value: number) => rows.push({
          ...observation(date, 'experiments', name, value, definition, population, null, rowDimensions),
          sourceId: connection.id, retrievedAt: now.toISOString(), coverageThrough: null, quality: date < today ? 'complete' : 'partial',
        });
        const interval = (stats: Record<string, unknown>, prefix: string, validate: (value: unknown) => number) => {
          const lowPresent = present(stats.ci_low), highPresent = present(stats.ci_high);
          if (lowPresent !== highPresent) throw Error('Intelligems experiment interval is incomplete');
          if (!lowPresent) return;
          const low = validate(stats.ci_low), high = validate(stats.ci_high);
          if (low > high) throw Error('Intelligems experiment interval is inverted');
          add(`${prefix}_ci_low`, low); add(`${prefix}_ci_high`, high);
        };
        for (const [field, name] of [['n_visitors', 'visitors'], ['n_orders', 'orders']]) {
          const stats = statisticalMetric(metric[field]);
          if (stats && present(stats.value)) add(name, count(stats.value));
        }
        const conversion = statisticalMetric(metric.conversion_rate);
        if (!conversion) continue;
        if (present(conversion.value)) add('conversion_rate', probability(conversion.value));
        interval(conversion, 'conversion_rate', probability);
        if (present(conversion.p2bb)) add('conversion_rate_probability_best', probability(conversion.p2bb));
        if (!variant.isControl) {
          if (present(conversion.p2bc)) add('conversion_rate_probability_to_beat_control', probability(conversion.p2bc));
          const uplift = statisticalMetric(conversion.uplift);
          if (uplift) {
            if (present(uplift.value)) add('conversion_rate_lift', finite(uplift.value));
            interval(uplift, 'conversion_rate_lift', finite);
          }
        }
      }
      if (reported.size !== variants.size) throw Error('Intelligems experiment variation report is incomplete');
    }
  }
  return validateBatch({clientId: client.id, timezone: client.timezone, currency: client.currency, channels: [], dimensions,
    grain: 'daily', complete: true, coverageThrough: null, nextCursor: null, rows}, client.id);
}

export function autobrushIntelligemsQualification(batch: SourceBatch): RegisteredContract {
  if (batch.clientId !== 'autobrush' || batch.timezone !== 'America/New_York' || batch.currency !== 'USD' ||
      !batch.complete || batch.nextCursor || batch.grain !== 'daily')
    throw Error('Intelligems qualification requires complete daily Autobrush experiment reporting');
  return {
    clientId: batch.clientId, queryId: 'autobrush-intelligems:daily-experiments-v1', timezone: batch.timezone, currency: batch.currency,
    hourlyGrain: false, channels: [], requiredChannels: [], dimensions, requiredDimensions: dimensions,
    paginationComplete: true, reconciled: true,
    reconciliationEvidence: 'Authenticated fixed Autobrush organization. Complete page-based experiment catalog reconciles stable totals with unique experiment identities; started, paused and ended experiments overlap each requested New York calendar day. POST overview reconciles all variation identities and exactly one control. All countries use the documented omitted countryCodes filter, all experiment products disabled explicitly, all currencies and Z-score 3. Visitor/order counts and provider-reported conversion rates, intervals and probabilities retain the exposed experiment visitor population; no causal verdict is inferred from daily subsets. Monetary outcomes are omitted because currency filters may be silently ignored. New York/USD are store-window metadata, not a provider reporting-timezone or monetary-unit assertion. latestRunTs does not establish source coverage, which remains unknown. A complete empty catalog and unavailable metrics produce no invented zero observations.',
    profiles: metrics.map(metric => ({dataset: 'experiments', metric, population, definition, currency: null, dimensions, hourly: false})),
  };
}
