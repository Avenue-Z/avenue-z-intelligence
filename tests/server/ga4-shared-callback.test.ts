import {beforeEach, afterEach, expect, it, vi} from 'vitest';
import type {AccessScope} from '../../lib/analytics/contracts';
import {createGa4ConnectionHandlers} from '../../lib/server/ga4-connection';
import {createAutobrushGa4ConnectionHandlers} from '../../lib/server/autobrush-ga4-connection';
import {readProviderCredential} from '../../lib/server/provider-credentials';

vi.mock('@/lib/server/access', () => ({scopeForUser: async () => scope, getStore: () => store}));
vi.mock('@/lib/server/secrets', () => ({serverSecret: (key: string) => env[key] ?? null}));
vi.mock('@/lib/server/ga4-connection', async () => import('../../lib/server/ga4-connection'));
vi.mock('@/lib/server/autobrush-ga4-connection', async () => import('../../lib/server/autobrush-ga4-connection'));

const origin = 'https://app.example', shared = '/api/integrations/ga4/beam/callback';
const scope: AccessScope = {organizationId: 'avenue-z', actorId: 'google:admin', role: 'admin', permittedClientIds: ['beam']};
const env: Record<string, string> = {
  AUTH_URL: origin, AUTH_SECRET: 'private-company-test-secret-at-least-32-characters',
  SOURCE_BEAM_GA4: JSON.stringify({clientId: 'company.apps.googleusercontent.com', clientSecret: 'private-test-app-secret', propertyId: '292550743'}),
  SOURCE_AUTOBRUSH_GA4: JSON.stringify({propertyId: '274489308', oauthClientConfig: 'SOURCE_BEAM_GA4'}),
};
let rows: Map<string, string>, writes: string[][];
let store: {first: <T = unknown>(sql: string, ...args: unknown[]) => Promise<T | null>; run: (sql: string, ...args: unknown[]) => Promise<{meta: {changes: number}}>};
let exchanges: URLSearchParams[];
beforeEach(() => {
  rows = new Map(); writes = []; exchanges = [];
  store = {
    first: async <T,>(_sql: string, ...args: unknown[]): Promise<T | null> => {const payload = rows.get(JSON.stringify(args)); return payload ? {payload} as T : null;},
    run: async (_sql, ...args) => {writes.push(args.slice(0, 3) as string[]); rows.set(JSON.stringify(args.slice(0, 3)), String(args[3])); return {meta: {changes: 1}};},
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(url).toBe('https://oauth2.googleapis.com/token');
    exchanges.push(new URLSearchParams(init.body as URLSearchParams));
    return Response.json({access_token: 'private-test-access', refresh_token: 'private-test-refresh', expires_in: 3600, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/analytics.readonly'});
  });
});
afterEach(() => vi.unstubAllGlobals());
async function start(client: 'beam' | 'autobrush') {
  const deps = {scope: async () => scope, store: () => store, secret: (key: string) => env[key] ?? null};
  const handlers = client === 'beam' ? createGa4ConnectionHandlers(deps) : createAutobrushGa4ConnectionHandlers(deps);
  const response = await handlers.connect(new Request(`${origin}/api/integrations/ga4/${client}/connect`));
  const target = new URL(response.headers.get('location')!);
  return {state: target.searchParams.get('state')!, cookie: response.headers.get('set-cookie')!.split(';')[0]};
}
function callback(state: string, cookie: string) {
  return new Request(`${origin}${shared}?${new URLSearchParams({state, code: 'one-use-code', iss: 'https://accounts.google.com'})}`, {headers: {cookie}});
}

it('saves a fresh Autobrush authorization through the registered company callback without changing Beam', async () => {
  const {GET} = await import('../../app/api/integrations/ga4/beam/callback/route');
  const flow = await start('autobrush');
  const response = await GET(callback(flow.state, flow.cookie));
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe(`${origin}/api/integrations/ga4/autobrush/status`);
  expect(writes).toEqual([['avenue-z', 'autobrush', 'ga4']]);
  expect(exchanges).toHaveLength(1);
  expect(exchanges[0].get('redirect_uri')).toBe(`${origin}${shared}`);
  expect(await readProviderCredential(store, {organizationId: 'avenue-z', clientId: 'autobrush', provider: 'ga4'}, env.AUTH_SECRET)).toMatchObject({propertyId: '274489308'});
  expect(await readProviderCredential(store, {organizationId: 'avenue-z', clientId: 'beam', provider: 'ga4'}, env.AUTH_SECRET)).toBeNull();
});

it('preserves the existing Beam authorization and property on the shared callback', async () => {
  const {GET} = await import('../../app/api/integrations/ga4/beam/callback/route');
  const flow = await start('beam');
  const response = await GET(callback(flow.state, flow.cookie));
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe(`${origin}/clients/beam`);
  expect(writes).toEqual([['avenue-z', 'beam', 'ga4']]);
  expect(await readProviderCredential(store, {organizationId: 'avenue-z', clientId: 'beam', provider: 'ga4'}, env.AUTH_SECRET)).toMatchObject({propertyId: '292550743'});
});

it('rejects cross-brand cookie substitution, forged routing prefixes and duplicate state before any token exchange', async () => {
  const {GET} = await import('../../app/api/integrations/ga4/beam/callback/route');
  const beam = await start('beam'), autobrush = await start('autobrush');
  const requests = [
    callback(autobrush.state, beam.cookie), callback(beam.state, autobrush.cookie),
    callback(`az_autobrush_ga4_v1.${beam.state}`, beam.cookie),
    new Request(`${callback(autobrush.state, '').url}&state=${encodeURIComponent(beam.state)}`, {headers: {cookie: `${beam.cookie}; ${autobrush.cookie}`}}),
    new Request(`${callback(beam.state, '').url}&state=${encodeURIComponent(autobrush.state)}`, {headers: {cookie: `${beam.cookie}; ${autobrush.cookie}`}}),
  ];
  for (const request of requests) expect((await GET(request)).status).toBe(400);
  expect(exchanges).toHaveLength(0); expect(writes).toHaveLength(0);
});
