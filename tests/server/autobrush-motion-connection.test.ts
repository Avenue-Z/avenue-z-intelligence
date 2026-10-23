import {createHash} from 'node:crypto';
import {beforeEach, expect, it, vi} from 'vitest';
import type {AccessScope} from '../../lib/analytics/contracts';
import {createAutobrushMotionConnectionHandlers} from '../../lib/server/autobrush-motion-connection';
import {createMotionConnectionHandlers} from '../../lib/server/motion-connection';
import {readProviderCredential, saveProviderCredential} from '../../lib/server/provider-credentials';

vi.mock('../../lib/server/access', () => ({scopeForUser: async () => scope, getStore: () => store}));
vi.mock('../../lib/server/secrets', () => ({serverSecret: (key: string) => env[key] ?? null}));
const origin = 'https://app.example', prefix = '/api/integrations/motion/autobrush', now = Date.parse('2026-10-22T16:00:00Z');
const appClientId = 'autobrush-public-motion-client', secret = 'private-auth-secret-at-least-32-characters';
const env: Record<string, string> = {AUTH_URL: origin, AUTH_SECRET: secret, SOURCE_AUTOBRUSH_MOTION: JSON.stringify({clientId: appClientId})};
const admin: AccessScope = {organizationId: 'avenue-z', actorId: 'google:admin', role: 'admin', permittedClientIds: []};
const identity = {organizationId: 'avenue-z', clientId: 'autobrush', provider: 'motion'};
let scope: AccessScope | null, rows: Map<string, string>;
let store: {first: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>}, fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  scope = {...admin}; rows = new Map();
  store = {
    first: vi.fn(async (_sql: string, ...args: unknown[]) => {const payload = rows.get(JSON.stringify(args)); return payload ? {payload} : null;}),
    run: vi.fn(async (_sql: string, ...args: unknown[]) => {rows.set(JSON.stringify(args.slice(0, 3)), String(args[3])); return {meta: {changes: 1}};}),
  };
  fetcher = vi.fn(async () => Response.json({access_token: 'private-motion-access', refresh_token: 'private-motion-refresh', expires_in: 3600, token_type: 'Bearer', scope: 'openid profile email offline_access'}));
});
const handlers = (changes: Partial<Record<string, string>> = {}, time = now) => createAutobrushMotionConnectionHandlers({scope: async () => scope, store: () => store, secret: key => ({...env, ...changes})[key] ?? null, fetcher: fetcher as typeof fetch, now: () => time});
const request = (operation: string, headers: Record<string, string> = {}) => new Request(`${origin}${prefix}/${operation}`, {headers});
const callback = (state: string) => `${origin}${prefix}/callback?${new URLSearchParams({code: 'one-use-code', state, iss: 'https://projects.motionapp.com/api/auth'})}`;
const saved = () => ({appClientId, accessToken: 'private-motion-access', refreshToken: 'private-motion-refresh', expiresAt: now + 3_600_000, tokenType: 'Bearer', scopes: ['openid', 'profile', 'email', 'offline_access'], authorizedAt: new Date(now).toISOString()});
async function start() {
  const response = await handlers().connect(request('connect')); expect(response.status).toBe(303);
  const target = new URL(response.headers.get('location')!);
  return {response, target, state: target.searchParams.get('state')!, cookie: response.headers.get('set-cookie')!.split(';')[0]};
}

it('redirects unauthenticated connect to sign-in with the static callback and protects callback/status', async () => {
  scope = null;
  const response = await handlers().connect(request('connect?returnTo=https://evil.example')), target = new URL(response.headers.get('location')!);
  expect(target.origin + target.pathname).toBe(`${origin}/signin`); expect(target.searchParams.get('callbackUrl')).toBe(`${prefix}/connect`);
  expect(response.headers.get('set-cookie')).toBeNull();
  for (const operation of ['callback', 'status'] as const) expect((await handlers()[operation](request(operation))).status).toBe(403);
  expect(store.first).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it.each([{...admin, role: 'analyst' as const}, {...admin, role: 'service' as const}, {...admin, organizationId: 'outside-company'}])('isolates company admin role and organization %#', async denied => {
  scope = denied;
  for (const operation of ['connect', 'callback', 'status'] as const) expect((await handlers()[operation](request(operation))).status).toBe(403);
  expect(store.first).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it('allows a configured-company admin before Autobrush registration without client membership', async () => {
  expect((await handlers({APP_ORGANIZATION_ID: 'configured-company'}).connect(request('connect'))).status).toBe(403);
  scope = {...admin, organizationId: 'configured-company'};
  const response = await handlers({APP_ORGANIZATION_ID: 'configured-company'}).connect(request('connect'));
  expect(response.status).toBe(303); expect(store.first.mock.calls[0].slice(1)).toEqual(['configured-company', 'autobrush', 'motion']);
  expect(store.run).not.toHaveBeenCalled();
});

it('requests identity/offline scopes and S256 PKCE with an isolated encrypted ten-minute state cookie', async () => {
  const {response, target, state, cookie} = await start();
  expect(target.origin + target.pathname).toBe('https://projects.motionapp.com/api/auth/oauth2/authorize');
  expect(target.searchParams.get('client_id')).toBe(appClientId); expect(target.searchParams.get('redirect_uri')).toBe(`${origin}${prefix}/callback`);
  expect(target.searchParams.get('resource')).toBe('https://projects.motionapp.com/mcp'); expect(target.searchParams.get('scope')).toBe('openid profile email offline_access');
  expect(target.searchParams.get('code_challenge_method')).toBe('S256'); expect(target.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(target.searchParams.has('code_verifier')).toBe(false); expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(cookie).toMatch(/^__Host-az-autobrush-motion-oauth=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  expect(cookie).not.toContain(state); expect(response.headers.get('set-cookie')).toContain('Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600');
  expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('location')).not.toContain('private-'); expect(fetcher).not.toHaveBeenCalled();
});

it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])('supports actual loopback proxy URLs with matching public Host: %s', async internal => {
  const response = await handlers().connect(new Request(`${internal}${prefix}/connect`, {headers: {host: 'app.example', origin}}));
  expect(response.status).toBe(303);
  const target = new URL(response.headers.get('location')!), url = new URL(callback(target.searchParams.get('state')!));
  const complete = await handlers().callback(new Request(`${internal}${url.pathname}${url.search}`, {headers: {host: 'app.example', origin, cookie: response.headers.get('set-cookie')!.split(';')[0]}}));
  expect(complete.status).toBe(303); expect(complete.headers.get('location')).toBe(`${origin}${prefix}/status`);
  const status = await handlers().status(new Request(`${internal}${prefix}/status`, {headers: {host: 'app.example'}}));
  expect(await status.json()).toMatchObject({authorized: true, reportingVerified: false, workspaceVerified: false});
});

it('rejects visitor Host spoofing, nonloopback proxy URLs, cross-origin Origin and unsafe schemes', async () => {
  const cases: [string, Record<string, string>][] = [
    ['https://evil.example', {host: 'app.example'}], ['http://10.0.0.1:3000', {host: 'app.example'}], ['http://localhost.evil.example:3000', {host: 'app.example'}],
    ['http://localhost:3000', {}], ['http://localhost:3000', {host: 'evil.example'}], ['http://localhost:3000', {host: 'app.example', origin: 'https://evil.example'}],
    [origin, {origin: 'https://evil.example'}], [origin, {origin: 'null'}], ['http://app.example', {host: 'app.example'}],
  ];
  for (const operation of ['connect', 'callback', 'status'] as const) for (const [base, headers] of cases) {
    const response = await handlers()[operation](new Request(`${base}${prefix}/${operation}`, {headers})); expect(response.status).toBe(403);
    if (operation === 'callback') expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  }
  expect(store.first).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it('rejects missing, tampered, duplicate, expired, future, different-actor and different-org state', async () => {
  const {state, cookie} = await start(), tampered = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a');
  for (const invalid of ['', tampered, `${cookie}; ${cookie}`, `${cookie}; __Host-az-autobrush-motion-oauth=`]) {
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

it('rejects wrong or duplicate callback state, code, issuer and provider denials without leaking details', async () => {
  const {state, cookie} = await start();
  for (const url of [callback('wrong-state'), `${callback(state)}&state=${state}`, `${callback(state)}&code=another`, `${callback(state)}&iss=https://evil.example`, `${callback(state)}&error=access_denied&error_description=private-provider-content`, callback(state).replace('https%3A%2F%2Fprojects.motionapp.com%2Fapi%2Fauth', 'https%3A%2F%2Fevil.example')]) {
    const response = await handlers().callback(new Request(url, {headers: {cookie}}));
    expect(response.status).toBe(400); expect(await response.text()).not.toContain('private-'); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  }
  expect(fetcher).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled();
});

it('consumes verified state before token exchange and rejects concurrent and sequential replays across handler instances', async () => {
  const {state, cookie} = await start();
  const responses = await Promise.all([handlers().callback(new Request(callback(state), {headers: {cookie}})), handlers().callback(new Request(callback(state), {headers: {cookie}}))]);
  expect(responses.map(response => response.status).sort()).toEqual([303, 400]);
  expect((await handlers().callback(new Request(callback(state), {headers: {cookie}}))).status).toBe(400);
  expect(fetcher).toHaveBeenCalledOnce(); expect(store.run).toHaveBeenCalledOnce();
});

it('exchanges with the original PKCE verifier and encrypts only a fresh Autobrush grant without workspace claims', async () => {
  const {state, cookie, target} = await start(), response = await handlers().callback(new Request(callback(state), {headers: {cookie}}));
  expect(response.status).toBe(303); expect(response.headers.get('location')).toBe(`${origin}${prefix}/status`); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('https://projects.motionapp.com/api/auth/oauth2/token'); expect(init.method).toBe('POST'); expect(init.redirect).toBe('error');
  const form = init.body as URLSearchParams;
  expect(form.get('grant_type')).toBe('authorization_code'); expect(form.get('client_id')).toBe(appClientId); expect(form.has('client_secret')).toBe(false);
  expect(form.get('redirect_uri')).toBe(`${origin}${prefix}/callback`); expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(target.searchParams.get('code_challenge'));
  expect(store.run.mock.calls[0].slice(1, 4)).toEqual(['avenue-z', 'autobrush', 'motion']); expect(store.run.mock.calls[0].join(' ')).not.toContain('private-');
  expect(await readProviderCredential(store, identity, secret)).toEqual(saved());
  const status = await handlers().status(request('status')), json = await status.json();
  expect(json).toEqual({clientId: 'autobrush', provider: 'motion', authorized: true, scopes: saved().scopes, authorizedAt: saved().authorizedAt, expiresAt: new Date(saved().expiresAt).toISOString(), expectedOrganizationId: '699496be6f1a754daac7f10e', expectedWorkspaceId: '6ac52fac7231e870caa82acb', workspaceVerified: false, reportingVerified: false});
  expect(JSON.stringify(json)).not.toMatch(/private-|accessToken|refreshToken|appClientId/);
  expect((await handlers().connect(request('connect'))).headers.get('location')).toBe(`${origin}${prefix}/status`); expect(fetcher).toHaveBeenCalledOnce();
});

it.each([
  {access_token: 'private-access', expires_in: 3600, token_type: 'Bearer', scope: 'offline_access'},
  {access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, token_type: 'Bearer', scope: 'openid profile email'},
  {access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, token_type: 'Bearer', scope: 'offline_access write_projects'},
])('rejects missing offline refresh access or over-scoped grants %#', async payload => {
  const {state, cookie} = await start(); fetcher.mockResolvedValueOnce(Response.json(payload));
  const response = await handlers().callback(new Request(callback(state), {headers: {cookie}}));
  expect(response.status).toBe(502); expect(await response.text()).not.toContain('private-'); expect(response.headers.get('set-cookie')).toContain('Max-Age=0'); expect(store.run).not.toHaveBeenCalled();
});

it.each([{appClientId: 'other-app'}, {refreshToken: ''}, {accessToken: 'bad\ntoken'}, {tokenType: 'Basic'}, {scopes: []}, {scopes: ['offline_access', 'offline_access']}, {scopes: ['offline_access', 'write_projects']}, {expiresAt: Number.MAX_SAFE_INTEGER}, {authorizedAt: 'invalid'}])('does not reuse an invalid stored grant %#', async changes => {
  await saveProviderCredential(store, identity, {...saved(), ...changes}, secret);
  const json = await (await handlers().status(request('status'))).json();
  expect(json).toMatchObject({authorized: false, scopes: [], authorizedAt: null, expiresAt: null, workspaceVerified: false, reportingVerified: false});
  expect(new URL((await handlers().connect(request('connect'))).headers.get('location')!).pathname).toBe('/api/auth/oauth2/authorize'); expect(fetcher).not.toHaveBeenCalled();
});

it('retains offline authorization after access-token expiry without refreshing tokens in status or connect', async () => {
  await saveProviderCredential(store, identity, {...saved(), expiresAt: now - 1_000}, secret);
  expect(await (await handlers().status(request('status'))).json()).toMatchObject({authorized: true, workspaceVerified: false, reportingVerified: false});
  expect((await handlers().connect(request('connect'))).headers.get('location')).toBe(`${origin}${prefix}/status`); expect(fetcher).not.toHaveBeenCalled();
});

it('never reads Beam grants and rejects both renamed and original Beam state cookies', async () => {
  await saveProviderCredential(store, {...identity, clientId: 'beam'}, saved(), secret);
  expect(await (await handlers().status(request('status'))).json()).toMatchObject({authorized: false});
  expect(store.first.mock.calls[0].slice(1)).toEqual(['avenue-z', 'autobrush', 'motion']);
  const beam = createMotionConnectionHandlers({scope: async () => ({...admin, permittedClientIds: ['beam']}), store: () => store, secret: key => ({...env, SOURCE_BEAM_MOTION: JSON.stringify({clientId: 'beam-public-client'})})[key] ?? null, now: () => now});
  const started = await beam.connect(new Request(`${origin}/api/integrations/motion/beam/connect`)), target = new URL(started.headers.get('location')!);
  const beamCookie = started.headers.get('set-cookie')!.split(';')[0];
  for (const cookie of [beamCookie, beamCookie.replace('__Host-az-beam-motion-oauth', '__Host-az-autobrush-motion-oauth')]) expect((await handlers().callback(new Request(callback(target.searchParams.get('state')!), {headers: {cookie}}))).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([false, true])('renders safe static dark HTML without credentials, scope or workspace claims: authorized=%s', async authorized => {
  if (authorized) await saveProviderCredential(store, identity, saved(), secret);
  const response = await handlers().status(request('status', {accept: 'text/html,application/xhtml+xml'})), html = await response.text();
  expect(response.headers.get('content-type')).toContain('text/html'); expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(html).toContain(authorized ? 'Motion connected' : 'Motion not connected'); expect(html).toMatch(/reporting setup pending/i);
  expect(html).toContain(authorized ? `href="${origin}/"` : `href="${origin}${prefix}/connect"`);
  expect(html).not.toMatch(/private-|google:admin|offline_access|6ac52fac|699496be|<script|<img|<link/);
  expect((await handlers().status(request('status'))).headers.get('content-type')).toContain('application/json');
  expect((await handlers().status(request('status', {accept: 'text/html;q=0, application/json'}))).headers.get('content-type')).toContain('application/json');
});

it('sanitizes provider, persistence, credential read and authorization-service failures', async () => {
  let started = await start(); fetcher.mockRejectedValueOnce(new Error('private-access-token'));
  let response = await handlers().callback(new Request(callback(started.state), {headers: {cookie: started.cookie}}));
  expect(response.status).toBe(502); expect(await response.text()).not.toContain('private-'); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  started = await start(); store.run.mockRejectedValueOnce(new Error('private-refresh-token'));
  response = await handlers().callback(new Request(callback(started.state), {headers: {cookie: started.cookie}}));
  expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-'); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  for (const operation of ['connect', 'status'] as const) {
    store.first.mockRejectedValueOnce(new Error('private-ciphertext'));
    response = await handlers()[operation](request(operation)); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-');
  }
  const failing = createAutobrushMotionConnectionHandlers({scope: async () => {throw Error('private-user-profile');}, store: () => store, secret: key => env[key] ?? null});
  for (const operation of ['connect', 'callback', 'status'] as const) {response = await failing[operation](request(operation)); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-');}
});

it.each([{SOURCE_AUTOBRUSH_MOTION: ''}, {SOURCE_AUTOBRUSH_MOTION: JSON.stringify({clientId: appClientId, clientSecret: 'private-wrong-secret'})}, {AUTH_SECRET: 'short'}, {AUTH_URL: 'http://app.example'}, {AUTH_URL: 'https://app.example/other'}, {AUTH_URL: 'https://app.example/?private=secret'}])('fails closed for missing or unsafe settings %#', async changes => {
  for (const operation of ['connect', 'callback', 'status'] as const) {
    const response = await handlers(changes)[operation](request(operation)); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-');
    if (operation === 'callback') expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  }
  expect(store.run).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it('wires all three uncached Node routes through the real protected handlers', async () => {
  const routes = [
    ['connect', await import('../../app/api/integrations/motion/autobrush/connect/route')],
    ['callback', await import('../../app/api/integrations/motion/autobrush/callback/route')],
    ['status', await import('../../app/api/integrations/motion/autobrush/status/route')],
  ] as const;
  for (const [operation, route] of routes) {
    expect(route.dynamic).toBe('force-dynamic'); expect(route.runtime).toBe('nodejs'); expect(route.maxDuration).toBe(30);
    const result = await route.GET(request(operation)); expect(result.status).toBe(operation === 'connect' ? 303 : operation === 'callback' ? 400 : 200);
    expect(result.headers.get('cache-control')).toContain('no-store');
  }
  scope = null;
  for (const [operation, route] of routes) expect((await route.GET(request(operation))).status).toBe(operation === 'connect' ? 303 : 403);
  expect(store.run).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
