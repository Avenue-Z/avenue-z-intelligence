import {describe, expect, it, vi} from 'vitest';
import type {Client, SourceBatch} from '../../lib/analytics/contracts';
import {
  AUTOBRUSH_INTELLIGEMS_ORGANIZATION,
  autobrushIntelligemsConfiguration,
  autobrushIntelligemsQualification,
  fetchAutobrushIntelligemsSource,
} from '../../lib/sources/autobrush-intelligems';
import {validateRegisteredBatch} from '../../lib/sources/registered-contract';

const client = {id: 'autobrush', timezone: 'America/New_York', currency: 'USD'} as Client;
const connection = {id: 'autobrush-intelligems', clientId: 'autobrush'};
const now = new Date('2026-10-22T18:37:42Z');
const eid = 'a4f0e288-a668-488a-bb92-9cfb10ed08fc';
const control = '9e361491-af09-43f9-9cae-61ae52ae494c';
const treatment = '5111d163-0af7-4536-9b10-2dd75f416415';
type Experiment = {id: string; name: string; category: string; status: string; startedAtTs: number | null;
  endedAtTs: number | null; pausedAtTs: number | null; isDeleted: boolean; organizationId: string};
const experiment: Experiment = {
  id: eid, name: 'Checkout timer', category: 'experiment', status: 'started',
  startedAtTs: Date.parse('2026-10-18T12:00:00Z'), endedAtTs: null, pausedAtTs: null,
  isDeleted: false, organizationId: AUTOBRUSH_INTELLIGEMS_ORGANIZATION,
};
function overview(experienceId = eid) {
  return {
    datasetId: 'variation_overview', latestRunTs: 0, experienceId,
    cogsConfigured: false, cogsCoveragePct: 0, audienceOrder: [], histogram: [], kde: [], cdf: [],
    variations: [
      {id: control, experienceId, name: 'No Timer', isControl: true},
      {id: treatment, experienceId, name: 'With Timer', isControl: false},
    ],
    metrics: [
      {variation_id: control, n_visitors: {value: 100}, n_orders: {value: 10},
        net_revenue: {value: 10000}, conversion_rate: {value: .1, ci_low: .05, ci_high: .15, p2bb: .3, p2bc: .5}},
      {variation_id: treatment, n_visitors: {value: 100}, n_orders: {value: 12},
        net_revenue: {value: 12000}, conversion_rate: {value: .12, ci_low: .06, ci_high: .18, p2bb: .7, p2bc: .7,
          uplift: {value: .2, ci_low: -.2, ci_high: .6}}},
    ],
    impact: {est_monthly_revenue_increase: 100}, testResult: {verdict: 'strong_win'},
  };
}
function catalog(experiencesList: Experiment[] = [experiment], page = 1, total = experiencesList.length, totalPages = Math.ceil(total / 20)) {
  return {experiencesList, page, limit: 20, total, totalPages};
}
const response = (body: unknown) => new Response(JSON.stringify(body), {status: 200});
function fetcher(data: unknown = overview(), list: unknown = catalog()) {
  return vi.fn().mockResolvedValueOnce(response(list)).mockResolvedValueOnce(response(data)) as ReturnType<typeof vi.fn> & typeof fetch;
}
function read(f: typeof fetch, window = {from: '2026-10-21', to: '2026-10-21'}, at = now) {
  return fetchAutobrushIntelligemsSource(connection, client, window, 'private-key', f, Date.now() + 10000, at);
}
function analysisBody(f: ReturnType<typeof fetcher>, call = 1) {
  return JSON.parse(f.mock.calls[call][1].body);
}

describe('Autobrush Intelligems experiment reporting', () => {
  it('requests all countries and all products with the verified POST overview scope', async () => {
    const f = fetcher(), batch = await read(f);
    expect(f.mock.calls[1][0]).toBe(`https://api.intelligems.io/v25-10-beta/analytics/resource/${eid}`);
    expect(f.mock.calls[1][1]).toMatchObject({method: 'POST', headers: {'intelligems-access-token': 'private-key'}});
    expect(analysisBody(f)).toEqual({view: 'overview', startTs: '1792555200', endTs: '1792641600',
      analyticsViewType: 'sitewide_orders', filters: {experimentProductsOnly: false, maxZScore: 3}});
    expect(batch.rows.every(row => row.dimensions.market === 'All')).toBe(true);
    expect(batch.rows[0].population).toBe('intelligems_exposed_experiment_visitors');
    expect(validateRegisteredBatch(batch, autobrushIntelligemsQualification(batch))).toEqual(batch);
  });

  it('preserves counts, conversion intervals and treatment probabilities without money or a win verdict', async () => {
    const batch = await read(fetcher());
    expect(batch.rows.find(row => row.metric === 'conversion_rate_lift_ci_low')).toMatchObject({value: -.2,
      dimensions: {experiment_id: eid, variant_id: treatment, status: 'started', is_control: 'false'}});
    expect(batch.rows.filter(row => row.dimensions.variant_id === treatment).map(row => [row.metric, row.value])).toEqual([
      ['visitors', 100], ['orders', 12], ['conversion_rate', .12], ['conversion_rate_ci_low', .06],
      ['conversion_rate_ci_high', .18], ['conversion_rate_probability_best', .7],
      ['conversion_rate_probability_to_beat_control', .7], ['conversion_rate_lift', .2],
      ['conversion_rate_lift_ci_low', -.2], ['conversion_rate_lift_ci_high', .6],
    ]);
    expect(batch.rows.some(row => /revenue|profit|verdict|winner/.test(row.metric) || row.currency !== null)).toBe(false);
    expect(batch.rows.filter(row => row.dimensions.is_control === 'true').some(row => row.metric.includes('lift') || row.metric.includes('beat_control'))).toBe(false);
    expect(batch).toMatchObject({clientId: 'autobrush', timezone: 'America/New_York', currency: 'USD',
      grain: 'daily', complete: true, coverageThrough: null, nextCursor: null});
    expect(batch.rows.every(row => row.coverageThrough === null && row.quality === 'complete' && !row.start && !row.end)).toBe(true);
    expect(autobrushIntelligemsQualification(batch).hourlyGrain).toBe(false);
  });

  it('does not invent zero observations for absent or null outcomes', async () => {
    const data = overview();
    data.metrics = [{variation_id: control}, {variation_id: treatment}] as typeof data.metrics;
    const batch = await read(fetcher(data));
    expect(batch.rows).toEqual([]);
    expect(batch.coverageThrough).toBeNull();
  });

  it('returns no invented experiments for a complete empty catalog', async () => {
    const f = fetcher(undefined, catalog([])), batch = await read(f);
    expect(batch.rows).toEqual([]);
    expect(batch.complete).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect(autobrushIntelligemsQualification(batch).profiles.length).toBeGreaterThan(0);
  });

  it('reads all seven catalog pages and includes only experiments overlapping the selected day', async () => {
    const experiments: Experiment[] = Array.from({length: 126}, (_, index) => ({...experiment,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      status: 'ended', endedAtTs: Date.parse('2026-10-19T00:00:00Z')}));
    experiments[125] = {...experiment, id: experiments[125].id, status: 'started'};
    const f = vi.fn(async (url: string) => {
      if (url.includes('/experiences-list?')) {
        const page = Number(new URL(url).searchParams.get('page'));
        return response(catalog(experiments.slice((page - 1) * 20, page * 20), page, 126, 7));
      }
      if (url.endsWith(experiments[125].id)) return response(overview(experiments[125].id));
      throw Error('Unexpected experiment analysis');
    }) as ReturnType<typeof vi.fn> & typeof fetch;
    const batch = await read(f);
    expect(batch.rows.filter(row => row.metric === 'visitors').map(row => row.value)).toEqual([100, 100]);
    expect(new Set(batch.rows.map(row => row.dimensions.experiment_id))).toEqual(new Set([experiments[125].id]));
    expect(f).toHaveBeenCalledTimes(8);
    expect(f.mock.calls[6][0]).toContain('page=7');
  });

  it.each(['wrong-org', 'duplicate-id', 'changed-total', 'wrong-page', 'omitted-final-row', 'cursor'])('rejects %s in the catalog', async reason => {
    const experiments = Array.from({length: 21}, (_, index) => ({...experiment,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`}));
    const first = catalog(experiments.slice(0, 20), 1, 21, 2);
    const second = catalog(experiments.slice(20), 2, 21, 2);
    if (reason === 'wrong-org') first.experiencesList[0].organizationId = 'd6ad5167-0729-4e0f-8269-4d8c0a390dbd';
    if (reason === 'duplicate-id') second.experiencesList[0] = first.experiencesList[0];
    if (reason === 'changed-total') second.total = 22;
    if (reason === 'wrong-page') second.page = 1;
    if (reason === 'omitted-final-row') second.experiencesList = [];
    if (reason === 'cursor') Object.assign(second, {nextCursor: 'unread-page'});
    const f = vi.fn().mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response(second));
    await expect(read(f)).rejects.toThrow(/Intelligems/);
  });

  it.each(['wrong-experiment', 'cursor', 'more-pages', 'wrong-dataset', 'duplicate-variant', 'duplicate-row', 'missing-variation', 'empty-metrics', 'missing-control', 'wrong-variant-experiment', 'segmented-row'])('rejects %s in an overview', async reason => {
    const data = overview();
    if (reason === 'wrong-experiment') data.experienceId = '00000000-0000-4000-8000-000000000001';
    if (reason === 'cursor') Object.assign(data, {nextCursor: 'unread-metrics'});
    if (reason === 'more-pages') Object.assign(data, {hasNextPage: true});
    if (reason === 'wrong-dataset') data.datasetId = 'audience_overview';
    if (reason === 'duplicate-variant') data.variations[1].id = control;
    if (reason === 'duplicate-row') data.metrics[1].variation_id = control;
    if (reason === 'missing-variation') data.metrics.pop();
    if (reason === 'empty-metrics') data.metrics = [];
    if (reason === 'missing-control') data.variations[0].isControl = false;
    if (reason === 'wrong-variant-experiment') data.variations[1].experienceId = '00000000-0000-4000-8000-000000000001';
    if (reason === 'segmented-row') Object.assign(data.metrics[1], {audience: 'new'});
    await expect(read(fetcher(data))).rejects.toThrow(/Intelligems/);
  });

  it.each(['negative-count', 'fractional-count', 'invalid-probability', 'inverted-interval', 'missing-interval-bound', 'invalid-lift'])('rejects %s statistics', async reason => {
    const data = overview();
    if (reason === 'negative-count') data.metrics[0].n_visitors.value = -1;
    if (reason === 'fractional-count') data.metrics[0].n_orders.value = 1.5;
    if (reason === 'invalid-probability') data.metrics[1].conversion_rate.p2bc = 1.1;
    if (reason === 'inverted-interval') data.metrics[1].conversion_rate.ci_low = .9;
    if (reason === 'missing-interval-bound') delete (data.metrics[1].conversion_rate as {ci_high?: number}).ci_high;
    if (reason === 'invalid-lift') Object.assign(data.metrics[1].conversion_rate.uplift!, {value: 'NaN'});
    await expect(read(fetcher(data))).rejects.toThrow(/Intelligems/);
  });

  it('uses exact New York day overlap boundaries for ended, paused, pending and deleted experiments', async () => {
    const examples = [
      {...experiment, status: 'ended', endedAtTs: Date.parse('2026-10-21T04:00:00Z')},
      {...experiment, status: 'paused', pausedAtTs: Date.parse('2026-10-21T04:00:00Z')},
      {...experiment, status: 'started', startedAtTs: Date.parse('2026-10-22T04:00:00Z')},
      {...experiment, status: 'pending', startedAtTs: null},
      {...experiment, isDeleted: true},
      {...experiment, status: 'ended', endedAtTs: Date.parse('2026-10-21T04:00:01Z')},
    ].map((ex, index) => ({...ex, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`})) as Experiment[];
    const f = fetcher(overview(examples[5].id), catalog(examples));
    const batch = await read(f);
    expect(f).toHaveBeenCalledTimes(2);
    expect(new Set(batch.rows.map(row => row.dimensions.experiment_id))).toEqual(new Set([examples[5].id]));
  });

  it('requests the 25-hour New York DST day and caps today at the supplied current instant', async () => {
    const f = fetcher(), later = new Date('2026-11-03T17:00:00Z');
    await read(f, {from: '2026-11-01', to: '2026-11-01'}, later);
    expect(analysisBody(f)).toMatchObject({startTs: '1793505600', endTs: '1793595600'});
    const current = fetcher(), batch = await read(current, {from: '2026-10-22', to: '2026-10-22'});
    expect(analysisBody(current)).toMatchObject({startTs: '1792641600', endTs: '1792694262'});
    expect(batch.rows.every(row => row.quality === 'partial' && row.coverageThrough === null)).toBe(true);
  });

  it.each(['client', 'connection', 'timezone', 'currency'])('rejects a changed %s identity before requesting data', async part => {
    const f = fetcher(), c = {...client}, source = {...connection};
    if (part === 'client') c.id = 'beam';
    if (part === 'connection') source.clientId = 'beam';
    if (part === 'timezone') c.timezone = 'America/Los_Angeles';
    if (part === 'currency') c.currency = 'CAD';
    await expect(fetchAutobrushIntelligemsSource(source, c, {from: '2026-10-21', to: '2026-10-21'}, 'private-key', f)).rejects.toThrow(/identity/);
    expect(f).not.toHaveBeenCalled();
  });

  it.each([{from: '2026-10-23', to: '2026-10-23'}, {from: '2026-10-22', to: '2026-10-21'},
    {from: '2026-02-30', to: '2026-02-30'}, {from: '2026-10-1', to: '2026-10-21'}])('rejects invalid source window %j', async window => {
    const f = fetcher();
    await expect(read(f, window)).rejects.toThrow(/Intelligems.*window/);
    expect(f).not.toHaveBeenCalled();
  });

  it('rejects malformed lifecycle dates rather than silently omitting experiments', async () => {
    const ex = {...experiment, startedAtTs: '1790000000'} as unknown as Experiment;
    await expect(read(fetcher(undefined, catalog([ex])))).rejects.toThrow(/Intelligems/);
  });

  it('pins configuration to the Autobrush organization and rejects unusable credentials', async () => {
    expect(autobrushIntelligemsConfiguration.parse({apiKey: 'private-key'}).organizationId).toBe(AUTOBRUSH_INTELLIGEMS_ORGANIZATION);
    expect(() => autobrushIntelligemsConfiguration.parse({apiKey: 'private-key', organizationId: 'd6ad5167-0729-4e0f-8269-4d8c0a390dbd'})).toThrow();
    for (const key of ['', '   ', 'private-key\r\nother-header']) {
      const f = fetcher();
      await expect(fetchAutobrushIntelligemsSource(connection, client, {from: '2026-10-21', to: '2026-10-21'}, key, f, Date.now() + 10000, now)).rejects.toThrow(/credential/);
      expect(f).not.toHaveBeenCalled();
    }
  });

  it('keeps provider rejection bodies and credentials out of errors', async () => {
    const f = vi.fn().mockResolvedValue(new Response('private-key private provider response', {status: 401}));
    await expect(read(f)).rejects.toThrow('Provider returned HTTP 401');
  });

  it('will not qualify incomplete reporting or another client/store identity', async () => {
    const batch = await read(fetcher());
    for (const patch of [{clientId: 'beam'}, {timezone: 'America/Los_Angeles'}, {currency: 'CAD'},
      {complete: false}, {grain: 'hourly'}, {nextCursor: 'more'}]) {
      expect(() => autobrushIntelligemsQualification({...batch, ...patch} as SourceBatch)).toThrow(/Intelligems/);
    }
  });
});
