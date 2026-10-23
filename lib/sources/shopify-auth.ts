import { createHmac, timingSafeEqual } from 'node:crypto';

export type ShopifyAppConfig = {
  storeDomain: string;
  clientId: string;
  clientSecret: string;
};

export const SHOPIFY_REPORTING_SCOPES = ['read_reports', 'read_orders', 'read_products'] as const;

function visibleString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && /^[\x21-\x7e]+$/.test(value);
}

function appConfig(value: unknown): ShopifyAppConfig {
  const invalid = () => new Error('Invalid Shopify app configuration');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'clientId,clientSecret,storeDomain') throw invalid();
  if (!visibleString(input.storeDomain, 100) || !visibleString(input.clientId, 512) || !visibleString(input.clientSecret, 4096)) throw invalid();
  const storeDomain = input.storeDomain.startsWith('https://') ? input.storeDomain.slice(8).replace(/\/$/, '') : input.storeDomain;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(storeDomain)) throw invalid();
  return { storeDomain, clientId: input.clientId, clientSecret: input.clientSecret };
}

export function parseShopifyAppConfig(raw: string): ShopifyAppConfig {
  try {
    if (typeof raw !== 'string' || raw.length > 16384) throw new Error();
    return appConfig(JSON.parse(raw));
  } catch {
    throw new Error('Invalid Shopify app configuration');
  }
}

export function shopifyAuthorizationUrl(config: ShopifyAppConfig, redirectUri: string, state: string): string {
  const validated = appConfig(config);
  try {
    if (!visibleString(redirectUri, 4096) || !visibleString(state, 1024)) throw new Error();
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.hash) throw new Error();
    const url = new URL(`https://${validated.storeDomain}/admin/oauth/authorize`);
    // Omitting grant_options[]=per-user requests an offline token.
    url.search = new URLSearchParams({
      client_id: validated.clientId,
      scope: SHOPIFY_REPORTING_SCOPES.join(','),
      redirect_uri: redirectUri,
      state,
    }).toString();
    return url.toString();
  } catch {
    throw new Error('Invalid Shopify authorization request');
  }
}

export function verifyShopifyCallback(params: URLSearchParams, config: ShopifyAppConfig, expectedState: string, nowMs = Date.now()): { code: string } {
  try {
    const validated = appConfig(config);
    const pairs = [...params];
    if (pairs.length > 32 || params.toString().length > 32768 || new Set(pairs.map(([key]) => key)).size !== pairs.length) throw new Error();
    const hmac = params.get('hmac'), shop = params.get('shop'), state = params.get('state');
    const code = params.get('code'), timestamp = params.get('timestamp');
    if (!hmac || !/^[a-f0-9]{64}$/.test(hmac) || shop !== validated.storeDomain || !visibleString(code, 4096)) throw new Error();
    if (!visibleString(state, 1024) || !visibleString(expectedState, 1024)) throw new Error();
    const stateBytes = Buffer.from(state), expectedStateBytes = Buffer.from(expectedState);
    if (stateBytes.length !== expectedStateBytes.length || !timingSafeEqual(stateBytes, expectedStateBytes)) throw new Error();
    if (!timestamp || !/^[1-9][0-9]{0,12}$/.test(timestamp) || !Number.isFinite(nowMs)) throw new Error();
    const timestampMs = Number(timestamp) * 1000;
    if (!Number.isSafeInteger(timestampMs) || nowMs - timestampMs > 600000 || timestampMs - nowMs > 60000) throw new Error();
    // Match Shopify's official Node SDK: sorted, URL-encoded pairs, with spaces
    // serialized as %20. Both modern and legacy signature fields are excluded.
    const signedPairs = pairs.filter(([key]) => key !== 'hmac' && key !== 'signature').sort(([left], [right]) => left.localeCompare(right));
    const message = new URLSearchParams(signedPairs).toString().replace(/\+/g, '%20');
    const digest = createHmac('sha256', validated.clientSecret).update(message).digest();
    if (!timingSafeEqual(Buffer.from(hmac, 'hex'), digest)) throw new Error();
    return { code };
  } catch {
    throw new Error('Invalid Shopify OAuth callback');
  }
}

export async function exchangeShopifyCode(config: ShopifyAppConfig, code: string, fetcher: typeof fetch = fetch): Promise<{ accessToken: string; scopes: string[] }> {
  const validated = appConfig(config);
  if (!visibleString(code, 4096)) throw new Error('Invalid Shopify authorization code');
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unreachable = () => new Error('Shopify token exchange timed out or could not be reached');
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(unreachable()), 15000);
  });
  const exchange = async () => {
    let response: Response;
    try {
      response = await fetcher(`https://${validated.storeDomain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: validated.clientId, client_secret: validated.clientSecret, code, expiring: '0' }),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      throw unreachable();
    }
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw unreachable();
    }
    if (response.redirected) throw new Error('Shopify token exchange rejected a redirect');
    if (!response.ok) throw new Error(`Shopify token exchange returned HTTP ${response.status}`);
    const responseLimit = 65536;
    if (Number(response.headers.get('Content-Length')) > responseLimit) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Shopify token exchange response exceeds 64 KB');
    }
    if (!response.body) throw new Error('Shopify token exchange returned an invalid response');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try { result = await reader.read(); } catch { throw new Error('Shopify token exchange returned an invalid response'); }
      if (result.done) break;
      length += result.value.byteLength;
      if (length > responseLimit) throw new Error('Shopify token exchange response exceeds 64 KB');
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('Shopify token exchange returned an invalid response'); }
    const invalidToken = () => new Error('Shopify token exchange returned an invalid token or scope grant');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalidToken();
    const token = payload as Record<string, unknown>;
    // Explicitly requesting expiring=0 is safe only if the response confirms an
    // offline token without any lifetime, refresh, or user-session metadata.
    if (['associated_user', 'associated_user_scope', 'expires_in', 'refresh_token', 'refresh_token_expires_in'].some(key => Object.hasOwn(token, key))) {
      throw new Error('Shopify token exchange did not return a nonexpiring offline token');
    }
    if (!visibleString(token.access_token, 4096) || typeof token.scope !== 'string' || token.scope.length > 8192) throw invalidToken();
    const scopes = token.scope.split(',');
    if (!scopes.every(scope => /^[a-z][a-z0-9_]{0,127}$/.test(scope)) || new Set(scopes).size !== scopes.length || !SHOPIFY_REPORTING_SCOPES.every(scope => scopes.includes(scope))) throw invalidToken();
    return { accessToken: token.access_token, scopes };
  };
  try {
    return await Promise.race([exchange(), timeout]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}
