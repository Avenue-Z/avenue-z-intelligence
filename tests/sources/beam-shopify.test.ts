import {describe,expect,it} from 'vitest';
import initial from '../../data/initial-clients.json';
import {BEAM_SHOPIFY_ENDPOINT,beamShopifyQualification,fetchBeamShopifySource} from '../../lib/sources/beam-shopify';
import {requireQualifiedSource,validateRegisteredBatch} from '../../lib/sources/registered-contract';
import type {Client,Connection} from '../../lib/analytics/contracts';

const date='2026-10-15',window={from:date,to:date},now=new Date('2026-10-16T17:12:00Z');
const client={...initial[0],id:'beam',timezone:'America/New_York',currency:'USD',version:1} as Client;
const connection=(provider:string)=>({id:provider,clientId:'beam',provider,endpoint:BEAM_SHOPIFY_ENDPOINT}) as Connection;
const values={net_sales:'30',gross_sales:'40',discounts:'-7',returns:'-3',orders:'2'};
const sessions={sessions:'10',sessions_with_cart_additions:'3',sessions_that_reached_checkout:'2',sessions_that_completed_checkout:'1'};
function response(rows:unknown[]){return Response.json({data:{shopifyqlQuery:{parseErrors:[],tableData:{columns:[],rows}}}});}
function commerceFetcher(queries:string[],change?:(query:string,rows:Record<string,string>[])=>Record<string,string>[]):typeof fetch{
 return (async(input,init)=>{
  expect(String(input)).toBe(BEAM_SHOPIFY_ENDPOINT);
  const query=JSON.parse(String(init?.body)).query;
  expect(new Headers(init?.headers).get('X-Shopify-Access-Token')).toBe('beam-secret');
  if(query.includes('shop {'))return Response.json({data:{shop:{myshopifyDomain:'beamtlc.myshopify.com',ianaTimezone:client.timezone,currencyCode:'USD'}}});
  const q=JSON.parse(query.match(/shopifyqlQuery\(query: (".*")\)/)![1]);queries.push(q);
  const hourly=q.includes('day,hour_of_day'),grouped=/GROUP BY [^ ]*sales_channel/.test(q),product=q.includes('product_title_at_time_of_sale');
  const raw=[{day:date,...hourly?{hour_of_day:'2'}:{},...grouped?{sales_channel:'Online Store'}:{},...product?{product_title_at_time_of_sale:'Dream'}:{},...values}];
  return response(change?change(q,raw):raw);
 }) as typeof fetch;
}
describe('Beam Shopify financial source',()=>{
 it('pins Beam identity and excludes Faire in every query while retaining Loop as financial sales',async()=>{
  const queries:string[]=[];
  const batch=await fetchBeamShopifySource(connection('beam-shopify-sales'),client,window,'beam-secret',commerceFetcher(queries),Date.now()+30000,now);
  expect(queries.every(q=>q.includes("sales_channel != 'Faire: Sell Wholesale'"))).toBe(true);
  expect(queries.every(q=>!q.includes("Loop Subscriptions'"))).toBe(true);
  expect(batch.rows.filter(r=>r.dataset==='revenue'&&r.metric==='revenue').reduce((sum,r)=>sum+r.value!,0)).toBe(30);
  for(const metric of ['revenue','online_store_revenue'])expect(batch.rows.filter(r=>r.dataset==='overview'&&r.metric===metric).reduce((sum,r)=>sum+r.value!,0)).toBe(30);
  expect(batch.rows.filter(r=>r.dataset==='overview'&&r.metric==='orders').reduce((sum,r)=>sum+r.value!,0)).toBe(2);
  expect(batch.rows.find(r=>r.dataset==='revenue'&&r.metric==='refunds'&&r.value)).toMatchObject({value:3,dimensions:{stream:'Online Store'}});
  expect(batch.coverageThrough).toBe('2026-10-16T04:00:00Z');
  const contract=requireQualifiedSource(beamShopifyQualification(batch,'beam-shopify-sales'),client);
  expect(()=>validateRegisteredBatch(batch,contract)).not.toThrow();
  expect(contract.profiles).toHaveLength(9);
 });
 it('refuses identity changes before exposing a token to another endpoint',async()=>{
  let calls=0;const fetcher=(async()=>{calls++;throw Error('unexpected');}) as typeof fetch;
  const mismatches:[Connection,Client][]=[[{...connection('beam-shopify-sales'),clientId:'kind-patches'},client],[{...connection('beam-shopify-sales'),endpoint:'https://bright-patches.myshopify.com/admin/api/2026-07/graphql.json'},client],[connection('beam-shopify-sales'),{...client,timezone:'UTC'}]];
  for(const [conn,c] of mismatches)await expect(fetchBeamShopifySource(conn,c,window,'beam-secret',fetcher,Date.now()+10000,now)).rejects.toThrow(/identity|endpoint/i);
  expect(calls).toBe(0);
 });
 it('fails an independently inconsistent financial total and a provider parse rejection',async()=>{
  await expect(fetchBeamShopifySource(connection('beam-shopify-sales'),client,window,'beam-secret',commerceFetcher([],(_q,rows)=>rows.map(r=>({...r,net_sales:r.sales_channel?r.net_sales:'31'}))),Date.now()+30000,now)).rejects.toThrow(/reconcile/i);
  const fetcher=(async(_input,init)=>JSON.parse(String(init?.body)).query.includes('shop {')?Response.json({data:{shop:{myshopifyDomain:'beamtlc.myshopify.com',ianaTimezone:client.timezone,currencyCode:'USD'}}}):Response.json({data:{shopifyqlQuery:{parseErrors:['invalid grammar'],tableData:null}}})) as typeof fetch;
  await expect(fetchBeamShopifySource(connection('beam-shopify-sales'),client,window,'beam-secret',fetcher,Date.now()+30000,now)).rejects.toThrow(/ShopifyQL query rejected/i);
 });
 it('keeps the same completed-hour predicate for current detail and independent totals',async()=>{
  const today='2026-10-16',queries:string[]=[];
  const f=commerceFetcher(queries,(_q,rows)=>rows.map(r=>({...r,day:today})));
  const batch=await fetchBeamShopifySource(connection('beam-shopify-sales'),client,{from:today,to:today},'beam-secret',f,Date.now()+30000,now);
  expect(queries.every(q=>q.includes('hour_of_day < 13'))).toBe(true);
  expect(batch.coverageThrough).toBe('2026-10-16T17:00:00Z');
  expect(batch.rows.every(r=>Date.parse(r.end!)<=Date.parse(batch.coverageThrough!))).toBe(true);
 });
 it('uses unique cumulative order increments when one order occurs in multiple hours',async()=>{
  const queries:string[]=[],batch=await fetchBeamShopifySource(connection('beam-shopify-sales'),client,window,'beam-secret',commerceFetcher(queries,(q,rows)=>{
   if(q.startsWith('FROM sales SHOW orders'))return q.includes('hour_of_day < 1 ')?[]:rows.map(r=>({...r,orders:'2'}));
   if(q.includes('day,hour_of_day'))return [{...rows[0],hour_of_day:'0'},{...rows[0],hour_of_day:'1',net_sales:'0',gross_sales:'0',discounts:'0',returns:'0',orders:'1'}];
   return rows;
  }),Date.now()+30000,now);
  expect(queries.filter(q=>q.startsWith('FROM sales SHOW orders'))).toHaveLength(24);
  expect(queries.every(q=>q.includes("sales_channel != 'Faire: Sell Wholesale'"))).toBe(true);
  expect(batch.rows.filter(r=>r.dataset==='overview'&&r.metric==='orders').reduce((sum,r)=>sum+r.value!,0)).toBe(2);
 });
 it('retains explicit overlapping product orders while checking all financial totals',async()=>{
  const batch=await fetchBeamShopifySource(connection('beam-shopify-products'),client,window,'beam-secret',commerceFetcher([],q=>q.includes('product_title_at_time_of_sale')?[
   {day:date,...q.includes('day,hour_of_day')?{hour_of_day:'2'}:{},sales_channel:'Online Store',product_title_at_time_of_sale:'Dream',...values},
   {day:date,...q.includes('day,hour_of_day')?{hour_of_day:'2'}:{},sales_channel:'Online Store',product_title_at_time_of_sale:'Hydration',net_sales:'20',gross_sales:'20',discounts:'0',returns:'0',orders:'1'},
  ]:[{day:date,net_sales:'50',gross_sales:'60',discounts:'-7',returns:'-3',orders:'2'}]),Date.now()+30000,now);
  expect(batch.rows.filter(r=>r.metric==='orders').reduce((sum,r)=>sum+r.value!,0)).toBe(3);
  expect(batch.rows.every(r=>r.definition==='beam_shopify_product_net_sales_excluding_faire_orders_may_overlap')).toBe(true);
 });
});
describe('Beam human US session source',()=>{
 function fetcher(queries:string[],country='United States',path='/?token=private'):typeof fetch{return (async(_input,init)=>{
  const query=JSON.parse(String(init?.body)).query;
  if(query.includes('shop {'))return Response.json({data:{shop:{myshopifyDomain:'beamtlc.myshopify.com',ianaTimezone:client.timezone,currencyCode:'USD'}}});
  const q=JSON.parse(query.match(/shopifyqlQuery\(query: (".*")\)/)![1]);queries.push(q);
  return response([{day:date,...q.includes('day,hour_of_day')?{hour_of_day:'2'}:{},...q.includes('landing_page_path,session_country')?{landing_page_path:path,session_country:country}:{},...sessions}]);
 }) as typeof fetch;}
 it('uses the explicit human US cohort for headline and public pages and sanitizes URLs',async()=>{
  const queries:string[]=[],batch=await fetchBeamShopifySource(connection('beam-shopify-sessions'),client,window,'beam-secret',fetcher(queries),Date.now()+30000,now);
  expect(queries).toHaveLength(4);
  expect(queries.every(q=>q.includes("human_or_bot_session = 'human'")&&q.includes("session_country = 'United States'"))).toBe(true);
  expect(queries.filter(q=>q.includes('landing_page_path NOT')).every(q=>q.includes("landing_page_path NOT STARTS WITH '/a/loop_subscriptions'")&&q.includes("landing_page_path NOT STARTS WITH '/customer/'"))).toBe(true);
  expect(batch.rows.filter(r=>r.dataset==='overview'&&r.metric==='sessions').reduce((sum,r)=>sum+r.value!,0)).toBe(10);
  expect(batch.rows.find(r=>r.dataset==='funnels'&&r.metric==='sessions')).toMatchObject({dimensions:{page:'/',market:'US'},population:'human_us_public_landing_page_sessions'});
  const contract=requireQualifiedSource(beamShopifyQualification(batch,'beam-shopify-sessions'),client);
  expect(()=>validateRegisteredBatch(batch,contract)).not.toThrow();
 });
 it('rejects a foreign-country result instead of silently broadening the cohort',async()=>{
  await expect(fetchBeamShopifySource(connection('beam-shopify-sessions'),client,window,'beam-secret',fetcher([],'Canada'),Date.now()+30000,now)).rejects.toThrow(/US population/i);
 });
 it('rejects nested customer portal paths in the funnel export before normalizing page rows',async()=>{
  await expect(fetchBeamShopifySource(connection('beam-shopify-sessions'),client,window,'beam-secret',fetcher([],'United States','/customer/123/subscription/456/a/loop_subscriptions/customer/123'),Date.now()+30000,now)).rejects.toThrow(/Private landing page/i);
 });
});
describe('Beam detailed traffic and financial countries',()=>{
 function fetcher(queries:string[],privatePage:string|false=false):typeof fetch{return (async(_input,init)=>{
  const query=JSON.parse(String(init?.body)).query;
  if(query.includes('shop {'))return Response.json({data:{shop:{myshopifyDomain:'beamtlc.myshopify.com',ianaTimezone:client.timezone,currencyCode:'USD'}}});
  const q=JSON.parse(query.match(/shopifyqlQuery\(query: (".*")\)/)![1]);queries.push(q);
  const base={day:date,...q.includes('day,hour_of_day')?{hour_of_day:'2'}:{}};
  if(q.startsWith('FROM sales'))return response([{...base,.../GROUP BY [^ ]*billing_country/.test(q)?{billing_country:'United States'}:{},...values}]);
  return response([{...base,...q.includes('landing_page_path,session_country')?{landing_page_path:privatePage||'/',session_country:'United States',session_device_type:'mobile',referrer_source:'google',utm_source:'google',utm_medium:'cpc',utm_campaign:'Dream'}:{},...sessions}]);
 }) as typeof fetch;}
 it('keeps all traffic dimensions hourly and qualifies the US population',async()=>{
  const queries:string[]=[],batch=await fetchBeamShopifySource(connection('beam-shopify-traffic'),client,window,'beam-secret',fetcher(queries),Date.now()+30000,now);
  expect(batch.rows).toHaveLength(5);expect(batch.rows.every(r=>r.population==='human_us_public_landing_page_sessions')).toBe(true);
  expect(batch.rows[0].dimensions).toEqual({page:'/',market:'US',device:'mobile',source:'google',utm_source:'google',utm_medium:'cpc',utm_campaign:'Dream'});
  expect(queries.every(q=>q.includes("session_country = 'United States'"))).toBe(true);
  expect(queries.every(q=>q.includes("landing_page_path NOT STARTS WITH '/a/loop_subscriptions'"))).toBe(true);
  expect(()=>validateRegisteredBatch(batch,requireQualifiedSource(beamShopifyQualification(batch,'beam-shopify-traffic'),client))).not.toThrow();
  for(const path of ['/account/private','/a/loop_subscriptions/customer/123/subscription/456','/apps/loop_subscriptions/customer/123','/tools/recurring/account/123','/%61/loop_subscriptions/customer/123','/customer/123/subscription/456/a/loop_subscriptions/customer/123','/customers/123','/nested/loop_subscriptions/customer/123'])await expect(fetchBeamShopifySource(connection('beam-shopify-traffic'),client,window,'beam-secret',fetcher([],path),Date.now()+30000,now)).rejects.toThrow(/Private landing page/i);
 });
 it('keeps billing-country revenue and human US conversions as separate populations',async()=>{
  const queries:string[]=[],batch=await fetchBeamShopifySource(connection('beam-shopify-markets'),client,window,'beam-secret',fetcher(queries),Date.now()+30000,now);
  expect(queries.filter(q=>q.startsWith('FROM sales')).some(q=>q.includes('billing_country'))).toBe(true);
  expect(batch.rows.every(r=>r.dataset==='markets'&&r.dimensions.market==='US')).toBe(true);
  expect(batch.rows.find(r=>r.metric==='orders'&&r.value)).toMatchObject({value:2,population:'beam_shopify_sales_excluding_faire'});
  expect(batch.rows.find(r=>r.metric==='converting_sessions'&&r.value)).toMatchObject({value:1,population:'human_us_online_store_sessions'});
  expect(()=>validateRegisteredBatch(batch,requireQualifiedSource(beamShopifyQualification(batch,'beam-shopify-markets'),client))).not.toThrow();
 });
});
