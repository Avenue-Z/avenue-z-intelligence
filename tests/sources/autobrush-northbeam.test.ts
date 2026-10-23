import {afterEach, describe, expect, expectTypeOf, it, vi} from 'vitest';
import {
  createNorthbeamExport, discoverNorthbeamOptions, readNorthbeamExport,
  type NorthbeamExportJob, type NorthbeamExportRequest,
} from '../../lib/sources/autobrush-northbeam';

const config = {apiKey: 'private-northbeam-api-key', dataClientId: 'autobrush-account'};
const identity = {clientId: 'autobrush', dataClientId: 'autobrush-account'} as const;
const exportId = '3c90c3cc-0d44-4b50-8888-8dd25736052a';
const base = 'https://api.northbeam.io/v1/exports';
const privateUrl = 'https://storage.example.test/export.csv?signature=private-download-secret';
const discovery = {
  '/metrics': {metrics: [{id: 'rev', label: 'Revenue'}, {id: 'spend', label: null}]},
  '/attribution-models': {attribution_models: [{id: 'northbeam_custom', name: 'Clicks only'}]},
  '/breakdowns': {breakdowns: [{key: 'Platform (Northbeam)', values: ['Facebook Ads', 'Google Ads']}]},
};
function request(): NorthbeamExportRequest {
  return {
    level: 'ad', time_granularity: 'HOURLY', period_type: 'FIXED',
    period_options: {period_starting_at: '2026-10-18T00:00:00Z', period_ending_at: '2026-10-19T00:00:00Z'},
    attribution_options: {attribution_models: ['northbeam_custom'], attribution_windows: ['7'], accounting_modes: ['cash']},
    metrics: [{id: 'rev', label: 'attributed_revenue'}, {id: 'spend'}],
    breakdowns: [{key: 'Platform (Northbeam)', values: ['Facebook Ads']}],
    options: {export_aggregation: 'DATE', remove_zero_spend: false, aggregate_data: false, include_ids: true, include_kind_and_platform: true},
  };
}
function job(): NorthbeamExportJob { return {exportId, identity, request: request()}; }
function result(status = 'SUCCESS', changes: Record<string, unknown> = {}) {
  return {data_export_id: exportId, status, result: status === 'SUCCESS' ? [privateUrl] : [],
    created_at: '2026-10-20T13:00:00Z', finished_at: status === 'PENDING' ? null : '2026-10-20T13:01:00Z', ...changes};
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
function fixture(responder?: (path: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: {url: string; init: RequestInit}[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input), path = url.slice(base.length);
    calls.push({url, init: init ?? {}});
    if (responder) return responder(path, init ?? {});
    if (path in discovery) return json(discovery[path as keyof typeof discovery]);
    if (path === '/data-export') return json({id: exportId}, 201);
    if (path === `/data-export/result/${exportId}`) return json(result());
    throw new Error('Unexpected test endpoint');
  };
  return {fetcher, calls};
}
afterEach(() => vi.restoreAllMocks());

describe('Northbeam account discovery', () => {
  it('uses documented account discovery routes and raw API-key authorization', async () => {
    const {fetcher, calls} = fixture();
    const options = await discoverNorthbeamOptions(config, identity, fetcher);
    expect(options).toEqual({identity, metrics: discovery['/metrics'].metrics,
      attributionModels: discovery['/attribution-models'].attribution_models, breakdowns: discovery['/breakdowns'].breakdowns});
    expect(calls.map(call => call.url).sort()).toEqual([`${base}/attribution-models`, `${base}/breakdowns`, `${base}/metrics`]);
    for (const call of calls) {
      expect(call.init.method).toBe('GET');
      expect(new Headers(call.init.headers).get('Authorization')).toBe('private-northbeam-api-key');
      expect(new Headers(call.init.headers).get('Data-Client-ID')).toBe('autobrush-account');
      expect(call.init.redirect).toBe('error');
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(Object.isFrozen(options.breakdowns[0].values)).toBe(true);
  });

  it.each([
    ['/metrics', {metrics: [{id: 'rev', label: 'Revenue'}, {id: 'rev', label: 'Different revenue'}]}],
    ['/metrics', {data: [{id: 'rev'}]}],
    ['/attribution-models', {attribution_models: [{id: ''}]}],
    ['/attribution-models', {attribution_models: ['northbeam_custom']}],
    ['/breakdowns', {breakdowns: [{key: 'Platform', values: 'Meta'}]}],
    ['/breakdowns', {breakdowns: [{key: 'Platform', values: ['Meta', 'Meta']}]}],
  ])('rejects malformed or ambiguous discovery at %s', async (target, body) => {
    const {fetcher} = fixture(path => json(path === target ? body : discovery[path as keyof typeof discovery]));
    await expect(discoverNorthbeamOptions(config, identity, fetcher)).rejects.toThrow(/Northbeam.*discovery/);
  });

  it.each([undefined, null, 'Revenue'])('accepts identical repeated provider metric definitions with label %s', async label => {
    const repeated = {id: 'rev', ...(label === undefined ? {} : {label})};
    const {fetcher} = fixture(path => json(path === '/metrics'
      ? {metrics: [repeated, {id: 'spend', label: null}, {...repeated}]}
      : discovery[path as keyof typeof discovery]));
    const options = await discoverNorthbeamOptions(config, identity, fetcher);
    expect(options.metrics).toEqual([repeated, {id: 'spend', label: null}]);
    expect(Object.isFrozen(options.metrics)).toBe(true);
  });

  it('preserves the provider empty-string breakdown label as a selectable value', async () => {
    const {fetcher, calls} = fixture(path => {
      if (path === '/breakdowns') return json({breakdowns: [{key: 'Platform (Northbeam)', values: ['', 'Facebook Ads']}]});
      if (path === '/data-export') return json({id: exportId}, 201);
      return json(discovery[path as keyof typeof discovery]);
    });
    const options = await discoverNorthbeamOptions(config, identity, fetcher);
    expect(options.breakdowns[0].values).toEqual(['', 'Facebook Ads']);
    const created = await createNorthbeamExport(config, identity, options, {...request(), breakdowns: [{key: 'Platform (Northbeam)', values: ['']}]}, fetcher);
    expect(created.request.breakdowns[0].values).toEqual(['']);
    const posted = calls.find(call => call.init.method === 'POST')!;
    expect(JSON.parse(String(posted.init.body)).breakdowns[0].values).toEqual(['']);
  });

  it('rejects a configured account that differs from the expected account before any request', async () => {
    const {fetcher, calls} = fixture();
    await expect(discoverNorthbeamOptions({...config, dataClientId: 'another-account'}, identity, fetcher)).rejects.toThrow(/identity/);
    expect(calls).toHaveLength(0);
  });
});

describe('Northbeam export creation', () => {
  it('restricts accounting modes and attribution windows in the public request type', () => {
    expectTypeOf<NorthbeamExportRequest['attribution_options']['accounting_modes'][number]>().toEqualTypeOf<'cash' | 'accrual'>();
    expectTypeOf<NorthbeamExportRequest['attribution_options']['attribution_windows'][number]>().toEqualTypeOf<'1' | '3' | '7' | '14' | '30' | '60' | '90'>();
  });

  it('pins the complete validated request and returns a resumable account-scoped export ID', async () => {
    const {fetcher, calls} = fixture(), options = await discoverNorthbeamOptions(config, identity, fetcher);
    const input = request(), created = await createNorthbeamExport(config, identity, options, input, fetcher);
    expect(created).toEqual({exportId, identity, request: input});
    const posted = calls.find(call => call.init.method === 'POST')!;
    expect(posted.url).toBe(`${base}/data-export`);
    expect(JSON.parse(String(posted.init.body))).toEqual(request());
    expect(new Headers(posted.init.headers).get('Content-Type')).toBe('application/json');
    expect(Object.isFrozen(created.request.attribution_options.accounting_modes)).toBe(true);
    expect(Object.isFrozen(created.identity)).toBe(true);
    expect(created.request).not.toBe(input);
    expect(JSON.stringify(created)).not.toContain(config.apiKey);
  });

  it.each([
    {metrics: [{id: 'undiscovered'}]},
    {attribution_options: {attribution_models: ['last_touch'], attribution_windows: ['7'], accounting_modes: ['cash']}},
    {breakdowns: [{key: 'Undiscovered', values: []}]},
    {breakdowns: [{key: 'Platform (Northbeam)', values: ['TikTok']}]},
    {breakdowns: [{key: 'Platform (Northbeam)', values: ['']}]},
  ])('rejects selections absent from account discovery: %j', async changes => {
    const {fetcher, calls} = fixture(), options = await discoverNorthbeamOptions(config, identity, fetcher);
    await expect(createNorthbeamExport(config, identity, options, {...request(), ...changes} as NorthbeamExportRequest, fetcher)).rejects.toThrow(/discovered/);
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(0);
  });

  it.each([
    {level: 'customer'}, {time_granularity: 'MINUTELY'}, {period_type: 'LAST_2_DAYS'},
    {period_options: undefined},
    {period_options: {period_starting_at: '2026-10-19T00:00:00Z', period_ending_at: '2026-10-18T00:00:00Z'}},
    {period_options: {period_starting_at: '2023-10-18T00:00:00Z', period_ending_at: '2026-10-18T00:00:00Z'}},
    {attribution_options: {attribution_models: ['northbeam_custom'], attribution_windows: ['2'], accounting_modes: ['cash']}},
    {attribution_options: {attribution_models: ['northbeam_custom'], attribution_windows: ['7'], accounting_modes: ['hybrid']}},
    {attribution_options: {attribution_models: [], attribution_windows: ['7'], accounting_modes: ['cash']}},
    {metrics: [{id: 'rev', label: 'Revenue ($)'}]}, {metrics: [{id: 'rev'}, {id: 'rev'}]},
    {options: {export_aggregation: 'WEEK'}}, {bucket_name: 'unexpected-write-target'},
  ])('rejects invalid or unsupported request values before POST: %j', async changes => {
    const {fetcher, calls} = fixture(), options = await discoverNorthbeamOptions(config, identity, fetcher);
    await expect(createNorthbeamExport(config, identity, options, {...request(), ...changes} as NorthbeamExportRequest, fetcher)).rejects.toThrow(/request/);
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(0);
  });

  it('rejects discovery saved for a different account', async () => {
    const {fetcher, calls} = fixture(), options = await discoverNorthbeamOptions(config, identity, fetcher);
    await expect(createNorthbeamExport(config, identity, {...options, identity: {...identity, dataClientId: 'another'}}, request(), fetcher)).rejects.toThrow(/identity/);
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(0);
  });

  it('snapshots provenance before awaiting the provider', async () => {
    let finish!: (response: Response) => void;
    const normal = fixture(), options = await discoverNorthbeamOptions(config, identity, normal.fetcher);
    const {fetcher} = fixture(() => new Promise(resolve => { finish = resolve; }));
    const input = request(), pending = createNorthbeamExport(config, identity, options, input, fetcher);
    (input.metrics as {id: string}[])[0].id = 'spend';
    finish(json({id: exportId}, 201));
    expect((await pending).request.metrics[0].id).toBe('rev');
  });

  it.each(['transport', 'timeout', 'rate-limit', 'invalid-json', 'invalid-id'])('never replays an ambiguous creation after %s', async failure => {
    const normal = fixture(), options = await discoverNorthbeamOptions(config, identity, normal.fetcher);
    const {fetcher, calls} = fixture(() => {
      if (failure === 'transport') throw new Error(`${config.apiKey} ${privateUrl}`);
      if (failure === 'timeout') return new Promise(() => {});
      if (failure === 'rate-limit') return json({error: privateUrl}, 429);
      if (failure === 'invalid-json') return new Response(privateUrl, {status: 201});
      return json({id: privateUrl}, 201);
    });
    const error = await createNorthbeamExport(config, identity, options, request(), fetcher, Date.now() + 20).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(config.apiKey);
    expect(String(error)).not.toContain(privateUrl);
    expect(calls).toHaveLength(1);
  });
});

describe('Northbeam resumable result reads', () => {
  it.each(['PENDING', 'ERROR'])('keeps %s distinct from success without returning private result files', async status => {
    const {fetcher, calls} = fixture(() => json(result(status, {result: [privateUrl]})));
    const response = await readNorthbeamExport(config, identity, job(), fetcher);
    expect(response).toMatchObject({exportId, identity, request: request(), status});
    expect(response).not.toHaveProperty('files');
    expect(JSON.stringify(response)).not.toContain(privateUrl);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${base}/data-export/result/${exportId}`);
    expect(calls[0].init.method).toBe('GET');
  });

  it('returns all success file links server-side without inferring source coverage from completion', async () => {
    const secondUrl = 'https://storage.example.test/export-2.csv?signature=second-secret';
    const {fetcher, calls} = fixture(() => json(result('SUCCESS', {result: [privateUrl, secondUrl], warn: {url: privateUrl}})));
    const response = await readNorthbeamExport(config, identity, job(), fetcher);
    expect(response).toEqual({exportId, identity, request: request(), status: 'SUCCESS', files: [privateUrl, secondUrl],
      createdAt: '2026-10-20T13:00:00Z', finishedAt: '2026-10-20T13:01:00Z'});
    expect(response).not.toHaveProperty('coverageThrough');
    expect(calls).toHaveLength(1);
    if (response.status === 'SUCCESS') expect(Object.isFrozen(response.files)).toBe(true);
  });

  it.each([
    {data_export_id: '63b57a62-4edb-4d6c-ac62-21733b13e5eb'}, {status: 'DONE'}, {result: []},
    {result: [privateUrl, 23]}, {result: ['javascript:alert(1)']}, {finished_at: null},
    {created_at: 'invalid'}, {finished_at: '2026-10-20T12:59:00Z'},
  ])('rejects malformed or wrong-job success results: %j', async changes => {
    const {fetcher} = fixture(() => json(result('SUCCESS', changes)));
    const error = await readNorthbeamExport(config, identity, job(), fetcher).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(privateUrl);
  });

  it('rejects a resumed job belonging to another account before requesting results', async () => {
    const {fetcher, calls} = fixture();
    await expect(readNorthbeamExport(config, identity, {...job(), identity: {...identity, dataClientId: 'another'}}, fetcher)).rejects.toThrow(/identity/);
    expect(calls).toHaveLength(0);
  });
});

describe('Northbeam request safety', () => {
  it.each(['content-length', 'stream'])('rejects oversized provider payloads by %s without exposing the body', async kind => {
    const {fetcher} = fixture(() => kind === 'content-length'
      ? new Response(privateUrl, {headers: {'Content-Length': '6000001'}})
      : new Response(new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(6000001)); controller.close();}})));
    const error = await readNorthbeamExport(config, identity, job(), fetcher).catch(error => error);
    expect(String(error)).toContain('exceeds 6 MB');
    expect(String(error)).not.toContain(privateUrl);
  });

  it('fails before network access when the request deadline is spent', async () => {
    const {fetcher, calls} = fixture();
    await expect(readNorthbeamExport(config, identity, job(), fetcher, Date.now() - 1)).rejects.toThrow(/deadline/);
    expect(calls).toHaveLength(0);
  });

  it('bounds response-body reading by the same deadline', async () => {
    const {fetcher} = fixture(() => new Response(new ReadableStream({start() {}})));
    await expect(readNorthbeamExport(config, identity, job(), fetcher, Date.now() + 20)).rejects.toThrow(/deadline/);
  });

  it.each([401, 403, 422, 429, 500, 302])('returns only safe diagnostics for HTTP %i', async status => {
    const errorLog = vi.spyOn(console, 'error'), warningLog = vi.spyOn(console, 'warn');
    const {fetcher} = fixture(() => json({error: `${config.apiKey} ${privateUrl}`}, status));
    const error = await readNorthbeamExport(config, identity, job(), fetcher).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(`HTTP ${status}`);
    expect(String(error)).not.toContain(config.apiKey);
    expect(String(error)).not.toContain(privateUrl);
    expect(errorLog).not.toHaveBeenCalled();
    expect(warningLog).not.toHaveBeenCalled();
  });
});
