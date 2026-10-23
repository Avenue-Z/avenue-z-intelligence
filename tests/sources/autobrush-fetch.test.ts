import {beforeEach,expect,it,vi} from 'vitest';
import type {Client,Connection} from '../../lib/analytics/contracts';
import {saveProviderCredential,readProviderCredential} from '../../lib/server/provider-credentials';
import {fetchAutobrushSource} from '../../lib/sources/autobrush-fetch';
const calls=vi.hoisted(()=>({shopify:vi.fn(),motion:vi.fn(),intelligems:vi.fn()}));
vi.mock('../../lib/sources/autobrush-shopify',()=>({fetchAutobrushShopifySource:calls.shopify,AUTOBRUSH_SHOPIFY_ENDPOINT:'https://ama-brushh.myshopify.com/admin/api/2026-07/graphql.json'}));
vi.mock('../../lib/sources/autobrush-motion',()=>({fetchAutobrushMotionSource:calls.motion}));
vi.mock('../../lib/sources/autobrush-intelligems',()=>({fetchAutobrushIntelligemsSource:calls.intelligems}));
const now=new Date('2026-10-22T12:00:00Z'),window={from:'2026-10-22',to:'2026-10-22'};
const client={id:'autobrush',timezone:'America/New_York',currency:'USD'} as Client;
const secret='private-test-company-auth-secret-at-least-32-characters';
const env:Record<string,string>={AUTH_SECRET:secret,AUTOBRUSH_SHOPIFY_CLIENT_ID:'autobrush-app',AUTOBRUSH_SHOPIFY_CLIENT_SECRET:'private-app-secret',SOURCE_AUTOBRUSH_SHOPIFY:JSON.stringify({storeDomain:'ama-brushh.myshopify.com'}),SOURCE_AUTOBRUSH_MOTION:JSON.stringify({clientId:'autobrush-motion-app'}),SOURCE_AUTOBRUSH_INTELLIGEMS:'private-intelligems-key'};
let rows:Map<string,string>;
let store:{first:ReturnType<typeof vi.fn>;run:ReturnType<typeof vi.fn>};
beforeEach(()=>{vi.clearAllMocks();rows=new Map();store={first:vi.fn(async(_sql:string,...args:unknown[])=>{const payload=rows.get(JSON.stringify(args));return payload?{payload}:null;}),run:vi.fn(async(_sql:string,...args:unknown[])=>{rows.set(JSON.stringify(args.slice(0,3)),String(args[3]));return {meta:{changes:1}};})};});
const source=(provider:Connection['provider']='autobrush-shopify-sales'):Connection=>({id:provider,clientId:'autobrush',provider,name:provider,endpoint:provider==='autobrush-motion'?'https://projects.motionapp.com/mcp':provider==='autobrush-intelligems'?'https://api.intelligems.io/v25-10-beta':'https://ama-brushh.myshopify.com/admin/api/2026-07/graphql.json',secretRef:provider==='autobrush-motion'?'SOURCE_AUTOBRUSH_MOTION':provider==='autobrush-intelligems'?'SOURCE_AUTOBRUSH_INTELLIGEMS':'SOURCE_AUTOBRUSH_SHOPIFY',enabled:true,pollMinutes:60,lastSuccess:null,coverageThrough:null,error:null,version:1});
const read=(connection=source(),subject=client,org='avenue-z',fetcher?:typeof fetch)=>fetchAutobrushSource(connection,subject,window,store,org,key=>env[key]??null,fetcher,Date.now()+120000,now);
const grant={accessToken:'private-shopify-token',scopes:['read_orders','read_reports','read_products'],storeDomain:'ama-brushh.myshopify.com',appClientId:'autobrush-app',authorizedAt:now.toISOString()};
it('uses only the encrypted Autobrush Shopify grant and fixed store endpoint',async()=>{
 await saveProviderCredential(store,{organizationId:'avenue-z',clientId:'autobrush',provider:'shopify'},grant,secret);calls.shopify.mockResolvedValue({clientId:'autobrush',rows:[]});
 await read();expect(calls.shopify).toHaveBeenCalledOnce();expect(calls.shopify.mock.calls[0].slice(0,4)).toEqual([source(),client,window,'private-shopify-token']);
 expect(store.first.mock.calls.every(call=>call.slice(1,4).join(':')==='avenue-z:autobrush:shopify')).toBe(true);
});
it('rejects a foreign brand, organization, endpoint or secret reference before vault access',async()=>{
 for(const connection of [{...source(),clientId:'beam'},{...source(),endpoint:'https://evil.example'},{...source(),secretRef:'SOURCE_BEAM_SHOPIFY'}])await expect(read(connection)).rejects.toThrow();
 await expect(read(source(),{...client,id:'beam'})).rejects.toThrow();await expect(read(source(),client,'another-company')).rejects.toThrow();
 expect(store.first).not.toHaveBeenCalled();expect(calls.shopify).not.toHaveBeenCalled();
});
it('does not borrow Beam authorization when the Autobrush grant is absent or changed',async()=>{
 await saveProviderCredential(store,{organizationId:'avenue-z',clientId:'beam',provider:'shopify'},{...grant,storeDomain:'beamtlc.myshopify.com'},secret);
 await expect(read()).rejects.toThrow('not authorized');
 await saveProviderCredential(store,{organizationId:'avenue-z',clientId:'autobrush',provider:'shopify'},{...grant,appClientId:'another-app'},secret);
 await expect(read()).rejects.toThrow('not authorized');expect(calls.shopify).not.toHaveBeenCalled();
});
it('refreshes and encrypts only an expired Autobrush Motion grant before reading its reports',async()=>{
 const identity={organizationId:'avenue-z',clientId:'autobrush',provider:'motion'};
 await saveProviderCredential(store,identity,{accessToken:'private-old-access',refreshToken:'private-old-refresh',expiresAt:now.getTime()-1000,tokenType:'Bearer',scopes:['openid','profile','email','offline_access'],appClientId:'autobrush-motion-app',authorizedAt:now.toISOString()},secret);
 const fetcher=vi.fn(async()=>Response.json({access_token:'private-new-access',refresh_token:'private-new-refresh',expires_in:3600,token_type:'Bearer',scope:'openid profile email offline_access'}));
 calls.motion.mockImplementation(async()=>{expect(await readProviderCredential(store,identity,secret)).toMatchObject({accessToken:'private-new-access',refreshToken:'private-new-refresh'});return {clientId:'autobrush',rows:[]};});
 await read(source('autobrush-motion'),client,'avenue-z',fetcher as typeof fetch);
 expect(fetcher).toHaveBeenCalledOnce();expect(calls.motion.mock.calls[0][3]).toBe('private-new-access');expect(await readProviderCredential(store,{...identity,clientId:'beam'},secret)).toBeNull();
});
it('passes the server-side Intelligems credential only to the fixed Autobrush adapter',async()=>{
 calls.intelligems.mockResolvedValue({clientId:'autobrush',rows:[]});await read(source('autobrush-intelligems'));
 expect(calls.intelligems.mock.calls[0][3]).toBe('private-intelligems-key');expect(store.first).not.toHaveBeenCalled();expect(calls.shopify).not.toHaveBeenCalled();
});
it('resolves only the explicit Autobrush API-key environment reference without copying a credential',async()=>{
 const original=env.SOURCE_AUTOBRUSH_INTELLIGEMS;env.SOURCE_AUTOBRUSH_INTELLIGEMS=JSON.stringify({apiKeyEnv:'AUTOBRUSH_INTELLIGEMS_API_KEY'});env.AUTOBRUSH_INTELLIGEMS_API_KEY='private-existing-key';
 try{await read(source('autobrush-intelligems'));expect(calls.intelligems.mock.calls[0][3]).toBe('private-existing-key');env.SOURCE_AUTOBRUSH_INTELLIGEMS=JSON.stringify({apiKeyEnv:'SOURCE_BEAM_INTELLIGEMS'});await expect(read(source('autobrush-intelligems'))).rejects.toThrow();}
 finally{env.SOURCE_AUTOBRUSH_INTELLIGEMS=original;delete env.AUTOBRUSH_INTELLIGEMS_API_KEY;}
});
