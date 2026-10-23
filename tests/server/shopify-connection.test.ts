import {createHmac} from 'node:crypto';
import {beforeEach,expect,it,vi} from 'vitest';
import {createShopifyConnectionHandlers} from '../../lib/server/shopify-connection';
import type {AccessScope} from '../../lib/analytics/contracts';

const origin='https://app.example',prefix='/api/integrations/shopify/beam',now=Date.parse('2026-10-16T16:30:00Z');
const app={storeDomain:'beamtlc.myshopify.com',clientId:'test-app-id',clientSecret:'test-shopify-app-secret-32-characters'};
const env:Record<string,string>={AUTH_URL:origin,AUTH_SECRET:'test-company-auth-secret-at-least-32-characters',SOURCE_BEAM_SHOPIFY:JSON.stringify(app)};
const admin:AccessScope={organizationId:'avenue-z',actorId:'google:admin',role:'admin',permittedClientIds:['beam','kind-patches']};
let scope:AccessScope|null,rows:Map<string,string>,store:{first:ReturnType<typeof vi.fn>;run:ReturnType<typeof vi.fn>},fetcher:ReturnType<typeof vi.fn>;
beforeEach(()=>{
 scope={...admin};rows=new Map();
 store={first:vi.fn(async(_sql:string,...args:unknown[])=>{const payload=rows.get(JSON.stringify(args));return payload?{payload}:null;}),run:vi.fn(async(_sql:string,...args:unknown[])=>{rows.set(JSON.stringify(args.slice(0,3)),String(args[3]));return {meta:{changes:1}};})};
 fetcher=vi.fn(async()=>Response.json({access_token:'private-offline-token',scope:'read_reports,read_orders,read_products'}));
});
const handlers=(changes:Record<string,string>={})=>createShopifyConnectionHandlers({scope:async()=>scope,store:()=>store,secret:key=>({...env,...changes})[key]??null,fetcher:fetcher as typeof fetch,now:()=>now});
function signedCallback(state:string,code='one-time-code'){
 const p=new URLSearchParams({code,shop:app.storeDomain,state,timestamp:String(now/1000)});
 p.sort();const message=p.toString().replaceAll('+','%20');p.set('hmac',createHmac('sha256',app.clientSecret).update(message).digest('hex'));
 return `${origin}${prefix}/callback?${p}`;
}
async function start(){const r=await handlers().connect(new Request(`${origin}${prefix}/connect`));const destination=new URL(r.headers.get('location')!);return {response:r,state:destination.searchParams.get('state')!,cookie:r.headers.get('set-cookie')!.split(';')[0]};}

it('requires company sign-in before creating a Shopify authorization state',async()=>{
 scope=null;const r=await handlers().connect(new Request(`${origin}${prefix}/connect`));
 expect(r.status).toBe(303);const target=new URL(r.headers.get('location')!);expect(target.origin).toBe(origin);expect(target.pathname).toBe('/signin');expect(target.searchParams.get('callbackUrl')).toBe(`${prefix}/connect`);expect(r.headers.get('set-cookie')).toBeNull();
});
it.each([{...admin,role:'analyst' as const},{...admin,permittedClientIds:['kind-patches']}])('does not authorize an analyst or a user without Beam access',async denied=>{
 scope=denied;expect((await handlers().connect(new Request(`${origin}${prefix}/connect`))).status).toBe(403);expect(fetcher).not.toHaveBeenCalled();expect(store.run).not.toHaveBeenCalled();
});
it('starts an offline flow at the configured store with a secure actor-bound state cookie',async()=>{
 const {response,state}=await start(),target=new URL(response.headers.get('location')!);
 expect(target.origin).toBe(`https://${app.storeDomain}`);expect(target.pathname).toBe('/admin/oauth/authorize');expect(target.searchParams.get('redirect_uri')).toBe(`${origin}${prefix}/callback`);expect(target.searchParams.get('scope')).toBe('read_reports,read_orders,read_products');expect(state.length).toBeGreaterThan(30);expect(target.searchParams.has('grant_options[]')).toBe(false);
 expect(response.headers.get('set-cookie')).toContain('__Host-az-beam-shopify-oauth=');expect(response.headers.get('set-cookie')).toContain('Secure');expect(response.headers.get('set-cookie')).toContain('HttpOnly');expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');expect(response.headers.get('cache-control')).toContain('no-store');
 expect(response.headers.get('location')).not.toContain(app.clientSecret);
});
it('rejects a hostile host or store before accessing credentials or Shopify',async()=>{
 expect((await handlers().connect(new Request(`https://evil.example${prefix}/connect`))).status).toBe(403);
 expect((await handlers().connect(new Request(`${origin}${prefix}/connect?shop=other.myshopify.com`))).status).toBe(400);
 expect(fetcher).not.toHaveBeenCalled();
});
it('requires a valid state cookie and authenticated admin before exchanging a code',async()=>{
 const {state,cookie}=await start();
 expect((await handlers().callback(new Request(signedCallback(state)))).status).toBe(400);
 scope=null;expect((await handlers().callback(new Request(signedCallback(state),{headers:{cookie}}))).status).toBe(403);
 expect(fetcher).not.toHaveBeenCalled();expect(store.run).not.toHaveBeenCalled();
});
it('rejects tampered, duplicate, expired and different-actor state cookies',async()=>{
 const {state,cookie}=await start();
 const tampered=cookie.slice(0,-1)+(cookie.endsWith('a')?'b':'a');
 expect((await handlers().callback(new Request(signedCallback(state),{headers:{cookie:tampered}}))).status).toBe(400);
 expect((await handlers().callback(new Request(signedCallback(state),{headers:{cookie:`${cookie}; ${cookie}`}}))).status).toBe(400);
 scope={...admin,actorId:'google:other-admin'};expect((await handlers().callback(new Request(signedCallback(state),{headers:{cookie}}))).status).toBe(400);scope={...admin};
 const later=createShopifyConnectionHandlers({scope:async()=>scope,store:()=>store,secret:key=>env[key]??null,fetcher:fetcher as typeof fetch,now:()=>now+11*60000});
 expect((await later.callback(new Request(signedCallback(state),{headers:{cookie}}))).status).toBe(400);expect(fetcher).not.toHaveBeenCalled();
});
it('saves the verified offline grant as ciphertext and returns only safe authorization status',async()=>{
 const {state,cookie}=await start(),r=await handlers().callback(new Request(signedCallback(state),{headers:{cookie}}));
 expect(r.status).toBe(303);expect(r.headers.get('location')).toBe(`${origin}/clients/beam`);expect(r.headers.get('set-cookie')).toContain('Max-Age=0');
 expect(store.run).toHaveBeenCalledOnce();expect(store.run.mock.calls[0].join(' ')).not.toContain('private-offline-token');
 const status=await handlers().status(new Request(`${origin}${prefix}/status`));const json=await status.json();
 expect(json).toMatchObject({clientId:'beam',provider:'shopify',storeDomain:app.storeDomain,authorized:true,scopes:['read_reports','read_orders','read_products']});expect(JSON.stringify(json)).not.toContain('private-offline-token');expect(JSON.stringify(json)).not.toContain(app.clientSecret);
 const revisit=await handlers().connect(new Request(`${origin}${prefix}/connect`));expect(revisit.headers.get('location')).toBe(`${origin}/clients/beam`);expect(fetcher).toHaveBeenCalledOnce();
});
it('rejects callback tampering without exchanging or saving anything',async()=>{
 const {state,cookie}=await start(),target=new URL(signedCallback(state));target.searchParams.set('code','tampered-code');
 const r=await handlers().callback(new Request(target,{headers:{cookie}}));expect(r.status).toBe(400);expect(fetcher).not.toHaveBeenCalled();expect(store.run).not.toHaveBeenCalled();
});
it('fails closed and returns no tokens when Shopify rejects the grant or persistence fails',async()=>{
 const {state,cookie}=await start();fetcher.mockResolvedValueOnce(Response.json({error:'denied',error_description:'private-offline-token'},{status:400}));
 let r=await handlers().callback(new Request(signedCallback(state),{headers:{cookie}}));expect(r.status).toBe(502);expect(await r.text()).not.toContain('private-offline-token');expect(store.run).not.toHaveBeenCalled();
 store.run.mockRejectedValueOnce(new Error('private-offline-token'));r=await handlers().callback(new Request(signedCallback(state),{headers:{cookie}}));expect(r.status).toBe(503);expect(await r.text()).not.toContain('private-offline-token');
});
it('protects status and missing configuration without provider or storage writes',async()=>{
 scope=null;expect((await handlers().status(new Request(`${origin}${prefix}/status`))).status).toBe(403);scope=admin;
 const r=await handlers({SOURCE_BEAM_SHOPIFY:''}).connect(new Request(`${origin}${prefix}/connect`));expect(r.status).toBe(503);expect(await r.text()).not.toContain(app.clientSecret);expect(store.run).not.toHaveBeenCalled();
});
