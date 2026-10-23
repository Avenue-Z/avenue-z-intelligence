import {createHash} from 'node:crypto';
import {beforeEach,expect,it,vi} from 'vitest';
import type {AccessScope} from '../../lib/analytics/contracts';
import {createGa4ConnectionHandlers,validGa4Grant} from '../../lib/server/ga4-connection';
import type {SavedGa4Grant} from '../../lib/server/ga4-connection';
import {readProviderCredential,saveProviderCredential} from '../../lib/server/provider-credentials';

const origin='https://app.example',prefix='/api/integrations/ga4/beam',now=Date.parse('2026-10-16T19:00:00Z');
const analyticsScope='https://www.googleapis.com/auth/analytics.readonly';
const app={clientId:'test-ga4-app.apps.googleusercontent.com',clientSecret:'private-ga4-app-secret',propertyId:'292550743'};
const env:Record<string,string>={AUTH_URL:origin,AUTH_SECRET:'test-company-auth-secret-at-least-32-characters',SOURCE_BEAM_GA4:JSON.stringify(app)};
const admin:AccessScope={organizationId:'avenue-z',actorId:'google:admin',role:'admin',permittedClientIds:['beam','kind-patches']};
const identity={organizationId:admin.organizationId,clientId:'beam',provider:'ga4'};
let scope:AccessScope|null,rows:Map<string,string>,store:{first:ReturnType<typeof vi.fn>;run:ReturnType<typeof vi.fn>},fetcher:ReturnType<typeof vi.fn>;

beforeEach(()=>{
 scope={...admin};rows=new Map();
 store={first:vi.fn(async(_sql:string,...args:unknown[])=>{const payload=rows.get(JSON.stringify(args));return payload?{payload}:null;}),run:vi.fn(async(_sql:string,...args:unknown[])=>{rows.set(JSON.stringify(args.slice(0,3)),String(args[3]));return {meta:{changes:1}};})};
 fetcher=vi.fn(async()=>Response.json({access_token:'private-ga4-access-token',refresh_token:'private-ga4-refresh-token',expires_in:3600,token_type:'Bearer',scope:analyticsScope}));
});
const handlers=(changes:Partial<Record<string,string>>={},time=now)=>createGa4ConnectionHandlers({scope:async()=>scope,store:()=>store,secret:key=>({...env,...changes})[key]??null,fetcher:fetcher as typeof fetch,now:()=>time});
const request=(operation:string)=>new Request(`${origin}${prefix}/${operation}`);
const callback=(state:string)=>`${origin}${prefix}/callback?${new URLSearchParams({code:'one-time-code',state,iss:'https://accounts.google.com'})}`;
async function start(time=now){const response=await handlers({},time).connect(request('connect')),target=new URL(response.headers.get('location')!);return {response,target,state:target.searchParams.get('state')!,cookie:response.headers.get('set-cookie')!.split(';')[0]};}
const savedGrant=():SavedGa4Grant=>({accessToken:'private-ga4-access-token',refreshToken:'private-ga4-refresh-token',expiresAt:now+3600000,tokenType:'Bearer',scopes:[analyticsScope],appClientId:app.clientId,propertyId:app.propertyId,authorizedAt:new Date(now).toISOString()});

it('requires company sign-in and Beam administrator access for every protected operation',async()=>{
 scope=null;const login=await handlers().connect(request('connect')),target=new URL(login.headers.get('location')!);
 expect(login.status).toBe(303);expect(target.origin+target.pathname).toBe(`${origin}/signin`);expect(target.searchParams.get('callbackUrl')).toBe(`${prefix}/connect`);
 expect((await handlers().status(request('status'))).status).toBe(403);expect((await handlers().callback(request('callback'))).status).toBe(403);
 for(const denied of [{...admin,role:'analyst' as const},{...admin,role:'service' as const},{...admin,permittedClientIds:['kind-patches']}]){
  scope=denied;for(const operation of ['connect','callback','status'] as const)expect((await handlers()[operation](request(operation))).status).toBe(403);
 }
 expect(store.first).not.toHaveBeenCalled();expect(store.run).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
});

it('requests only read-only analytics access with offline PKCE and an encrypted ten-minute cookie',async()=>{
 const {response,target,state,cookie}=await start();
 expect(target.origin+target.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
 expect(target.searchParams.get('client_id')).toBe(app.clientId);expect(target.searchParams.get('redirect_uri')).toBe(`${origin}${prefix}/callback`);
 expect(target.searchParams.get('scope')).toBe(analyticsScope);expect(target.searchParams.get('access_type')).toBe('offline');
 expect(target.searchParams.get('code_challenge_method')).toBe('S256');expect(target.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(target.searchParams.has('code_verifier')).toBe(false);
 expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(cookie).toMatch(/^__Host-az-beam-ga4-oauth=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
 expect(cookie).not.toContain(state);expect(response.headers.get('set-cookie')).toContain('Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600');
 expect(response.headers.get('cache-control')).toContain('no-store');expect(response.headers.get('referrer-policy')).toBe('no-referrer');
 expect(response.headers.get('location')).not.toContain(app.clientSecret);expect(fetcher).not.toHaveBeenCalled();
});

it.each(['http://localhost:3000','http://127.0.0.1:3000','http://[::1]:3000'])('serves connect, callback and status through the Next loopback proxy at %s using the configured public host',async internal=>{
 const proxied=(path:string,cookie?:string)=>new Request(`${internal}${path}`,{headers:{host:'app.example',origin,...cookie?{cookie}:{}}});
 const connect=await handlers().connect(proxied(`${prefix}/connect`));expect(connect.status).toBe(303);
 const target=new URL(connect.headers.get('location')!);expect(target.origin).toBe('https://accounts.google.com');expect(target.searchParams.get('redirect_uri')).toBe(`${origin}${prefix}/callback`);
 const cookie=connect.headers.get('set-cookie')!.split(';')[0],state=target.searchParams.get('state')!;
 const complete=await handlers().callback(proxied(`${prefix}/callback?${new URL(callback(state)).searchParams}`,cookie));
 expect(complete.status).toBe(303);expect(complete.headers.get('location')).toBe(`${origin}/clients/beam`);expect(complete.headers.get('set-cookie')).toContain('Max-Age=0');
 const form=fetcher.mock.calls[0][1].body as URLSearchParams;expect(form.get('redirect_uri')).toBe(`${origin}${prefix}/callback`);
 const status=await handlers().status(proxied(`${prefix}/status`));expect(status.status).toBe(200);expect(await status.json()).toMatchObject({authorized:true,propertyId:'292550743'});
 scope=null;const login=await handlers().connect(proxied(`${prefix}/connect`));expect(login.status).toBe(303);expect(new URL(login.headers.get('location')!).origin).toBe(origin);
});

it('rejects proxy host and origin conflicts and arbitrary external request URLs carrying a spoofed public Host',async()=>{
 for(const operation of ['connect','callback','status'] as const){
  for(const [base,headers] of [
   ['http://localhost:3000',{host:'evil.example'}],['http://localhost:3000',{}],['http://localhost:3000',{host:'app.example',origin:'https://evil.example'}],
   ['https://evil.example',{host:'app.example'}],['http://10.0.0.1:3000',{host:'app.example'}],['http://localhost.evil.example:3000',{host:'app.example'}],
  ] as [string,Record<string,string>][]){
   expect((await handlers()[operation](new Request(`${base}${prefix}/${operation}`,{headers}))).status).toBe(403);
  }
 }
 expect(store.first).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
});

it('rejects hostile origins on all operations before accessing credentials or exchanging codes',async()=>{
 for(const operation of ['connect','callback','status'] as const){
  expect((await handlers()[operation](new Request(`https://evil.example${prefix}/${operation}`))).status).toBe(403);
  expect((await handlers()[operation](new Request(`${origin}${prefix}/${operation}`,{headers:{origin:'https://evil.example'}}))).status).toBe(403);
  expect((await handlers()[operation](new Request(`http://app.example${prefix}/${operation}`,{headers:{host:'app.example'}}))).status).toBe(403);
 }
 expect(store.first).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
});

it('requires the same authenticated actor and organization plus one untampered encrypted state cookie',async()=>{
 const {state,cookie}=await start();
 expect((await handlers().callback(new Request(callback(state)))).status).toBe(400);
 for(const changed of [{...admin,actorId:'google:another-admin'},{...admin,organizationId:'another-company'}]){scope=changed;expect((await handlers().callback(new Request(callback(state),{headers:{cookie}}))).status).toBe(400);}
 scope=admin;const changed=cookie.slice(0,-1)+(cookie.endsWith('a')?'b':'a');
 for(const invalid of [changed,`${cookie}; ${cookie}`,`${cookie}; __Host-az-beam-ga4-oauth=`]){
  const response=await handlers().callback(new Request(callback(state),{headers:{cookie:invalid}}));expect(response.status).toBe(400);expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
 }
 expect(fetcher).not.toHaveBeenCalled();expect(store.run).not.toHaveBeenCalled();
});

it('rejects expired and future-dated cookies, mismatched or duplicate state, and provider denial without exchanging a token',async()=>{
 const {state,cookie}=await start();
 expect((await handlers({},now+600000).callback(new Request(callback(state),{headers:{cookie}}))).status).toBe(400);
 expect((await handlers({},now-31000).callback(new Request(callback(state),{headers:{cookie}}))).status).toBe(400);
 for(const url of [callback('wrong-state'),`${callback(state)}&state=${state}`,`${callback(state)}&error=access_denied&error_description=private-ga4-refresh-token`,`${callback(state)}&code=second-code`]){
  const response=await handlers().callback(new Request(url,{headers:{cookie}}));expect(response.status).toBe(400);expect(await response.text()).not.toContain('private-ga4');expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
 }
 expect(fetcher).not.toHaveBeenCalled();expect(store.run).not.toHaveBeenCalled();
});

it('stores only an encrypted valid grant for the fixed Beam property and retains PKCE for the original authorization',async()=>{
 const {state,cookie,target}=await start(),response=await handlers().callback(new Request(callback(state),{headers:{cookie}}));
 expect(response.status).toBe(303);expect(response.headers.get('location')).toBe(`${origin}/clients/beam`);expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
 const form=fetcher.mock.calls[0][1].body as URLSearchParams;
 expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(target.searchParams.get('code_challenge'));
 expect(form.get('client_id')).toBe(app.clientId);expect(form.get('client_secret')).toBe(app.clientSecret);expect(form.get('redirect_uri')).toBe(`${origin}${prefix}/callback`);
 expect(store.run).toHaveBeenCalledOnce();expect(store.run.mock.calls[0].slice(1,4)).toEqual(['avenue-z','beam','ga4']);
 expect(store.run.mock.calls[0].join(' ')).not.toContain('private-ga4');
 const stored=await readProviderCredential(store,identity,env.AUTH_SECRET);
 expect(stored).toMatchObject(savedGrant());expect(validGa4Grant(stored,app)).toBe(true);
 const status=await handlers().status(request('status')),json=await status.json();
 expect(json).toMatchObject({clientId:'beam',provider:'ga4',propertyId:'292550743',authorized:true,scopes:[analyticsScope],reportingVerified:false});
 expect(JSON.stringify(json)).not.toContain('private-ga4');expect(json).not.toHaveProperty('accessToken');expect(json).not.toHaveProperty('refreshToken');expect(json).not.toHaveProperty('clientSecret');
 expect(status.headers.get('cache-control')).toContain('no-store');
 const revisit=await handlers().connect(request('connect'));expect(revisit.headers.get('location')).toBe(`${origin}/clients/beam`);expect(fetcher).toHaveBeenCalledOnce();
});

it.each([
 ['changed app',{appClientId:'another-app'}],['changed property',{propertyId:'999999999'}],['invalid access token',{accessToken:'bad\ntoken'}],['invalid refresh token',{refreshToken:'bad token'}],
 ['missing read-only scope',{scopes:[]}],['broader scope',{scopes:[analyticsScope,'openid']}],['duplicate scope',{scopes:[analyticsScope,analyticsScope]}],['wrong token type',{tokenType:'Basic'}],['invalid authorization time',{authorizedAt:'invalid'}],['invalid expiry',{expiresAt:0}],['unrepresentable expiry',{expiresAt:Number.MAX_SAFE_INTEGER}],
])('does not reuse a stored grant with %s',async(_label,changes)=>{
 await saveProviderCredential(store,identity,{...savedGrant(),...changes},env.AUTH_SECRET);
 const response=await handlers().status(request('status')),json=await response.json();expect(response.status).toBe(200);expect(json).toMatchObject({authorized:false,scopes:[],authorizedAt:null,expiresAt:null});expect(JSON.stringify(json)).not.toContain('private-ga4');
 const reconnect=await handlers().connect(request('connect'));expect(new URL(reconnect.headers.get('location')!).origin).toBe('https://accounts.google.com');expect(fetcher).not.toHaveBeenCalled();
});

it('retains offline authorization when only the short-lived access token has expired, without refreshing through status',async()=>{
 await saveProviderCredential(store,identity,{...savedGrant(),expiresAt:now-1000},env.AUTH_SECRET);
 const json=await (await handlers().status(request('status'))).json() as {authorized:boolean};expect(json.authorized).toBe(true);
 expect((await handlers().connect(request('connect'))).headers.get('location')).toBe(`${origin}/clients/beam`);expect(fetcher).not.toHaveBeenCalled();
});

it.each([
 {access_token:'private-ga4-access-token',expires_in:3600,token_type:'Bearer',scope:analyticsScope},
 {access_token:'private-ga4-access-token',refresh_token:'private-ga4-refresh-token',expires_in:3600,token_type:'Bearer',scope:`${analyticsScope} https://www.googleapis.com/auth/analytics.edit`},
 {access_token:'private-ga4-access-token',refresh_token:'private-ga4-refresh-token',expires_in:3600,token_type:'Bearer',scope:''},
])('does not persist an incomplete or over-scoped provider grant',async payload=>{
 const {state,cookie}=await start();fetcher.mockResolvedValueOnce(Response.json(payload));
 const response=await handlers().callback(new Request(callback(state),{headers:{cookie}}));expect(response.status).toBe(502);expect(response.headers.get('set-cookie')).toContain('Max-Age=0');expect(await response.text()).not.toContain('private-ga4');expect(store.run).not.toHaveBeenCalled();
});

it('sanitizes provider and credential-storage failures and clears callback state',async()=>{
 const {state,cookie}=await start();fetcher.mockResolvedValueOnce(Response.json({error:'private-ga4-access-token'},{status:400}));
 let response=await handlers().callback(new Request(callback(state),{headers:{cookie}}));expect(response.status).toBe(502);expect(await response.text()).not.toContain('private-ga4');expect(response.headers.get('set-cookie')).toContain('Max-Age=0');expect(store.run).not.toHaveBeenCalled();
 store.run.mockRejectedValueOnce(Error('private-ga4-refresh-token'));
 response=await handlers().callback(new Request(callback(state),{headers:{cookie}}));expect(response.status).toBe(503);expect(await response.text()).not.toContain('private-ga4');expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
 store.first.mockRejectedValueOnce(Error('private-ga4-app-secret'));
 response=await handlers().status(request('status'));expect(response.status).toBe(503);expect(await response.text()).not.toContain('private-ga4');
});

it.each([
 {SOURCE_BEAM_GA4:''},{SOURCE_BEAM_GA4:JSON.stringify({...app,propertyId:'999999999'})},{AUTH_SECRET:'short'},{AUTH_URL:'http://app.example'},{AUTH_URL:'https://app.example/other'},{AUTH_URL:'https://app.example/?secret=private-ga4-app-secret'},
])('fails closed when server configuration is missing, unsafe, or targets another property',async changes=>{
 for(const operation of ['connect','callback','status'] as const){const response=await handlers(changes)[operation](request(operation));expect(response.status).toBe(503);expect(await response.text()).not.toContain('private-ga4');}
 expect(store.first).not.toHaveBeenCalled();expect(store.run).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
});
