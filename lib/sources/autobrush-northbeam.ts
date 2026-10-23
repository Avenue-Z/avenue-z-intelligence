import {Temporal} from '@js-temporal/polyfill';
import {z} from 'zod';

// Protocol: https://docs.northbeam.io/reference/post_data-export-1
// Discovery/result envelopes: https://docs.northbeam.io/docs/northbeam-api-data-export-1
// Result lifecycle: https://docs.northbeam.io/docs/northbeam-api-data-exports-overview
type Immutable<T> = T extends object ? {readonly [K in keyof T]: Immutable<T[K]>} : T;

export type NorthbeamConfig = Readonly<{apiKey: string; dataClientId: string}>;
export type NorthbeamIdentity = Readonly<{clientId: 'autobrush'; dataClientId: string}>;
export type NorthbeamOptions = Immutable<{
  identity: NorthbeamIdentity;
  metrics: {id: string; label?: string | null}[];
  attributionModels: {id: string; name?: string | null}[];
  breakdowns: {key: string; values: string[]}[];
}>;

const nonempty = z.string().min(1).max(1000);
const uniqueStrings = <T extends z.ZodType<string>>(item: T) => z.array(item).refine(values => new Set(values).size === values.length);
const timestamp = z.string().datetime({offset: true});
const identitySchema = z.object({clientId: z.literal('autobrush'), dataClientId: nonempty}).strict();
const periodTypes = [
  'FIXED', 'TODAY', 'YESTERDAY', 'YESTERDAY_AND_TODAY', 'LAST_3_DAYS', 'LAST_7_DAYS', 'LAST_14_DAYS',
  'LAST_28_DAYS', 'LAST_30_DAYS', 'LAST_60_DAYS', 'LAST_90_DAYS', 'LAST_180_DAYS', 'MONTH_TO_DATE',
  'LAST_MONTH', 'THIS_WEEK', 'LAST_WEEK', 'THIS_WEEK_AND_LAST_WEEK', 'LAST_3_WEEKS', 'LAST_4_WEEKS',
  'LAST_7_WEEKS', 'LAST_12_WEEKS', 'LAST_14_WEEKS', 'LAST_26_WEEKS', 'LAST_28_WEEKS', 'LAST_52_WEEKS',
  'THIS_MONTH', 'THIS_MONTH_AND_LAST_MONTH', 'LAST_3_MONTHS', 'LAST_6_MONTHS', 'LAST_9_MONTHS',
  'LAST_12_MONTHS', 'YEAR_TO_DATE', 'LAST_YEAR', 'LAST_3_YEARS', 'LAST_5_YEARS',
] as const;
// The provider includes an empty label in discovered dimensions. Preserve it
// verbatim; export selection still requires an exact account-discovered value.
const breakdownSchema = z.object({key: nonempty, values: uniqueStrings(z.string().max(1000))}).strict();
const requestSchema = z.object({
  export_file_name: z.string().min(3).regex(/^[A-Za-z0-9_-]+$/).optional(),
  level: z.enum(['platform', 'campaign', 'adset', 'ad']),
  time_granularity: z.enum(['MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY']),
  period_type: z.enum(periodTypes),
  period_options: z.object({period_starting_at: timestamp, period_ending_at: timestamp}).strict().optional(),
  attribution_options: z.object({
    attribution_models: uniqueStrings(nonempty).refine(values => values.length > 0),
    attribution_windows: uniqueStrings(z.enum(['1', '3', '7', '14', '30', '60', '90'])).refine(values => values.length > 0),
    accounting_modes: uniqueStrings(z.enum(['cash', 'accrual'])).refine(values => values.length > 0),
  }).strict(),
  metrics: z.array(z.object({id: nonempty, label: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]+[a-zA-Z0-9]$/).optional()}).strict())
    .min(1).refine(values => new Set(values.map(value => value.id)).size === values.length),
  breakdowns: z.array(breakdownSchema).refine(values => new Set(values.map(value => value.key)).size === values.length),
  options: z.object({
    export_aggregation: z.enum(['BREAKDOWN', 'DATE']), remove_zero_spend: z.boolean(),
    aggregate_data: z.boolean(), include_ids: z.boolean(), include_kind_and_platform: z.boolean(),
  }).strict(),
}).strict().superRefine((input, context) => {
  if (input.period_type !== 'FIXED') {
    if (input.period_options !== undefined) context.addIssue({code: 'custom', message: 'Fixed period required'});
    return;
  }
  if (!input.period_options) {
    context.addIssue({code: 'custom', message: 'Fixed period required'});
    return;
  }
  try {
    const start = Temporal.Instant.from(input.period_options.period_starting_at);
    const end = Temporal.Instant.from(input.period_options.period_ending_at);
    const limit = start.toZonedDateTimeISO('UTC').add({years: 2}).toInstant();
    if (Temporal.Instant.compare(start, end) >= 0 || Temporal.Instant.compare(end, limit) > 0)
      context.addIssue({code: 'custom', message: 'Invalid fixed period'});
  } catch { context.addIssue({code: 'custom', message: 'Invalid fixed period'}); }
});

/** Explicit fields pin every server default. Only the documented Northbeam
 * documents destination is supported; external storage writes are out of scope. */
export type NorthbeamExportRequest = Immutable<z.infer<typeof requestSchema>>;
export type NorthbeamExportJob = Immutable<{exportId: string; identity: NorthbeamIdentity; request: NorthbeamExportRequest}>;
type ResultBase = NorthbeamExportJob & Readonly<{createdAt: string; finishedAt: string | null}>;
export type NorthbeamExportResult =
  | (ResultBase & Readonly<{status: 'PENDING' | 'ERROR'}>)
  | (ResultBase & Readonly<{status: 'SUCCESS'; finishedAt: string; files: readonly string[]}>);

const baseUrl = 'https://api.northbeam.io/v1/exports';
const headerValue = nonempty.refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const configSchema = z.object({apiKey: headerValue, dataClientId: headerValue}).strict();
const metricSchema = z.object({id: nonempty, label: z.string().nullable().optional()});
const metricsSchema = z.object({metrics: z.array(metricSchema)
  .refine(values => new Set(values.map(value => value.id)).size === values.length)});
const modelsSchema = z.object({attribution_models: z.array(z.object({id: nonempty, name: z.string().nullable().optional()}))
  .refine(values => new Set(values.map(value => value.id)).size === values.length)});
const breakdownsSchema = z.object({breakdowns: z.array(breakdownSchema)
  .refine(values => new Set(values.map(value => value.key)).size === values.length)});
const optionsSchema = z.object({identity: identitySchema, metrics: metricsSchema.shape.metrics,
  attributionModels: modelsSchema.shape.attribution_models, breakdowns: breakdownsSchema.shape.breakdowns}).strict();
const uuid = z.string().uuid();
const jobSchema = z.object({exportId: uuid, identity: identitySchema, request: requestSchema}).strict();
const resultSchema = z.object({
  data_export_id: uuid, status: z.enum(['PENDING', 'SUCCESS', 'ERROR']), result: z.array(z.string().url()),
  created_at: timestamp, finished_at: timestamp.nullable(),
});

class NorthbeamProtocolError extends Error {}
function fail(message: string): never { throw new NorthbeamProtocolError(`Northbeam ${message}`); }
function validated<T>(schema: z.ZodType<T>, input: unknown, description: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail(`invalid ${description}`);
  return parsed.data;
}
function discoveredMetrics(input: unknown) {
  const {metrics} = validated(z.object({metrics: z.array(metricSchema)}), input, 'metrics discovery');
  const unique = new Map<string, z.infer<typeof metricSchema>>();
  for (const metric of metrics) {
    // Live discovery can repeat an identical custom metric. Preserve stable
    // order without accepting conflicting definitions for the same identifier.
    if (unique.has(metric.id) && unique.get(metric.id)!.label !== metric.label) fail('conflicting metrics discovery');
    if (!unique.has(metric.id)) unique.set(metric.id, metric);
  }
  return [...unique.values()];
}
function immutable<T>(input: T): Immutable<T> {
  if (input !== null && typeof input === 'object') {
    for (const value of Object.values(input)) immutable(value);
    Object.freeze(input);
  }
  return input as Immutable<T>;
}
function scoped(config: NorthbeamConfig, identity: NorthbeamIdentity) {
  const credentials = validated(configSchema, config, 'credentials');
  const account = validated(identitySchema, identity, 'account identity');
  if (credentials.dataClientId !== account.dataClientId) fail('account identity mismatch');
  return {credentials, account};
}
function sameIdentity(expected: NorthbeamIdentity, actual: NorthbeamIdentity) {
  if (actual.clientId !== expected.clientId || actual.dataClientId !== expected.dataClientId) fail('account identity mismatch');
}

/** Do not retry: a timed-out POST may already have created an export. Bound
 * fetch AND body reading; neither provider text nor transport causes escape. */
async function providerJson(config: NorthbeamConfig, path: string, method: 'GET' | 'POST', fetcher: typeof fetch,
  deadline: number, body?: string): Promise<unknown> {
  const remaining = deadline - Date.now();
  if (!Number.isFinite(deadline) || remaining <= 0) fail('request deadline reached');
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new NorthbeamProtocolError('Northbeam request deadline reached'));
      controller.abort();
      void reader?.cancel().catch(() => {});
    }, Math.min(60000, remaining));
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetcher(`${baseUrl}${path}`, {
        method, redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: {Authorization: config.apiKey, 'Data-Client-ID': config.dataClientId, Accept: 'application/json',
          ...(method === 'POST' ? {'Content-Type': 'application/json'} : {})},
        ...(body === undefined ? {} : {body}),
      });
      if (response.status !== (method === 'POST' ? 201 : 200)) fail(`request returned HTTP ${response.status}`);
      const limit = 6000000;
      if (Number(response.headers.get('Content-Length')) > limit) fail('response exceeds 6 MB');
      reader = response.body?.getReader();
      if (!reader) fail('response contains invalid JSON');
      let bytes = 0, text = '';
      const decoder = new TextDecoder('utf-8', {fatal: true});
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > limit) fail('response exceeds 6 MB');
        text += decoder.decode(chunk.value, {stream: true});
      }
      text += decoder.decode();
      try { return JSON.parse(text) as unknown; } catch { fail('response contains invalid JSON'); }
    })()]);
  } catch (error) {
    if (error instanceof NorthbeamProtocolError) throw error;
    fail('request failed or could not be reached');
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}

/** Scope records the requested Data-Client-ID; discovery does not verify the
 * account's store identity, timezone, currency, cadence, or hourly entitlement. */
export async function discoverNorthbeamOptions(
  config: NorthbeamConfig, identity: NorthbeamIdentity, fetcher: typeof fetch = fetch, deadline = Date.now() + 60000,
): Promise<NorthbeamOptions> {
  const {credentials, account} = scoped(config, identity);
  const [metrics, models, breakdowns] = await Promise.all([
    providerJson(credentials, '/metrics', 'GET', fetcher, deadline),
    providerJson(credentials, '/attribution-models', 'GET', fetcher, deadline),
    providerJson(credentials, '/breakdowns', 'GET', fetcher, deadline),
  ]);
  return immutable({identity: account,
    metrics: discoveredMetrics(metrics),
    attributionModels: validated(modelsSchema, models, 'attribution model discovery').attribution_models,
    breakdowns: validated(breakdownsSchema, breakdowns, 'breakdown discovery').breakdowns});
}

/** Exactly one POST. An error after dispatch can leave creation unconfirmed;
 * callers must reconcile that outcome before deciding to create another job. */
export async function createNorthbeamExport(
  config: NorthbeamConfig, identity: NorthbeamIdentity, options: NorthbeamOptions, input: NorthbeamExportRequest,
  fetcher: typeof fetch = fetch, deadline = Date.now() + 60000,
): Promise<NorthbeamExportJob> {
  const {credentials, account} = scoped(config, identity);
  const discovered = validated(optionsSchema, options, 'account discovery');
  sameIdentity(account, discovered.identity);
  const request = immutable(validated(requestSchema, input, 'export request'));
  if (request.metrics.some(metric => !discovered.metrics.some(option => option.id === metric.id)) ||
    request.attribution_options.attribution_models.some(id => !discovered.attributionModels.some(option => option.id === id)) ||
    request.breakdowns.some(breakdown => {
      const option = discovered.breakdowns.find(option => option.key === breakdown.key);
      return !option || breakdown.values.some(value => !option.values.includes(value));
    })) fail('export request includes an option not discovered for this account');
  const response = await providerJson(credentials, '/data-export', 'POST', fetcher, deadline, JSON.stringify(request));
  const created = validated(z.object({id: uuid}), response, 'export creation response');
  return immutable({exportId: created.id, identity: account, request});
}

/** One resumable read only. SUCCESS proves export completion, not coverage or
 * reconciliation. File URLs are private server-side handles, never fetched here. */
export async function readNorthbeamExport(
  config: NorthbeamConfig, identity: NorthbeamIdentity, job: NorthbeamExportJob,
  fetcher: typeof fetch = fetch, deadline = Date.now() + 60000,
): Promise<NorthbeamExportResult> {
  const {credentials, account} = scoped(config, identity);
  const saved = validated(jobSchema, job, 'export job');
  sameIdentity(account, saved.identity);
  const snapshot = immutable(saved);
  const response = await providerJson(credentials, `/data-export/result/${snapshot.exportId}`, 'GET', fetcher, deadline);
  const result = validated(resultSchema, response, 'export result');
  if (result.data_export_id !== snapshot.exportId) fail('export result identity mismatch');
  if (result.finished_at !== null && Date.parse(result.finished_at) < Date.parse(result.created_at)) fail('invalid export result timestamps');
  const common = {...snapshot, createdAt: result.created_at, finishedAt: result.finished_at};
  if (result.status !== 'SUCCESS') return immutable({...common, status: result.status});
  if (result.finished_at === null || result.result.length === 0) fail('invalid successful export result');
  if (result.result.some(file => {
    const url = new URL(file);
    return url.protocol !== 'https:' || !!url.username || !!url.password;
  })) fail('invalid export result file URI');
  return immutable({...common, status: 'SUCCESS', finishedAt: result.finished_at, files: result.result});
}
