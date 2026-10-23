import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import type {AccessScope} from '../analytics/contracts';
import {exchangeShopifyCode, parseShopifyAppConfig, SHOPIFY_REPORTING_SCOPES, shopifyAuthorizationUrl, verifyShopifyCallback} from '../sources/shopify-auth';
import type {ShopifyAppConfig} from '../sources/shopify-auth';
import {authorize} from './policy';
import {readProviderCredential, saveProviderCredential} from './provider-credentials';
import type {Store} from './store';

export type AutobrushShopifyConnectionDependencies = {
  scope: () => Promise<AccessScope | null>;
  store: () => Pick<Store, 'first' | 'run'>;
  secret: (key: string) => string | null;
  fetcher?: typeof fetch;
  now?: () => number;
};
type Grant = {accessToken: string; scopes: string[]; storeDomain: string; appClientId: string; authorizedAt: string};
const prefix = '/api/integrations/shopify/autobrush', cookieName = '__Host-az-autobrush-shopify-oauth';
const shop = 'ama-brushh.myshopify.com', lifetime = 600_000;
const cookieOptions = 'Path=/; Secure; HttpOnly; SameSite=Lax';
const clearCookie = `${cookieName}=; ${cookieOptions}; Max-Age=0`;
const securityHeaders = {'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'};
// This suppresses duplicate/concurrent callbacks in a warm process. Shopify's
// single-use authorization code remains the replay boundary across processes.
const consumedStates = new Map<string, number>();

function response(body: unknown, status = 200, clear = false) {
  return Response.json(body, {status, headers: {...securityHeaders, ...(clear ? {'Set-Cookie': clearCookie} : {})}});
}
function redirect(location: string, cookie?: string) {
  return new Response(null, {status: 303, headers: {...securityHeaders, Location: location, ...(cookie ? {'Set-Cookie': cookie} : {})}});
}
function signature(value: string, secret: string) {
  return createHmac('sha256', secret).update('autobrush-shopify-state:v1:').update(value).digest('base64url');
}
function actor(scope: AccessScope) {
  return createHash('sha256').update(JSON.stringify([scope.organizationId, scope.actorId])).digest('base64url');
}
function same(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function stateCookie(scope: AccessScope, secret: string, now: number) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(now + lifetime)) throw Error('Invalid state time');
  const state = randomBytes(32).toString('base64url');
  const encoded = Buffer.from(JSON.stringify({state, actor: actor(scope), issuedAt: now, expiresAt: now + lifetime})).toString('base64url');
  return {state, cookie: `${cookieName}=${encoded}.${signature(encoded, secret)}; ${cookieOptions}; Max-Age=600`};
}
function readState(request: Request, scope: AccessScope, secret: string, now: number) {
  const matches = (request.headers.get('cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
  if (matches.length !== 1 || matches[0].length > 2_048 || !Number.isSafeInteger(now)) throw Error('Invalid state');
  const parts = matches[0].slice(cookieName.length + 1).split('.');
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)) || !same(parts[1], signature(parts[0], secret))) throw Error('Invalid state');
  const bytes = Buffer.from(parts[0], 'base64url');
  if (bytes.toString('base64url') !== parts[0]) throw Error('Invalid state');
  const data = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as Record<string, unknown>;
  if (typeof data.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.state) || data.actor !== actor(scope) || typeof data.issuedAt !== 'number' || !Number.isSafeInteger(data.issuedAt) || typeof data.expiresAt !== 'number' || !Number.isSafeInteger(data.expiresAt) || data.expiresAt - data.issuedAt !== lifetime || data.issuedAt > now + 30_000 || data.expiresAt <= now) throw Error('Invalid state');
  return {state: data.state, expiresAt: data.expiresAt};
}
function consumeState(state: string, secret: string, expiresAt: number, now: number) {
  for (const [key, expiry] of consumedStates) if (expiry <= now) consumedStates.delete(key);
  const key = signature(`consumed:${state}`, secret);
  if (consumedStates.has(key) || consumedStates.size >= 10_000) throw Error('Invalid state');
  consumedStates.set(key, expiresAt);
}
function validGrant(value: unknown, config: ShopifyAppConfig): value is Grant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const grant = value as Grant;
  return grant.storeDomain === shop && grant.storeDomain === config.storeDomain && grant.appClientId === config.clientId && typeof grant.accessToken === 'string' && /^[\x21-\x7e]{1,4096}$/.test(grant.accessToken) && Array.isArray(grant.scopes) && grant.scopes.every(scope => typeof scope === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(scope)) && new Set(grant.scopes).size === grant.scopes.length && SHOPIFY_REPORTING_SCOPES.every(scope => grant.scopes.includes(scope)) && typeof grant.authorizedAt === 'string' && Number.isFinite(Date.parse(grant.authorizedAt));
}
function trusted(request: Request, origin: string) {
  const url = new URL(request.url), claimedOrigin = request.headers.get('origin');
  const loopback = ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && request.headers.get('host') === new URL(origin).host;
  return (url.origin === origin || loopback) && (!claimedOrigin || claimedOrigin === origin);
}
function allowedShop(request: Request) {
  const shops = new URL(request.url).searchParams.getAll('shop');
  return shops.length === 0 || shops.length === 1 && shops[0] === shop;
}
function htmlStatus(authorized: boolean, origin: string) {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const label = authorized ? 'Shopify connected' : 'Shopify not connected';
  const href = authorized ? `${origin}/` : `${origin}${prefix}/connect`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${label}</title><style>html{color-scheme:dark}body{margin:0;background:#111318;color:#f5f5f5;font:18px/1.5 system-ui,sans-serif}main{max-width:34rem;margin:12vh auto;padding:2rem}h1{font-size:2rem}p{color:#b8bec9}a{color:#b8d5ff}</style></head><body><main><h1>${label}</h1><p>Reporting setup pending.</p><a href="${escape(href)}">${authorized ? 'Return to app' : 'Connect Shopify'}</a></main></body></html>`;
  return new Response(html, {headers: {...securityHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"}});
}

export function createAutobrushShopifyConnectionHandlers(deps: AutobrushShopifyConnectionDependencies) {
  const now = deps.now ?? Date.now;
  function settings() {
    const raw = deps.secret('AUTH_URL'), secret = deps.secret('AUTH_SECRET');
    if (!raw || !secret || secret.length < 32) throw Error('Missing configuration');
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Invalid origin');
    return {origin: url.origin, secret};
  }
  function config() {
    return parseShopifyAppConfig(JSON.stringify({storeDomain: shop, clientId: deps.secret('AUTOBRUSH_SHOPIFY_CLIENT_ID'), clientSecret: deps.secret('AUTOBRUSH_SHOPIFY_CLIENT_SECRET')}));
  }
  function companyAdmin(current: AccessScope) {
    const scope = authorize(current, undefined, true);
    if (scope.organizationId !== (deps.secret('APP_ORGANIZATION_ID') || 'avenue-z') || typeof scope.actorId !== 'string' || !scope.actorId) throw Error('Administrator access required');
    return scope;
  }
  const identity = (scope: AccessScope) => ({organizationId: scope.organizationId, clientId: 'autobrush', provider: 'shopify'});
  async function protectedAccess() {
    const current = await deps.scope();
    if (!current) return null;
    try {return companyAdmin(current);} catch {return null;}
  }
  return {
    async connect(request: Request): Promise<Response> {
      let setup;
      try {setup = settings();} catch {return response({error: 'Shopify connection is not configured'}, 503);}
      if (!trusted(request, setup.origin)) return response({error: 'Origin not allowed'}, 403);
      let current;
      try {current = await deps.scope();} catch {return response({error: 'Shopify connection access is unavailable'}, 503);}
      if (!current) {
        const target = new URL('/signin', setup.origin); target.searchParams.set('callbackUrl', `${prefix}/connect`);
        return redirect(target.toString());
      }
      let scope;
      try {scope = companyAdmin(current);} catch {return response({error: 'Administrator access required'}, 403);}
      if (!allowedShop(request)) return response({error: 'Store not allowed'}, 400);
      let app;
      try {app = config();} catch {return response({error: 'Shopify connection is not configured'}, 503);}
      try {
        const saved = await readProviderCredential(deps.store(), identity(scope), setup.secret);
        if (validGrant(saved, app)) return redirect(`${setup.origin}${prefix}/status`);
      } catch {return response({error: 'Shopify connection storage is unavailable'}, 503);}
      try {
        const state = stateCookie(scope, setup.secret, now());
        return redirect(shopifyAuthorizationUrl(app, `${setup.origin}${prefix}/callback`, state.state), state.cookie);
      } catch {return response({error: 'Shopify connection is not configured'}, 503);}
    },
    async callback(request: Request): Promise<Response> {
      let setup;
      try {setup = settings();} catch {return response({error: 'Shopify connection is not configured'}, 503, true);}
      if (!trusted(request, setup.origin)) return response({error: 'Origin not allowed'}, 403, true);
      let scope;
      try {scope = await protectedAccess();} catch {return response({error: 'Shopify connection access is unavailable'}, 503, true);}
      if (!scope) return response({error: 'Administrator access required'}, 403, true);
      if (!allowedShop(request)) return response({error: 'Store not allowed'}, 400, true);
      let app;
      try {app = config();} catch {return response({error: 'Shopify connection is not configured'}, 503, true);}
      let code;
      try {
        const at = now(), state = readState(request, scope, setup.secret, at), params = new URL(request.url).searchParams;
        if (params.has('error') || params.has('error_description')) throw Error('Authorization denied');
        code = verifyShopifyCallback(params, app, state.state, at).code;
        consumeState(state.state, setup.secret, state.expiresAt, at);
      } catch {return response({error: 'Shopify authorization expired or could not be verified. Start the connection again.'}, 400, true);}
      let grant;
      try {grant = await exchangeShopifyCode(app, code, deps.fetcher);} catch {return response({error: 'Shopify did not authorize the required offline reporting access'}, 502, true);}
      try {
        await saveProviderCredential(deps.store(), identity(scope), {...grant, storeDomain: shop, appClientId: app.clientId, authorizedAt: new Date(now()).toISOString()} satisfies Grant, setup.secret);
      } catch {return response({error: 'Shopify authorization could not be stored. Start the connection again.'}, 503, true);}
      return redirect(`${setup.origin}${prefix}/status`, clearCookie);
    },
    async status(request: Request): Promise<Response> {
      let setup;
      try {setup = settings();} catch {return response({error: 'Shopify connection is not configured'}, 503);}
      if (!trusted(request, setup.origin)) return response({error: 'Origin not allowed'}, 403);
      let scope;
      try {scope = await protectedAccess();} catch {return response({error: 'Shopify connection access is unavailable'}, 503);}
      if (!scope) return response({error: 'Administrator access required'}, 403);
      if (!allowedShop(request)) return response({error: 'Store not allowed'}, 400);
      let app;
      try {app = config();} catch {return response({error: 'Shopify connection is not configured'}, 503);}
      try {
        const grant = await readProviderCredential(deps.store(), identity(scope), setup.secret), authorized = validGrant(grant, app);
        if (request.headers.get('accept')?.split(',').some(part => /^\s*text\/html(?:\s*;|\s*$)/i.test(part) && !/;\s*q=0(?:\.0*)?(?:\s*;|\s*$)/i.test(part))) return htmlStatus(authorized, setup.origin);
        return response({clientId: 'autobrush', provider: 'shopify', storeDomain: shop, authorized, scopes: authorized ? grant.scopes : [], authorizedAt: authorized ? grant.authorizedAt : null, reportingVerified: false});
      } catch {return response({error: 'Shopify connection storage is unavailable'}, 503);}
    },
  };
}
