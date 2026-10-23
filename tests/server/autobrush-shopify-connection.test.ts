import {createHmac} from 'node:crypto';
import {beforeEach, expect, it, vi} from 'vitest';
import type {AccessScope} from '../../lib/analytics/contracts';
import {createAutobrushShopifyConnectionHandlers} from '../../lib/server/autobrush-shopify-connection';
import {readProviderCredential, saveProviderCredential} from '../../lib/server/provider-credentials';
import {createShopifyConnectionHandlers} from '../../lib/server/shopify-connection';

const origin = 'https://app.example', prefix = '/api/integrations/shopify/autobrush';
const now = Date.parse('2026-10-21T16:00:00Z');
const shop = 'ama-brushh.myshopify.com', clientId = 'autobrush-app-id', clientSecret = 'private-autobrush-shopify-app-secret';
const authSecret = 'private-company-auth-secret-at-least-32-characters';
const env: Record<string, string> = {AUTH_URL: origin, AUTH_SECRET: authSecret, AUTOBRUSH_SHOPIFY_CLIENT_ID: clientId, AUTOBRUSH_SHOPIFY_CLIENT_SECRET: clientSecret};
const admin: AccessScope = {organizationId: 'avenue-z', actorId: 'google:admin', role: 'admin', permittedClientIds: ['beam']};
const credentialIdentity = {organizationId: 'avenue-z', clientId: 'autobrush', provider: 'shopify'};
let scope: AccessScope | null, rows: Map<string, string>;
let store: {first: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>}, fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  scope = {...admin}; rows = new Map();
  store = {
    first: vi.fn(async (_sql: string, ...args: unknown[]) => {const payload = rows.get(JSON.stringify(args)); return payload ? {payload} : null;}),
    run: vi.fn(async (_sql: string, ...args: unknown[]) => {rows.set(JSON.stringify(args.slice(0, 3)), String(args[3])); return {meta: {changes: 1}};}),
  };
  fetcher = vi.fn(async () => Response.json({access_token: 'private-autobrush-offline-token', scope: 'read_reports,read_orders,read_products'}));
});
const handlers = (changes: Partial<Record<string, string>> = {}, time = now) => createAutobrushShopifyConnectionHandlers({scope: async () => scope, store: () => store, secret: key => ({...env, ...changes})[key] ?? null, fetcher: fetcher as typeof fetch, now: () => time});
const request = (operation: string, headers: Record<string, string> = {}) => new Request(`${origin}${prefix}/${operation}`, {headers});
function callback(state: string, changes: Record<string, string> = {}, secret = clientSecret) {
  const params = new URLSearchParams({code: 'one-use-code', shop, state, timestamp: String(now / 1000), ...changes});
  params.sort(); params.set('hmac', createHmac('sha256', secret).update(params.toString().replace(/\+/g, '%20')).digest('hex'));
  return `${origin}${prefix}/callback?${params}`;
}
async function start() {
  const response = await handlers().connect(request('connect'));
  const target = new URL(response.headers.get('location')!);
  return {response, target, state: target.searchParams.get('state')!, cookie: response.headers.get('set-cookie')!.split(';')[0]};
}
const saved = () => ({accessToken: 'private-autobrush-offline-token', scopes: ['read_reports', 'read_orders', 'read_products'], storeDomain: shop, appClientId: clientId, authorizedAt: new Date(now).toISOString()});

it('redirects unauthenticated connect to sign-in with a static callback and protects status/callback', async () => {
  scope = null;
  const response = await handlers().connect(request('connect')), target = new URL(response.headers.get('location')!);
  expect(response.status).toBe(303); expect(target.origin + target.pathname).toBe(`${origin}/signin`);
  expect(target.searchParams.get('callbackUrl')).toBe(`${prefix}/connect`); expect(response.headers.get('set-cookie')).toBeNull();
  expect((await handlers().status(request('status'))).status).toBe(403);
  expect((await handlers().callback(request('callback'))).status).toBe(403);
  expect(store.first).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled();
});

it.each([{...admin, role: 'analyst' as const}, {...admin, role: 'service' as const}, {...admin, organizationId: 'outside-company'}])('isolates roles and configured company organization %#', async denied => {
  scope = denied;
  for (const operation of ['connect', 'callback', 'status'] as const) expect((await handlers()[operation](request(operation))).status).toBe(403);
  expect(store.first).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it('permits a company admin before Autobrush registration without requiring client membership', async () => {
  scope = {...admin, permittedClientIds: []};
  const {response, target, state} = await start();
  expect(response.status).toBe(303); expect(target.origin + target.pathname).toBe(`https://${shop}/admin/oauth/authorize`);
  expect(target.searchParams.get('client_id')).toBe(clientId); expect(target.searchParams.get('redirect_uri')).toBe(`${origin}${prefix}/callback`);
  expect(target.searchParams.get('scope')).toBe('read_reports,read_orders,read_products'); expect(target.searchParams.has('grant_options[]')).toBe(false);
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(response.headers.get('set-cookie')).toContain('__Host-az-autobrush-shopify-oauth=');
  expect(response.headers.get('set-cookie')).toContain('Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600');
  expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(store.first.mock.calls[0].slice(1)).toEqual(['avenue-z', 'autobrush', 'shopify']);
  expect(store.run).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it('honors a configured organization and rejects default-org administrators when it changes', async () => {
  expect((await handlers({APP_ORGANIZATION_ID: 'configured-company'}).connect(request('connect'))).status).toBe(403);
  scope = {...admin, organizationId: 'configured-company', permittedClientIds: []};
  expect((await handlers({APP_ORGANIZATION_ID: 'configured-company'}).connect(request('connect'))).status).toBe(303);
  expect(store.first.mock.calls[0].slice(1)).toEqual(['configured-company', 'autobrush', 'shopify']);
});

it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])('accepts an actual Next loopback URL with matching public Host: %s', async internal => {
  const connect = await handlers().connect(new Request(`${internal}${prefix}/connect`, {headers: {host: 'app.example', origin}}));
  expect(connect.status).toBe(303);
  const target = new URL(connect.headers.get('location')!); expect(target.searchParams.get('redirect_uri')).toBe(`${origin}${prefix}/callback`);
  const url = new URL(callback(target.searchParams.get('state')!));
  const response = await handlers().callback(new Request(`${internal}${url.pathname}${url.search}`, {headers: {host: 'app.example', origin, cookie: connect.headers.get('set-cookie')!.split(';')[0]}}));
  expect(response.status).toBe(303); expect(response.headers.get('location')).toBe(`${origin}${prefix}/status`);
  const status = await handlers().status(new Request(`${internal}${prefix}/status`, {headers: {host: 'app.example'}}));
  expect(await status.json()).toMatchObject({authorized: true, reportingVerified: false});
});

it('rejects external URL/Host spoofing, nonloopback proxies and cross-origin headers on every operation', async () => {
  const cases: [string, Record<string, string>][] = [
    ['https://evil.example', {host: 'app.example'}], ['http://10.0.0.1:3000', {host: 'app.example'}], ['http://localhost.evil.example:3000', {host: 'app.example'}],
    ['http://localhost:3000', {}], ['http://localhost:3000', {host: 'evil.example'}], ['http://localhost:3000', {host: 'app.example', origin: 'https://evil.example'}],
    [origin, {origin: 'https://evil.example'}], ['http://app.example', {host: 'app.example'}],
  ];
  for (const operation of ['connect', 'callback', 'status'] as const) for (const [base, headers] of cases) expect((await handlers()[operation](new Request(`${base}${prefix}/${operation}`, {headers}))).status).toBe(403);
  expect(store.first).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it('pins the shop and rejects wrong or duplicate shop parameters before reading credentials', async () => {
  for (const operation of ['connect', 'callback', 'status'] as const) for (const query of ['shop=other.myshopify.com', `shop=${shop}&shop=${shop}`]) {
    const response = await handlers()[operation](request(`${operation}?${query}`)); expect(response.status).toBe(400);
    if (operation === 'callback') expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  }
  expect(store.first).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it('rejects missing, tampered, duplicate, expired, future and other-actor state cookies', async () => {
  const {state, cookie} = await start();
  const tampered = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a');
  for (const invalid of ['', tampered, `${cookie}; ${cookie}`, `${cookie}; __Host-az-autobrush-shopify-oauth=`]) {
    const response = await handlers().callback(new Request(callback(state), {headers: {cookie: invalid}}));
    expect(response.status).toBe(400); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  }
  for (const time of [now + 600_000, now - 31_000]) expect((await handlers({}, time).callback(new Request(callback(state), {headers: {cookie}}))).status).toBe(400);
  scope = {...admin, actorId: 'google:other-admin'};
  expect((await handlers().callback(new Request(callback(state), {headers: {cookie}}))).status).toBe(400);
  scope = {...admin, organizationId: 'other-company'};
  expect((await handlers({APP_ORGANIZATION_ID: 'other-company'}).callback(new Request(callback(state), {headers: {cookie}}))).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled();
});

it('rejects mismatched/duplicate state, provider denial, wrong-shop signatures and callback HMAC tampering', async () => {
  const {state, cookie} = await start();
  const tampered = new URL(callback(state)); tampered.searchParams.set('code', 'tampered-code');
  for (const url of [callback('wrong-state'), `${callback(state)}&state=${state}`, `${callback(state)}&code=second-code`, callback(state, {error: 'access_denied', error_description: 'private-provider-details'}), callback(state, {}, 'wrong-store-secret'), tampered.toString()]) {
    const response = await handlers().callback(new Request(url, {headers: {cookie}}));
    expect(response.status).toBe(400); expect(await response.text()).not.toContain('private-'); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  }
  expect(fetcher).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled();
});

it('consumes verified callback state before exchanging and rejects sequential or concurrent replay', async () => {
  const {state, cookie} = await start();
  const responses = await Promise.all([handlers().callback(new Request(callback(state), {headers: {cookie}})), handlers().callback(new Request(callback(state), {headers: {cookie}}))]);
  expect(responses.map(response => response.status).sort()).toEqual([303, 400]);
  expect((await handlers().callback(new Request(callback(state), {headers: {cookie}}))).status).toBe(400);
  expect(fetcher).toHaveBeenCalledOnce(); expect(store.run).toHaveBeenCalledOnce();
});

it('encrypts the verified offline grant for Autobrush and reports authorization without claiming reporting readiness', async () => {
  const {state, cookie} = await start(), response = await handlers().callback(new Request(callback(state), {headers: {cookie}}));
  expect(response.status).toBe(303); expect(response.headers.get('location')).toBe(`${origin}${prefix}/status`); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe(`https://${shop}/admin/oauth/access_token`); expect(init.method).toBe('POST'); expect(init.redirect).toBe('error');
  expect((init.body as URLSearchParams).get('expiring')).toBe('0'); expect((init.body as URLSearchParams).get('client_id')).toBe(clientId);
  expect((init.body as URLSearchParams).get('client_secret')).toBe(clientSecret); expect((init.body as URLSearchParams).has('grant_type')).toBe(false);
  expect(store.run.mock.calls[0].slice(1, 4)).toEqual(['avenue-z', 'autobrush', 'shopify']); expect(store.run.mock.calls[0].join(' ')).not.toContain('private-');
  expect(await readProviderCredential(store, credentialIdentity, authSecret)).toEqual(saved());
  const status = await handlers().status(request('status')); expect(status.headers.get('cache-control')).toContain('no-store');
  expect(await status.json()).toEqual({clientId: 'autobrush', provider: 'shopify', storeDomain: shop, authorized: true, scopes: saved().scopes, authorizedAt: saved().authorizedAt, reportingVerified: false});
  expect((await handlers().connect(request('connect'))).headers.get('location')).toBe(`${origin}${prefix}/status`); expect(fetcher).toHaveBeenCalledOnce();
});

it.each([
  {access_token: 'private-token', scope: 'read_orders'},
  {access_token: 'private-token', scope: 'read_reports,read_orders,read_products', associated_user: {}},
  {access_token: 'private-token', scope: 'read_reports,read_orders,read_products', expires_in: 3600},
])('rejects insufficient or non-offline token grants without persistence %#', async payload => {
  const {state, cookie} = await start(); fetcher.mockResolvedValueOnce(Response.json(payload));
  const response = await handlers().callback(new Request(callback(state), {headers: {cookie}}));
  expect(response.status).toBe(502); expect(await response.text()).not.toContain('private-'); expect(response.headers.get('set-cookie')).toContain('Max-Age=0'); expect(store.run).not.toHaveBeenCalled();
});

it.each([{storeDomain: 'beamtlc.myshopify.com'}, {appClientId: 'other-app'}, {scopes: ['read_orders']}, {accessToken: 'bad\ntoken'}, {authorizedAt: 'invalid'}])('does not reuse an invalid or differently scoped stored grant %#', async changes => {
  await saveProviderCredential(store, credentialIdentity, {...saved(), ...changes}, authSecret);
  const status = await handlers().status(request('status'));
  expect(await status.json()).toMatchObject({authorized: false, scopes: [], authorizedAt: null, reportingVerified: false});
  const response = await handlers().connect(request('connect')); expect(new URL(response.headers.get('location')!).hostname).toBe(shop);
  expect(fetcher).not.toHaveBeenCalled();
});

it('keeps Beam credentials and state cookies isolated from Autobrush', async () => {
  const beamApp = {storeDomain: 'beamtlc.myshopify.com', clientId: 'beam-app-id', clientSecret: 'private-beam-app-secret'};
  await saveProviderCredential(store, {...credentialIdentity, clientId: 'beam'}, {...saved(), storeDomain: beamApp.storeDomain, appClientId: beamApp.clientId}, authSecret);
  expect(await (await handlers().status(request('status'))).json()).toMatchObject({authorized: false});
  const beam = createShopifyConnectionHandlers({scope: async () => scope, store: () => store, secret: key => ({...env, SOURCE_BEAM_SHOPIFY: JSON.stringify(beamApp)})[key] ?? null, now: () => now});
  // Use an empty store for Beam's state creation; its saved credential otherwise short-circuits.
  rows.clear(); const started = await beam.connect(new Request(`${origin}/api/integrations/shopify/beam/connect`));
  const target = new URL(started.headers.get('location')!), beamCookie = started.headers.get('set-cookie')!.split(';')[0];
  const renamedCookie = beamCookie.replace('__Host-az-beam-shopify-oauth', '__Host-az-autobrush-shopify-oauth');
  for (const cookie of [beamCookie, renamedCookie]) expect((await handlers().callback(new Request(callback(target.searchParams.get('state')!), {headers: {cookie}}))).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([false, true])('serves a tiny static dark HTML confirmation with no private values; authorized=%s', async authorized => {
  if (authorized) await saveProviderCredential(store, credentialIdentity, saved(), authSecret);
  const response = await handlers().status(request('status', {accept: 'text/html,application/xhtml+xml'})), html = await response.text();
  expect(response.headers.get('content-type')).toContain('text/html'); expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(html).toContain(authorized ? 'Shopify connected' : 'Shopify not connected'); expect(html).toMatch(/reporting setup pending/i);
  expect(html).toContain(authorized ? `href="${origin}/"` : `href="${origin}${prefix}/connect"`);
  expect(html).not.toMatch(/private-|google:admin|read_orders|autobrush-app-id|<script|<img|<link|ama-brushh/);
  const json = await handlers().status(request('status')); expect(json.headers.get('content-type')).toContain('application/json');
});

it('sanitizes storage and provider failures and clears all failed callback cookies', async () => {
  let started = await start(); fetcher.mockRejectedValueOnce(new Error('private-autobrush-offline-token'));
  let response = await handlers().callback(new Request(callback(started.state), {headers: {cookie: started.cookie}}));
  expect(response.status).toBe(502); expect(await response.text()).not.toContain('private-'); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  started = await start(); store.run.mockRejectedValueOnce(new Error('private-storage-content'));
  response = await handlers().callback(new Request(callback(started.state), {headers: {cookie: started.cookie}}));
  expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-'); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  for (const operation of ['connect', 'status'] as const) {
    store.first.mockRejectedValueOnce(new Error('private-ciphertext'));
    response = await handlers()[operation](request(operation)); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-');
  }
});

it.each([{AUTOBRUSH_SHOPIFY_CLIENT_ID: ''}, {AUTOBRUSH_SHOPIFY_CLIENT_SECRET: ''}, {AUTH_SECRET: 'short'}, {AUTH_URL: 'http://app.example'}, {AUTH_URL: 'https://app.example/other'}, {AUTH_URL: 'https://app.example/?private=value'}])('fails closed for missing or unsafe configuration %#', async changes => {
  for (const operation of ['connect', 'callback', 'status'] as const) {
    const response = await handlers(changes)[operation](request(operation)); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-');
  }
  expect(store.run).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
