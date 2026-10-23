import {it,expect,vi} from 'vitest';
import {fetchKindSource,fetchKindBatches} from '../../lib/sources/kind-fetch';
import {KIND_SOURCES,kindQualification} from '../../lib/sources/kind-patches';
import {validateRegisteredBatch} from '../../lib/sources/registered-contract';
import initial from '../../data/initial-clients.json';
import type {Client,Connection,SourceBatch} from '../../lib/analytics/contracts';
const client=initial[0] as Client,w={from:'2026-10-07',to:'2026-10-08'},secret=JSON.stringify({SHOP_DOMAIN:'bright-patches.myshopify.com',SHOPIFY_ADMIN_TOKEN:'private',TRIPLE_WHALE_SQL_KEY:'private',TRIPLE_WHALE_SUMMARY_KEY:'private',META_ACCESS_TOKEN:'private',META_AD_ACCOUNT_ID:'123',META_API_VERSION:'v24.0',META_TIME_ZONE:'Europe/Stockholm',APPLOVIN_REPORT_KEY:'private',RECHARGE_ADMIN_TOKEN:'private'});
it('will not forward the credential bundle to an edited endpoint or another client',async()=>{const source={...KIND_SOURCES[4],clientId:client.id,endpoint:'https://attacker.example'} as any;let requests=0;await expect(fetchKindSource(source,client,w,secret,async()=>{requests++;return Response.json({});})).rejects.toThrow('endpoint');expect(requests).toBe(0);await expect(fetchKindSource({...source,...KIND_SOURCES[4]}, {...client,id:'beam'},w,secret)).rejects.toThrow('Kind Patches');});
it.each(['https://r.applovin.com/report','https://r.applovin.com/webReport'])('dispatches the fixed AppLovin connection %s to the supported cost report',async endpoint=>{
 const source={...KIND_SOURCES.find(item=>item.provider==='kind-applovin')!,endpoint} as Connection;
 const fetcher:typeof fetch=async url=>{
  const u=new URL(String(url));if(u.origin!=='https://r.applovin.com'||u.pathname!=='/webReport'||u.searchParams.get('attribution_mode')!=='click')throw Error('Unsupported report');
  return Response.json({code:200,results:u.searchParams.get('columns')==='day,hour,cost'?[{day:'2026-10-13',hour:'14:00',cost:'20'}]:[{day:'2026-10-13',hour:'14:00',campaign:'Dream',campaign_id_external:'2',country:'US',cost:'20'}]});
 };
 const batch=await fetchKindSource(source,client,{from:'2026-10-13',to:'2026-10-13'},secret,fetcher,Date.now()+10000,new Date('2026-10-13T15:45:00Z'));
 expect(batch.coverageThrough).toBe('2026-10-13T15:00:00Z');expect(batch.rows).toHaveLength(1);expect(batch.rows[0]).toMatchObject({metric:'platform_spend',value:20,currency:'USD'});
 expect(()=>validateRegisteredBatch(batch,kindQualification(batch,'kind-applovin'))).not.toThrow();
});
it.each(['https://r.applovin.com/report?extra=1','https://r.applovin.com/webReport?extra=1','https://r.applovin.com/other','http://r.applovin.com/report','https://r.applovin.com.attacker.example/webReport'])('rejects the nonfixed AppLovin endpoint %s before forwarding credentials',async endpoint=>{
 let requests=0;const source={...KIND_SOURCES.find(item=>item.provider==='kind-applovin')!,endpoint} as Connection;
 await expect(fetchKindSource(source,client,w,secret,async()=>{requests++;return Response.json({});})).rejects.toThrow('endpoint');expect(requests).toBe(0);
});
it('records Recharge current active customers without relabeling them subscriptions or historical dates',async()=>{const source=KIND_SOURCES[6] as any;const result=await fetchKindSource(source,client,w,secret,async url=>Response.json(String(url).endsWith('/store')?{store:{platform_domain:'bright-patches.myshopify.com',storefront_domain:'kindpatches.com',test_mode:false}}:{count:12345}));expect(result.rows[0].metric).toBe('active_customers');expect(result.rows[0].value).toBe(12345);expect(result.rows[0].date).not.toBe('2026-10-07');});
it('rejects cross-store Recharge responses and redacts provider error bodies',async()=>{await expect(fetchKindSource(KIND_SOURCES[6] as any,client,w,secret,async()=>Response.json({store:{platform_domain:'other.myshopify.com'}}))).rejects.toThrow('identity');await expect(fetchKindSource(KIND_SOURCES[6] as any,client,w,secret,async()=>new Response('private-token',{status:403}))).rejects.toThrow('HTTP 403');});
it('honors a provider rate-limit retry for read-only requests without returning an empty success',async()=>{let count=0;const result=await fetchKindSource(KIND_SOURCES[6] as any,client,w,secret,async url=>{if(count++===0)return new Response('',{status:429,headers:{'Retry-After':'0'}});return Response.json(String(url).endsWith('/store')?{store:{platform_domain:'bright-patches.myshopify.com',storefront_domain:'kindpatches.com',test_mode:false}}:{count:50});});expect(result.rows[0].value).toBe(50);expect(count).toBe(3);});
it.each(['kind-shopify-sales','kind-shopify-products'])('%s publishes a real qualified closed-day batch at store hour zero',async provider=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-13T22:35:00Z');try{
  const source=KIND_SOURCES.find(item=>item.provider===provider)! as Connection,queries:string[]=[];
  const fetcher:typeof fetch=async(_url,options)=>{const query=JSON.parse(String(options?.body)).query;queries.push(query);if(query.includes('shop {'))return Response.json({data:{shop:{ianaTimezone:client.timezone,currencyCode:client.currency,myshopifyDomain:'bright-patches.myshopify.com'}}});
   const row={day:'2026-10-13',sales_channel:'Online Store',product_title_at_time_of_sale:'Dream Mag',net_sales:30,gross_sales:40,discounts:-7,returns:-3,orders:2,...query.includes('day,hour_of_day')?{hour_of_day:23}:{}};
   return Response.json({data:{shopifyqlQuery:{parseErrors:[],tableData:{columns:[],rows:[row]}}}});
  };
  const batches:{batch:SourceBatch;window:{from:string;to:string}}[]=[];for await(const part of fetchKindBatches(source,client,{from:'2026-10-14',to:'2026-10-14'},secret,fetcher,Date.now()+180000))batches.push(part);
  expect(batches).toHaveLength(1);expect(batches[0].window).toEqual({from:'2026-10-13',to:'2026-10-13'});expect(batches[0].batch.coverageThrough).toBe('2026-10-13T22:00:00Z');
  expect(batches[0].batch.rows.every(row=>row.date==='2026-10-13')).toBe(true);expect(batches[0].batch.rows.filter(row=>row.metric==='orders')).toHaveLength(24);
  expect(queries.filter(query=>query.includes('shopifyqlQuery')).every(query=>query.includes('SINCE 2026-10-13 UNTIL 2026-10-13'))).toBe(true);
  expect(()=>validateRegisteredBatch(batches[0].batch,kindQualification(batches[0].batch,source.provider))).not.toThrow();
 }finally{vi.useRealTimers();}
});

it('keeps private customer routes out of hourly public-page funnels while preserving authoritative human totals',async()=>{
 const routes=['/pages/glp','/checkout/token','/checkouts/token','/orders/token','/account','/cart/c/token','/tools/recurring/portal','/a/account/login'];
 const fetcher:typeof fetch=async(_url,options)=>{const query=JSON.parse(String(options?.body)).query;if(query.includes('shop {'))return Response.json({data:{shop:{ianaTimezone:'Europe/Stockholm',currencyCode:'USD',myshopifyDomain:'bright-patches.myshopify.com'}}});
  const exclusions=[...String(query).matchAll(/landing_page_path NOT STARTS WITH '([^']+)'/g)].map(m=>m[1]);const selected=routes.filter(path=>!exclusions.some(prefix=>path.startsWith(prefix)));
  const counts={sessions:7,sessions_with_cart_additions:3,sessions_that_reached_checkout:2,sessions_that_completed_checkout:1};
  const rows=query.includes('landing_page_path,session_country')?selected.map(path=>({day:'2026-10-07',hour_of_day:2,landing_page_path:path,session_country:'United States',...counts})):[{day:'2026-10-07',...query.includes('GROUP BY day,hour_of_day')?{hour_of_day:2}:{},...Object.fromEntries(Object.entries(counts).map(([key,n])=>[key,n*selected.length]))}];return Response.json({data:{shopifyqlQuery:{parseErrors:[],tableData:{columns:[],rows}}}});
 };
 const batch=await fetchKindSource(KIND_SOURCES[2] as Connection,client,{from:'2026-10-07',to:'2026-10-07'},secret,fetcher,Date.now()+10000,new Date('2026-10-08T12:00:00Z'));
 expect(batch.rows.filter(r=>r.dataset==='funnels'&&r.metric==='sessions').map(r=>r.dimensions.page)).toEqual(['/pages/glp']);
 expect(batch.rows.filter(r=>r.dataset==='overview'&&r.metric==='sessions').reduce((sum,row)=>sum+row.value!,0)).toBe(56);
});

it('rejects private routes returned by a provider despite the hourly public-page filter',async()=>{
 const counts={sessions:7,sessions_with_cart_additions:3,sessions_that_reached_checkout:2,sessions_that_completed_checkout:1};
 const fetcher:typeof fetch=async(_url,options)=>{const query=JSON.parse(String(options?.body)).query;if(query.includes('shop {'))return Response.json({data:{shop:{ianaTimezone:'Europe/Stockholm',currencyCode:'USD',myshopifyDomain:'bright-patches.myshopify.com'}}});const rows=[{day:'2026-10-07',...query.includes('GROUP BY day,hour_of_day')?{hour_of_day:2}:{},...counts,...query.includes('landing_page_path,session_country')?{landing_page_path:'/a/account/customer',session_country:'United States'}:{}}];return Response.json({data:{shopifyqlQuery:{parseErrors:[],tableData:{columns:[],rows}}}});};
 await expect(fetchKindSource(KIND_SOURCES[2] as Connection,client,{from:'2026-10-07',to:'2026-10-07'},secret,fetcher)).rejects.toThrow('Private landing page');
});
