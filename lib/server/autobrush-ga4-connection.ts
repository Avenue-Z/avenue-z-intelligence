import {ga4AppConfig} from './ga4-profile-config';
import {createCipheriv, createDecipheriv, createHash, createHmac, randomBytes} from 'node:crypto';
import type {AccessScope} from '../analytics/contracts';
import {exchangeGa4Code, GA4_SCOPES, ga4AuthorizationUrl, verifyGa4Callback} from '../sources/ga4-auth';
import type {Ga4AppConfig, Ga4Grant} from '../sources/ga4-auth';
import {authorize} from './policy';
import {readProviderCredential, saveProviderCredential} from './provider-credentials';
import type {Store} from './store';

export type AutobrushGa4ConnectionDependencies = {
  scope: () => Promise<AccessScope | null>;
  store: () => Pick<Store, 'first' | 'run'>;
  secret: (key: string) => string | null;
  fetcher?: typeof fetch;
  now?: () => number;
};
export type SavedAutobrushGa4Grant = Ga4Grant & {appClientId: string; propertyId: string; authorizedAt: string};
export const AUTOBRUSH_GA4_STATE_PREFIX = 'az_autobrush_ga4_v1.';

const prefix = '/api/integrations/ga4/autobrush', cookieName = '__Host-az-autobrush-ga4-oauth';
// The existing company OAuth application already registers this callback. Its
// dispatcher uses only our state prefix; this handler still verifies all state.
const registeredCallbackPath = '/api/integrations/ga4/beam/callback';
const propertyId = '274489308', lifetime = 600000;
const cookieOptions = 'Path=/; Secure; HttpOnly; SameSite=Lax';
const clearCookie = `${cookieName}=; ${cookieOptions}; Max-Age=0`;
const securityHeaders = {'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie, Accept'};
// This blocks duplicate/concurrent callbacks in a warm process. Google's
// single-use authorization code remains the replay boundary across processes.
const consumedStates = new Map<string, number>();

function response(body: unknown, status = 200, clear = false) {
  return Response.json(body, {status, headers: {...securityHeaders, ...(clear ? {'Set-Cookie': clearCookie} : {})}});
}
function redirect(location: string, cookie?: string) {
  return new Response(null, {status: 303, headers: {...securityHeaders, Location: location, ...(cookie ? {'Set-Cookie': cookie} : {})}});
}
function stateKey(secret: string) {
  return createHash('sha256').update('avenue-z:autobrush-ga4-state:v1:').update(secret).digest();
}
function context(scope: AccessScope, app: Ga4AppConfig, origin: string) {
  return createHash('sha256').update(JSON.stringify([scope.organizationId, scope.actorId, app.clientId, app.propertyId, origin, registeredCallbackPath])).digest('base64url');
}
function stateCookie(scope: AccessScope, app: Ga4AppConfig, origin: string, secret: string, now: number) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + lifetime)) throw Error('Invalid state time');
  const state = AUTOBRUSH_GA4_STATE_PREFIX + randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
  const plaintext = Buffer.from(JSON.stringify({state, verifier, context: context(scope, app, origin), issuedAt: now, expiresAt: now + lifetime}));
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', stateKey(secret), iv); cipher.setAAD(Buffer.from(cookieName));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const value = ['v1', iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  return {state, verifier, cookie: `${cookieName}=${value}; ${cookieOptions}; Max-Age=600`};
}
function decode(part: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw Error('Invalid state');
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw Error('Invalid state');
  return bytes;
}
function readState(request: Request, scope: AccessScope, app: Ga4AppConfig, origin: string, secret: string, now: number) {
  const matches = (request.headers.get('cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
  if (matches.length !== 1 || matches[0].length > 4096 || !Number.isSafeInteger(now) || now < 0) throw Error('Invalid state');
  const parts = matches[0].slice(cookieName.length + 1).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw Error('Invalid state');
  const iv = decode(parts[1]), encrypted = decode(parts[2]), tag = decode(parts[3]);
  if (iv.length !== 12 || tag.length !== 16) throw Error('Invalid state');
  const decipher = createDecipheriv('aes-256-gcm', stateKey(secret), iv); decipher.setAAD(Buffer.from(cookieName)); decipher.setAuthTag(tag);
  const data: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat([decipher.update(encrypted), decipher.final()])));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid state');
  const value = data as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'context,expiresAt,issuedAt,state,verifier' ||
    typeof value.state !== 'string' || !value.state.startsWith(AUTOBRUSH_GA4_STATE_PREFIX) || !/^[A-Za-z0-9_-]{43}$/.test(value.state.slice(AUTOBRUSH_GA4_STATE_PREFIX.length)) ||
    typeof value.verifier !== 'string' || !/^[A-Za-z0-9_-]{64}$/.test(value.verifier) ||
    value.context !== context(scope, app, origin) || typeof value.issuedAt !== 'number' || !Number.isSafeInteger(value.issuedAt) ||
    typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt - value.issuedAt !== lifetime ||
    value.issuedAt > now + 30000 || value.expiresAt <= now) throw Error('Invalid state');
  return {state: value.state, verifier: value.verifier, expiresAt: value.expiresAt};
}
function consumeState(state: string, secret: string, expiresAt: number, now: number) {
  for (const [key, expiry] of consumedStates) if (expiry <= now) consumedStates.delete(key);
  const key = createHmac('sha256', secret).update('avenue-z:autobrush-ga4-consumed:v1:').update(state).digest('base64url');
  if (consumedStates.has(key) || consumedStates.size >= 10000) throw Error('Invalid state');
  consumedStates.set(key, expiresAt);
}

/** A stored offline grant remains authorized after access-token expiry.
 * Property permission and reporting metadata require separate qualification. */
export function validAutobrushGa4Grant(payload: unknown, config: Ga4AppConfig): payload is SavedAutobrushGa4Grant {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || config.propertyId !== propertyId) return false;
  const grant = payload as SavedAutobrushGa4Grant;
  const token = (value: unknown) => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value);
  return grant.appClientId === config.clientId && grant.propertyId === propertyId && grant.tokenType === 'Bearer' &&
    token(grant.accessToken) && token(grant.refreshToken) && Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > 0 &&
    Number.isFinite(new Date(grant.expiresAt).getTime()) && Array.isArray(grant.scopes) && grant.scopes.length === GA4_SCOPES.length &&
    GA4_SCOPES.every(scope => grant.scopes.includes(scope)) && typeof grant.authorizedAt === 'string' && Number.isFinite(Date.parse(grant.authorizedAt));
}
function trusted(request: Request, origin: string) {
  const url = new URL(request.url), claimedOrigin = request.headers.get('origin');
  const loopback = ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && request.headers.get('host') === new URL(origin).host;
  return (url.origin === origin || loopback) && (!claimedOrigin || claimedOrigin === origin);
}
function htmlStatus(authorized: boolean, origin: string) {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const label = authorized ? 'Google Analytics connected' : 'Google Analytics not connected';
  const href = authorized ? `${origin}/` : `${origin}${prefix}/connect`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${label}</title><style>html{color-scheme:dark}body{margin:0;background:#111318;color:#f5f5f5;font:18px/1.5 system-ui,sans-serif}main{max-width:34rem;margin:12vh auto;padding:2rem}h1{font-size:2rem}p{color:#b8bec9}a{color:#b8d5ff}</style></head><body><main><h1>${label}</h1><p>Reporting setup pending.</p><a href="${escape(href)}">${authorized ? 'Return to app' : 'Connect Google Analytics'}</a></main></body></html>`;
  return new Response(html, {headers: {...securityHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"}});
}

export function createAutobrushGa4ConnectionHandlers(deps: AutobrushGa4ConnectionDependencies) {
  const now = deps.now ?? Date.now;
  function settings() {
    const raw = deps.secret('AUTH_URL'), secret = deps.secret('AUTH_SECRET');
    if (!raw || !secret || secret.length < 32) throw Error('Missing configuration');
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Invalid origin');
    return {origin: url.origin, secret};
  }
  function config() {return ga4AppConfig(deps.secret,'autobrush');}
  function companyAdmin(current: AccessScope) {
    const scope = authorize(current, undefined, true), company = deps.secret('APP_ORGANIZATION_ID') || 'avenue-z';
    const validIdentity = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
    if (!validIdentity(scope.organizationId) || scope.organizationId !== company || !validIdentity(scope.actorId)) throw Error('Administrator access required');
    return scope;
  }
  async function protectedAccess() {
    const current = await deps.scope();
    if (!current) return null;
    try {return companyAdmin(current);} catch {return null;}
  }
  const identity = (scope: AccessScope) => ({organizationId: scope.organizationId, clientId: 'autobrush', provider: 'ga4'});
  return {
    async connect(request: Request): Promise<Response> {
      let setup;
      try {setup = settings();} catch {return response({error: 'GA4 connection is not configured'}, 503);}
      if (!trusted(request, setup.origin)) return response({error: 'Origin not allowed'}, 403);
      let current;
      try {current = await deps.scope();} catch {return response({error: 'GA4 connection access is unavailable'}, 503);}
      if (!current) {
        const target = new URL('/signin', setup.origin); target.searchParams.set('callbackUrl', `${prefix}/connect`);
        return redirect(target.toString());
      }
      let scope;
      try {scope = companyAdmin(current);} catch {return response({error: 'Administrator access required'}, 403);}
      let app;
      try {app = config();} catch {return response({error: 'GA4 connection is not configured'}, 503);}
      try {
        const saved = await readProviderCredential(deps.store(), identity(scope), setup.secret);
        if (validAutobrushGa4Grant(saved, app)) return redirect(`${setup.origin}${prefix}/status`);
      } catch {return response({error: 'GA4 connection storage is unavailable'}, 503);}
      try {
        const state = stateCookie(scope, app, setup.origin, setup.secret, now());
        return redirect(ga4AuthorizationUrl(app, `${setup.origin}${registeredCallbackPath}`, state.state, state.verifier), state.cookie);
      } catch {return response({error: 'GA4 connection is not configured'}, 503);}
    },
    async callback(request: Request): Promise<Response> {
      let setup;
      try {setup = settings();} catch {return response({error: 'GA4 connection is not configured'}, 503, true);}
      if (!trusted(request, setup.origin)) return response({error: 'Origin not allowed'}, 403, true);
      let scope;
      try {scope = await protectedAccess();} catch {return response({error: 'GA4 connection access is unavailable'}, 503, true);}
      if (!scope) return response({error: 'Administrator access required'}, 403, true);
      let app;
      try {app = config();} catch {return response({error: 'GA4 connection is not configured'}, 503, true);}
      let code: string, verifier: string;
      try {
        const at = now(), state = readState(request, scope, app, setup.origin, setup.secret, at);
        code = verifyGa4Callback(new URL(request.url).searchParams, state.state).code; verifier = state.verifier;
        consumeState(state.state, setup.secret, state.expiresAt, at);
      } catch {return response({error: 'GA4 authorization expired or could not be verified. Start the connection again.'}, 400, true);}
      let grant: SavedAutobrushGa4Grant;
      try {
        const at = now();
        grant = {...await exchangeGa4Code(app, code, `${setup.origin}${registeredCallbackPath}`, verifier, deps.fetcher, at),
          appClientId: app.clientId, propertyId: app.propertyId, authorizedAt: new Date(at).toISOString()};
        if (!validAutobrushGa4Grant(grant, app)) throw Error('Invalid grant');
      } catch {return response({error: 'GA4 did not authorize the required offline reporting access'}, 502, true);}
      try {await saveProviderCredential(deps.store(), identity(scope), grant, setup.secret);}
      catch {return response({error: 'GA4 authorization could not be stored. Start the connection again.'}, 503, true);}
      return redirect(`${setup.origin}${prefix}/status`, clearCookie);
    },
    async status(request: Request): Promise<Response> {
      let setup;
      try {setup = settings();} catch {return response({error: 'GA4 connection is not configured'}, 503);}
      if (!trusted(request, setup.origin)) return response({error: 'Origin not allowed'}, 403);
      let scope;
      try {scope = await protectedAccess();} catch {return response({error: 'GA4 connection access is unavailable'}, 503);}
      if (!scope) return response({error: 'Administrator access required'}, 403);
      let app;
      try {app = config();} catch {return response({error: 'GA4 connection is not configured'}, 503);}
      try {
        const grant = await readProviderCredential(deps.store(), identity(scope), setup.secret), authorized = validAutobrushGa4Grant(grant, app);
        const acceptsHtml = request.headers.get('accept')?.split(',').some(part => /^\s*text\/html(?:\s*;|\s*$)/i.test(part) && !/;\s*q=0(?:\.0*)?(?:\s*;|\s*$)/i.test(part));
        if (acceptsHtml) return htmlStatus(authorized, setup.origin);
        return response({clientId: 'autobrush', provider: 'ga4', propertyId: app.propertyId, authorized,
          scopes: authorized ? grant.scopes : [], authorizedAt: authorized ? grant.authorizedAt : null,
          expiresAt: authorized ? new Date(grant.expiresAt).toISOString() : null, reportingVerified: false});
      } catch {return response({error: 'GA4 connection storage is unavailable'}, 503);}
    },
  };
}
