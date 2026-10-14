import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {fetchKindSource} from '../../lib/sources/kind-fetch';
import {rechargeProviderJson} from '../../lib/sources/recharge-provider-json';
import {kindQualification} from '../../lib/sources/kind-patches';
import {requireQualifiedSource,validateRegisteredBatch} from '../../lib/sources/registered-contract';
import {Store} from '../../lib/server/store';
import type {Client,Connection} from '../../lib/analytics/contracts';
import initial from '../../data/initial-clients.json';
vi.mock('@avenue/runtime',()=>({env:{},runtimePlatform:'sites'}));

const client=initial[0] as Client,source={provider:'kind-recharge-cancellations',endpoint:'https://api.rechargeapps.com'} as Connection;
const config={SHOP_DOMAIN:'bright-patches.myshopify.com',SHOPIFY_ADMIN_TOKEN:'private',TRIPLE_WHALE_SQL_KEY:'private',TRIPLE_WHALE_SUMMARY_KEY:'private',META_ACCESS_TOKEN:'private',META_AD_ACCOUNT_ID:'123',META_API_VERSION:'v24.0',META_TIME_ZONE:'Europe/Stockholm',APPLOVIN_REPORT_KEY:'private',RECHARGE_ADMIN_TOKEN:'private-provider-token'};
const url='https://api.rechargeapps.com/subscriptions?limit=250&cursor=private-cursor',options={headers:{'X-Recharge-Access-Token':'private-provider-token','X-Recharge-Version':'2021-11'}},timeout=()=>new DOMException('private customer@example.test timeout','TimeoutError');
let sqlite:DatabaseSync|undefined;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime('2026-10-14T14:00:00Z');});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();sqlite?.close();sqlite=undefined;});
function publicationStore(){
 const database=sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))database.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:unknown[]=[];const statement={sql,bind(...args:unknown[]){values=args;return statement;},async all(){return {results:database.prepare(sql).all(...values as SQLInputValue[])};},async first(){return database.prepare(sql).get(...values as SQLInputValue[])??null;},async run(){return {meta:{changes:Number(database.prepare(sql).run(...values as SQLInputValue[]).changes)}};}};return statement;};
 return new Store({prepare,batch:statements=>Promise.all(statements.map(statement=>statement.run()))});
}

it.each(['cancellation-state','creation-cohort'] as const)('retries the same historical %s cursor and publishes the complete deduplicated count batch',async failingPhase=>{
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{}),requests:{url:string;options:RequestInit|undefined}[]=[],window={from:'2026-09-18',to:'2026-09-18'};
 const records=[1,2].map(id=>({id,status:'cancelled',created_at:`2026-09-18T0${id+5}:00:00Z`,cancelled_at:`2026-09-18T${id===1?'08':'10'}:00:00Z`,updated_at:`2026-09-18T${id===1?'08':'10'}:00:00Z`}));
 let failed=false;
 const fetcher:typeof fetch=async(input,init)=>{
  const request=new URL(String(input));requests.push({url:String(input),options:init});
  if(request.pathname==='/store')return Response.json({store:{platform_domain:config.SHOP_DOMAIN,storefront_domain:'kindpatches.com',test_mode:false}});
  if(request.pathname==='/events')throw Error('Old dates must skip retained events');
  const cursor=request.searchParams.get('cursor'),phase=cursor?cursor==='private-cancel-cursor'?'cancellation-state':'creation-cohort':request.searchParams.has('created_at_min')?'creation-cohort':'cancellation-state';
  if(cursor&&phase===failingPhase&&!failed){failed=true;vi.setSystemTime(Date.now()+60003);throw timeout();}
  return Response.json({subscriptions:cursor?records:[records[0]],next_cursor:cursor?null:phase==='cancellation-state'?'private-cancel-cursor':'private-create-cursor'});
 };
 const batch=await fetchKindSource(source,client,window,JSON.stringify(config),fetcher,Date.now()+700000,new Date('2026-10-14T14:00:00Z'));
 validateRegisteredBatch(batch,requireQualifiedSource(kindQualification(batch,source.provider),client));
 expect(batch.complete).toBe(true);expect(batch.rows).toHaveLength(72);expect(batch.coverageThrough).toBe('2026-09-18T22:00:00Z');
 const repeated=requests.filter(request=>new URL(request.url).searchParams.get('cursor')===(failingPhase==='cancellation-state'?'private-cancel-cursor':'private-create-cursor'));
 expect(repeated).toHaveLength(2);expect(repeated[1].url).toBe(repeated[0].url);
 const {signal:firstSignal,...firstOptions}=repeated[0].options!,{signal:retrySignal,...retryOptions}=repeated[1].options!;
 expect(retryOptions).toEqual(firstOptions);expect(retrySignal).not.toBe(firstSignal);expect(retrySignal?.aborted).toBe(false);
 const store=publicationStore();await store.persistBatch('o','source',batch,'cursor-retry-capture',new Date().toISOString(),window);
 expect(await store.first('SELECT date FROM current_snapshots')).toEqual({date:'2026-09-18'});
 expect(await store.all("SELECT json_extract(payload,'$.metric') metric,COUNT(*) hours,SUM(json_extract(payload,'$.value')) value FROM observations GROUP BY metric ORDER BY metric")).toEqual([
  {metric:'new_subscriptions',hours:24,value:2},{metric:'same_day_subscription_cancellations',hours:24,value:2},{metric:'subscription_cancellations',hours:24,value:2},
 ]);
 expect(warn.mock.calls).toHaveLength(1);expect(warn.mock.calls[0]).toEqual(['Recharge provider cursor retry',expect.objectContaining({phase:failingPhase,cursor:true,retry:1,kind:'TimeoutError',requestTimeoutMs:60000})]);
 expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-|customer@example|X-Recharge|created_at|updated_at/);
});

it('stops after both exact-cursor requests fail and preserves the public provider error',async()=>{
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});let requests=0;
 await expect(rechargeProviderJson(async()=>{requests++;vi.setSystemTime(Date.now()+60000);throw timeout();},url,options,Date.now()+700000,'cancellation-state',true,60000)).rejects.toThrow('Provider request timed out or could not be reached');
 expect(requests).toBe(2);expect(warn.mock.calls.map(call=>call[0])).toEqual(['Recharge provider cursor retry','Recharge provider request failed']);
 expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-|customer@example|X-Recharge/);
});

it.each([60000,60001,150999])('does not add a cursor request when its %s ms initial budget cannot preserve full retry and publication headroom',async budget=>{
 vi.spyOn(console,'warn').mockImplementation(()=>{});let requests=0;
 await expect(rechargeProviderJson(async()=>{requests++;vi.setSystemTime(Date.now()+60000);throw timeout();},url,options,Date.now()+budget,'creation-cohort',true,60000)).rejects.toThrow('Provider request timed out or could not be reached');expect(requests).toBe(1);
});

it('permits one full retry at the exact 60-second plus 31-second publication reserve boundary',async()=>{
 vi.spyOn(console,'warn').mockImplementation(()=>{});let requests=0;
 const result=await rechargeProviderJson(async()=>{if(++requests===1){vi.setSystemTime(Date.now()+60000);throw timeout();}return Response.json({subscriptions:[],next_cursor:null});},url,options,Date.now()+151000,'creation-cohort',true,60000);
 expect(result).toEqual({subscriptions:[],next_cursor:null});expect(requests).toBe(2);
});

it.each([
 ['store-identity',false,25000],['cancellation-state',true,25000],['creation-cohort',true,25000],['retained-events',true,25000],['cancellation-state',false,180000],['creation-cohort',false,180000],
] as const)('does not retry %s with cursor=%s and request timeout=%s',async(phase,cursor,requestTimeout)=>{
 vi.spyOn(console,'warn').mockImplementation(()=>{});let requests=0;
 await expect(rechargeProviderJson(async()=>{requests++;throw timeout();},url,options,Date.now()+700000,phase,cursor,requestTimeout)).rejects.toThrow('Provider request timed out or could not be reached');expect(requests).toBe(1);
});

it.each([401,403,500])('does not add retries to a cursor HTTP %s response',async status=>{
 vi.spyOn(console,'warn').mockImplementation(()=>{});let requests=0;
 await expect(rechargeProviderJson(async()=>{requests++;return new Response('private customer body',{status});},url,options,Date.now()+700000,'cancellation-state',true,60000)).rejects.toThrow(`Provider returned HTTP ${status}`);expect(requests).toBe(1);
});

it('does not retry invalid cursor JSON or unrecognized failures',async()=>{
 vi.spyOn(console,'warn').mockImplementation(()=>{});let requests=0;
 await expect(rechargeProviderJson(async()=>{requests++;return new Response('private invalid json');},url,options,Date.now()+700000,'cancellation-state',true,60000)).rejects.toThrow('Provider returned invalid JSON');expect(requests).toBe(1);
 requests=0;await expect(rechargeProviderJson(async()=>{requests++;throw new TypeError('programmer error');},url,options,Date.now()+700000,'cancellation-state',true,60000)).rejects.toThrow('Provider request timed out or could not be reached');expect(requests).toBe(1);
});

it('retries a recognized connection failure only for the same idempotent GET',async()=>{
 vi.spyOn(console,'warn').mockImplementation(()=>{});let requests=0;
 const fetcher:typeof fetch=async()=>{if(++requests===1)throw new TypeError('fetch failed',{cause:Object.assign(new Error('private host'),{code:'ECONNRESET'})});return Response.json({subscriptions:[],next_cursor:null});};
 expect(await rechargeProviderJson(fetcher,url,options,Date.now()+700000,'cancellation-state',true,60000)).toEqual({subscriptions:[],next_cursor:null});expect(requests).toBe(2);
 requests=0;await expect(rechargeProviderJson(fetcher,url,{...options,method:'POST'},Date.now()+700000,'cancellation-state',true,60000)).rejects.toThrow('Provider request timed out or could not be reached');expect(requests).toBe(1);
});
