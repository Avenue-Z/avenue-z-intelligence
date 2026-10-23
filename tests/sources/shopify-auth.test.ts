import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseShopifyAppConfig,
  SHOPIFY_REPORTING_SCOPES,
  shopifyAuthorizationUrl,
  verifyShopifyCallback,
  exchangeShopifyCode,
  type ShopifyAppConfig,
} from '../../lib/sources/shopify-auth';

const config: ShopifyAppConfig = {
  storeDomain: 'beamtlc.myshopify.com',
  clientId: 'test-app-client',
  clientSecret: 'test-app-secret',
};

afterEach(() => vi.useRealTimers());

describe('Shopify app configuration', () => {
  it('normalizes only a canonical Shopify host or its HTTPS origin', () => {
    expect(parseShopifyAppConfig(JSON.stringify(config))).toEqual(config);
    expect(parseShopifyAppConfig(JSON.stringify({ ...config, storeDomain: 'https://beamtlc.myshopify.com' }))).toEqual(config);
    expect(parseShopifyAppConfig(JSON.stringify({ ...config, storeDomain: 'https://beamtlc.myshopify.com/' }))).toEqual(config);
  });

  it.each([
    'http://beamtlc.myshopify.com', 'beamtlc.myshopify.com.attacker.example',
    'https://beamtlc.myshopify.com@attacker.example', 'https://user@beamtlc.myshopify.com',
    'https://beamtlc.myshopify.com:443', 'https://beamtlc.myshopify.com/path',
    'https://beamtlc.myshopify.com?x=1', 'https://beamtlc.myshopify.com#fragment',
    'beamtlc.myshopify.com.', 'beamtlc.myshopify.com\n', '-beam.myshopify.com',
    'beam-.myshopify.com', 'beam_tlc.myshopify.com', 'beam.tlc.myshopify.com',
  ])('rejects unsafe store domain %j', storeDomain => {
    expect(() => parseShopifyAppConfig(JSON.stringify({ ...config, storeDomain }))).toThrow('Invalid Shopify app configuration');
  });

  it.each([
    'invalid-test-secret-json', 'null', '[]', '{}',
    JSON.stringify({ ...config, clientId: '' }),
    JSON.stringify({ ...config, clientSecret: ' secret ' }),
    JSON.stringify({ ...config, clientSecret: 'x'.repeat(4097) }),
    JSON.stringify({ ...config, clientId: 123 }),
    JSON.stringify({ ...config, unexpected: 'test-secret' }),
  ])('rejects malformed configuration without echoing input', raw => {
    expect(() => parseShopifyAppConfig(raw)).toThrow(/^Invalid Shopify app configuration$/);
  });
});

const nowMs = 1_800_000_000_000;
const expectedState = 'random-state-value';
function signedCallback(overrides: Record<string, string> = {}) {
  const params = new URLSearchParams({
    code: 'test-authorization-code', shop: config.storeDomain,
    state: expectedState, timestamp: '1800000000', ...overrides,
  });
  const pairs = [...params].filter(([key]) => key !== 'hmac' && key !== 'signature').sort(([left], [right]) => left.localeCompare(right));
  const message = new URLSearchParams(pairs).toString().replace(/\+/g, '%20');
  params.set('hmac', createHmac('sha256', config.clientSecret).update(message).digest('hex'));
  return params;
}

describe('Shopify callback validation', () => {
  it('returns only the authorization code for an authenticated callback', () => {
    expect(verifyShopifyCallback(signedCallback(), config, expectedState, nowMs)).toEqual({ code: 'test-authorization-code' });
  });

  it('matches the official SDK escaping for sorted parameters and excludes legacy signatures', () => {
    const params = new URLSearchParams('timestamp=1800000000&state=random-state-value&shop=beamtlc.myshopify.com&host=admin.shopify.com%2Fstore%2Fbeamtlc%3Fx%3Da+b&code=test-authorization-code&signature=ignored-legacy-signature');
    const canonical = 'code=test-authorization-code&host=admin.shopify.com%2Fstore%2Fbeamtlc%3Fx%3Da%20b&shop=beamtlc.myshopify.com&state=random-state-value&timestamp=1800000000';
    params.set('hmac', createHmac('sha256', config.clientSecret).update(canonical).digest('hex'));
    expect(verifyShopifyCallback(params, config, expectedState, nowMs)).toEqual({ code: 'test-authorization-code' });
    expect(params.has('signature')).toBe(true);
  });

  it.each(['code', 'shop', 'state', 'timestamp', 'hmac', 'host'])('rejects duplicate %s parameters', key => {
    const params = signedCallback({ host: 'host-value' });
    params.append(key, params.get(key)!);
    expect(() => verifyShopifyCallback(params, config, expectedState, nowMs)).toThrow('Invalid Shopify OAuth callback');
  });

  it.each(['code', 'shop', 'state', 'timestamp', 'hmac'])('requires a nonempty %s parameter', key => {
    const params = signedCallback();
    params.delete(key);
    expect(() => verifyShopifyCallback(params, config, expectedState, nowMs)).toThrow('Invalid Shopify OAuth callback');
    const empty = signedCallback({ [key]: '' });
    empty.set(key, '');
    expect(() => verifyShopifyCallback(empty, config, expectedState, nowMs)).toThrow('Invalid Shopify OAuth callback');
  });

  it.each(['code', 'state', 'timestamp', 'host'])('rejects unsigned changes to %s', key => {
    const params = signedCallback({ host: 'host-value' });
    params.set(key, key === 'timestamp' ? '1799999999' : 'tampered-value');
    expect(() => verifyShopifyCallback(params, config, expectedState, nowMs)).toThrow('Invalid Shopify OAuth callback');
  });

  it.each(['other-store.myshopify.com', 'beamtlc.myshopify.com.attacker.example', 'https://beamtlc.myshopify.com', 'beamtlc.myshopify.com:443', 'BEAMTLC.myshopify.com'])('rejects even signed callbacks for unexpected shop %j', shop => {
    expect(() => verifyShopifyCallback(signedCallback({ shop }), config, expectedState, nowMs)).toThrow('Invalid Shopify OAuth callback');
  });

  it('rejects a correctly signed callback with a different or missing expected state', () => {
    expect(() => verifyShopifyCallback(signedCallback({ state: 'another-valid-state' }), config, expectedState, nowMs)).toThrow('Invalid Shopify OAuth callback');
    expect(() => verifyShopifyCallback(signedCallback(), config, '', nowMs)).toThrow('Invalid Shopify OAuth callback');
  });

  it.each(['1799999399', '1800000061', '1800000000.0', '1.8e9', '-1', 'NaN'])('rejects stale, future, or malformed timestamp %j', timestamp => {
    expect(() => verifyShopifyCallback(signedCallback({ timestamp }), config, expectedState, nowMs)).toThrow('Invalid Shopify OAuth callback');
  });

  it('accepts the ten-minute past and sixty-second future boundaries', () => {
    expect(verifyShopifyCallback(signedCallback({ timestamp: '1799999400' }), config, expectedState, nowMs).code).toBe('test-authorization-code');
    expect(verifyShopifyCallback(signedCallback({ timestamp: '1800000060' }), config, expectedState, nowMs).code).toBe('test-authorization-code');
  });

  it.each(['x', 'a'.repeat(63), 'g'.repeat(64), '0'.repeat(64), '0'.repeat(66)])('rejects malformed or incorrect HMAC without leaking callback values', hmac => {
    const params = signedCallback({ code: 'sensitive-test-code' });
    params.set('hmac', hmac);
    expect(() => verifyShopifyCallback(params, config, expectedState, nowMs)).toThrow(/^Invalid Shopify OAuth callback$/);
  });
});

describe('Shopify authorization URL', () => {
  it('requests the exact reporting scopes using the offline default', () => {
    const redirect = 'https://analytics.example.com/api/shopify/callback';
    const result = new URL(shopifyAuthorizationUrl(config, redirect, 'random-state-value'));
    expect(SHOPIFY_REPORTING_SCOPES).toEqual(['read_reports', 'read_orders', 'read_products']);
    expect(result.origin).toBe('https://beamtlc.myshopify.com');
    expect(result.pathname).toBe('/admin/oauth/authorize');
    expect(Object.fromEntries(result.searchParams)).toEqual({
      client_id: config.clientId,
      scope: 'read_reports,read_orders,read_products',
      redirect_uri: redirect,
      state: 'random-state-value',
    });
    expect(result.toString()).not.toContain(config.clientSecret);
  });

  it.each(['http://analytics.example.com/callback', 'https://user:pass@analytics.example.com/callback', 'https://analytics.example.com/callback#token'])('rejects unsafe redirect URI %j', redirect => {
    expect(() => shopifyAuthorizationUrl(config, redirect, 'random-state-value')).toThrow('Invalid Shopify authorization request');
  });

  it('validates typed configuration and state again before constructing any URL', () => {
    expect(() => shopifyAuthorizationUrl({ ...config, storeDomain: 'attacker.example' }, 'https://analytics.example.com/callback', 'random-state-value')).toThrow();
    expect(() => shopifyAuthorizationUrl(config, 'https://analytics.example.com/callback', '')).toThrow('Invalid Shopify authorization request');
  });
});

const tokenResult = {
  access_token: 'shpat_test-offline-token',
  scope: 'read_reports,read_orders,read_products',
};
function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
}

describe('Shopify authorization code exchange', () => {
  it('exchanges only with the configured HTTPS shop for a nonexpiring offline token', async () => {
    const fetcher: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://beamtlc.myshopify.com/admin/oauth/access_token');
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
      expect(new Headers(init?.headers).get('Accept')).toBe('application/json');
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
        client_id: config.clientId, client_secret: config.clientSecret,
        code: 'test-authorization-code', expiring: '0',
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      return jsonResponse(tokenResult);
    };
    await expect(exchangeShopifyCode(config, 'test-authorization-code', fetcher)).resolves.toEqual({
      accessToken: tokenResult.access_token, scopes: ['read_reports', 'read_orders', 'read_products'],
    });
  });

  it('preserves actual granted scopes rather than replacing them with the requested list', async () => {
    await expect(exchangeShopifyCode(config, 'test-code', async () => jsonResponse({ ...tokenResult, scope: 'read_products,read_reports,read_orders,read_inventory' }))).resolves.toEqual({
      accessToken: tokenResult.access_token, scopes: ['read_products', 'read_reports', 'read_orders', 'read_inventory'],
    });
  });

  it.each([
    { associated_user: { id: 123, first_name: 'Test', email: 'test@example.com' } },
    { associated_user: null }, { associated_user_scope: 'read_orders' },
    { expires_in: 3600 }, { expires_in: 0 }, { expires_in: null },
    { refresh_token: 'sensitive-test-refresh' }, { refresh_token: null },
    { refresh_token_expires_in: 7776000 },
  ])('rejects online or expiring metadata %j', extra => {
    return expect(exchangeShopifyCode(config, 'test-code', async () => jsonResponse({ ...tokenResult, ...extra }))).rejects.toThrow(/^Shopify token exchange did not return a nonexpiring offline token$/);
  });

  it.each([
    {}, null, [], { access_token: '' }, { access_token: 123, scope: tokenResult.scope },
    { ...tokenResult, scope: null }, { ...tokenResult, scope: '' },
    { ...tokenResult, scope: 'read_reports,read_orders' },
    { ...tokenResult, scope: 'write_reports,write_orders,write_products' },
    { ...tokenResult, scope: 'read_reports,read_orders,read_products_extra' },
    { ...tokenResult, scope: 'read_reports,read_orders,read_products,read_orders' },
    { ...tokenResult, scope: ['read_reports', 'read_orders', 'read_products'] },
    { ...tokenResult, access_token: 'contains whitespace' },
    { ...tokenResult, access_token: 'x'.repeat(4097) },
  ])('rejects malformed token responses and incomplete exact grants without response data', result => {
    return expect(exchangeShopifyCode(config, 'sensitive-test-code', async () => jsonResponse(result))).rejects.toThrow(/^Shopify token exchange returned an invalid token or scope grant$/);
  });

  it.each([302, 400, 401, 429, 500])('rejects HTTP %i without exposing body or redirect target', status => {
    return expect(exchangeShopifyCode(config, 'test-code', async () => new Response('sensitive-provider-body', { status, headers: { Location: 'https://attacker.example/test-secret' } }))).rejects.toThrow(`Shopify token exchange returned HTTP ${status}`);
  });

  it('redacts transport and invalid JSON errors', async () => {
    await expect(exchangeShopifyCode(config, 'test-code', async () => { throw new Error('sensitive-token-sensitive-secret'); })).rejects.toThrow(/^Shopify token exchange timed out or could not be reached$/);
    await expect(exchangeShopifyCode(config, 'test-code', async () => new Response('sensitive-token-invalid-json'))).rejects.toThrow(/^Shopify token exchange returned an invalid response$/);
  });

  it('rejects redirected responses even if a custom fetcher followed a redirect', async () => {
    const response = jsonResponse(tokenResult);
    Object.defineProperty(response, 'redirected', { value: true });
    await expect(exchangeShopifyCode(config, 'test-code', async () => response)).rejects.toThrow(/^Shopify token exchange rejected a redirect$/);
  });

  it('enforces a fifteen-second timeout even when fetch ignores the abort signal', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const pending = exchangeShopifyCode(config, 'test-code', async (_input, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    });
    const rejection = expect(pending).rejects.toThrow(/^Shopify token exchange timed out or could not be reached$/);
    await vi.advanceTimersByTimeAsync(14999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(signal?.aborted).toBe(true);
  });

  it('bounds streamed response bytes before parsing without relying on Content-Length', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(16385).fill(32)); },
      cancel() { canceled = true; },
    });
    await expect(exchangeShopifyCode(config, 'test-code', async () => new Response(stream))).rejects.toThrow(/^Shopify token exchange response exceeds 64 KB$/);
    expect(canceled).toBe(true);
  });

  it('bounds slow response bodies by the same timeout', async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    const pending = exchangeShopifyCode(config, 'test-code', async () => new Response(stream));
    const rejection = expect(pending).rejects.toThrow(/^Shopify token exchange timed out or could not be reached$/);
    await vi.advanceTimersByTimeAsync(15000);
    await rejection;
  });

  it('rejects hostile typed configuration and empty code before making a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(exchangeShopifyCode({ ...config, storeDomain: 'attacker.example' }, 'test-code', fetcher)).rejects.toThrow();
    await expect(exchangeShopifyCode(config, '', fetcher)).rejects.toThrow(/^Invalid Shopify authorization code$/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
