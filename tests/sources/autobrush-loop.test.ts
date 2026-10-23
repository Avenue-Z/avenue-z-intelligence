import {createHmac} from 'node:crypto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  readLoopActivityLogs,
  readLoopSubscriptions,
  summarizeLoopSubscriptions,
  verifyLoopWebhookSignature,
  type LoopActivitySnapshot,
  type LoopSubscriptionSnapshot,
} from '../../lib/sources/autobrush-loop';

const config = {token: 'private-loop-token'};
let domain = 'ama-brushh.myshopify.com';
let identity = {expectedShopifyDomain: domain, authenticatedShopifyDomain: domain};
let caseNumber = 0;
const from = '2026-10-19T04:00:00Z';
const through = '2026-10-20T16:00:00Z';
const window = {from, through, timeZone: 'America/New_York'};
const coverage = {creationsComplete: true, activityLogsComplete: true};
const subscription = (id = 9, customerId = 4, status = 'ACTIVE', createdAt = '2026-10-19T05:00:00Z') => ({
  id, status, createdAt, updatedAt: '2026-10-20T16:30:00Z',
  cancelledAt: null as string | null, pausedAt: null, expiredAt: null,
  customer: {id: customerId, shopifyId: 88, email: 'private@example.com'},
  shippingAddress: {address1: 'private address'}, paymentMethod: {lastDigits: '9999'},
});
const event = (id = 100, subscriptionId = 9, key = 'subscription_cancelled', createdAt: string | null = '2026-10-19T06:00:00Z') => ({
  id, subscriptionId, key, createdAt, source: 'Customer', entity: 'Loop Subscriptions',
  data: {cancellationComment: 'private comment', email: 'private@example.com'},
});
const page = (data: unknown[], nextCursor: string | null = null) => ({
  success: true, code: 'SUCCESS', message: 'Fetched successfully', data,
  pageInfo: {hasNextPage: nextCursor !== null, nextCursor, hasPreviousPage: false, previousCursor: null},
});
const response = (body: unknown, status = 200) => Response.json(body, {status});
function options(fetcher: typeof fetch, extra: {maxPages?: number; pageSize?: number; requestTimeoutMs?: number} = {}) {
  return {fetcher, deadline: Date.now() + 60_000, ...extra};
}
async function fixtures(rows: ReturnType<typeof subscription>[], logs: ReturnType<typeof event>[] = []) {
  const inventory = await readLoopSubscriptions(config, identity, options(async () => response(page(rows))));
  const activity = await readLoopActivityLogs(config, identity, {from, through}, options(async () => response(page(logs))));
  return {inventory, activity};
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-20T16:35:00Z');
  domain = `fixture-${++caseNumber}.myshopify.com`;
  identity = {expectedShopifyDomain: domain, authenticatedShopifyDomain: domain};
});
afterEach(() => {vi.useRealTimers();});

describe('Loop read-only protocol', () => {
  it('advances the documented cursor, reads all statuses and drops customer PII', async () => {
    const requests: {url: URL; init?: RequestInit}[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      const parsed = new URL(String(url)); requests.push({url: parsed, init});
      return response(parsed.searchParams.has('afterCursor') ? page([subscription(8, 5, 'PAUSED')]) : page([subscription()], 'cursor-2'));
    };
    const result = await readLoopSubscriptions(config, identity, options(fetcher));
    expect(requests.map(r => r.url.pathname)).toEqual(['/admin/2026-04/subscription', '/admin/2026-04/subscription']);
    expect(requests.map(r => r.url.searchParams.get('afterCursor'))).toEqual([null, 'cursor-2']);
    expect(requests.every(r => !r.url.searchParams.has('status') && r.url.searchParams.get('pageSize') === '100')).toBe(true);
    expect(new Headers(requests[0].init?.headers).get('X-Loop-Token')).toBe(config.token);
    expect(requests[0].init?.redirect).toBe('manual');
    expect(result.shopifyDomain).toBe(domain);
    expect(result.paginationComplete).toBe(true);
    expect(result.subscriptions).toEqual([
      {id: '9', customerId: '4', status: 'ACTIVE', createdAt: '2026-10-19T05:00:00Z', updatedAt: '2026-10-20T16:30:00Z', cancelledAt: null, pausedAt: null, expiredAt: null},
      {id: '8', customerId: '5', status: 'PAUSED', createdAt: '2026-10-19T05:00:00Z', updatedAt: '2026-10-20T16:30:00Z', cancelledAt: null, pausedAt: null, expiredAt: null},
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private|address|paymentMethod|email|shopifyId/);
  });

  it('uses the store-wide activity endpoint, preserves bounds and minimizes lifecycle events', async () => {
    const urls: URL[] = [];
    const fetcher: typeof fetch = async url => {
      const parsed = new URL(String(url)); urls.push(parsed);
      return response(parsed.searchParams.has('afterCursor')
        ? page([event(99, 9, 'subscription_reactivated', '2026-10-19T07:00:00Z')])
        : page([event(), event(101, 9, 'streak_failed', null)], 'next'));
    };
    const result = await readLoopActivityLogs(config, identity, {from, through}, options(fetcher));
    expect(urls.map(url => url.pathname)).toEqual(['/admin/2026-04/activityLog', '/admin/2026-04/activityLog']);
    expect(urls.every(url => url.searchParams.get('createdAtStartEpoch') === '1792382400' && url.searchParams.get('createdAtEndEpoch') === '1792512000')).toBe(true);
    expect(result.events).toEqual([
      {id: '100', subscriptionId: '9', key: 'subscription_cancelled', createdAt: '2026-10-19T06:00:00Z'},
      {id: '99', subscriptionId: '9', key: 'subscription_reactivated', createdAt: '2026-10-19T07:00:00Z'},
    ]);
    expect(result).toMatchObject({shopifyDomain: domain, from, through, paginationComplete: true});
    expect(JSON.stringify(result)).not.toMatch(/private|email|source|entity|comment/);
  });

  it.each([
    {success: true, code: 'SUCCESS', data: []},
    {...page([]), pageInfo: {hasNextPage: true}},
    {...page([]), pageInfo: {hasNextPage: true, nextCursor: null}},
    {...page([]), pageInfo: {hasNextPage: false, nextCursor: 'unread-page'}},
    {...page([]), pageInfo: {nextCursor: null}},
  ])('rejects incomplete or inconsistent pagination metadata %#', async body => {
    await expect(readLoopSubscriptions(config, identity, options(async () => response(body)))).rejects.toThrow(/pagination/i);
  });

  it('rejects a cursor cycle and never returns a truncated snapshot', async () => {
    let count = 0;
    const assertion = expect(readLoopSubscriptions(config, identity, options(async () => {
      count++; return response(page([subscription()], count === 2 ? 'b' : 'a'));
    }))).rejects.toThrow(/advance|pagination/i);
    await vi.runAllTimersAsync();
    await assertion;
    expect(count).toBe(3);
  });

  it('paces the third subscription page until the rolling three-second window has elapsed', async () => {
    const times: number[] = [], started = Date.now();
    const pending = readLoopSubscriptions(config, identity, options(async () => {
      times.push(Date.now() - started);
      return response(page([subscription(10 - times.length)], times.length < 3 ? `page-${times.length + 1}` : null));
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(times).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(times).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).subscriptions).toHaveLength(3);
    expect(times).toEqual([0, 0, 3_000]);
  });

  it('shares pacing across concurrent subscription and activity reads for one authenticated store', async () => {
    const requests: {path: string; at: number}[] = [], started = Date.now();
    const fetcher: typeof fetch = async url => {
      const path = new URL(String(url)).pathname; requests.push({path, at: Date.now() - started});
      return response(page(path.endsWith('/subscription') ? [subscription()] : [event()]));
    };
    const first = readLoopSubscriptions(config, identity, options(fetcher));
    const second = readLoopActivityLogs({...config}, identity, {from, through}, options(fetcher));
    const third = readLoopSubscriptions({token: 'another-token-for-the-same-store'}, {...identity}, options(fetcher));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(requests).toEqual([{path: '/admin/2026-04/subscription', at: 0}, {path: '/admin/2026-04/activityLog', at: 0}]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second, third]);
    expect(requests[2]).toEqual({path: '/admin/2026-04/subscription', at: 3_000});
  });

  it('rejects before waiting when the next rate-limit slot cannot fit within the deadline', async () => {
    let requests = 0;
    const fetcher: typeof fetch = async () => {requests++; return response(page([subscription()]));};
    await readLoopSubscriptions(config, identity, options(fetcher));
    await readLoopSubscriptions(config, identity, options(fetcher));
    const started = Date.now();
    const error = await readLoopSubscriptions(config, identity, {...options(fetcher), deadline: started + 1_000}).catch(error => error as Error);
    expect(String(error)).toMatch(/deadline/i);
    expect(String(error)).not.toContain(config.token);
    expect(requests).toBe(2);
    expect(Date.now()).toBe(started);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(requests).toBe(2);
  });

  it('throws when another page exceeds the explicit page budget', async () => {
    await expect(readLoopSubscriptions(config, identity, options(async () => response(page([subscription()], 'next')), {maxPages: 1}))).rejects.toThrow(/page budget/i);
  });

  it('rejects the documented store-wide log example that announces another page without a cursor', async () => {
    const body = {...page([event()]), pageInfo: {hasNextPage: true, hasPreviousPage: false}};
    await expect(readLoopActivityLogs(config, identity, {from, through}, options(async () => response(body)))).rejects.toThrow(/pagination/i);
  });

  it('accepts explicit terminal page metadata without a continuation cursor', async () => {
    const body = {...page([subscription()]), pageInfo: {hasNextPage: false}};
    expect((await readLoopSubscriptions(config, identity, options(async () => response(body)))).subscriptions).toHaveLength(1);
  });

  it('stops on HTTP rate limits instead of retrying beyond the request budget', async () => {
    let requests = 0;
    await expect(readLoopSubscriptions(config, identity, options(async () => {requests++; return response({}, 429);}))).rejects.toThrow(/HTTP 429/);
    expect(requests).toBe(1);
  });

  it('rejects oversized response streams without exposing their contents', async () => {
    const error = await readLoopSubscriptions(config, identity, options(async () => new Response('private@example.com'.repeat(400_000)))).catch(error => error as Error);
    expect(String(error)).toMatch(/byte limit/);
    expect(String(error)).not.toMatch(/private@example/);
  });

  it('deduplicates identical identities and rejects changed lifecycle records', async () => {
    let count = 0;
    const read = (change: boolean) => readLoopSubscriptions(config, identity, options(async () => {
      count++;
      return response(count === 1 ? page([subscription()], 'next') : page([subscription(9, change ? 99 : 4)]));
    }));
    expect((await read(false)).subscriptions).toHaveLength(1);
    count = 0;
    const assertion = expect(read(true)).rejects.toThrow(/changed/i);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('deduplicates activity identities and detects changes to their subscription identity', async () => {
    let count = 0;
    const activity = await readLoopActivityLogs(config, identity, {from, through}, options(async () => {
      count++; return response(count === 1 ? page([event()], 'next') : page([event()]));
    }));
    expect(activity.events).toHaveLength(1);
    count = 0;
    const assertion = expect(readLoopActivityLogs(config, identity, {from, through}, options(async () => {
      count++; return response(count === 1 ? page([event()], 'next') : page([event(100, 8)]));
    }))).rejects.toThrow(/changed/i);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it.each([
    {...subscription(), id: Number.MAX_SAFE_INTEGER + 1},
    {...subscription(), customer: {email: 'private@example.com'}},
    {...subscription(), status: 'UNKNOWN'},
    {...subscription(), createdAt: '2026-02-30T05:00:00Z'},
    {...subscription(), createdAt: '2026-10-19'},
    {...subscription(), cancelledAt: '2026-10-18T06:00:00Z'},
  ])('rejects unusable subscription lifecycle fields %#', async record => {
    await expect(readLoopSubscriptions(config, identity, options(async () => response(page([record]))))).rejects.toThrow(/Loop/);
  });

  it('rejects missing cancellation event times and events outside requested bounds', async () => {
    for (const record of [event(100, 9, 'subscription_cancelled', null), event(100, 9, 'subscription_cancelled', '2026-10-18T00:00:00Z')]) {
      await expect(readLoopActivityLogs(config, identity, {from, through}, options(async () => response(page([record]))))).rejects.toThrow(/timestamp|window/i);
    }
  });

  it('requires authenticated identity agreement before sending the API token', async () => {
    let requests = 0;
    await expect(readLoopSubscriptions(config, {...identity, authenticatedShopifyDomain: 'other.myshopify.com'}, options(async () => {requests++; return response(page([]));}))).rejects.toThrow(/identity/i);
    expect(requests).toBe(0);
  });

  it.each([response({message: 'private@example.com private-loop-token'}, 403), response({...page([]), success: false, message: 'private@example.com private-loop-token'})])('sanitizes HTTP and provider errors %#', async providerResponse => {
    const error = await readLoopSubscriptions(config, identity, options(async () => providerResponse)).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toMatch(/private@example|private-loop-token/);
  });

  it('sanitizes transport errors and JSON parse errors', async () => {
    for (const fetcher of [async () => {throw new Error('private-loop-token private@example.com');}, async () => new Response('private@example.com')]) {
      const error = await readLoopSubscriptions(config, identity, options(fetcher)).catch(error => error as Error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toMatch(/private@example|private-loop-token/);
    }
  });

  it('enforces the deadline even if the fetch implementation ignores abort', async () => {
    const pending = readLoopSubscriptions(config, identity, {...options(async () => new Promise<Response>(() => {})), deadline: Date.now() + 10});
    const assertion = expect(pending).rejects.toThrow(/deadline|timed out/i);
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
  });

  it('enforces the deadline while reading a stalled response body', async () => {
    const pending = readLoopSubscriptions(config, identity, {...options(async () => new Response(new ReadableStream({start() {}}))), deadline: Date.now() + 10});
    const assertion = expect(pending).rejects.toThrow(/deadline|timed out/i);
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
  });

  it('rejects an expired deadline before making any request', async () => {
    let calls = 0;
    await expect(readLoopSubscriptions(config, identity, {...options(async () => {calls++; return response(page([]));}), deadline: Date.now()})).rejects.toThrow(/deadline/i);
    expect(calls).toBe(0);
  });
});

describe('Loop subscription metrics', () => {
  it('separates current active customers from contracts and retains cancellation after reactivation', async () => {
    const {inventory, activity} = await fixtures([
      subscription(9, 4), subscription(8, 4), subscription(7, 5, 'PAUSED'), subscription(6, 6, 'CANCELLED'), subscription(5, 7, 'EXPIRED'),
    ], [event(), event(101), event(102, 9, 'subscription_reactivated', '2026-10-19T07:00:00Z'), event(103, 6)]);
    const result = summarizeLoopSubscriptions(inventory, activity, window, coverage);
    expect(result.currentActiveCustomers).toBe(1);
    expect(result.currentActiveContracts).toBe(2);
    expect(result.inventoryAsOf).toBe('2026-10-20T16:35:00Z');
    expect(result.days).toEqual([
      {date: '2026-10-19', through: '2026-10-20T04:00:00Z', newSubscriptions: 5, sameDayCancellationContracts: 2, sameDayCancellationRate: 0.4, calendarDayCancellationContracts: 2, unavailableReason: null},
      {date: '2026-10-20', through, newSubscriptions: 0, sameDayCancellationContracts: 0, sameDayCancellationRate: null, calendarDayCancellationContracts: 0, unavailableReason: 'zero_denominator'},
    ]);
    expect(result.days.every(day => !('activeCustomers' in day) && !('activeContracts' in day))).toBe(true);
  });

  it('uses the original creation store day and excludes the incomplete hour', async () => {
    const {inventory, activity} = await fixtures([
      subscription(9, 4, 'ACTIVE', '2026-10-20T03:30:00Z'),
      subscription(8, 5, 'CANCELLED', '2026-10-20T04:30:00Z'),
      subscription(7, 6, 'PAUSED', '2026-10-20T15:59:59Z'),
      subscription(6, 7, 'ACTIVE', '2026-10-20T16:10:00Z'),
    ], [event(100, 9, 'subscription_cancelled', '2026-10-20T04:10:00Z'), event(101, 8, 'subscription_cancelled', '2026-10-20T05:00:00Z'), event(102, 7, 'subscription_cancelled', through)]);
    const result = summarizeLoopSubscriptions(inventory, activity, window, coverage);
    expect(result.days.map(day => [day.newSubscriptions, day.sameDayCancellationContracts, day.sameDayCancellationRate])).toEqual([[1, 0, 0], [2, 1, 0.5]]);
  });

  it('counts distinct cancelled contracts per store calendar day independently of creation and reactivation', async () => {
    const {inventory, activity} = await fixtures([subscription(), subscription(8, 5, 'ACTIVE', '2026-10-18T06:00:00Z')], [
      event(100), event(101, 9, 'subscription_cancelled', '2026-10-19T07:00:00Z'),
      event(102, 9, 'subscription_reactivated', '2026-10-19T08:00:00Z'),
      event(103, 9, 'subscription_cancelled', '2026-10-20T05:00:00Z'),
      event(104, 8, 'subscription_cancelled', '2026-10-20T03:30:00Z'),
      event(105, 123, 'subscription_cancelled', '2026-10-20T06:00:00Z'),
      event(106, 7, 'subscription_cancelled', through),
    ]);
    const result = summarizeLoopSubscriptions(inventory, activity, window, coverage);
    expect(result.days.map(day => day.calendarDayCancellationContracts)).toEqual([2, 2]);
    expect(result.days.map(day => [day.newSubscriptions, day.sameDayCancellationContracts, day.sameDayCancellationRate])).toEqual([[1, 1, 1], [0, 0, null]]);
    const incompleteCreations = summarizeLoopSubscriptions(inventory, activity, window, {...coverage, creationsComplete: false});
    expect(incompleteCreations.days.map(day => day.calendarDayCancellationContracts)).toEqual([2, 2]);
    const incompleteActivity = summarizeLoopSubscriptions(inventory, activity, window, {...coverage, activityLogsComplete: false});
    expect(incompleteActivity.days.map(day => day.calendarDayCancellationContracts)).toEqual([null, null]);
  });

  it('does not infer historical events from the current cancelledAt field', async () => {
    const row = {...subscription(9, 4, 'CANCELLED'), cancelledAt: '2026-10-19T06:00:00Z'};
    const {inventory, activity} = await fixtures([row]);
    const result = summarizeLoopSubscriptions(inventory, activity, window, {...coverage, activityLogsComplete: false});
    expect(result.days[0]).toMatchObject({newSubscriptions: 1, sameDayCancellationContracts: null, sameDayCancellationRate: null, unavailableReason: 'incomplete_activity_history'});
  });

  it('leaves creation cohort metrics unavailable without complete creation history', async () => {
    const {inventory, activity} = await fixtures([subscription()], [event()]);
    const result = summarizeLoopSubscriptions(inventory, activity, window, {...coverage, creationsComplete: false});
    expect(result.days[0]).toMatchObject({newSubscriptions: null, sameDayCancellationContracts: null, sameDayCancellationRate: null, unavailableReason: 'incomplete_creation_history'});
  });

  it('requires source identity and coverage bounds to agree', async () => {
    const {inventory, activity} = await fixtures([subscription()], [event()]);
    expect(() => summarizeLoopSubscriptions(inventory, {...activity, shopifyDomain: 'other.myshopify.com'}, window, coverage)).toThrow(/identity/i);
    expect(() => summarizeLoopSubscriptions(inventory, {...activity, from: '2026-10-20T04:00:00Z'}, window, coverage)).toThrow(/coverage/i);
  });

  it('rejects an unfinished local hour or nonmidnight cohort start', async () => {
    const {inventory, activity} = await fixtures([subscription()]);
    expect(() => summarizeLoopSubscriptions(inventory, activity, {...window, through: '2026-10-20T16:30:00Z'}, coverage)).toThrow(/hour/i);
    expect(() => summarizeLoopSubscriptions(inventory, activity, {...window, from: '2026-10-19T05:00:00Z'}, coverage)).toThrow(/midnight/i);
  });

  it('rejects cancellation before original creation and conflicting duplicates in summary inputs', async () => {
    const {inventory, activity} = await fixtures([subscription()], [event()]);
    expect(() => summarizeLoopSubscriptions(inventory, {...activity, events: [{...activity.events[0], createdAt: '2026-10-19T04:30:00Z'}]}, window, coverage)).toThrow(/precedes/i);
    expect(() => summarizeLoopSubscriptions({...inventory, subscriptions: [...inventory.subscriptions, {...inventory.subscriptions[0], customerId: '8'}]}, activity, window, coverage)).toThrow(/changed/i);
  });

  it('rejects a complete-history assertion contradicted by a missing created contract', async () => {
    const {inventory, activity} = await fixtures([subscription()], [event(100, 123, 'subscription_created')]);
    expect(() => summarizeLoopSubscriptions(inventory, activity, window, coverage)).toThrow(/creation history/i);
    const incomplete = summarizeLoopSubscriptions(inventory, activity, window, {...coverage, creationsComplete: false});
    expect(incomplete.days[0].newSubscriptions).toBeNull();
  });

  it('counts both repeated DST hours inside the completed source window', () => {
    const inventory: LoopSubscriptionSnapshot = {shopifyDomain: domain, readAt: '2026-11-01T08:30:00Z', paginationComplete: true, subscriptions: [
      {id: '1', customerId: '1', status: 'ACTIVE', createdAt: '2026-11-01T05:30:00Z', updatedAt: '2026-11-01T07:00:00Z', cancelledAt: null, pausedAt: null, expiredAt: null},
      {id: '2', customerId: '2', status: 'ACTIVE', createdAt: '2026-11-01T06:30:00Z', updatedAt: '2026-11-01T07:00:00Z', cancelledAt: null, pausedAt: null, expiredAt: null},
    ]};
    const activity: LoopActivitySnapshot = {shopifyDomain: domain, readAt: inventory.readAt, from: '2026-11-01T04:00:00Z', through: '2026-11-01T08:00:00Z', paginationComplete: true, events: []};
    const result = summarizeLoopSubscriptions(inventory, activity, {from: activity.from, through: activity.through, timeZone: 'America/New_York'}, coverage);
    expect(result.days[0]).toMatchObject({date: '2026-11-01', newSubscriptions: 2, sameDayCancellationRate: 0});
  });
});

describe('Loop webhook signatures', () => {
  it('authenticates original raw bytes and accepts an active rotated secret', () => {
    const raw = new TextEncoder().encode('{ "payload": {"unicode":"é"}, "metaData": {} }\n');
    const signed = createHmac('sha256', 'new-secret').update(raw).digest('hex');
    const header = `v2=unknown, v1=${'0'.repeat(64)}, v1=${signed}`;
    expect(verifyLoopWebhookSignature(raw, header, ['old-secret', 'new-secret'])).toBe(true);
    expect(verifyLoopWebhookSignature(new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(raw)))), header, ['new-secret'])).toBe(false);
  });

  it.each([undefined, null, '', 'v1=ab', `v1=${'z'.repeat(64)}`, `v2=${'0'.repeat(64)}`, `v1=${'0'.repeat(64)}`])('rejects missing, malformed or wrong signatures %#', header => {
    expect(verifyLoopWebhookSignature(new Uint8Array([1, 2, 3]), header, ['secret'])).toBe(false);
  });

  it('rejects unconfigured secrets even if an attacker signs with the empty key', () => {
    const raw = new Uint8Array([0, 255, 128]);
    const header = `v1=${createHmac('sha256', '').update(raw).digest('hex')}`;
    expect(verifyLoopWebhookSignature(raw, header, [''])).toBe(false);
    expect(verifyLoopWebhookSignature(raw, header, [])).toBe(false);
  });
});
