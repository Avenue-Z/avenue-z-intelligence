import { createHash, timingSafeEqual } from 'node:crypto';

export type MotionAppConfig = { clientId: string };
export type MotionGrant = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  tokenType: 'Bearer';
};
export const MOTION_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const;
const issuer = 'https://projects.motionapp.com/api/auth';
const resource = 'https://projects.motionapp.com/mcp';

function visibleString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && /^[\x21-\x7e]+$/.test(value);
}

function appConfig(value: unknown): MotionAppConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Motion app configuration');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).join(',') !== 'clientId' || !visibleString(input.clientId, 512)) throw new Error('Invalid Motion app configuration');
  return { clientId: input.clientId };
}

export function parseMotionAppConfig(raw: string): MotionAppConfig {
  try {
    if (typeof raw !== 'string' || raw.length > 16384) throw new Error();
    return appConfig(JSON.parse(raw));
  } catch {
    throw new Error('Invalid Motion app configuration');
  }
}

function validRedirect(redirectUri: string): boolean {
  try {
    if (!visibleString(redirectUri, 4096)) return false;
    const url = new URL(redirectUri);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch { return false; }
}
function validVerifier(verifier: string): boolean {
  return typeof verifier === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(verifier);
}

export function motionAuthorizationUrl(config: MotionAppConfig, redirectUri: string, state: string, verifier: string): string {
  const validated = appConfig(config);
  if (!validRedirect(redirectUri) || !visibleString(state, 1024) || !validVerifier(verifier)) throw new Error('Invalid Motion authorization request');
  const url = new URL(`${issuer}/oauth2/authorize`);
  url.search = new URLSearchParams({
    client_id: validated.clientId, redirect_uri: redirectUri,
    response_type: 'code', scope: MOTION_SCOPES.join(' '), state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', resource,
  }).toString();
  return url.toString();
}

export function verifyMotionCallback(params: URLSearchParams, expectedState: string): { code: string } {
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
    throw new Error('Invalid Motion OAuth callback');
  }
}

function validScopes(scopes: unknown): scopes is string[] {
  return Array.isArray(scopes) && scopes.length > 0 && scopes.length <= MOTION_SCOPES.length &&
    scopes.every(scope => typeof scope === 'string' && (MOTION_SCOPES as readonly string[]).includes(scope)) &&
    new Set(scopes).size === scopes.length && scopes.includes('offline_access');
}

function parseToken(payload: unknown, permittedScopes: readonly string[], nowMs: number, priorRefreshToken?: string): MotionGrant {
  const invalid = () => new Error('Motion token response is invalid or does not grant offline access');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid();
  const token = payload as Record<string, unknown>;
  if (Object.hasOwn(token, 'error') || typeof token.token_type !== 'string' || !/^Bearer$/i.test(token.token_type)) throw invalid();
  const refreshToken = Object.hasOwn(token, 'refresh_token') ? token.refresh_token : priorRefreshToken;
  if (!visibleString(token.access_token, 4096) || !visibleString(refreshToken, 4096)) throw invalid();
  if (typeof token.expires_in !== 'number' || !Number.isInteger(token.expires_in) || token.expires_in <= 0 || token.expires_in > 31536000) throw invalid();
  const expiresAt = nowMs + token.expires_in * 1000;
  if (!Number.isSafeInteger(expiresAt)) throw invalid();
  let scopes: string[];
  // OAuth allows scope to be omitted when it is unchanged. For refresh, retain
  // the previous grant rather than assuming every originally requested scope.
  if (Object.hasOwn(token, 'scope')) {
    if (typeof token.scope !== 'string' || token.scope.length > 1024) throw invalid();
    scopes = token.scope.split(' ');
  } else scopes = [...permittedScopes];
  if (!validScopes(scopes) || !scopes.every(scope => permittedScopes.includes(scope))) throw invalid();
  return { accessToken: token.access_token, refreshToken, expiresAt, scopes, tokenType: 'Bearer' };
}

async function requestToken(body: URLSearchParams, fetcher: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unreachable = () => new Error('Motion token request timed out or could not be reached');
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(unreachable()), 15000);
  });
  const request = async () => {
    let response: Response;
    try {
      response = await fetcher(`${issuer}/oauth2/token`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body,
      });
    } catch { throw unreachable(); }
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw unreachable();
    }
    if (response.redirected) throw new Error('Motion token request rejected a redirect');
    if (!response.ok) throw new Error(`Motion token request returned HTTP ${response.status}`);
    const responseLimit = 65536;
    if (Number(response.headers.get('Content-Length')) > responseLimit) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Motion token response exceeds 64 KB');
    }
    if (!response.body) throw new Error('Motion token request returned an invalid response');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try { result = await reader.read(); } catch { throw new Error('Motion token request returned an invalid response'); }
      if (result.done) break;
      length += result.value.byteLength;
      if (length > responseLimit) throw new Error('Motion token response exceeds 64 KB');
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new Error('Motion token request returned an invalid response'); }
  };
  try { return await Promise.race([request(), timeout]); }
  finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}

export async function exchangeMotionCode(config: MotionAppConfig, code: string, redirectUri: string, verifier: string, fetcher: typeof fetch = fetch, nowMs = Date.now()): Promise<MotionGrant> {
  const validated = appConfig(config);
  if (!visibleString(code, 4096) || !validRedirect(redirectUri) || !validVerifier(verifier) || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('Invalid Motion token request');
  const payload = await requestToken(new URLSearchParams({
    grant_type: 'authorization_code', client_id: validated.clientId, code,
    redirect_uri: redirectUri, code_verifier: verifier, resource,
  }), fetcher);
  return parseToken(payload, MOTION_SCOPES, nowMs);
}

export async function refreshMotionGrant(config: MotionAppConfig, grant: MotionGrant, fetcher: typeof fetch = fetch, nowMs = Date.now()): Promise<MotionGrant> {
  const validated = appConfig(config);
  if (!grant || typeof grant !== 'object' || !visibleString(grant.accessToken, 4096) || !visibleString(grant.refreshToken, 4096) ||
    grant.tokenType !== 'Bearer' || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= 0 || !validScopes(grant.scopes) ||
    !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('Invalid Motion refresh grant');
  const payload = await requestToken(new URLSearchParams({
    grant_type: 'refresh_token', client_id: validated.clientId, refresh_token: grant.refreshToken, resource,
  }), fetcher);
  return parseToken(payload, grant.scopes, nowMs, grant.refreshToken);
}
