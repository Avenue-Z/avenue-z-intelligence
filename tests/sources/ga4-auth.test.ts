import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GA4_SCOPES,
  ga4AuthorizationUrl,
  parseGa4AppConfig,
  verifyGa4Callback,
  exchangeGa4Code,
  refreshGa4Grant,
  type Ga4AppConfig,
  type Ga4Grant,
} from '../../lib/sources/ga4-auth';

const config: Ga4AppConfig = {
  clientId: '123456789-test-client.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-test-client-secret', propertyId: '292550743',
};
const redirectUri = 'https://avenue-z-intelligence.vercel.app/api/integrations/ga4/beam/callback';
const state = 'test-random-ga4-state';
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const scope = 'https://www.googleapis.com/auth/analytics.readonly';
const nowMs = 1_800_000_000_000;
afterEach(() => vi.useRealTimers());

describe('GA4 OAuth app configuration', () => {
  it('accepts the bounded Google Web client and numeric property ID', () => {
    expect(parseGa4AppConfig(JSON.stringify(config))).toEqual(config);
  });

  it.each([
    'sensitive-invalid-json', 'null', '[]', '{}',
    JSON.stringify({ ...config, clientId: '' }),
    JSON.stringify({ ...config, clientId: 'attacker.apps.googleusercontent.com.evil.example' }),
    JSON.stringify({ ...config, clientId: 'https://123.apps.googleusercontent.com' }),
    JSON.stringify({ ...config, clientId: `${'a'.repeat(512)}.apps.googleusercontent.com` }),
    JSON.stringify({ ...config, clientSecret: '' }),
    JSON.stringify({ ...config, clientSecret: 'secret\nwith-control' }),
    JSON.stringify({ ...config, clientSecret: 'x'.repeat(4097) }),
    JSON.stringify({ ...config, propertyId: 292550743 }),
    JSON.stringify({ ...config, propertyId: 'properties/292550743' }),
    JSON.stringify({ ...config, propertyId: '0' }),
    JSON.stringify({ ...config, propertyId: '0292550743' }),
    JSON.stringify({ ...config, propertyId: '1'.repeat(21) }),
    JSON.stringify({ ...config, unexpected: 'sensitive-test-secret' }),
  ])('rejects malformed or unsafe configuration without echoing it', raw => {
    expect(() => parseGa4AppConfig(raw)).toThrow(/^Invalid GA4 app configuration$/);
  });
});

describe('GA4 authorization URL', () => {
  it('requests only offline Analytics read access with explicit consent and S256 PKCE', () => {
    const url = new URL(ga4AuthorizationUrl(config, redirectUri, state, verifier));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', scope,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state,
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256',
    });
    expect(GA4_SCOPES).toEqual([scope]);
    expect(url.toString()).not.toContain(config.clientSecret);
    expect(url.toString()).not.toContain(verifier);
    expect(url.searchParams.has('propertyId')).toBe(false);
  });

  it.each([
    'http://app.example/callback', 'https://user:pass@app.example/callback',
    'https://app.example/callback?token=secret', 'https://app.example/callback#secret',
  ])('rejects unsafe or nonexact callback URI %j', redirect => {
    expect(() => ga4AuthorizationUrl(config, redirect, state, verifier)).toThrow(/^Invalid GA4 authorization request$/);
  });

  it.each(['', 'a'.repeat(42), 'a'.repeat(129), `${'a'.repeat(42)}+`, `${'a'.repeat(42)}/`, `${'a'.repeat(42)}=`])('rejects invalid verifier %j', invalid => {
    expect(() => ga4AuthorizationUrl(config, redirectUri, state, invalid)).toThrow(/^Invalid GA4 authorization request$/);
  });

  it('accepts the full RFC PKCE unreserved alphabet and rejects empty state', () => {
    expect(() => ga4AuthorizationUrl(config, redirectUri, state, `${'a'.repeat(41)}.~`)).not.toThrow();
    expect(() => ga4AuthorizationUrl(config, redirectUri, '', verifier)).toThrow(/^Invalid GA4 authorization request$/);
  });
});

function callback(changes: Record<string, string> = {}) {
  return new URLSearchParams({ code: '4/test-google-authorization-code', state, ...changes });
}

describe('GA4 callback validation', () => {
  it('returns only the code after checking state and the optional Google issuer', () => {
    expect(verifyGa4Callback(callback(), state)).toEqual({ code: '4/test-google-authorization-code' });
    expect(verifyGa4Callback(callback({ iss: 'https://accounts.google.com' }), state)).toEqual({ code: '4/test-google-authorization-code' });
  });

  it.each(['code', 'state', 'iss', 'error', 'extra'])('rejects duplicate %s parameters', key => {
    const params = callback({ [key]: 'duplicate' }); params.append(key, 'duplicate');
    expect(() => verifyGa4Callback(params, state)).toThrow(/^Invalid GA4 OAuth callback$/);
  });

  it.each([
    { state: 'wrong-state' }, { state: 'x'.repeat(state.length) }, { state: '' },
    { code: '' }, { code: 'x'.repeat(4097) }, { code: 'code\nwith-control' },
    { error: 'sensitive-provider-error' }, { error: '' }, { error_description: 'sensitive-detail' },
    { iss: 'https://attacker.example' }, { iss: 'https://accounts.google.com/' },
    { iss: 'accounts.google.com' }, { iss: '' },
  ] as Record<string, string>[])('rejects state mismatches, errors and unexpected issuers without reflecting input', changes => {
    expect(() => verifyGa4Callback(callback(changes), state)).toThrow(/^Invalid GA4 OAuth callback$/);
  });

  it('requires code, state and a nonempty expected state', () => {
    for (const key of ['code', 'state']) {
      const params = callback(); params.delete(key);
      expect(() => verifyGa4Callback(params, state)).toThrow(/^Invalid GA4 OAuth callback$/);
    }
    expect(() => verifyGa4Callback(callback(), '')).toThrow(/^Invalid GA4 OAuth callback$/);
  });
});

const tokenResponse = {
  access_token: 'sensitive-test-ga4-access', refresh_token: 'sensitive-test-ga4-refresh',
  token_type: 'Bearer', expires_in: 3600, scope,
};
const grant: Ga4Grant = {
  accessToken: tokenResponse.access_token, refreshToken: tokenResponse.refresh_token,
  tokenType: 'Bearer', expiresAt: nowMs + 3600000, scopes: [scope],
};
const tokenFetcher = (payload: unknown): typeof fetch => async () => Response.json(payload);
const exchange = (fetcher: typeof fetch) => exchangeGa4Code(config, 'test-code', redirectUri, verifier, fetcher, nowMs);
const refresh = (fetcher: typeof fetch) => refreshGa4Grant(config, grant, fetcher, nowMs);

describe('GA4 code exchange', () => {
  it('posts the client secret and PKCE verifier only to the fixed Google token endpoint', async () => {
    const fetcher: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://oauth2.googleapis.com/token');
      expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error');
      const headers = new Headers(init?.headers);
      expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
      expect(headers.get('Accept')).toBe('application/json');
      expect(headers.get('Authorization')).toBeNull();
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
        grant_type: 'authorization_code', client_id: config.clientId, client_secret: config.clientSecret,
        code: 'test-code', redirect_uri: redirectUri, code_verifier: verifier,
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json(tokenResponse);
    };
    await expect(exchange(fetcher)).resolves.toEqual(grant);
  });

  it('normalizes Bearer case and ignores unrelated response fields', async () => {
    await expect(exchange(tokenFetcher({ ...tokenResponse, token_type: 'bearer', extra: 'ignored' }))).resolves.toEqual(grant);
  });

  it.each([
    null, [], {}, { ...tokenResponse, access_token: '' },
    { ...tokenResponse, access_token: 'contains whitespace' }, { ...tokenResponse, access_token: 'x'.repeat(4097) },
    { ...tokenResponse, refresh_token: '' }, { ...tokenResponse, refresh_token: null },
    { ...tokenResponse, token_type: 'MAC' }, { ...tokenResponse, token_type: null },
    { ...tokenResponse, scope: '' }, { ...tokenResponse, scope: null },
    { ...tokenResponse, scope: 'https://www.googleapis.com/auth/analytics' },
    { ...tokenResponse, scope: `${scope} https://www.googleapis.com/auth/analytics.edit` },
    { ...tokenResponse, scope: `${scope} openid` }, { ...tokenResponse, scope: `${scope} ${scope}` },
    { ...tokenResponse, error: 'sensitive-provider-error' },
    { ...tokenResponse, refresh_token_expires_in: 604800 },
  ])('rejects malformed tokens, broader scopes, and unsupported time-limited refresh grants', payload => {
    return expect(exchange(tokenFetcher(payload))).rejects.toThrow(/^GA4 token response is invalid or does not grant offline read access$/);
  });

  it.each(['scope', 'refresh_token'])('requires explicit %s on the initial grant', key => {
    const payload: Record<string, unknown> = { ...tokenResponse }; delete payload[key];
    return expect(exchange(tokenFetcher(payload))).rejects.toThrow(/^GA4 token response is invalid or does not grant offline read access$/);
  });

  it.each([0, -1, 1.5, '3600', null, 31536001])('rejects invalid or unbounded access lifetime %j', expires_in => {
    return expect(exchange(tokenFetcher({ ...tokenResponse, expires_in }))).rejects.toThrow(/^GA4 token response is invalid or does not grant offline read access$/);
  });

  it('validates request parameters before sending any client credentials', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(exchangeGa4Code(config, '', redirectUri, verifier, fetcher, nowMs)).rejects.toThrow(/^Invalid GA4 token request$/);
    await expect(exchangeGa4Code(config, 'code', 'http://attacker.example', verifier, fetcher, nowMs)).rejects.toThrow(/^Invalid GA4 token request$/);
    await expect(exchangeGa4Code(config, 'code', redirectUri, 'short', fetcher, nowMs)).rejects.toThrow(/^Invalid GA4 token request$/);
    await expect(exchangeGa4Code({ ...config, clientId: 'invalid' }, 'code', redirectUri, verifier, fetcher, nowMs)).rejects.toThrow(/^Invalid GA4 app configuration$/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('GA4 offline refresh', () => {
  it('authenticates the refresh grant and rotates tokens without an active user session', async () => {
    const fetcher: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://oauth2.googleapis.com/token');
      expect(init?.redirect).toBe('error');
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
        grant_type: 'refresh_token', client_id: config.clientId,
        client_secret: config.clientSecret, refresh_token: grant.refreshToken,
      });
      return Response.json({ ...tokenResponse, access_token: 'replacement-access', refresh_token: 'replacement-refresh', expires_in: 7200 });
    };
    await expect(refreshGa4Grant(config, { ...grant, expiresAt: nowMs - 1 }, fetcher, nowMs)).resolves.toEqual({
      ...grant, accessToken: 'replacement-access', refreshToken: 'replacement-refresh', expiresAt: nowMs + 7200000,
    });
  });

  it('preserves the existing refresh token and scopes when Google omits them', async () => {
    await expect(refresh(tokenFetcher({ access_token: 'replacement-access', token_type: 'Bearer', expires_in: 600 }))).resolves.toEqual({
      ...grant, accessToken: 'replacement-access', expiresAt: nowMs + 600000,
    });
  });

  it.each([
    { ...tokenResponse, refresh_token: '' }, { ...tokenResponse, refresh_token: null },
    { ...tokenResponse, scope: '' }, { ...tokenResponse, scope: 'openid' },
    { ...tokenResponse, scope: `${scope} https://www.googleapis.com/auth/analytics.edit` },
    { ...tokenResponse, expires_in: 0 }, { ...tokenResponse, token_type: 'MAC' },
    { ...tokenResponse, refresh_token_expires_in: 3600 },
  ])('rejects invalid refresh responses and any scope broadening', payload => {
    return expect(refresh(tokenFetcher(payload))).rejects.toThrow(/^GA4 token response is invalid or does not grant offline read access$/);
  });

  it.each([
    { ...grant, refreshToken: '' }, { ...grant, scopes: [] },
    { ...grant, scopes: [scope, 'https://www.googleapis.com/auth/analytics.edit'] },
    { ...grant, scopes: [scope, scope] }, { ...grant, tokenType: 'MAC' }, { ...grant, expiresAt: NaN },
  ])('rejects invalid stored grants before sending credentials', async invalid => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(refreshGa4Grant(config, invalid as Ga4Grant, fetcher, nowMs)).rejects.toThrow(/^Invalid GA4 refresh grant$/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe.each([['exchange', exchange], ['refresh', refresh]] as const)('GA4 %s transport', (_label, request) => {
  it.each([302, 400, 401, 429, 500])('rejects HTTP %i without disclosing provider text or redirect targets', status => {
    return expect(request(async () => new Response('sensitive-provider-body', { status, headers: { Location: 'https://attacker.example/sensitive-token' } }))).rejects.toThrow(`GA4 token request returned HTTP ${status}`);
  });

  it('rejects a response followed through a redirect', async () => {
    const response = Response.json(tokenResponse); Object.defineProperty(response, 'redirected', { value: true });
    await expect(request(async () => response)).rejects.toThrow(/^GA4 token request rejected a redirect$/);
  });

  it('redacts network and malformed JSON errors', async () => {
    await expect(request(async () => { throw new Error('sensitive-provider-token'); })).rejects.toThrow(/^GA4 token request timed out or could not be reached$/);
    await expect(request(async () => new Response('sensitive-invalid-json'))).rejects.toThrow(/^GA4 token request returned an invalid response$/);
  });

  it('bounds streamed bytes without relying on Content-Length', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(16385).fill(32)); },
      cancel() { canceled = true; },
    });
    await expect(request(async () => new Response(stream))).rejects.toThrow(/^GA4 token response exceeds 64 KB$/);
    expect(canceled).toBe(true);
  });

  it('accepts a valid response at the exact 64 KiB limit', async () => {
    await expect(request(async () => new Response(JSON.stringify(tokenResponse).padEnd(65536, ' ')))).resolves.toEqual(grant);
  });

  it('times out after fifteen seconds even when fetch ignores abort', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | null | undefined;
    const pending = request(async (_input, init) => { signal = init?.signal; return new Promise<Response>(() => {}); });
    const rejected = expect(pending).rejects.toThrow(/^GA4 token request timed out or could not be reached$/);
    await vi.advanceTimersByTimeAsync(14999); expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await rejected; expect(signal?.aborted).toBe(true);
  });

  it('uses the same deadline for a stalled body', async () => {
    vi.useFakeTimers(); const stream = new ReadableStream<Uint8Array>({ start() {} });
    const rejected = expect(request(async () => new Response(stream))).rejects.toThrow(/^GA4 token request timed out or could not be reached$/);
    await vi.advanceTimersByTimeAsync(15000); await rejected;
  });
});
