import {afterEach,describe,expect,it,vi} from 'vitest';
import {fetchKindSource} from '../../lib/sources/kind-fetch';
import type {Client,Connection} from '../../lib/analytics/contracts';
import initial from '../../data/initial-clients.json';

const client=initial[0] as Client,source={provider:'kind-recharge-cancellations',endpoint:'https://api.rechargeapps.com'} as Connection;
const secret=JSON.stringify({SHOP_DOMAIN:'bright-patches.myshopify.com',SHOPIFY_ADMIN_TOKEN:'private',TRIPLE_WHALE_SQL_KEY:'private',TRIPLE_WHALE_SUMMARY_KEY:'private',META_ACCESS_TOKEN:'private',META_AD_ACCOUNT_ID:'123',META_API_VERSION:'v24.0',META_TIME_ZONE:'Europe/Stockholm',APPLOVIN_REPORT_KEY:'private',RECHARGE_ADMIN_TOKEN:'never-log-this-token'});
const store={store:{platform_domain:'bright-patches.myshopify.com',storefront_domain:'kindpatches.com',test_mode:false}};
const historical={from:'2026-09-18',to:'2026-09-18'},asOf=new Date('2026-10-14T14:00:00Z');
const execute=(fetcher:typeof fetch,deadline=Date.now()+700000,window=historical)=>fetchKindSource(source,client,window,secret,fetcher,deadline,asOf);
afterEach(()=>vi.restoreAllMocks());

describe('Recharge provider failure diagnostics',()=>{
 it('labels the failed identity read while excluding credentials, query strings and arbitrary provider error details',async()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{}),error=new TypeError('customer@example.test https://private.test?token=secret',{cause:Object.assign(new Error('private subscription 123456'),{code:'UND_ERR_CONNECT_TIMEOUT'})});
  await expect(execute(async()=>{throw error;})).rejects.toThrow('Provider request timed out or could not be reached');
  expect(warn.mock.calls).toHaveLength(1);
  expect(warn.mock.calls[0]).toEqual(['Recharge provider request failed',expect.objectContaining({service:'recharge',resource:'store',phase:'store-identity',cursor:false,requestPhase:'fetch',kind:'TypeError',causeCode:'UND_ERR_CONNECT_TIMEOUT',status:null,requestTimeoutMs:25000})]);
  const output=JSON.stringify(warn.mock.calls);for(const value of ['never-log-this-token','customer@example.test','private.test','private subscription','123456','X-Recharge','updated_at_min'])expect(output).not.toContain(value);
 });

 it.each([
  ['cancellation-state',false],['cancellation-state',true],['creation-cohort',false],['creation-cohort',true],
 ] as const)('attributes a %s failure with cursor=%s even when the cursor URL has no filters',async(phase,cursor)=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});let nextPhase='cancellation-state',page=0;
  const fetcher:typeof fetch=async input=>{
   const url=new URL(String(input));if(url.pathname==='/store')return Response.json(store);
   if(url.pathname==='/events')throw Error('Historical dates must skip retained events');
   if(url.searchParams.has('created_at_min')){nextPhase='creation-cohort';page=0;}
   const currentCursor=url.searchParams.has('cursor');if(nextPhase===phase&&currentCursor===cursor)throw Object.assign(new Error('private-cursor customer@example.test'),{name:'TimeoutError',cause:{code:'not-public-private-code'}});
   if(nextPhase===phase&&cursor&&page++===0)return Response.json({subscriptions:[],next_cursor:'private-cursor'});
   return Response.json({subscriptions:[],next_cursor:null});
  };
  await expect(execute(fetcher)).rejects.toThrow('Provider request timed out or could not be reached');
  expect(warn.mock.calls).toHaveLength(1);
  expect(warn.mock.calls[0]).toEqual(['Recharge provider request failed',expect.objectContaining({service:'recharge',resource:'subscriptions',phase,cursor,requestPhase:'fetch',kind:'TimeoutError',causeCode:'other',requestTimeoutMs:cursor?60000:180000})]);
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-cursor|customer@example|not-public-private-code|created_at_min|updated_at_min/);
 });

 it('labels the retained event boundary separately from the two subscription scans',async()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  await expect(execute(async input=>{const url=new URL(String(input));if(url.pathname==='/store')return Response.json(store);if(url.pathname==='/events')throw new DOMException('private event details','AbortError');return Response.json({subscriptions:[],next_cursor:null});},Date.now()+700000,{from:'2026-10-13',to:'2026-10-13'})).rejects.toThrow('Provider request timed out or could not be reached');
  expect(warn.mock.calls[0]).toEqual(['Recharge provider request failed',expect.objectContaining({resource:'events',phase:'retained-events',cursor:false,requestPhase:'fetch',kind:'AbortError',causeCode:'none',requestTimeoutMs:25000})]);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private event details');
 });

 it('reports deadline-clipped request budgets without changing the public timeout error',async()=>{
  let now=Date.parse('2026-10-14T14:00:00Z');vi.spyOn(Date,'now').mockImplementation(()=>now);const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  await expect(execute(async()=>{now+=1200;throw new DOMException('private details','TimeoutError');},now+1200)).rejects.toThrow('Provider request timed out or could not be reached');
  expect(warn.mock.calls[0]).toEqual(['Recharge provider request failed',expect.objectContaining({elapsedMs:1200,remainingBudgetMs:1200,remainingBudgetAfterMs:0,requestTimeoutMs:1200,kind:'TimeoutError'})]);
 });

 it('preserves response failures while logging only a whitelisted phase and HTTP status',async()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  await expect(execute(async()=>new Response('private customer response token',{status:503}))).rejects.toThrow('Provider returned HTTP 503');
  expect(warn.mock.calls[0]).toEqual(['Recharge provider request failed',expect.objectContaining({resource:'store',phase:'store-identity',requestPhase:'response',status:503,kind:'Error',causeCode:'none'})]);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private customer response');
 });

 it('does not emit per-page success logs or change successful historical count captures',async()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  const batch=await execute(async input=>String(input).endsWith('/store')?Response.json(store):Response.json({subscriptions:[],next_cursor:null}));
  expect(batch.complete).toBe(true);expect(batch.rows).toHaveLength(72);expect(batch.rows.every(row=>row.value===0&&row.date==='2026-09-18')).toBe(true);expect(warn).not.toHaveBeenCalled();
 });

 it('keeps logging failures from replacing the original synchronization error',async()=>{
  vi.spyOn(console,'warn').mockImplementation(()=>{throw Error('logging unavailable');});
  await expect(execute(async()=>{throw new TypeError('private failure');})).rejects.toThrow('Provider request timed out or could not be reached');
 });
});
