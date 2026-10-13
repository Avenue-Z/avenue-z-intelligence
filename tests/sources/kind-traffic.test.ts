import {it,expect,vi} from 'vitest';
import {fetchKindSource,fetchKindBatches} from '../../lib/sources/kind-fetch';
import {kindQualification} from '../../lib/sources/kind-patches';
import {validateRegisteredBatch} from '../../lib/sources/registered-contract';
import initial from '../../data/initial-clients.json';
import type {Client,Connection} from '../../lib/analytics/contracts';
import type {Raw} from '../../lib/sources/kind-patches';
const client=initial[0] as Client;
const source={provider:'kind-shopify-traffic',endpoint:'https://bright-patches.myshopify.com/admin/api/2026-07/graphql.json'} as Connection;
const secret=JSON.stringify({SHOP_DOMAIN:'bright-patches.myshopify.com',SHOPIFY_ADMIN_TOKEN:'private',TRIPLE_WHALE_SQL_KEY:'private',TRIPLE_WHALE_SUMMARY_KEY:'private',META_ACCESS_TOKEN:'private',META_AD_ACCOUNT_ID:'123',META_API_VERSION:'v24.0',META_TIME_ZONE:'Europe/Stockholm',APPLOVIN_REPORT_KEY:'private',RECHARGE_ADMIN_TOKEN:'private'});
const counts={sessions:100,sessions_with_cart_additions:20,sessions_that_reached_checkout:10,sessions_that_completed_checkout:5};
const row={day:'2026-10-11',hour_of_day:2,landing_page_path:'/pages/glp?email=private',session_country:'France',session_device_type:'Mobile',referrer_source:'social',utm_source:'facebook',utm_medium:'paid',utm_campaign:'Fall campaign',...counts};
function provider(raw:Raw[],daily:Raw[]=[{day:'2026-10-11',...counts}]):typeof fetch{return async(_url,options)=>{const query=JSON.parse(String(options?.body)).query;if(query.includes('shop {'))return Response.json({data:{shop:{ianaTimezone:client.timezone,currencyCode:client.currency,myshopifyDomain:'bright-patches.myshopify.com'}}});const rows=query.includes('landing_page_path,session_country')?raw:query.includes('GROUP BY day,hour_of_day')?daily.map(row=>({...row,hour_of_day:2})):daily;return Response.json({data:{shopifyqlQuery:{parseErrors:[],tableData:{columns:[],rows}}}});};}
it('produces a separate reconciled country, device, source, UTM and public-page cut without duplicate headline metrics',async()=>{
 const batch=await fetchKindSource(source,client,{from:'2026-10-11',to:'2026-10-11'},secret,provider([row]),Date.now()+10000,new Date('2026-10-12T12:00:00Z'));
 expect(batch.rows).toHaveLength(5);expect([...new Set(batch.rows.map(r=>r.dataset))]).toEqual(['traffic']);
 expect(batch.rows.find(r=>r.metric==='sessions')).toMatchObject({value:100,dimensions:{page:'/pages/glp',market:'FR',device:'Mobile',source:'social',utm_source:'facebook',utm_medium:'paid',utm_campaign:'Fall campaign'},population:'human_public_landing_page_sessions',definition:'shopify_human_public_landing_page_traffic'});
 expect(batch.rows.find(r=>r.metric==='completed_checkouts')?.value).toBe(5);
 expect(()=>validateRegisteredBatch(batch,kindQualification(batch,source.provider))).not.toThrow();
});
it('rejects a traffic export that reaches its sentinel or fails independent day-total reconciliation',async()=>{
 await expect(fetchKindSource(source,client,{from:'2026-10-11',to:'2026-10-11'},secret,provider(Array.from({length:40000},()=>row)))).rejects.toThrow('row limit');
 await expect(fetchKindSource(source,client,{from:'2026-10-11',to:'2026-10-11'},secret,provider([row],[{day:'2026-10-11',...counts,sessions:200}]))).rejects.toThrow('reconcile');
});
it('reconciles 9999 distinct traffic groups while retaining fewer than 50000 observations',async()=>{
 const raw=Array.from({length:9999},(_,index)=>({...row,utm_campaign:`Campaign ${index}`})),totals=Object.fromEntries(Object.entries(counts).map(([metric,value])=>[metric,value*raw.length])),queries:string[]=[],respond=provider(raw,[{day:row.day,...totals}]);
 const fetcher:typeof fetch=async(url,options)=>{queries.push(JSON.parse(String(options?.body)).query);return respond(url,options);};
 const batch=await fetchKindSource(source,client,{from:row.day,to:row.day},secret,fetcher);
 expect(batch.rows).toHaveLength(49995);expect(new Set(batch.rows.filter(r=>r.metric==='sessions').map(r=>r.dimensions.utm_campaign)).size).toBe(9999);
 for(const [field,metric] of Object.entries({sessions:'sessions',sessions_with_cart_additions:'atc_sessions',sessions_that_reached_checkout:'checkouts',sessions_that_completed_checkout:'converting_sessions'}))expect(batch.rows.filter(r=>r.metric===metric).reduce((sum,r)=>sum+(r.value??0),0)).toBe(totals[field]);
 expect(batch.rows.filter(r=>r.metric==='completed_checkouts').reduce((sum,r)=>sum+(r.value??0),0)).toBe(totals.sessions_that_completed_checkout);
 expect(()=>validateRegisteredBatch(batch,kindQualification(batch,source.provider))).not.toThrow();
 expect(queries.filter(query=>query.includes('shopifyqlQuery')).every(query=>query.includes('LIMIT 40000'))).toBe(true);
 await expect(fetchKindSource(source,client,{from:row.day,to:row.day},secret,provider(raw,[{day:row.day,...totals,sessions_with_cart_additions:totals.sessions_with_cart_additions*2}]))).rejects.toThrow('reconcile');
});
it('redacts private attribution labels and collapses equivalent sanitized groups without losing counts',async()=>{
 const batch=await fetchKindSource(source,client,{from:'2026-10-11',to:'2026-10-11'},secret,provider([{...row,utm_campaign:'person@example.com'},{...row,landing_page_path:'/pages/glp?other=tracking',utm_campaign:'other@example.com'}],[{day:'2026-10-11',sessions:200,sessions_with_cart_additions:40,sessions_that_reached_checkout:20,sessions_that_completed_checkout:10}]));
 expect(batch.rows).toHaveLength(5);expect(batch.rows.find(r=>r.metric==='sessions')).toMatchObject({value:200,dimensions:{utm_campaign:'[private]',page:'/pages/glp'}});
});
it('rejects provider-returned customer routes despite a public-page query',async()=>{
 await expect(fetchKindSource(source,client,{from:'2026-10-11',to:'2026-10-11'},secret,provider([{...row,landing_page_path:'/tools/recurring/customer'}]))).rejects.toThrow('Private landing page');
});
it('qualifies an independently confirmed zero-traffic day with stable metric profiles',async()=>{
 const batch=await fetchKindSource(source,client,{from:'2026-10-11',to:'2026-10-11'},secret,provider([],[{day:'2026-10-11',sessions:0,sessions_with_cart_additions:0,sessions_that_reached_checkout:0,sessions_that_completed_checkout:0}]));
 expect(batch.rows).toEqual([]);expect(kindQualification(batch,source.provider).profiles.map(p=>p.metric)).toEqual(['sessions','atc_sessions','checkouts','converting_sessions','completed_checkouts']);
});
it.each(['kind-shopify-traffic','kind-shopify-funnels'])('%s refreshes hourly benchmark cuts with the latest coverage first',async(providerName)=>{
 const dates:string[]=[];const fetcher:typeof fetch=async(_url,options)=>{const query=JSON.parse(String(options?.body)).query;if(query.includes('shop {'))return Response.json({data:{shop:{ianaTimezone:client.timezone,currencyCode:client.currency,myshopifyDomain:'bright-patches.myshopify.com'}}});const day=query.match(/SINCE (\d{4}-\d{2}-\d{2})/)![1];dates.push(day);return Response.json({data:{shopifyqlQuery:{parseErrors:[],tableData:{columns:[],rows:[query.includes('landing_page_path,session_country')?{...row,day}:{day,...counts,...query.includes('GROUP BY day,hour_of_day')?{hour_of_day:2}:{}}]}}}});};
 const batches=[];for await(const part of fetchKindBatches({...source,provider:providerName} as Connection,client,{from:'2026-08-01',to:'2026-10-11'},secret,fetcher))batches.push(part);
 expect(batches.map(b=>b.window)).toEqual([{from:'2026-10-11',to:'2026-10-11'},{from:'2026-10-10',to:'2026-10-10'},{from:'2026-10-04',to:'2026-10-04'},{from:'2026-09-13',to:'2026-09-13'},{from:'2026-09-11',to:'2026-09-11'}]);expect([...new Set(dates)]).toEqual(['2026-10-11','2026-10-10','2026-10-04','2026-09-13','2026-09-11']);
 for(const {batch,window} of batches){expect([...new Set(batch.rows.map(r=>r.date))]).toEqual([window.to]);expect(()=>validateRegisteredBatch(batch,kindQualification(batch,providerName))).not.toThrow();}
 expect(batches[0]?.batch.coverageThrough).toBe('2026-10-11T22:00:00Z');
});
it('publishes current traffic before optional history and succeeds when persistence consumes historical headroom',async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-13T15:35:00Z');
 try{
  const start=Date.now(),queries:string[]=[],date='2026-10-13',fetcher:typeof fetch=async(_url,options)=>{
   const query=JSON.parse(String(options?.body)).query;queries.push(query);if(query.includes('shop {'))return Response.json({data:{shop:{ianaTimezone:client.timezone,currencyCode:client.currency,myshopifyDomain:'bright-patches.myshopify.com'}}});
   const rows=query.includes('landing_page_path,session_country')?[{...row,day:date}]:[{day:date,...counts,...query.includes('GROUP BY day,hour_of_day')?{hour_of_day:2}:{}}];return Response.json({data:{shopifyqlQuery:{parseErrors:[],tableData:{columns:[],rows}}}});
  };
  const batches=[];for await(const part of fetchKindBatches(source,client,{from:'2026-10-07',to:date},secret,fetcher,start+180000)){batches.push(part);vi.advanceTimersByTime(61000);}
  expect(batches).toHaveLength(1);expect(batches[0].window).toEqual({from:date,to:date});expect(batches[0].batch.coverageThrough).toBe('2026-10-13T15:00:00Z');expect(queries).toHaveLength(4);
 }finally{vi.useRealTimers();}
});
