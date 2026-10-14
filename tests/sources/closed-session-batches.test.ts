import {afterEach,expect,it,vi} from 'vitest';
import {fetchKindBatches} from '../../lib/sources/kind-fetch';
import {KIND_SOURCES} from '../../lib/sources/kind-patches';
import type {Client,Connection} from '../../lib/analytics/contracts';
import initial from '../../data/initial-clients.json';
const client=initial[0] as Client,secret=JSON.stringify({SHOP_DOMAIN:'bright-patches.myshopify.com',SHOPIFY_ADMIN_TOKEN:'private',TRIPLE_WHALE_SQL_KEY:'private',TRIPLE_WHALE_SUMMARY_KEY:'private',META_ACCESS_TOKEN:'private',META_AD_ACCOUNT_ID:'123',META_API_VERSION:'v24.0',META_TIME_ZONE:'Europe/Stockholm',APPLOVIN_REPORT_KEY:'private',RECHARGE_ADMIN_TOKEN:'private'});
afterEach(()=>vi.useRealTimers());
const window={from:'2026-10-08',to:'2026-10-14'};
function fixture(queries:string[]):typeof fetch{return async(_url,options)=>{
 const query=JSON.parse(String(options?.body)).query;queries.push(query);
 if(query.includes('shop {'))return Response.json({data:{shop:{ianaTimezone:client.timezone,currencyCode:client.currency,myshopifyDomain:'bright-patches.myshopify.com'}}});
 const day=query.match(/SINCE (\d{4}-\d{2}-\d{2})/)![1],counts={sessions:7,sessions_with_cart_additions:3,sessions_that_reached_checkout:2,sessions_that_completed_checkout:1};
 const row={day,...counts,...query.includes('GROUP BY day,hour_of_day')?{hour_of_day:0}:{},...query.includes('landing_page_path,session_country')?{landing_page_path:'/pages/glp',session_country:'United States'}:{}};
 return Response.json({data:{shopifyqlQuery:{parseErrors:[],tableData:{columns:[],rows:[row]}}}});
};}
it.each(['kind-shopify-hourly','kind-shopify-funnels'])('%s avoids all provider requests for chosen stored closed days, still fetches today and missing benchmarks',async provider=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-14T13:00:00Z');const queries:string[]=[],dates:string[]=[],source=KIND_SOURCES.find(source=>source.provider===provider)! as Connection;
 for await(const capture of fetchKindBatches(source,client,window,secret,fixture(queries),Date.now()+180000,new Set(['2026-10-14','2026-10-13','2026-10-07'])))dates.push(capture.window.to);
 expect(dates).toEqual(['2026-10-14','2026-09-16','2026-09-14']);expect(queries).toHaveLength(15);
 expect(queries.filter(query=>query.includes('shopifyqlQuery')).every(query=>!query.includes('SINCE 2026-10-13')&&!query.includes('SINCE 2026-10-07'))).toBe(true);
});
it('preserves the original five-date priming when no closed-date skip set is provided',async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-14T13:00:00Z');const queries:string[]=[],dates:string[]=[];
 for await(const capture of fetchKindBatches(KIND_SOURCES.find(source=>source.provider==='kind-shopify-hourly')! as Connection,client,window,secret,fixture(queries),Date.now()+180000))dates.push(capture.window.to);
 expect(dates).toEqual(['2026-10-14','2026-10-13','2026-10-07','2026-09-16','2026-09-14']);expect(queries).toHaveLength(25);
});
it('keeps the original historical headroom rule after publishing today',async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-14T13:00:00Z');const queries:string[]=[],dates:string[]=[],deadline=Date.now()+9999;
 for await(const capture of fetchKindBatches(KIND_SOURCES.find(source=>source.provider==='kind-shopify-hourly')! as Connection,client,window,secret,fixture(queries),deadline,new Set(['2026-10-13'])))dates.push(capture.window.to);
 expect(dates).toEqual(['2026-10-14']);expect(queries).toHaveLength(5);
});
it('shares one closed-tail budget activated after mandatory current publication instead of resetting it per date',async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-14T13:00:00Z');const queries:string[]=[],dates:string[]=[],started=Date.now(),budget={deadline:null as number|null},base=fixture(queries);
 const fetcher:typeof fetch=async(url,options)=>{if(budget.deadline!==null)vi.setSystemTime(Date.now()+10000);return base(url,options);};
 for await(const capture of fetchKindBatches(KIND_SOURCES.find(source=>source.provider==='kind-shopify-hourly')! as Connection,client,window,secret,fetcher,started+240000,undefined,budget)){
  dates.push(capture.window.to);if(dates.length===1){vi.setSystemTime(Date.now()+90000);budget.deadline=Date.now()+60000;}else vi.setSystemTime(Date.now()+11000);
 }
 expect(dates).toEqual(['2026-10-14','2026-10-13']);expect(queries).toHaveLength(10);expect(budget.deadline).toBe(started+150000);
});
it('requires the real midnight closed-day anchor even when it appears in the skip set, then defers only its older repair',async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-13T22:35:00Z');const queries:string[]=[],dates:string[]=[],budget={deadline:null as number|null},base=fixture(queries);
 const fetcher:typeof fetch=async(url,options)=>{const query=JSON.parse(String(options?.body)).query;if(query.includes('SINCE')&&!query.includes('SINCE 2026-10-13'))throw new DOMException('Request timed out','TimeoutError');return base(url,options);};
 for await(const capture of fetchKindBatches(KIND_SOURCES.find(source=>source.provider==='kind-shopify-hourly')! as Connection,client,window,secret,fetcher,Date.now()+180000,new Set(['2026-10-13']),budget)){dates.push(capture.window.to);expect(capture.batch.coverageThrough).toBe('2026-10-13T22:00:00Z');budget.deadline=Date.now()+60000;}
 expect(dates).toEqual(['2026-10-13']);expect(queries.some(query=>query.includes('SINCE 2026-10-13'))).toBe(true);
});
