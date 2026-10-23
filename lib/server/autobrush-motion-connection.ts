import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
import type {AccessScope} from '../analytics/contracts';
import {exchangeMotionCode, MOTION_SCOPES, motionAuthorizationUrl, parseMotionAppConfig, verifyMotionCallback} from '../sources/motion-auth';
import type {MotionGrant} from '../sources/motion-auth';
import {authorize} from './policy';
import {readProviderCredential, saveProviderCredential} from './provider-credentials';
import type {Store} from './store';

export type AutobrushMotionConnectionDependencies = {
  scope: () => Promise<AccessScope | null>;
  store: () => Pick<Store, 'first' | 'run'>;
  secret: (key: string) => string | null;
  fetcher?: typeof fetch;
  now?: () => number;
};
type SavedGrant = MotionGrant & {appClientId: string; authorizedAt: string};
const prefix = '/api/integrations/motion/autobrush', cookieName = '__Host-az-autobrush-motion-oauth', lifetime = 600_000;
const expectedOrganizationId = '699496be6f1a754daac7f10e', expectedWorkspaceId = '6ac52fac7231e870caa82acb';
const cookieOptions = 'Path=/; Secure; HttpOnly; SameSite=Lax';
const clearCookie = `${cookieName}=; ${cookieOptions}; Max-Age=0`;
const securityHeaders = {'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'};
// Warm-process guard only. The provider's one-use authorization code and PKCE
// remain the cross-process replay boundary; no shared nonce store is created.
const consumedStates = new Map<string, number>();

function response(body: unknown, status = 200, clear = false) {
  return Response.json(body, {status, headers: {...securityHeaders, ...(clear ? {'Set-Cookie': clearCookie} : {})}});
}
function redirect(location: string, cookie?: string) {
  return new Response(null, {status: 303, headers: {...securityHeaders, Location: location, ...(cookie ? {'Set-Cookie': cookie} : {})}});
}
function stateKey(secret: string) {
  return createHash('sha256').update('avenue-z:autobrush-motion-state:v1:').update(secret).digest();
}
function actor(scope: AccessScope) {
  return createHash('sha256').update(JSON.stringify([scope.organizationId, scope.actorId])).digest('base64url');
}
function stateCookie(scope: AccessScope, secret: string, now: number) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + lifetime)) throw Error('Invalid state time');
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
  const plaintext = Buffer.from(JSON.stringify({state, verifier, actor: actor(scope), issuedAt: now, expiresAt: now + lifetime}));
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', stateKey(secret), iv);
  cipher.setAAD(Buffer.from(cookieName));
  const value = ['v1', iv.toString('base64url'), Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  return {state, verifier, cookie: `${cookieName}=${value}; ${cookieOptions}; Max-Age=600`};
}
function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error('Invalid state');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw Error('Invalid state');
  return bytes;
}
function readState(request: Request, scope: AccessScope, secret: string, now: number) {
  const matches = (request.headers.get('cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
  if (matches.length !== 1 || matches[0].length > 4_096 || !Number.isSafeInteger(now) || now < 0) throw Error('Invalid state');
  const parts = matches[0].slice(cookieName.length + 1).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw Error('Invalid state');
  const iv = decode(parts[1]), encrypted = decode(parts[2]), tag = decode(parts[3]);
  if (iv.length !== 12 || tag.length !== 16) throw Error('Invalid state');
  const decipher = createDecipheriv('aes-256-gcm', stateKey(secret), iv);
  decipher.setAAD(Buffer.from(cookieName)); decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const data = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(plaintext)) as Record<string, unknown>;
  if (typeof data.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.state) || typeof data.verifier !== 'string' || !/^[A-Za-z0-9_-]{64}$/.test(data.verifier) || data.actor !== actor(scope) || typeof data.issuedAt !== 'number' || !Number.isSafeInteger(data.issuedAt) || data.issuedAt < 0 || typeof data.expiresAt !== 'number' || !Number.isSafeInteger(data.expiresAt) || data.expiresAt - data.issuedAt !== lifetime || data.issuedAt > now + 30_000 || data.expiresAt <= now) throw Error('Invalid state');
  return {state: data.state, verifier: data.verifier, expiresAt: data.expiresAt};
}
function consumeState(state: string, secret: string, expiresAt: number, now: number) {
  for (const [key, expiry] of consumedStates) if (expiry <= now) consumedStates.delete(key);
  const key = createHash('sha256').update(stateKey(secret)).update(state).digest('hex');
  if (consumedStates.has(key) || consumedStates.size >= 10_000) throw Error('Invalid state');
  consumedStates.set(key, expiresAt);
}
function validGrant(value: unknown, clientId: string): value is SavedGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const grant = value as SavedGrant;
  const token = (value: unknown) => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value);
  return grant.appClientId === clientId && grant.tokenType === 'Bearer' && token(grant.accessToken) && token(grant.refreshToken) && Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > 0 && Number.isFinite(new Date(grant.expiresAt).getTime()) && Array.isArray(grant.scopes) && grant.scopes.length > 0 && grant.scopes.length <= MOTION_SCOPES.length && new Set(grant.scopes).size === grant.scopes.length && grant.scopes.includes('offline_access') && grant.scopes.every(scope => typeof scope === 'string' && (MOTION_SCOPES as readonly string[]).includes(scope)) && typeof grant.authorizedAt === 'string' && Number.isFinite(Date.parse(grant.authorizedAt));
}
function trusted(request: Request, origin: string) {
  const url = new URL(request.url), claimedOrigin = request.headers.get('origin');
  const loopback = ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && request.headers.get('host') === new URL(origin).host;
  return (url.origin === origin || loopback) && (!claimedOrigin || claimedOrigin === origin);
}
function htmlStatus(authorized: boolean, origin: string) {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const label = authorized ? 'Motion connected' : 'Motion not connected', href = authorized ? `${origin}/` : `${origin}${prefix}/connect`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${label}</title><style>html{color-scheme:dark}body{margin:0;background:#111318;color:#f5f5f5;font:18px/1.5 system-ui,sans-serif}main{max-width:34rem;margin:12vh auto;padding:2rem}h1{font-size:2rem}p{color:#b8bec9}a{color:#b8d5ff}</style></head><body><main><h1>${label}</h1><p>Reporting setup pending.</p><a href="${escape(href)}">${authorized ? 'Return to app' : 'Connect Motion'}</a></main></body></html>`;
  return new Response(html, {headers: {...securityHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"}});
}

export function createAutobrushMotionConnectionHandlers(deps: AutobrushMotionConnectionDependencies) {
  const now = deps.now ?? Date.now;
  function settings() {
    const raw = deps.secret('AUTH_URL'), secret = deps.secret('AUTH_SECRET');
    if (!raw || !secret || secret.length < 32) throw Error('Missing configuration');
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Invalid origin');
    return {origin: url.origin, secret};
  }
  function companyAdmin(current: AccessScope) {
    const scope = authorize(current, undefined, true);
    if (scope.organizationId !== (deps.secret('APP_ORGANIZATION_ID') || 'avenue-z') || typeof scope.actorId !== 'string' || !scope.actorId) throw Error('Administrator access required');
    return scope;
  }
  async function protectedAccess() {
    const current = await deps.scope();
    if (!current) return null;
    try {return companyAdmin(current);} catch {return null;}
  }
  const identity = (scope: AccessScope) => ({organizationId: scope.organizationId, clientId: 'autobrush', provider: 'motion'});
  const config = () => parseMotionAppConfig(deps.secret('SOURCE_AUTOBRUSH_MOTION') || '');
  return {
    async connect(request: Request): Promise<Response> {
      let setup;
      try {setup = settings();} catch {return response({error: 'Motion connection is not configured'}, 503);}
      if (!trusted(request, setup.origin)) return response({error: 'Origin not allowed'}, 403);
      let current;
      try {current = await deps.scope();} catch {return response({error: 'Motion connection access is unavailable'}, 503);}
      if (!current) {
        const target = new URL('/signin', setup.origin); target.searchParams.set('callbackUrl', `${prefix}/connect`);
        return redirect(target.toString());
      }
      let scope;
      try {scope = companyAdmin(current);} catch {return response({error: 'Administrator access required'}, 403);}
      let app;
      try {app = config();} catch {return response({error: 'Motion connection is not configured'}, 503);}
      try {
        const saved = await readProviderCredential(deps.store(), identity(scope), setup.secret);
        if (validGrant(saved, app.clientId)) return redirect(`${setup.origin}${prefix}/status`);
      } catch {return response({error: 'Motion connection storage is unavailable'}, 503);}
      try {
        const state = stateCookie(scope, setup.secret, now());
        return redirect(motionAuthorizationUrl(app, `${setup.origin}${prefix}/callback`, state.state, state.verifier), state.cookie);
      } catch {return response({error: 'Motion connection is not configured'}, 503);}
    },
    async callback(request: Request): Promise<Response> {
      let setup;
      try {setup = settings();} catch {return response({error: 'Motion connection is not configured'}, 503, true);}
      if (!trusted(request, setup.origin)) return response({error: 'Origin not allowed'}, 403, true);
      let scope;
      try {scope = await protectedAccess();} catch {return response({error: 'Motion connection access is unavailable'}, 503, true);}
      if (!scope) return response({error: 'Administrator access required'}, 403, true);
      let app;
      try {app = config();} catch {return response({error: 'Motion connection is not configured'}, 503, true);}
      let code: string, verifier: string;
      try {
        const at = now(), state = readState(request, scope, setup.secret, at);
        code = verifyMotionCallback(new URL(request.url).searchParams, state.state).code; verifier = state.verifier;
        consumeState(state.state, setup.secret, state.expiresAt, at);
      } catch {return response({error: 'Motion authorization expired or could not be verified. Start the connection again.'}, 400, true);}
      let grant: SavedGrant;
      try {
        grant = {...await exchangeMotionCode(app, code, `${setup.origin}${prefix}/callback`, verifier, deps.fetcher, now()), appClientId: app.clientId, authorizedAt: new Date(now()).toISOString()};
        if (!validGrant(grant, app.clientId)) throw Error('Invalid grant');
      } catch {return response({error: 'Motion did not authorize the required offline reporting access'}, 502, true);}
      try {await saveProviderCredential(deps.store(), identity(scope), grant, setup.secret);} catch {return response({error: 'Motion authorization could not be stored. Start the connection again.'}, 503, true);}
      return redirect(`${setup.origin}${prefix}/status`, clearCookie);
    },
    async status(request: Request): Promise<Response> {
      let setup;
      try {setup = settings();} catch {return response({error: 'Motion connection is not configured'}, 503);}
      if (!trusted(request, setup.origin)) return response({error: 'Origin not allowed'}, 403);
      let scope;
      try {scope = await protectedAccess();} catch {return response({error: 'Motion connection access is unavailable'}, 503);}
      if (!scope) return response({error: 'Administrator access required'}, 403);
      let app;
      try {app = config();} catch {return response({error: 'Motion connection is not configured'}, 503);}
      try {
        const grant = await readProviderCredential(deps.store(), identity(scope), setup.secret), authorized = validGrant(grant, app.clientId);
        if (request.headers.get('accept')?.split(',').some(part => /^\s*text\/html(?:\s*;|\s*$)/i.test(part) && !/;\s*q=0(?:\.0*)?(?:\s*;|\s*$)/i.test(part))) return htmlStatus(authorized, setup.origin);
        return response({clientId: 'autobrush', provider: 'motion', authorized, scopes: authorized ? grant.scopes : [], authorizedAt: authorized ? grant.authorizedAt : null, expiresAt: authorized ? new Date(grant.expiresAt).toISOString() : null, expectedOrganizationId, expectedWorkspaceId, workspaceVerified: false, reportingVerified: false});
      } catch {return response({error: 'Motion connection storage is unavailable'}, 503);}
    },
  };
}
