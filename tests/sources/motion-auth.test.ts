import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MOTION_SCOPES,
  motionAuthorizationUrl,
  parseMotionAppConfig,
  verifyMotionCallback,
  exchangeMotionCode,
  refreshMotionGrant,
  type MotionAppConfig,
  type MotionGrant,
} from '../../lib/sources/motion-auth';

const config: MotionAppConfig = { clientId: 'test-motion-client' };
const redirectUri = 'https://analytics.example.com/api/motion/callback';
const state = 'test-random-motion-state';
// RFC 7636's public test vector checks the challenge independently.
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const nowMs = 1_800_000_000_000;
afterEach(() => vi.useRealTimers());

describe('Motion app configuration', () => {
  it('accepts only the bounded public client ID configuration', () => {
    expect(parseMotionAppConfig(JSON.stringify(config))).toEqual(config);
  });

  it.each([
    'sensitive-invalid-json', 'null', '[]', '{}',
    JSON.stringify({ clientId: '' }), JSON.stringify({ clientId: 123 }),
    JSON.stringify({ clientId: ' client ' }), JSON.stringify({ clientId: 'x'.repeat(513) }),
    JSON.stringify({ ...config, clientSecret: 'sensitive-test-secret' }),
  ])('rejects invalid configuration without disclosing its input', raw => {
    expect(() => parseMotionAppConfig(raw)).toThrow(/^Invalid Motion app configuration$/);
  });
});

const tokenResponse = {
  access_token: 'sensitive-test-motion-access', refresh_token: 'sensitive-test-motion-refresh',
  token_type: 'Bearer', expires_in: 3600, scope: 'openid profile email offline_access',
};
const grant: MotionGrant = {
  accessToken: tokenResponse.access_token, refreshToken: tokenResponse.refresh_token,
  tokenType: 'Bearer', expiresAt: nowMs + 3600000,
  scopes: ['openid', 'profile', 'email', 'offline_access'],
};
const tokenFetcher = (payload: unknown): typeof fetch => async () => Response.json(payload);
const exchange = (fetcher: typeof fetch) => exchangeMotionCode(config, 'test-code', redirectUri, verifier, fetcher, nowMs);
const refresh = (fetcher: typeof fetch) => refreshMotionGrant(config, grant, fetcher, nowMs);

describe('Motion authorization code exchange', () => {
  it('exchanges PKCE code at the discovered endpoint without a client secret', async () => {
    const fetcher: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://projects.motionapp.com/api/auth/oauth2/token');
      expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error');
      const headers = new Headers(init?.headers);
      expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
      expect(headers.get('Accept')).toBe('application/json');
      expect(headers.get('Authorization')).toBeNull();
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
        grant_type: 'authorization_code', client_id: config.clientId, code: 'test-code',
        redirect_uri: redirectUri, code_verifier: verifier, resource: 'https://projects.motionapp.com/mcp',
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json(tokenResponse);
    };
    await expect(exchange(fetcher)).resolves.toEqual(grant);
  });

  it('treats an omitted response scope as the requested scope and normalizes Bearer case', async () => {
    const payload: Partial<typeof tokenResponse> = { ...tokenResponse };
    delete payload.scope;
    await expect(exchange(tokenFetcher({ ...payload, token_type: 'bearer' }))).resolves.toEqual(grant);
  });

  it('preserves an explicitly granted identity scope subset with offline access', async () => {
    await expect(exchange(tokenFetcher({ ...tokenResponse, scope: 'offline_access profile' }))).resolves.toEqual({ ...grant, scopes: ['offline_access', 'profile'] });
  });

  it.each([
    null, [], {}, { ...tokenResponse, access_token: '' },
    { ...tokenResponse, access_token: 'contains whitespace' },
    { ...tokenResponse, access_token: 'x'.repeat(4097) },
    { ...tokenResponse, refresh_token: '' }, { ...tokenResponse, refresh_token: null },
    { ...tokenResponse, token_type: 'MAC' }, { ...tokenResponse, token_type: null },
    { ...tokenResponse, scope: '' }, { ...tokenResponse, scope: null },
    { ...tokenResponse, scope: 'openid profile email' },
    { ...tokenResponse, scope: 'offline_access write:projects' },
    { ...tokenResponse, scope: 'offline_access projects.write' },
    { ...tokenResponse, scope: 'offline_access read_projects' },
    { ...tokenResponse, scope: 'offline_access email email' },
    { ...tokenResponse, error: 'sensitive-provider-error' },
  ])('rejects malformed tokens or unauthorized scopes with a fixed error', payload => {
    return expect(exchange(tokenFetcher(payload))).rejects.toThrow(/^Motion token response is invalid or does not grant offline access$/);
  });

  it('requires a refresh token on the initial grant', async () => {
    const payload: Partial<typeof tokenResponse> = { ...tokenResponse };
    delete payload.refresh_token;
    await expect(exchange(tokenFetcher(payload))).rejects.toThrow(/^Motion token response is invalid or does not grant offline access$/);
  });

  it.each([0, -1, 1.5, '3600', null, 31536001])('rejects invalid or unbounded lifetime %j', expires_in => {
    return expect(exchange(tokenFetcher({ ...tokenResponse, expires_in }))).rejects.toThrow(/^Motion token response is invalid or does not grant offline access$/);
  });

  it('rejects invalid code, redirect or verifier before making any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(exchangeMotionCode(config, '', redirectUri, verifier, fetcher, nowMs)).rejects.toThrow(/^Invalid Motion token request$/);
    await expect(exchangeMotionCode(config, 'test-code', 'http://attacker.example/callback', verifier, fetcher, nowMs)).rejects.toThrow(/^Invalid Motion token request$/);
    await expect(exchangeMotionCode(config, 'test-code', redirectUri, 'short', fetcher, nowMs)).rejects.toThrow(/^Invalid Motion token request$/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Motion offline refresh', () => {
  it('uses the refresh grant and rotates both tokens without requiring an active user session', async () => {
    const fetcher: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://projects.motionapp.com/api/auth/oauth2/token');
      expect(init?.redirect).toBe('error');
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
        grant_type: 'refresh_token', client_id: config.clientId,
        refresh_token: grant.refreshToken, resource: 'https://projects.motionapp.com/mcp',
      });
      return Response.json({ ...tokenResponse, access_token: 'replacement-access', refresh_token: 'replacement-refresh', expires_in: 7200 });
    };
    await expect(refreshMotionGrant(config, { ...grant, expiresAt: nowMs - 1 }, fetcher, nowMs)).resolves.toEqual({
      ...grant, accessToken: 'replacement-access', refreshToken: 'replacement-refresh', expiresAt: nowMs + 7200000,
    });
  });

  it('retains the existing refresh token and scopes when the refresh response omits them', async () => {
    const payload = { access_token: 'replacement-access', token_type: 'Bearer', expires_in: 600 };
    const narrowed = { ...grant, scopes: ['offline_access', 'profile'] };
    await expect(refreshMotionGrant(config, narrowed, tokenFetcher(payload), nowMs)).resolves.toEqual({ ...narrowed, accessToken: 'replacement-access', expiresAt: nowMs + 600000 });
  });

  it('accepts returned scopes only when they narrow the previously granted scopes', async () => {
    await expect(refresh(tokenFetcher({ ...tokenResponse, scope: 'offline_access profile' }))).resolves.toEqual({ ...grant, scopes: ['offline_access', 'profile'] });
    await expect(refreshMotionGrant(config, { ...grant, scopes: ['offline_access', 'profile'] }, tokenFetcher(tokenResponse), nowMs)).rejects.toThrow(/^Motion token response is invalid or does not grant offline access$/);
  });

  it.each([
    { ...tokenResponse, refresh_token: '' }, { ...tokenResponse, refresh_token: null },
    { ...tokenResponse, scope: 'offline_access write_projects' },
    { ...tokenResponse, scope: 'openid profile email' },
    { ...tokenResponse, expires_in: 0 }, { ...tokenResponse, token_type: 'MAC' },
  ])('rejects invalid refresh responses instead of preserving invalid returned fields', payload => {
    return expect(refresh(tokenFetcher(payload))).rejects.toThrow(/^Motion token response is invalid or does not grant offline access$/);
  });

  it.each([
    { ...grant, refreshToken: '' }, { ...grant, scopes: ['offline_access', 'write_projects'] },
    { ...grant, scopes: ['openid'] }, { ...grant, scopes: ['offline_access', 'offline_access'] },
    { ...grant, tokenType: 'MAC' }, { ...grant, expiresAt: NaN },
  ])('rejects invalid stored grants before making a request', invalid => {
    const fetcher = vi.fn<typeof fetch>();
    return expect(refreshMotionGrant(config, invalid as MotionGrant, fetcher, nowMs)).rejects.toThrow(/^Invalid Motion refresh grant$/).then(() => expect(fetcher).not.toHaveBeenCalled());
  });
});

describe.each([['exchange', exchange], ['refresh', refresh]] as const)('Motion %s transport', (_label, request) => {
  it.each([302, 400, 401, 429, 500])('rejects HTTP %i without disclosing the body or redirect target', status => {
    return expect(request(async () => new Response('sensitive-provider-body', { status, headers: { Location: 'https://attacker.example/sensitive-token' } }))).rejects.toThrow(`Motion token request returned HTTP ${status}`);
  });

  it('rejects responses followed through a redirect', async () => {
    const response = Response.json(tokenResponse);
    Object.defineProperty(response, 'redirected', { value: true });
    await expect(request(async () => response)).rejects.toThrow(/^Motion token request rejected a redirect$/);
  });

  it('redacts network and malformed JSON errors', async () => {
    await expect(request(async () => { throw new Error('sensitive-provider-token'); })).rejects.toThrow(/^Motion token request timed out or could not be reached$/);
    await expect(request(async () => new Response('sensitive-invalid-json'))).rejects.toThrow(/^Motion token request returned an invalid response$/);
  });

  it('bounds an unending byte stream without relying on Content-Length', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(16385).fill(32)); },
      cancel() { canceled = true; },
    });
    await expect(request(async () => new Response(stream))).rejects.toThrow(/^Motion token response exceeds 64 KB$/);
    expect(canceled).toBe(true);
  });

  it('accepts a valid response at the exact 64 KiB limit', async () => {
    const json = JSON.stringify(tokenResponse), body = json.padEnd(65536, ' ');
    await expect(request(async () => new Response(body))).resolves.toEqual(grant);
  });

  it('times out the entire request after fifteen seconds even when fetch ignores abort', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const pending = request(async (_input, init) => { signal = init?.signal; return new Promise<Response>(() => {}); });
    const rejected = expect(pending).rejects.toThrow(/^Motion token request timed out or could not be reached$/);
    await vi.advanceTimersByTimeAsync(14999); expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await rejected; expect(signal?.aborted).toBe(true);
  });

  it('applies the same timeout while reading a stalled response body', async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    const pending = request(async () => new Response(stream));
    const rejected = expect(pending).rejects.toThrow(/^Motion token request timed out or could not be reached$/);
    await vi.advanceTimersByTimeAsync(15000); await rejected;
  });
});

describe('Motion authorization URL', () => {
  it('uses only the discovered issuer endpoint, identity scopes, MCP resource, and S256 PKCE', () => {
    const url = new URL(motionAuthorizationUrl(config, redirectUri, state, verifier));
    expect(url.origin).toBe('https://projects.motionapp.com');
    expect(url.pathname).toBe('/api/auth/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: 'openid profile email offline_access', state,
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256', resource: 'https://projects.motionapp.com/mcp',
    });
    expect(url.toString()).not.toContain(verifier);
    expect(MOTION_SCOPES).toEqual(['openid', 'profile', 'email', 'offline_access']);
  });

  it.each(['http://analytics.example.com/callback', 'https://user:pass@analytics.example.com/callback', 'https://analytics.example.com/callback#secret'])('rejects unsafe redirect %j', redirect => {
    expect(() => motionAuthorizationUrl(config, redirect, state, verifier)).toThrow(/^Invalid Motion authorization request$/);
  });

  it.each(['', 'a'.repeat(42), 'a'.repeat(129), `${'a'.repeat(42)}+`, `${'a'.repeat(42)}/`, `${'a'.repeat(42)}=`])('rejects invalid PKCE verifier %j', invalid => {
    expect(() => motionAuthorizationUrl(config, redirectUri, state, invalid)).toThrow(/^Invalid Motion authorization request$/);
  });

  it('rejects empty state and revalidates typed config before producing an authorization URL', () => {
    expect(() => motionAuthorizationUrl(config, redirectUri, '', verifier)).toThrow(/^Invalid Motion authorization request$/);
    expect(() => motionAuthorizationUrl({ clientId: '' }, redirectUri, state, verifier)).toThrow(/^Invalid Motion app configuration$/);
  });
});

function callback(changes: Record<string, string> = {}) {
  return new URLSearchParams({ code: 'test-authorization-code', state, ...changes });
}

describe('Motion callback verification', () => {
  it('returns only the code after checking state and the optional exact issuer', () => {
    expect(verifyMotionCallback(callback(), state)).toEqual({ code: 'test-authorization-code' });
    expect(verifyMotionCallback(callback({ iss: 'https://projects.motionapp.com/api/auth' }), state)).toEqual({ code: 'test-authorization-code' });
  });

  it.each(['code', 'state', 'iss', 'error', 'extra'])('rejects duplicated %s query parameters', key => {
    const params = callback({ [key]: 'duplicate' });
    params.append(key, 'duplicate');
    expect(() => verifyMotionCallback(params, state)).toThrow(/^Invalid Motion OAuth callback$/);
  });

  it.each([
    { state: 'wrong-state' }, { state: 'x'.repeat(state.length) }, { state: '' }, { code: '' }, { code: 'x'.repeat(4097) },
    { error: 'sensitive-provider-error' }, { error: '' },
    { iss: 'https://attacker.example/api/auth' }, { iss: 'https://projects.motionapp.com/api/auth/' },
    { iss: '' }, { code: 'code\nwith-control' },
  ] as Record<string, string>[])('rejects mismatches and provider errors without reflecting input', changes => {
    expect(() => verifyMotionCallback(callback(changes), state)).toThrow(/^Invalid Motion OAuth callback$/);
  });

  it('requires code, state and a nonempty expected state', () => {
    for (const key of ['code', 'state']) {
      const params = callback(); params.delete(key);
      expect(() => verifyMotionCallback(params, state)).toThrow(/^Invalid Motion OAuth callback$/);
    }
    expect(() => verifyMotionCallback(callback(), '')).toThrow(/^Invalid Motion OAuth callback$/);
  });
});
