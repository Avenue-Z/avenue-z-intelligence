import {describe,it,expect,vi} from 'vitest';
import {fetchKindSource,effectiveKindWindow} from '../../lib/sources/kind-fetch';
import {kindQualification} from '../../lib/sources/kind-patches';
import {requireQualifiedSource,validateRegisteredBatch} from '../../lib/sources/registered-contract';
import initial from '../../data/initial-clients.json';
import type {Client,Connection} from '../../lib/analytics/contracts';
const client=initial[0] as Client,source={provider:'kind-recharge-cancellations',endpoint:'https://api.rechargeapps.com'} as Connection;
const config={SHOP_DOMAIN:'bright-patches.myshopify.com',SHOPIFY_ADMIN_TOKEN:'private',TRIPLE_WHALE_SQL_KEY:'private',TRIPLE_WHALE_SUMMARY_KEY:'private',META_ACCESS_TOKEN:'private',META_AD_ACCOUNT_ID:'123',META_API_VERSION:'v24.0',META_TIME_ZONE:'Europe/Stockholm',APPLOVIN_REPORT_KEY:'private',RECHARGE_ADMIN_TOKEN:'private'};
const secret=JSON.stringify(config),asOf=new Date('2026-10-12T12:35:00Z'),window={from:'2026-10-10',to:'2026-10-12'};
const store={store:{platform_domain:'bright-patches.myshopify.com',storefront_domain:'kindpatches.com',test_mode:false,currency:'USD'}};
const record=(id:number,cancelled_at:string,updated_at='2026-10-12T12:30:00Z')=>({id,status:'cancelled',cancelled_at,updated_at,customer_id:12345,cancellation_reason_comments:'private customer text'});
const read=(rows:unknown[],next_cursor:string|null=null):typeof fetch=>async url=>String(url).endsWith('/store')?Response.json(store):Response.json({subscriptions:new URL(String(url)).searchParams.has('created_at_min')?[]:rows,next_cursor:new URL(String(url)).searchParams.has('created_at_min')?null:next_cursor,previous_cursor:null});
const execute=(fetcher:typeof fetch,w=window,now=asOf)=>fetchKindSource(source,client,w,secret,fetcher,Date.now()+10000,now);
const total=(rows:{date:string;value:number|null}[],date:string)=>rows.filter(row=>row.date===date&&(!('metric' in row)||row.metric==='subscription_cancellations')).reduce((sum,row)=>sum+(row.value??0),0);
describe('Recharge cancellation-date feed',()=>{
 it('captures a large historical cancellation cohort beyond the routine polling cap without persisting subscription identities',async()=>{
  let pages=0;
  const fetcher:typeof fetch=async url=>{if(String(url).endsWith('/store'))return Response.json(store);if(new URL(String(url)).searchParams.has('created_at_min'))return Response.json({subscriptions:[],next_cursor:null});const page=pages++;return Response.json({subscriptions:Array.from({length:250},(_,index)=>record(page*250+index+1,'2026-10-02T10:00:00Z','2026-10-02T10:00:00Z')),next_cursor:pages<201?`page${pages}`:null});};
  const batch=await fetchKindSource(source,client,{from:'2026-09-13',to:'2026-10-12'},secret,fetcher,Date.now()+120000,new Date('2026-10-13T12:00:00Z'));
  expect(pages).toBe(201);expect(total(batch.rows,'2026-10-02')).toBe(50250);expect(batch.rows).toHaveLength(30*24*3);expect(batch.rows.every(row=>row.quality==='complete')).toBe(true);
  expect(JSON.stringify(batch)).not.toContain('customer_id');expect(JSON.stringify(batch)).not.toContain('cancellation_reason_comments');expect(()=>validateRegisteredBatch(batch,requireQualifiedSource(kindQualification(batch,source.provider),client))).not.toThrow();
 });
 it('allows bounded longer historical cursor reads while keeping routine polling and the source deadline capped',async()=>{
  const timeout=vi.spyOn(AbortSignal,'timeout');
  try{
   await fetchKindSource(source,client,{from:'2026-10-01',to:'2026-10-04'},secret,read([]),Date.now()+240000,asOf);
   expect(timeout.mock.calls.map(call=>call[0])).toEqual([25000,180000,180000]);timeout.mockClear();
   await fetchKindSource(source,client,window,secret,read([]),Date.now()+120000,asOf);
   expect(timeout.mock.calls.map(call=>call[0])).toEqual([25000,25000,25000]);timeout.mockClear();
   await fetchKindSource(source,client,{from:'2026-10-01',to:'2026-10-04'},secret,read([]),Date.now()+5000,asOf);
   expect(timeout.mock.calls.every(call=>call[0]>0&&call[0]<=5000)).toBe(true);
  }finally{timeout.mockRestore();}
 });
 it('bounds automatic initialization and refresh to two closed days plus the partial current day',()=>{
  expect(effectiveKindWindow(source,client,{from:'2026-08-01',to:'2026-10-12'},asOf)).toEqual({from:'2026-10-10',to:'2026-10-12'});
  expect(effectiveKindWindow(source,client,{from:'2026-10-11',to:'2026-10-12'},asOf)).toEqual({from:'2026-10-11',to:'2026-10-12'});
  expect(effectiveKindWindow(source,client,{from:'2026-10-01',to:'2026-10-04'},asOf)).toEqual({from:'2026-10-01',to:'2026-10-04'});
 });
 it('maps UTC cancellation timestamps into Stockholm calendar days and keeps today at the completed-hour cutoff',async()=>{
  const requests:URL[]=[];
  const fetcher:typeof fetch=async(url,options)=>{requests.push(new URL(String(url)));expect(new Headers(options?.headers).get('X-Recharge-Version')).toBe('2021-11');return read([record(1,'2026-10-10T21:59:59Z'),record(2,'2026-10-10T22:00:00'),record(3,'2026-10-11T23:00:00+01:00'),record(4,'2026-10-12T12:05:00Z'),record(5,'2026-10-12T11:59:00Z')])(url,options);};
  const batch=await execute(fetcher);
  expect(total(batch.rows,'2026-10-10')).toBe(1);expect(total(batch.rows,'2026-10-11')).toBe(1);expect(total(batch.rows,'2026-10-12')).toBe(2);
  expect(batch.coverageThrough).toBe('2026-10-12T12:00:00Z');expect(batch.grain).toBe('hourly');
  expect(batch.rows.filter(row=>row.date==='2026-10-12').every(row=>row.quality==='partial'&&Date.parse(row.end!)<=Date.parse(batch.coverageThrough!))).toBe(true);
  expect(requests[1].searchParams.get('status')).toBe('cancelled');expect(requests[1].searchParams.get('limit')).toBe('250');
  expect(requests[1].searchParams.get('updated_at_min')).toBe('2026-10-09T21:59:58');
  expect(batch.rows.every(row=>row.dataset==='subscriptionEvents'&&['subscription_cancellations','new_subscriptions','same_day_subscription_cancellations'].includes(row.metric)&&row.currency===null)).toBe(true);
  expect(JSON.stringify(batch)).not.toContain('customer_id');expect(JSON.stringify(batch)).not.toContain('private customer text');
 });
 it('preserves midnight cancellations when the cancellation write timestamp follows updated_at by one second',async()=>{
  const batch=await execute(read([record(1,'2026-10-10T22:00:00Z','2026-10-10T21:59:59Z')]),{from:'2026-10-11',to:'2026-10-11'});expect(total(batch.rows,'2026-10-11')).toBe(1);
  await expect(execute(read([record(1,'2026-10-11T10:00:02Z','2026-10-11T10:00:00Z')]))).rejects.toThrow('updated-time ordering');
 });
 it('finishes cursor pagination and deduplicates the same subscription cancellation across page boundaries',async()=>{
  let pages=0;const fetcher:typeof fetch=async url=>{if(String(url).endsWith('/store'))return Response.json(store);const params=new URL(String(url)).searchParams;if(params.has('created_at_min'))return Response.json({subscriptions:[],next_cursor:null});pages++;if(!params.get('cursor'))return Response.json({subscriptions:[record(1,'2026-10-10T22:00:00Z')],next_cursor:'page2',previous_cursor:null});expect(params.get('cursor')).toBe('page2');if(params.has('status')||params.has('updated_at_min'))return new Response('Cursor cannot be combined with filter params',{status:422});return Response.json({subscriptions:[record(1,'2026-10-10T22:00:00Z'),record(2,'2026-10-10T23:00:00Z')],next_cursor:null,previous_cursor:'page1'});};
  const batch=await execute(fetcher);expect(pages).toBe(2);expect(total(batch.rows,'2026-10-11')).toBe(2);
  const contract=requireQualifiedSource(kindQualification(batch,source.provider),client);expect(()=>validateRegisteredBatch(batch,contract)).not.toThrow();expect(contract.reconciliationEvidence).toContain('reactivated');
 });
 it('reports zero for a closed date only after an explicitly complete query',async()=>{
  const batch=await execute(read([]),{from:'2026-10-11',to:'2026-10-11'});expect(batch.rows).toHaveLength(24*3);expect(batch.rows.every(row=>row.value===0&&row.quality==='complete')).toBe(true);
  await expect(execute(async url=>String(url).endsWith('/store')?Response.json(store):Response.json({subscriptions:[]}))).rejects.toThrow('pagination');
 });
 it('handles both occurrences of the repeated DST hour and the skipped spring hour',async()=>{
  const fall=await execute(read([record(1,'2026-10-25T00:30:00Z','2026-10-25T02:00:00Z'),record(2,'2026-10-25T01:30:00Z','2026-10-25T02:00:00Z')]),{from:'2026-10-25',to:'2026-10-25'},new Date('2026-10-26T12:00:00Z'));
  expect(fall.rows.find(row=>row.start==='2026-10-25T00:00:00Z')).toMatchObject({end:'2026-10-25T02:00:00Z',value:2});expect(total(fall.rows,'2026-10-25')).toBe(2);
  const spring=await execute(read([record(1,'2026-03-29T00:59:00Z','2026-03-29T04:00:00Z'),record(2,'2026-03-29T01:00:00Z','2026-03-29T04:00:00Z')]),{from:'2026-03-29',to:'2026-03-29'},new Date('2026-03-30T12:00:00Z'));
  expect(spring.rows).toHaveLength(23*3);expect(total(spring.rows,'2026-03-29')).toBe(2);expect(spring.coverageThrough).toBe('2026-03-29T22:00:00Z');
 });
 it('fails unavailable if pagination does not advance, records exceed the bound, or required scope is missing',async()=>{
  await expect(execute(read([record(1,'2026-10-11T10:00:00Z')],'same'))).rejects.toThrow('pagination');
  await expect(execute(read(Array.from({length:251},(_,index)=>record(index+1,'2026-10-11T10:00:00Z'))))).rejects.toThrow('limit');
  await expect(execute(async url=>String(url).endsWith('/store')?Response.json(store):new Response('private-token',{status:403}))).rejects.toThrow('HTTP 403');
 });
 it('rejects ignored filters, changed cancellation timestamps, unknown timestamps and cross-store identity',async()=>{
  await expect(execute(read([record(1,'2026-10-09T10:00:00Z','2026-10-09T10:01:00Z')]))).rejects.toThrow('updated');
  await expect(execute(read([{...record(1,'2026-10-11T10:00:00Z'),status:'active',cancelled_at:null}]))).rejects.toThrow('cancelled');
  await expect(execute(read([record(1,'2026-10-11T10:00:00Z'),record(1,'2026-10-11T11:00:00Z')]))).rejects.toThrow('changed');
  await expect(execute(read([record(1,'not-a-date')]))).rejects.toThrow('timestamp');
  await expect(execute(async()=>Response.json({store:{...store.store,platform_domain:'other.myshopify.com'}}))).rejects.toThrow('identity');
 });
});
