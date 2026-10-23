import {createHmac, timingSafeEqual} from 'node:crypto';
import {Temporal} from '@js-temporal/polyfill';

/** Protocol references (2026-04):
 * https://developer.loopwork.co/reference/read-all-subscriptions
 * https://developer.loopwork.co/reference/list-activity-logs-1
 * https://developer.loopwork.co/reference/pagination
 * https://developer.loopwork.co/reference/rate-limits
 * https://developer.loopwork.co/reference/verifying-webhook-signatures
 * No API list response proves store identity, deleted-contract coverage or log retention.
 */
export type LoopConfig = {token: string};
/** Supplied by an independently authenticated store identity check; list responses do not establish it. */
export type LoopStoreIdentity = {expectedShopifyDomain: string; authenticatedShopifyDomain: string};
export type LoopReadOptions = {fetcher: typeof fetch; deadline: number; maxPages?: number; pageSize?: number; requestTimeoutMs?: number};
export type LoopTimeWindow = {from: string; through: string};
export type LoopSubscriptionStatus = 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'EXPIRED';
export type LoopSubscription = {
  id: string; customerId: string; status: LoopSubscriptionStatus;
  createdAt: string; updatedAt: string; cancelledAt: string | null; pausedAt: string | null; expiredAt: string | null;
};
export type LoopLifecycleKey = 'subscription_created' | 'subscription_paused' | 'subscription_resumed' | 'subscription_reactivated' | 'subscription_cancelled' | 'subscription_expired';
export type LoopActivityLog = {id: string; subscriptionId: string; key: LoopLifecycleKey; createdAt: string};
export type LoopSubscriptionSnapshot = {shopifyDomain: string; readAt: string; paginationComplete: true; subscriptions: LoopSubscription[]};
/** Pagination completeness does not prove provider retention or historical event completeness. */
export type LoopActivitySnapshot = {shopifyDomain: string; readAt: string; paginationComplete: true; from: string; through: string; events: LoopActivityLog[]};
export type LoopHistoryCoverage = {creationsComplete: boolean; activityLogsComplete: boolean};
export type LoopSummaryWindow = LoopTimeWindow & {timeZone: string};
export type LoopSummaryDay = {
  date: string; through: string; newSubscriptions: number | null; sameDayCancellationContracts: number | null; sameDayCancellationRate: number | null;
  /** Distinct contracts cancelled on this store day; independent of creation history/current status. */
  calendarDayCancellationContracts: number | null;
  /** Availability reason for the creation-cohort metrics; calendar counts use activity coverage independently. */
  unavailableReason: 'incomplete_creation_history' | 'incomplete_activity_history' | 'zero_denominator' | null;
};
export type LoopSubscriptionSummary = {inventoryAsOf: string; currentActiveCustomers: number; currentActiveContracts: number; days: LoopSummaryDay[]};

const lifecycleKeys = new Set<string>(['subscription_created', 'subscription_paused', 'subscription_resumed', 'subscription_reactivated', 'subscription_cancelled', 'subscription_expired']);
const statuses = new Set<string>(['ACTIVE', 'PAUSED', 'CANCELLED', 'EXPIRED']);
const responseByteLimit = 6_000_000;
const compare = Temporal.Instant.compare;
const failure = (reason: string) => new Error(`Loop ${reason}`);
// Loop enforces quotas per store. Use the public authenticated domain, never a credential, as the key.
// Sharing the stricter rolling 2 / 3s budget across these reads also coordinates separate credentials.
const requestStarts = new Map<string, number[]>();

async function pacedRequest<T>(shopifyDomain: string, deadline: number, request: () => Promise<T>): Promise<T> {
  for (;;) {
    const now = Date.now();
    if (now >= deadline) throw failure('synchronization deadline reached');
    for (const [domain, starts] of requestStarts) if (starts[starts.length - 1] <= now - 3_000) requestStarts.delete(domain);
    const starts = (requestStarts.get(shopifyDomain) ?? []).filter(start => start > now - 3_000);
    if (starts.length < 2) {
      requestStarts.set(shopifyDomain, [...starts, now]);
      // Dispatch before yielding so reservation and actual request start share the same clock reading.
      return request();
    }
    const nextStart = starts[0] + 3_000;
    if (nextStart >= deadline) throw failure('rate-limit wait would exceed the synchronization deadline');
    await new Promise<void>(resolve => setTimeout(resolve, nextStart - now));
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw failure('response structure is invalid');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d{0,30}$/.test(value)) return value;
  throw failure('record identity is invalid');
}
function instant(value: unknown): Temporal.Instant {
  try {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw failure('timestamp is invalid');
    return Temporal.Instant.from(value);
  } catch {throw failure('timestamp is invalid');}
}
function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : instant(value).toString();
}
function storeDomain(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value)) throw failure('store identity is invalid');
  return value;
}
function validateIdentity(config: LoopConfig, identity: LoopStoreIdentity): string {
  const expected = storeDomain(identity.expectedShopifyDomain);
  if (storeDomain(identity.authenticatedShopifyDomain) !== expected) throw failure('store identity does not match');
  if (typeof config.token !== 'string' || !config.token.trim() || /[\r\n]/.test(config.token)) throw failure('API token is missing or invalid');
  return expected;
}
function validateOptions(options: LoopReadOptions) {
  const pageSize = options.pageSize ?? 100, maxPages = options.maxPages ?? 500, requestTimeoutMs = options.requestTimeoutMs ?? 25_000;
  if (!Number.isFinite(options.deadline)) throw failure('deadline is invalid');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 2_500 || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000) throw failure('request budget is invalid');
  return {pageSize, maxPages, requestTimeoutMs};
}

/** The timer covers fetch and streamed body reads, including injected fetchers that ignore abort. */
async function requestPage(url: URL, config: LoopConfig, options: LoopReadOptions, requestTimeoutMs: number): Promise<Record<string, unknown>> {
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) throw failure('synchronization deadline reached');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {controller.abort(); reject(failure('request timed out or deadline reached'));}, Math.min(requestTimeoutMs, remaining));
  });
  const operation = async () => {
    let response: Response;
    try {
      response = await options.fetcher(url.toString(), {method: 'GET', redirect: 'manual', headers: {'X-Loop-Token': config.token, Accept: 'application/json'}, signal: controller.signal});
    } catch {throw failure('request timed out or could not be reached');}
    if (!response.ok) throw failure(`provider returned HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw failure('provider returned an empty response');
    let bytes = 0;
    const decoder = new TextDecoder(), parts: string[] = [];
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > responseByteLimit) throw failure('provider response exceeds the byte limit');
        parts.push(decoder.decode(chunk.value, {stream: true}));
      }
      parts.push(decoder.decode());
    } catch {
      void reader.cancel().catch(() => {});
      throw failure('provider response could not be read or exceeds the byte limit');
    } finally {reader.releaseLock();}
    if (Date.now() >= options.deadline) throw failure('synchronization deadline reached');
    let parsed: unknown;
    try {parsed = JSON.parse(parts.join(''));} catch {throw failure('provider returned invalid JSON');}
    return object(parsed);
  };
  try {return await Promise.race([operation(), expired]);}
  finally {if (timer !== undefined) clearTimeout(timer); controller.abort();}
}

async function readPages(config: LoopConfig, shopifyDomain: string, options: LoopReadOptions, resource: 'subscription' | 'activityLog', params: URLSearchParams, receive: (record: unknown) => void) {
  const {pageSize, maxPages, requestTimeoutMs} = validateOptions(options);
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const query = new URLSearchParams(params);
    query.set('pageSize', String(pageSize));
    if (cursor !== undefined) query.set('afterCursor', cursor);
    const body = await pacedRequest(shopifyDomain, options.deadline, () => requestPage(new URL(`https://api.loopsubscriptions.com/admin/2026-04/${resource}?${query}`), config, options, requestTimeoutMs));
    if (body.success !== true || body.code !== 'SUCCESS') throw failure('provider did not return a successful result');
    if (!Array.isArray(body.data) || body.data.length > pageSize) throw failure('provider page data is invalid');
    let info: Record<string, unknown>;
    try {info = object(body.pageInfo);} catch {throw failure('pagination metadata is missing');}
    if (typeof info.hasNextPage !== 'boolean') throw failure('pagination metadata is missing');
    const next = info.nextCursor;
    if (info.hasNextPage) {
      // The store-wide log example omits this field. Never guess a cursor or return that page as complete.
      if (typeof next !== 'string' || !next.trim() || next.length > 4_096 || next === cursor || seenCursors.has(next) || body.data.length === 0) throw failure('pagination did not advance or lacks a cursor');
    } else if (next !== undefined && next !== null && next !== '') throw failure('pagination metadata is inconsistent');
    for (const record of body.data) receive(record);
    if (!info.hasNextPage) return;
    if (pageIndex === maxPages - 1) throw failure('pagination exceeds its page budget');
    cursor = next as string;
    seenCursors.add(cursor);
  }
  throw failure('pagination did not complete');
}

function normalizedSubscription(value: unknown): LoopSubscription {
  const row = object(value), customer = object(row.customer), created = instant(row.createdAt), updated = instant(row.updatedAt);
  if (typeof row.status !== 'string' || !statuses.has(row.status)) throw failure('subscription status is invalid');
  const cancelledAt = nullableTimestamp(row.cancelledAt), pausedAt = nullableTimestamp(row.pausedAt), expiredAt = nullableTimestamp(row.expiredAt);
  for (const time of [updated.toString(), cancelledAt, pausedAt, expiredAt]) if (time !== null && compare(instant(time), created) < 0) throw failure('subscription lifecycle timestamp precedes creation');
  return {id: identifier(row.id), customerId: identifier(customer.id), status: row.status as LoopSubscriptionStatus, createdAt: created.toString(), updatedAt: updated.toString(), cancelledAt, pausedAt, expiredAt};
}
function addStable<T extends {id: string}>(seen: Map<string, T>, row: T) {
  const previous = seen.get(row.id);
  if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw failure('record identity changed during pagination');
  if (!previous) seen.set(row.id, row);
}

export async function readLoopSubscriptions(config: LoopConfig, identity: LoopStoreIdentity, options: LoopReadOptions): Promise<LoopSubscriptionSnapshot> {
  const shopifyDomain = validateIdentity(config, identity), subscriptions = new Map<string, LoopSubscription>();
  // Omit status and date filters: the current inventory must include every documented status.
  await readPages(config, shopifyDomain, options, 'subscription', new URLSearchParams(), record => addStable(subscriptions, normalizedSubscription(record)));
  return {shopifyDomain, readAt: Temporal.Instant.fromEpochMilliseconds(Date.now()).toString(), paginationComplete: true, subscriptions: [...subscriptions.values()]};
}

export async function readLoopActivityLogs(config: LoopConfig, identity: LoopStoreIdentity, window: LoopTimeWindow, options: LoopReadOptions): Promise<LoopActivitySnapshot> {
  const shopifyDomain = validateIdentity(config, identity), start = instant(window.from), end = instant(window.through);
  if (compare(start, end) >= 0) throw failure('activity window is invalid');
  const records = new Map<string, {id: string; subscriptionId: string; key: string; createdAt: string | null}>();
  const params = new URLSearchParams({createdAtStartEpoch: String(Math.floor(start.epochMilliseconds / 1_000)), createdAtEndEpoch: String(Math.ceil(end.epochMilliseconds / 1_000))});
  await readPages(config, shopifyDomain, options, 'activityLog', params, value => {
    const row = object(value), id = identifier(row.id), subscriptionId = identifier(row.subscriptionId);
    if (typeof row.key !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(row.key)) throw failure('activity key is invalid');
    const createdAt = row.createdAt === null && !lifecycleKeys.has(row.key) ? null : instant(row.createdAt).toString();
    if (createdAt !== null && (compare(instant(createdAt), start) < 0 || compare(instant(createdAt), end) > 0)) throw failure('activity timestamp is outside the requested window');
    addStable(records, {id, subscriptionId, key: row.key, createdAt});
  });
  const events: LoopActivityLog[] = [];
  for (const row of records.values()) if (lifecycleKeys.has(row.key) && row.createdAt !== null) events.push({...row, key: row.key as LoopLifecycleKey, createdAt: row.createdAt});
  return {shopifyDomain, readAt: Temporal.Instant.fromEpochMilliseconds(Date.now()).toString(), paginationComplete: true, from: start.toString(), through: end.toString(), events};
}

/** Coverage is an external reconciliation assertion, never inferred from successful pagination.
 * In particular, current inventory alone cannot prove a creation cohort contains deleted contracts.
 * Active counts describe only inventoryAsOf; no historical active series is reconstructed.
 */
export function summarizeLoopSubscriptions(inventory: LoopSubscriptionSnapshot, activity: LoopActivitySnapshot, window: LoopSummaryWindow, coverage: LoopHistoryCoverage): LoopSubscriptionSummary {
  if (storeDomain(inventory.shopifyDomain) !== storeDomain(activity.shopifyDomain)) throw failure('summary source identity does not match');
  if (inventory.paginationComplete !== true || activity.paginationComplete !== true) throw failure('summary pagination is incomplete');
  const start = instant(window.from), end = instant(window.through), inventoryTime = instant(inventory.readAt), activityTime = instant(activity.readAt);
  let startLocal: Temporal.ZonedDateTime, endLocal: Temporal.ZonedDateTime;
  try {startLocal = start.toZonedDateTimeISO(window.timeZone); endLocal = end.toZonedDateTimeISO(window.timeZone);} catch {throw failure('store timezone is invalid');}
  if (startLocal.hour !== 0 || startLocal.minute !== 0 || startLocal.second !== 0 || startLocal.millisecond !== 0 || startLocal.microsecond !== 0 || startLocal.nanosecond !== 0) throw failure('cohort window must start at store midnight');
  if (endLocal.minute !== 0 || endLocal.second !== 0 || endLocal.millisecond !== 0 || endLocal.microsecond !== 0 || endLocal.nanosecond !== 0) throw failure('cohort window must end at a completed store hour');
  if (compare(start, end) >= 0 || compare(end, inventoryTime) > 0 || compare(end, activityTime) > 0 || compare(instant(activity.from), start) > 0 || compare(instant(activity.through), end) < 0) throw failure('summary source coverage does not contain the requested window');
  if (typeof coverage.creationsComplete !== 'boolean' || typeof coverage.activityLogsComplete !== 'boolean') throw failure('history coverage assertion is missing');
  const subscriptions = new Map<string, LoopSubscription>();
  for (const row of inventory.subscriptions) {
    const normalized = normalizedSubscription({...row, customer: {id: row.customerId}});
    if (compare(instant(normalized.createdAt), inventoryTime) > 0 || compare(instant(normalized.updatedAt), inventoryTime) > 0) throw failure('inventory timestamp is after its observation');
    addStable(subscriptions, normalized);
  }
  const customers = new Set<string>();
  let activeContracts = 0;
  const created = new Map<string, Set<string>>(), cancelled = new Map<string, Set<string>>(), calendarCancelled = new Map<string, Set<string>>();
  for (const row of subscriptions.values()) {
    if (row.status === 'ACTIVE') {activeContracts++; customers.add(row.customerId);}
    const time = instant(row.createdAt);
    if (compare(time, start) < 0 || compare(time, end) >= 0) continue;
    const date = time.toZonedDateTimeISO(window.timeZone).toPlainDate().toString();
    const ids = created.get(date) ?? new Set<string>(); ids.add(row.id); created.set(date, ids);
  }
  const events = new Map<string, LoopActivityLog>();
  for (const event of activity.events) {
    const row = {id: identifier(event.id), subscriptionId: identifier(event.subscriptionId), key: event.key, createdAt: instant(event.createdAt).toString()};
    if (!lifecycleKeys.has(row.key)) throw failure('summary lifecycle event is invalid');
    addStable(events, row);
  }
  for (const row of events.values()) {
    const time = instant(row.createdAt), contract = subscriptions.get(row.subscriptionId);
    if (coverage.creationsComplete && row.key === 'subscription_created' && !contract && compare(time, start) >= 0 && compare(time, end) < 0) throw failure('creation history is incomplete for an observed created contract');
    if (contract && compare(time, instant(contract.createdAt)) < 0) throw failure('activity timestamp precedes subscription creation');
    if (row.key !== 'subscription_cancelled' || compare(time, start) < 0 || compare(time, end) >= 0) continue;
    const calendarDate = time.toZonedDateTimeISO(window.timeZone).toPlainDate().toString();
    const calendarIds = calendarCancelled.get(calendarDate) ?? new Set<string>();
    calendarIds.add(row.subscriptionId); calendarCancelled.set(calendarDate, calendarIds);
    if (!contract) continue;
    const date = instant(contract.createdAt).toZonedDateTimeISO(window.timeZone).toPlainDate().toString();
    if (!created.get(date)?.has(contract.id) || time.toZonedDateTimeISO(window.timeZone).toPlainDate().toString() !== date) continue;
    const ids = cancelled.get(date) ?? new Set<string>(); ids.add(contract.id); cancelled.set(date, ids);
  }
  const days: LoopSummaryDay[] = [];
  let date = startLocal.toPlainDate();
  for (let count = 0; ; count++) {
    if (count >= 366) throw failure('summary window exceeds its day budget');
    const dayStart = date.toZonedDateTime({timeZone: window.timeZone}).toInstant();
    if (compare(dayStart, end) >= 0) break;
    const next = date.add({days: 1}), nextStart = next.toZonedDateTime({timeZone: window.timeZone}).toInstant();
    const dayThrough = compare(nextStart, end) < 0 ? nextStart : end, key = date.toString();
    const denominator = coverage.creationsComplete ? created.get(key)?.size ?? 0 : null;
    const numerator = coverage.creationsComplete && coverage.activityLogsComplete ? cancelled.get(key)?.size ?? 0 : null;
    const unavailableReason = !coverage.creationsComplete ? 'incomplete_creation_history' : !coverage.activityLogsComplete ? 'incomplete_activity_history' : denominator === 0 ? 'zero_denominator' : null;
    days.push({date: key, through: dayThrough.toString(), newSubscriptions: denominator, sameDayCancellationContracts: numerator, sameDayCancellationRate: denominator !== null && denominator > 0 && numerator !== null ? numerator / denominator : null, calendarDayCancellationContracts: coverage.activityLogsComplete ? calendarCancelled.get(key)?.size ?? 0 : null, unavailableReason});
    date = next;
  }
  return {inventoryAsOf: inventoryTime.toString(), currentActiveCustomers: customers.size, currentActiveContracts: activeContracts, days};
}

export function verifyLoopWebhookSignature(rawBody: Uint8Array, signatureHeader: string | null | undefined, secrets: readonly string[]): boolean {
  if (!(rawBody instanceof Uint8Array) || typeof signatureHeader !== 'string' || signatureHeader.length > 4_096) return false;
  const signatures = signatureHeader.split(',').map(token => token.trim()).filter(token => /^v1=[0-9a-f]{64}$/.test(token)).map(token => Buffer.from(token.slice(3), 'hex'));
  let matched = false;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    for (const received of signatures) if (timingSafeEqual(expected, received)) matched = true;
  }
  return matched;
}
