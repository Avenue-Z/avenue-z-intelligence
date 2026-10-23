import {createHash} from 'node:crypto';
import {beforeEach, expect, it, vi} from 'vitest';
import type {AccessScope} from '../../lib/analytics/contracts';
import {AUTOBRUSH_GA4_STATE_PREFIX, createAutobrushGa4ConnectionHandlers} from '../../lib/server/autobrush-ga4-connection';
import {createGa4ConnectionHandlers} from '../../lib/server/ga4-connection';
import {readProviderCredential, saveProviderCredential} from '../../lib/server/provider-credentials';

const origin = 'https://app.example', prefix = '/api/integrations/ga4/autobrush';
const registeredCallback = `${origin}/api/integrations/ga4/beam/callback`;
const now = Date.parse('2026-10-22T18:00:00Z'), analyticsScope = 'https://www.googleapis.com/auth/analytics.readonly';
const app = {clientId: 'autobrush-app.apps.googleusercontent.com', clientSecret: 'private-autobrush-ga4-app-secret', propertyId: '274489308'};
const authSecret = 'private-company-auth-secret-at-least-32-characters';
const env: Record<string, string> = {AUTH_URL: origin, AUTH_SECRET: authSecret, SOURCE_AUTOBRUSH_GA4: JSON.stringify(app)};
const admin: AccessScope = {organizationId: 'avenue-z', actorId: 'google:admin', role: 'admin', permittedClientIds: ['beam']};
const identity = {organizationId: 'avenue-z', clientId: 'autobrush', provider: 'ga4'};
const tokenResponse = () => ({access_token: 'private-autobrush-access-token', refresh_token: 'private-autobrush-refresh-token', expires_in: 3600, token_type: 'Bearer', scope: analyticsScope});
const saved = () => ({accessToken: 'private-autobrush-access-token', refreshToken: 'private-autobrush-refresh-token', expiresAt: now + 3600000,
  scopes: [analyticsScope], tokenType: 'Bearer', appClientId: app.clientId, propertyId: app.propertyId, authorizedAt: new Date(now).toISOString()});
let scope: AccessScope | null, rows: Map<string, string>, secretKeys: string[];
let store: {first: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>}, fetcher: ReturnType<typeof vi.fn>, scopeReader: ReturnType<typeof vi.fn>;
beforeEach(() => {
  scope = {...admin}; rows = new Map(); secretKeys = [];
  scopeReader = vi.fn(async () => scope);
  store = {
    first: vi.fn(async (_sql: string, ...args: unknown[]) => {const payload = rows.get(JSON.stringify(args)); return payload ? {payload} : null;}),
    run: vi.fn(async (_sql: string, ...args: unknown[]) => {rows.set(JSON.stringify(args.slice(0, 3)), String(args[3])); return {meta: {changes: 1}};}),
  };
  fetcher = vi.fn(async () => Response.json(tokenResponse()));
});
const handlers = (changes: Partial<Record<string, string>> = {}, time = now) => createAutobrushGa4ConnectionHandlers({
  scope: scopeReader as () => Promise<AccessScope | null>, store: () => store,
  secret: key => {secretKeys.push(key); return ({...env, ...changes})[key] ?? null;}, fetcher: fetcher as typeof fetch, now: () => time,
});
const request = (operation: string, headers: Record<string, string> = {}) => new Request(`${origin}${prefix}/${operation}`, {headers});
const callback = (state: string, changes: Record<string, string> = {}) => `${origin}${prefix}/callback?${new URLSearchParams({code: 'one-use-code', state, ...changes})}`;
async function start(changes: Partial<Record<string, string>> = {}) {
  const response = await handlers(changes).connect(request('connect')), target = new URL(response.headers.get('location')!);
  return {response, target, state: target.searchParams.get('state')!, cookie: response.headers.get('set-cookie')!.split(';')[0]};
}

it('permits a company administrator before client registration without requiring Autobrush client membership', async () => {
  scope = {...admin, permittedClientIds: []};
  const {response, target} = await start();
  expect(response.status).toBe(303); expect(target.origin).toBe('https://accounts.google.com');
  expect(store.first).toHaveBeenCalledWith(expect.stringContaining('FROM provider_credentials'), 'avenue-z', 'autobrush', 'ga4');
  expect(store.run).not.toHaveBeenCalled(); expect(secretKeys.some(key => key.includes('BEAM'))).toBe(false);
});

it('sends unsigned-in connect to the static company sign-in callback and protects callback/status', async () => {
  scope = null;
  const response = await handlers().connect(new Request(`${origin}${prefix}/connect?callbackUrl=https://evil.example`));
  const target = new URL(response.headers.get('location')!);
  expect(response.status).toBe(303); expect(target.origin + target.pathname).toBe(`${origin}/signin`);
  expect(target.searchParams.get('callbackUrl')).toBe(`${prefix}/connect`);
  expect((await handlers().callback(request('callback'))).status).toBe(403);
  expect((await handlers().status(request('status'))).status).toBe(403);
  expect(store.first).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  {...admin, role: 'analyst'}, {...admin, role: 'service'}, {...admin, organizationId: 'outside-company'},
  {...admin, actorId: ''}, {...admin, actorId: '   '}, {...admin, actorId: 'bad\nactor'}, {...admin, actorId: 42},
])('rejects wrong roles, organizations and invalid actors before credential access %#', async denied => {
  scope = denied as AccessScope;
  for (const operation of ['connect', 'callback', 'status'] as const) expect((await handlers()[operation](request(operation))).status).toBe(403);
  expect(store.first).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it('honors the configured company organization without granting default-company administrators access', async () => {
  expect((await handlers({APP_ORGANIZATION_ID: 'configured-company'}).connect(request('connect'))).status).toBe(403);
  scope = {...admin, organizationId: 'configured-company', permittedClientIds: []};
  expect((await handlers({APP_ORGANIZATION_ID: 'configured-company'}).connect(request('connect'))).status).toBe(303);
  expect(store.first).toHaveBeenCalledWith(expect.any(String), 'configured-company', 'autobrush', 'ga4');
});

it('requests exactly read-only offline Analytics consent with encrypted ten-minute PKCE state', async () => {
  const {response, target, cookie} = await start();
  expect(target.pathname).toBe('/o/oauth2/v2/auth');
  expect(target.searchParams.get('client_id')).toBe(app.clientId); expect(target.searchParams.get('redirect_uri')).toBe(registeredCallback);
  expect(AUTOBRUSH_GA4_STATE_PREFIX).toBe('az_autobrush_ga4_v1.');
  expect(target.searchParams.get('state')).toMatch(/^az_autobrush_ga4_v1\.[A-Za-z0-9_-]{43}$/);
  expect(target.searchParams.get('scope')).toBe(analyticsScope); expect(target.searchParams.get('access_type')).toBe('offline');
  expect(target.searchParams.get('prompt')).toBe('consent'); expect(target.searchParams.get('include_granted_scopes')).toBe('false');
  expect(target.searchParams.get('code_challenge_method')).toBe('S256'); expect(target.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(response.headers.get('set-cookie')).toContain('__Host-az-autobrush-ga4-oauth=');
  expect(response.headers.get('set-cookie')).toMatch(/Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
  expect(cookie).not.toMatch(/private-|google:admin|274489308|autobrush-app/);
  expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
});

it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])('serves all operations through the matching Next loopback proxy %s', async internal => {
  const proxied = (path: string, cookie?: string) => new Request(`${internal}${path}`, {headers: {host: 'app.example', origin, ...(cookie ? {cookie} : {})}});
  const started = await handlers().connect(proxied(`${prefix}/connect`)), target = new URL(started.headers.get('location')!);
  const cookie = started.headers.get('set-cookie')!.split(';')[0];
  const response = await handlers().callback(proxied(`${prefix}/callback?${new URL(callback(target.searchParams.get('state')!)).searchParams}`, cookie));
  expect(response.status).toBe(303); expect(response.headers.get('location')).toBe(`${origin}${prefix}/status`);
  expect(await (await handlers().status(proxied(`${prefix}/status`))).json()).toMatchObject({authorized: true, propertyId: '274489308'});
});

it('rejects hostile origins and public Host spoofing before any credential lookup or code exchange', async () => {
  for (const operation of ['connect', 'callback', 'status'] as const) {
    for (const [base, headers] of [
      ['https://evil.example', {host: 'app.example'}], ['http://app.example', {host: 'app.example'}],
      ['http://localhost:3000', {}], ['http://localhost:3000', {host: 'evil.example'}],
      ['http://localhost:3000', {host: 'app.example', origin: 'https://evil.example'}],
      ['http://10.0.0.1:3000', {host: 'app.example'}], ['http://localhost.evil.example', {host: 'app.example'}],
      [origin, {origin: 'https://evil.example'}],
    ] as [string, Record<string, string>][]) expect((await handlers()[operation](new Request(`${base}${prefix}/${operation}`, {headers}))).status).toBe(403);
  }
  expect(store.first).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it('rejects missing, tampered, duplicate, expired, future and other-actor encrypted state', async () => {
  const {state, cookie} = await start(), tampered = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a');
  for (const invalid of ['', tampered, `${cookie}; ${cookie}`, `${cookie}; __Host-az-autobrush-ga4-oauth=`]) {
    const response = await handlers().callback(new Request(callback(state), {headers: {cookie: invalid}}));
    expect(response.status).toBe(400); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  }
  for (const time of [now + 600000, now - 31000]) expect((await handlers({}, time).callback(new Request(callback(state), {headers: {cookie}}))).status).toBe(400);
  scope = {...admin, actorId: 'google:other-admin'};
  expect((await handlers().callback(new Request(callback(state), {headers: {cookie}}))).status).toBe(400);
  scope = {...admin, organizationId: 'another-company'};
  expect((await handlers({APP_ORGANIZATION_ID: 'another-company'}).callback(new Request(callback(state), {headers: {cookie}}))).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled();
});

it('rejects changed app configuration and wrong properties during a pending authorization', async () => {
  const {state, cookie} = await start();
  const changedApp = {SOURCE_AUTOBRUSH_GA4: JSON.stringify({...app, clientId: 'different-app.apps.googleusercontent.com'})};
  expect((await handlers(changedApp).callback(new Request(callback(state), {headers: {cookie}}))).status).toBe(400);
  for (const propertyId of ['292550743', '999999999']) {
    const response = await handlers({SOURCE_AUTOBRUSH_GA4: JSON.stringify({...app, propertyId})}).callback(new Request(callback(state), {headers: {cookie}}));
    expect(response.status).toBe(503);
  }
  expect(fetcher).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled();
});

it('rejects mismatched or duplicate OAuth parameters and provider denial without consuming valid state', async () => {
  const {state, cookie} = await start();
  for (const url of [callback('wrong-state'), `${callback(state)}&state=${state}`, `${callback(state)}&code=other-code`,
    callback(state, {error: 'access_denied', error_description: 'private-provider-details'}), callback(state, {iss: 'https://evil.example'})]) {
    const response = await handlers().callback(new Request(url, {headers: {cookie}}));
    expect(response.status).toBe(400); expect(await response.text()).not.toContain('private-'); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  }
  expect(fetcher).not.toHaveBeenCalled();
  expect((await handlers().callback(new Request(callback(state), {headers: {cookie}}))).status).toBe(303);
});

it('consumes verified state synchronously before token exchange and blocks concurrent and later warm-process replay', async () => {
  const {state, cookie} = await start(), incoming = () => new Request(callback(state), {headers: {cookie}});
  const responses = await Promise.all([handlers().callback(incoming()), handlers().callback(incoming())]);
  expect(responses.map(response => response.status).sort()).toEqual([303, 400]);
  expect((await handlers().callback(incoming())).status).toBe(400);
  expect(fetcher).toHaveBeenCalledOnce(); expect(store.run).toHaveBeenCalledOnce();
});

it('does not replay an exchanged authorization after an ambiguous token transport failure', async () => {
  const {state, cookie} = await start(); fetcher.mockRejectedValueOnce(new Error('private-autobrush-refresh-token'));
  const incoming = () => new Request(callback(state), {headers: {cookie}});
  expect((await handlers().callback(incoming())).status).toBe(502);
  expect((await handlers().callback(incoming())).status).toBe(400);
  expect(fetcher).toHaveBeenCalledOnce(); expect(store.run).not.toHaveBeenCalled();
});

it('saves a fresh offline grant encrypted only for Autobrush and redirects to its static status route', async () => {
  const {state, cookie, target} = await start(), response = await handlers().callback(new Request(`${callback(state)}&returnTo=https://evil.example`, {headers: {cookie}}));
  expect(response.status).toBe(303); expect(response.headers.get('location')).toBe(`${origin}${prefix}/status`); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  const [url, init] = fetcher.mock.calls[0], form = init.body as URLSearchParams;
  expect(url).toBe('https://oauth2.googleapis.com/token'); expect(init.method).toBe('POST'); expect(init.redirect).toBe('error');
  expect(form.get('grant_type')).toBe('authorization_code'); expect(form.get('client_id')).toBe(app.clientId); expect(form.get('client_secret')).toBe(app.clientSecret);
  expect(form.get('redirect_uri')).toBe(registeredCallback);
  expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(target.searchParams.get('code_challenge'));
  expect(store.run.mock.calls[0].slice(1, 4)).toEqual(['avenue-z', 'autobrush', 'ga4']); expect(store.run.mock.calls[0].join(' ')).not.toContain('private-');
  expect(await readProviderCredential(store, identity, authSecret)).toEqual(saved());
  const status = await handlers().status(request('status')), body = await status.json();
  expect(body).toEqual({clientId: 'autobrush', provider: 'ga4', propertyId: '274489308', authorized: true,
    scopes: [analyticsScope], authorizedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), reportingVerified: false});
  expect(JSON.stringify(body)).not.toMatch(/private-|accessToken|refreshToken|clientSecret|timeZone|currencyCode/);
  expect((await handlers().connect(request('connect'))).headers.get('location')).toBe(`${origin}${prefix}/status`);
  expect(fetcher).toHaveBeenCalledOnce(); expect(secretKeys.some(key => key.includes('BEAM'))).toBe(false);
});

it('uses explicitly referenced company app credentials while keeping the fresh Autobrush grant separate from Beam', async () => {
  const parentApp = {...app, clientId: 'company-app.apps.googleusercontent.com', clientSecret: 'private-company-app-secret', propertyId: '292550743'};
  const referenced = {SOURCE_AUTOBRUSH_GA4: JSON.stringify({propertyId: '274489308', oauthClientConfig: 'SOURCE_BEAM_GA4'}), SOURCE_BEAM_GA4: JSON.stringify(parentApp)};
  await saveProviderCredential(store, {...identity, clientId: 'beam'}, {...saved(), appClientId: parentApp.clientId, propertyId: '292550743'}, authSecret);
  const beamKey = JSON.stringify(['avenue-z', 'beam', 'ga4']), untouchedBeam = rows.get(beamKey);
  const {state, cookie, target} = await start(referenced);
  expect(target.searchParams.get('client_id')).toBe(parentApp.clientId); expect(target.searchParams.get('redirect_uri')).toBe(registeredCallback);
  const sharedUrl = `${registeredCallback}?${new URL(callback(state)).searchParams}`;
  const response = await handlers(referenced).callback(new Request(sharedUrl, {headers: {cookie}}));
  expect(response.status).toBe(303); expect(response.headers.get('location')).toBe(`${origin}${prefix}/status`);
  const form = fetcher.mock.calls[0][1].body as URLSearchParams;
  expect(form.get('client_id')).toBe(parentApp.clientId); expect(form.get('client_secret')).toBe(parentApp.clientSecret);
  expect(form.get('redirect_uri')).toBe(registeredCallback);
  expect(await readProviderCredential(store, identity, authSecret)).toMatchObject({...saved(), appClientId: parentApp.clientId, propertyId: '274489308'});
  expect(rows.get(beamKey)).toBe(untouchedBeam);
  expect(store.first.mock.calls.every(call => call.slice(1).join(',') === 'avenue-z,autobrush,ga4')).toBe(true);
  expect(await (await handlers(referenced).status(request('status'))).json()).toMatchObject({authorized: true, propertyId: '274489308', reportingVerified: false});
});

it('binds pending state to the referenced company application ID', async () => {
  const reference = JSON.stringify({propertyId: '274489308', oauthClientConfig: 'SOURCE_BEAM_GA4'});
  const original = {SOURCE_AUTOBRUSH_GA4: reference, SOURCE_BEAM_GA4: JSON.stringify({...app, propertyId: '292550743'})};
  const {state, cookie} = await start(original);
  const changed = {...original, SOURCE_BEAM_GA4: JSON.stringify({...app, clientId: 'other-company-app.apps.googleusercontent.com', propertyId: '292550743'})};
  const response = await handlers(changed).callback(new Request(callback(state), {headers: {cookie}}));
  expect(response.status).toBe(400); expect(fetcher).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled();
});

it.each([
  undefined, {propertyId: '274489308', oauthClientConfig: 'SOURCE_OTHER_GA4'},
  {propertyId: '292550743', oauthClientConfig: 'SOURCE_BEAM_GA4'},
  {propertyId: '274489308', oauthClientConfig: 'https://evil.example/config'},
  {propertyId: '274489308', oauthClientConfig: 'SOURCE_BEAM_GA4', extra: 'private-value'},
])('requires the exact explicit server-side Autobrush app reference and property %#', async value => {
  const changes = {SOURCE_AUTOBRUSH_GA4: value ? JSON.stringify(value) : '', SOURCE_BEAM_GA4: JSON.stringify({...app, propertyId: '292550743'})};
  for (const operation of ['connect', 'callback', 'status'] as const) expect((await handlers(changes)[operation](request(operation))).status).toBe(503);
  expect(secretKeys).not.toContain('SOURCE_BEAM_GA4');
  expect(store.first).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it('fails closed when an opted-in parent app configuration is missing or malformed', async () => {
  for (const value of ['', 'invalid-json', JSON.stringify({...app, clientSecret: ''})]) {
    const changes = {SOURCE_AUTOBRUSH_GA4: JSON.stringify({propertyId: '274489308', oauthClientConfig: 'SOURCE_BEAM_GA4'}), SOURCE_BEAM_GA4: value};
    expect((await handlers(changes).connect(request('connect'))).status).toBe(503);
  }
  expect(store.first).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  {refresh_token: undefined}, {scope: `${analyticsScope} openid`}, {scope: ''}, {scope: `${analyticsScope} ${analyticsScope}`},
  {refresh_token_expires_in: 604800}, {token_type: 'Basic'},
])('does not persist incomplete, bounded-refresh or over-scoped provider consent %#', async changes => {
  const {state, cookie} = await start(); fetcher.mockResolvedValueOnce(Response.json({...tokenResponse(), ...changes}));
  const response = await handlers().callback(new Request(callback(state), {headers: {cookie}}));
  expect(response.status).toBe(502); expect(await response.text()).not.toContain('private-'); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  expect(store.run).not.toHaveBeenCalled();
});

it.each([
  {appClientId: 'different-app'}, {propertyId: '292550743'}, {scopes: []}, {scopes: [analyticsScope, 'openid']},
  {refreshToken: ''}, {accessToken: 'bad\ntoken'}, {authorizedAt: 'invalid'}, {expiresAt: Number.MAX_SAFE_INTEGER}, {tokenType: 'Basic'},
])('does not reuse differently scoped or malformed stored authorization %#', async changes => {
  await saveProviderCredential(store, identity, {...saved(), ...changes}, authSecret);
  const response = await handlers().status(request('status'));
  expect(await response.json()).toMatchObject({authorized: false, scopes: [], authorizedAt: null, expiresAt: null, reportingVerified: false});
  expect(new URL((await handlers().connect(request('connect'))).headers.get('location')!).origin).toBe('https://accounts.google.com');
  expect(fetcher).not.toHaveBeenCalled();
});

it('retains offline authorization after access-token expiry without refreshing from status or connect', async () => {
  await saveProviderCredential(store, identity, {...saved(), expiresAt: now - 1000}, authSecret);
  expect(await (await handlers().status(request('status'))).json()).toMatchObject({authorized: true, reportingVerified: false});
  expect((await handlers().connect(request('connect'))).headers.get('location')).toBe(`${origin}${prefix}/status`);
  expect(fetcher).not.toHaveBeenCalled();
});

it('never reads Beam credentials or accepts Beam state, including a renamed state cookie', async () => {
  await saveProviderCredential(store, {...identity, clientId: 'beam'}, {...saved(), propertyId: '292550743'}, authSecret);
  expect(await (await handlers().status(request('status'))).json()).toMatchObject({authorized: false});
  expect(store.first.mock.calls.every(call => call.slice(1).join(',') === 'avenue-z,autobrush,ga4')).toBe(true);
  rows.clear();
  const beam = createGa4ConnectionHandlers({scope: async () => admin, store: () => store,
    secret: key => ({...env, SOURCE_BEAM_GA4: JSON.stringify({...app, propertyId: '292550743'})})[key] ?? null, now: () => now});
  const response = await beam.connect(new Request(`${origin}/api/integrations/ga4/beam/connect`));
  const state = new URL(response.headers.get('location')!).searchParams.get('state')!, beamCookie = response.headers.get('set-cookie')!.split(';')[0];
  for (const cookie of [beamCookie, beamCookie.replace('__Host-az-beam-ga4-oauth', '__Host-az-autobrush-ga4-oauth')])
    expect((await handlers().callback(new Request(callback(state), {headers: {cookie}}))).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([false, true])('serves a static dark browser status without private values; authorized=%s', async authorized => {
  if (authorized) await saveProviderCredential(store, identity, saved(), authSecret);
  const response = await handlers().status(request('status', {accept: 'text/html,application/xhtml+xml'})), html = await response.text();
  expect(response.headers.get('content-type')).toContain('text/html'); expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(html).toContain(authorized ? 'Google Analytics connected' : 'Google Analytics not connected'); expect(html).toMatch(/reporting setup pending/i);
  expect(html).toContain(authorized ? `href="${origin}/"` : `href="${origin}${prefix}/connect"`);
  expect(html).not.toMatch(/private-|google:admin|274489308|autobrush-app|<script|<img|<link|\/clients\//);
  expect((await handlers().status(request('status'))).headers.get('content-type')).toContain('application/json');
  expect((await handlers().status(request('status', {accept: 'text/html;q=0,application/json'}))).headers.get('content-type')).toContain('application/json');
});

it('sanitizes scope, storage and provider failures and clears failed callback cookies', async () => {
  scopeReader.mockRejectedValueOnce(new Error('private-company-session'));
  let response = await handlers().connect(request('connect')); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-');
  let pending = await start(); fetcher.mockRejectedValueOnce(new Error('private-autobrush-refresh-token'));
  response = await handlers().callback(new Request(callback(pending.state), {headers: {cookie: pending.cookie}}));
  expect(response.status).toBe(502); expect(await response.text()).not.toContain('private-'); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  pending = await start(); store.run.mockRejectedValueOnce(new Error('private-storage-details'));
  response = await handlers().callback(new Request(callback(pending.state), {headers: {cookie: pending.cookie}}));
  expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-'); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  for (const operation of ['connect', 'status'] as const) {
    store.first.mockRejectedValueOnce(new Error('private-ciphertext'));
    response = await handlers()[operation](request(operation)); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-');
  }
  scopeReader.mockRejectedValueOnce(new Error('private-company-session'));
  response = await handlers().callback(request('callback')); expect(response.status).toBe(503); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
});

it.each([
  {SOURCE_AUTOBRUSH_GA4: ''}, {SOURCE_AUTOBRUSH_GA4: JSON.stringify({...app, propertyId: '292550743'})},
  {SOURCE_AUTOBRUSH_GA4: JSON.stringify({...app, propertyId: '999999999'})}, {AUTH_SECRET: 'short'},
  {AUTH_URL: 'http://app.example'}, {AUTH_URL: 'https://app.example/other'}, {AUTH_URL: 'https://app.example/?private=value'},
])('fails closed for unsafe configuration or an unpinned property %#', async changes => {
  for (const operation of ['connect', 'callback', 'status'] as const) {
    const response = await handlers(changes)[operation](request(operation)); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-');
  }
  expect(store.first).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
