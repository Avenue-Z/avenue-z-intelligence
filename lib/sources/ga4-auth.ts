import { createHash, timingSafeEqual } from 'node:crypto';

export type Ga4AppConfig = { clientId: string; clientSecret: string; propertyId: string };
export type Ga4Grant = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  tokenType: 'Bearer';
};
export const GA4_SCOPES = ['https://www.googleapis.com/auth/analytics.readonly'] as const;
const issuer = 'https://accounts.google.com';

function visibleString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && /^[\x21-\x7e]+$/.test(value);
}

function appConfig(value: unknown): Ga4AppConfig {
  const invalid = () => new Error('Invalid GA4 app configuration');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'clientId,clientSecret,propertyId' ||
    !visibleString(input.clientId, 512) || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(input.clientId) ||
    !visibleString(input.clientSecret, 4096) || typeof input.propertyId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(input.propertyId)) throw invalid();
  return { clientId: input.clientId, clientSecret: input.clientSecret, propertyId: input.propertyId };
}

export function parseGa4AppConfig(raw: string): Ga4AppConfig {
  try {
    if (typeof raw !== 'string' || raw.length > 16384) throw new Error();
    return appConfig(JSON.parse(raw));
  } catch {
    throw new Error('Invalid GA4 app configuration');
  }
}

function validRedirect(redirectUri: string): boolean {
  try {
    if (!visibleString(redirectUri, 4096)) return false;
    const url = new URL(redirectUri);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
function validVerifier(verifier: string): boolean {
  return typeof verifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier);
}

export function ga4AuthorizationUrl(config: Ga4AppConfig, redirectUri: string, state: string, verifier: string): string {
  const validated = appConfig(config);
  if (!validRedirect(redirectUri) || !visibleString(state, 1024) || !validVerifier(verifier)) throw new Error('Invalid GA4 authorization request');
  const url = new URL(`${issuer}/o/oauth2/v2/auth`);
  url.search = new URLSearchParams({
    client_id: validated.clientId, redirect_uri: redirectUri, response_type: 'code', scope: GA4_SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

export function verifyGa4Callback(params: URLSearchParams, expectedState: string): { code: string } {
  try {
    const pairs = [...params];
    if (pairs.length > 32 || params.toString().length > 32768 || new Set(pairs.map(([key]) => key)).size !== pairs.length) throw new Error();
    if (['error', 'error_description', 'error_uri'].some(key => params.has(key)) || params.has('iss') && params.get('iss') !== issuer) throw new Error();
    const code = params.get('code'), state = params.get('state');
    if (!visibleString(code, 4096) || !visibleString(state, 1024) || !visibleString(expectedState, 1024)) throw new Error();
    const actual = Buffer.from(state), expected = Buffer.from(expectedState);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    return { code };
  } catch {
    throw new Error('Invalid GA4 OAuth callback');
  }
}

function validScopes(scopes: unknown): scopes is string[] {
  return Array.isArray(scopes) && scopes.length === 1 && scopes[0] === GA4_SCOPES[0];
}

function parseToken(payload: unknown, nowMs: number, prior?: Ga4Grant): Ga4Grant {
  const invalid = () => new Error('GA4 token response is invalid or does not grant offline read access');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid();
  const token = payload as Record<string, unknown>;
  if (Object.hasOwn(token, 'error') || typeof token.token_type !== 'string' || !/^Bearer$/i.test(token.token_type)) throw invalid();
  // This grant shape supports unattended access without a separate refresh
  // expiry. Never silently discard Google's explicit time-based access limit.
  if (Object.hasOwn(token, 'refresh_token_expires_in')) throw invalid();
  const refreshToken = Object.hasOwn(token, 'refresh_token') ? token.refresh_token : prior?.refreshToken;
  if (!visibleString(token.access_token, 4096) || !visibleString(refreshToken, 4096)) throw invalid();
  if (typeof token.expires_in !== 'number' || !Number.isInteger(token.expires_in) || token.expires_in <= 0 || token.expires_in > 31536000) throw invalid();
  const expiresAt = nowMs + token.expires_in * 1000;
  if (!Number.isSafeInteger(expiresAt)) throw invalid();
  let scopes: string[];
  if (Object.hasOwn(token, 'scope')) {
    if (typeof token.scope !== 'string' || token.scope.length > 1024) throw invalid();
    scopes = token.scope.split(' ');
  } else if (prior) scopes = [...prior.scopes];
  else throw invalid();
  if (!validScopes(scopes)) throw invalid();
  return { accessToken: token.access_token, refreshToken, expiresAt, scopes, tokenType: 'Bearer' };
}

async function requestToken(body: URLSearchParams, fetcher: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unreachable = () => new Error('GA4 token request timed out or could not be reached');
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(unreachable()), 15000);
  });
  const request = async () => {
    let response: Response;
    try {
      response = await fetcher('https://oauth2.googleapis.com/token', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body,
      });
    } catch { throw unreachable(); }
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw unreachable();
    }
    if (response.redirected) throw new Error('GA4 token request rejected a redirect');
    if (!response.ok) throw new Error(`GA4 token request returned HTTP ${response.status}`);
    const responseLimit = 65536;
    if (Number(response.headers.get('Content-Length')) > responseLimit) {
      void response.body?.cancel().catch(() => {});
      throw new Error('GA4 token response exceeds 64 KB');
    }
    if (!response.body) throw new Error('GA4 token request returned an invalid response');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try { result = await reader.read(); } catch { throw new Error('GA4 token request returned an invalid response'); }
      if (result.done) break;
      length += result.value.byteLength;
      if (length > responseLimit) throw new Error('GA4 token response exceeds 64 KB');
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new Error('GA4 token request returned an invalid response'); }
  };
  try { return await Promise.race([request(), timeout]); }
  finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}

export async function exchangeGa4Code(config: Ga4AppConfig, code: string, redirectUri: string, verifier: string, fetcher: typeof fetch = fetch, nowMs = Date.now()): Promise<Ga4Grant> {
  const validated = appConfig(config);
  if (!visibleString(code, 4096) || !validRedirect(redirectUri) || !validVerifier(verifier) || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('Invalid GA4 token request');
  const payload = await requestToken(new URLSearchParams({
    grant_type: 'authorization_code', client_id: validated.clientId, client_secret: validated.clientSecret,
    code, redirect_uri: redirectUri, code_verifier: verifier,
  }), fetcher);
  return parseToken(payload, nowMs);
}

export async function refreshGa4Grant(config: Ga4AppConfig, grant: Ga4Grant, fetcher: typeof fetch = fetch, nowMs = Date.now()): Promise<Ga4Grant> {
  const validated = appConfig(config);
  if (!grant || typeof grant !== 'object' || !visibleString(grant.accessToken, 4096) || !visibleString(grant.refreshToken, 4096) ||
    grant.tokenType !== 'Bearer' || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= 0 || !validScopes(grant.scopes) ||
    !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('Invalid GA4 refresh grant');
  const payload = await requestToken(new URLSearchParams({
    grant_type: 'refresh_token', client_id: validated.clientId,
    client_secret: validated.clientSecret, refresh_token: grant.refreshToken,
  }), fetcher);
  return parseToken(payload, nowMs, grant);
}
