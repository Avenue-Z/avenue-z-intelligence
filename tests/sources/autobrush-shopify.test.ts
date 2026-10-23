import {describe,expect,it} from 'vitest';
import initial from '../../data/initial-clients.json';
import type {Client,Connection,SourceBatch} from '../../lib/analytics/contracts';
import {AUTOBRUSH_SHOPIFY_ENDPOINT,autobrushShopifyQualification,fetchAutobrushShopifySource} from '../../lib/sources/autobrush-shopify';
import {AUTOBRUSH_SOURCES,autobrushSourceDefinition,effectiveAutobrushWindow,isAutobrushProvider} from '../../lib/sources/autobrush-sources';
import {requireQualifiedSource,validateRegisteredBatch} from '../../lib/sources/registered-contract';

const date='2026-10-21',window={from:date,to:date},now=new Date('2026-10-22T17:12:00Z');
const client={...initial[0],id:'autobrush',timezone:'America/New_York',currency:'USD',version:1} as Client;
const connection=(provider='autobrush-shopify-sales')=>({id:provider,clientId:'autobrush',provider,endpoint:AUTOBRUSH_SHOPIFY_ENDPOINT}) as Connection;
type Row=Record<string,string>;
type Edit=(query:string,rows:Row[])=>Row[];
const financials={net_sales:'100',gross_sales:'110',discounts:'-7',returns:'-3',orders:'6'};
const counts={sessions:'20',sessions_with_cart_additions:'6',sessions_that_reached_checkout:'4',sessions_that_completed_checkout:'3'};
const publicCounts={sessions:'12',sessions_with_cart_additions:'4',sessions_that_reached_checkout:'3',sessions_that_completed_checkout:'2'};
const countries=[
 {session_country:'United States',sessions:'10',sessions_with_cart_additions:'3',sessions_that_reached_checkout:'2',sessions_that_completed_checkout:'1'},
 {session_country:'Canada',sessions:'6',sessions_with_cart_additions:'2',sessions_that_reached_checkout:'1',sessions_that_completed_checkout:'1'},
 {session_country:'United Kingdom',sessions:'4',sessions_with_cart_additions:'1',sessions_that_reached_checkout:'1',sessions_that_completed_checkout:'1'},
];
function table(rows:unknown[]){return Response.json({data:{shopifyqlQuery:{parseErrors:[],tableData:{columns:[{name:'day',dataType:'DATE'}],rows}}}});}
/** Network-only fixture: the real query builders, normalizers, reconciliation,
 * contracts and privacy checks all run. Aggregate values are hand calculated. */
function fixture(queries:string[]=[],edit?:Edit,sourceDate=date,hour='2',shop='ama-brushh.myshopify.com'):typeof fetch{
 return (async(input,init)=>{
  expect(String(input)).toBe('https://ama-brushh.myshopify.com/admin/api/2026-07/graphql.json');
  expect(new Headers(init?.headers).get('X-Shopify-Access-Token')).toBe('autobrush-fixture-token');
  const wrapped=JSON.parse(String(init?.body)).query;
  if(wrapped.includes('shop {'))return Response.json({data:{shop:{myshopifyDomain:shop,ianaTimezone:'America/New_York',currencyCode:'USD'}}});
  const query=JSON.parse(wrapped.match(/shopifyqlQuery\(query: (".*")\)/)![1]);queries.push(query);
  const hourly=query.includes('day,hour_of_day'),base={day:sourceDate,...hourly?{hour_of_day:hour}:{}},group=query.match(/GROUP BY ([^ ]+)/)![1];
  let rows:Row[];
  if(query.startsWith('FROM sales')){
   if(group.includes('billing_country'))rows=[
    {...base,billing_country:'United States',net_sales:'30',gross_sales:'40',discounts:'-7',returns:'-3',orders:'2'},
    {...base,billing_country:'Canada',net_sales:'70',gross_sales:'70',discounts:'0',returns:'0',orders:'4'},
   ];
   else if(group.includes('sales_channel'))rows=[
    {...base,sales_channel:'Online Store',net_sales:'30',gross_sales:'40',discounts:'-7',returns:'-3',orders:'2'},
    {...base,sales_channel:'Faire: Sell Wholesale',net_sales:'20',gross_sales:'20',discounts:'0',returns:'0',orders:'1'},
    {...base,sales_channel:'Loop Subscriptions',net_sales:'50',gross_sales:'50',discounts:'0',returns:'0',orders:'3'},
   ].map(row=>({...row,...group.includes('product_title_at_time_of_sale')?{product_title_at_time_of_sale:'Autobrush Kids'}:{}}));
   else rows=[{...base,...financials}];
  }else if(group.includes('landing_page_path'))rows=[
   {...base,landing_page_path:'/products/kids?token=private',session_country:'United States',sessions:'6',sessions_with_cart_additions:'2',sessions_that_reached_checkout:'2',sessions_that_completed_checkout:'1'},
   {...base,landing_page_path:'/collections/adult#private',session_country:'Canada',sessions:'4',sessions_with_cart_additions:'1',sessions_that_reached_checkout:'1',sessions_that_completed_checkout:'1'},
   {...base,landing_page_path:'/',session_country:'United Kingdom',sessions:'2',sessions_with_cart_additions:'1',sessions_that_reached_checkout:'0',sessions_that_completed_checkout:'0'},
  ].map(row=>({...row,...group.includes('session_device_type')?{session_device_type:'mobile',referrer_source:'google',utm_source:'google',utm_medium:'cpc',utm_campaign:'Kids'}:{}}));
  else if(group.includes('session_country'))rows=countries.map(country=>({...base,...country}));
  else rows=[{...base,...query.includes('landing_page_path NOT')?publicCounts:counts}];
  return table(edit?edit(query,rows):rows);
 }) as typeof fetch;
}
function fetchSource(provider:string,edit?:Edit,queries:string[]=[],sourceDate=date,at=now,hour='2'){
 return fetchAutobrushShopifySource(connection(provider),client,{from:sourceDate,to:sourceDate},'autobrush-fixture-token',fixture(queries,edit,sourceDate,hour),Date.now()+30000,at);
}
function total(batch:SourceBatch,dataset:string,metric:string){return batch.rows.filter(row=>row.dataset===dataset&&row.metric===metric).reduce((sum,row)=>sum+(row.value??0),0);}
function qualified(batch:SourceBatch,provider:string){return requireQualifiedSource(autobrushShopifyQualification(batch,provider),client);}

describe('Autobrush Shopify source isolation',()=>{
 it('defines exactly seven Autobrush providers with separate server configuration references',()=>{
  expect(AUTOBRUSH_SOURCES.map(source=>source.provider)).toEqual(['autobrush-shopify-sales','autobrush-shopify-products','autobrush-shopify-sessions','autobrush-shopify-traffic','autobrush-shopify-markets','autobrush-motion','autobrush-intelligems']);
  expect(AUTOBRUSH_SOURCES.slice(0,5).every(source=>source.secretRef==='SOURCE_AUTOBRUSH_SHOPIFY'&&source.endpoint==='https://ama-brushh.myshopify.com/admin/api/2026-07/graphql.json')).toBe(true);
  expect(autobrushSourceDefinition('autobrush-motion','autobrush').secretRef).toBe('SOURCE_AUTOBRUSH_MOTION');
  expect(autobrushSourceDefinition('autobrush-intelligems','autobrush').secretRef).toBe('SOURCE_AUTOBRUSH_INTELLIGEMS');
  expect(isAutobrushProvider('beam-shopify-sales')).toBe(false);
  expect(()=>autobrushSourceDefinition('autobrush-shopify-sales','beam')).toThrow(/Autobrush/);
  expect(()=>autobrushSourceDefinition('beam-motion','autobrush')).toThrow(/Unknown/);
 });
 it('refuses identity and date changes before sending credentials',async()=>{
  let requests=0;const noNetwork=(async()=>{requests++;throw Error('unexpected network');}) as typeof fetch;
  const mismatches:[Connection,Client,string,{from:string;to:string}][]=[
   [{...connection(),clientId:'beam'},client,'autobrush-fixture-token',window],
   [connection(),{...client,id:'kind-patches'},'autobrush-fixture-token',window],
   [{...connection(),endpoint:'https://beamtlc.myshopify.com/admin/api/2026-07/graphql.json'},client,'autobrush-fixture-token',window],
   [connection(),{...client,timezone:'UTC'},'autobrush-fixture-token',window],
   [connection(),{...client,currency:'CAD'},'autobrush-fixture-token',window],
   [{...connection(),provider:'beam-shopify-sales'},client,'autobrush-fixture-token',window],
   [connection(),client,' ',window],
   [connection(),client,'autobrush-fixture-token',{from:'2026-10-20',to:date}],
   [connection(),client,'autobrush-fixture-token',{from:'2026-02-30',to:'2026-02-30'}],
   [connection(),client,'autobrush-fixture-token',{from:'2026-10-23',to:'2026-10-23'}],
  ];
  for(const [conn,c,token,w] of mismatches)await expect(fetchAutobrushShopifySource(conn,c,w,token,noNetwork,Date.now()+10000,now)).rejects.toThrow();
  expect(requests).toBe(0);
 });
 it('verifies the authenticated store before any analytics request',async()=>{
  const queries:string[]=[];
  await expect(fetchAutobrushShopifySource(connection(),client,window,'autobrush-fixture-token',fixture(queries,undefined,date,'2','beamtlc.myshopify.com'),Date.now()+10000,now)).rejects.toThrow(/store identity/i);
  expect(queries).toHaveLength(0);
 });
 it('moves the midnight Shopify run to the last closed day without moving daily media',()=>{
  const midnight=new Date('2026-10-22T04:30:00Z'),today={from:'2026-10-22',to:'2026-10-22'};
  expect(effectiveAutobrushWindow(connection(),client,today,midnight)).toEqual({from:'2026-10-21',to:'2026-10-21'});
  expect(effectiveAutobrushWindow(connection('autobrush-motion'),client,today,midnight)).toEqual(today);
  expect(()=>effectiveAutobrushWindow({...connection(),clientId:'beam'},client,today,midnight)).toThrow(/identity/i);
 });
});

describe('Autobrush Shopify all-channel financial reporting',()=>{
 it('retains Faire and subscription sales while independently reconciling headline totals',async()=>{
  const queries:string[]=[],batch=await fetchSource('autobrush-shopify-sales',undefined,queries);
  expect(queries).toHaveLength(3);expect(queries.every(query=>!query.includes(' WHERE '))).toBe(true);
  expect(total(batch,'revenue','revenue')).toBe(100);expect(total(batch,'overview','revenue')).toBe(100);
  expect(total(batch,'overview','orders')).toBe(6);expect(total(batch,'overview','online_store_revenue')).toBe(30);
  expect(total(batch,'overview','online_store_orders')).toBe(2);
  expect(batch.rows.find(row=>row.dimensions.stream==='Faire: Sell Wholesale'&&row.metric==='revenue'&&row.value)).toMatchObject({value:20,population:'shopify_sales'});
  expect(batch.rows.find(row=>row.dimensions.stream==='Loop Subscriptions'&&row.metric==='revenue'&&row.value)).toMatchObject({value:50});
  expect(batch.rows.find(row=>row.dataset==='revenue'&&row.metric==='refunds'&&row.value)?.value).toBe(3);
  expect(batch.coverageThrough).toBe('2026-10-22T04:00:00Z');
  expect(()=>validateRegisteredBatch(batch,qualified(batch,'autobrush-shopify-sales'))).not.toThrow();
 });
 it('retains product order overlap without equating it to distinct store orders',async()=>{
  const batch=await fetchSource('autobrush-shopify-products',(query,rows)=>query.includes('product_title_at_time_of_sale')?rows.map(row=>({...row,orders:String(Number(row.orders)+1)})):rows);
  expect(total(batch,'products','orders')).toBe(9);expect(total(batch,'products','revenue')).toBe(100);
  expect(batch.rows.every(row=>row.definition==='shopify_product_net_sales_orders_may_overlap')).toBe(true);
  expect(()=>validateRegisteredBatch(batch,qualified(batch,'autobrush-shopify-products'))).not.toThrow();
 });
 it('rejects a discrepant independent daily authority',async()=>{
  await expect(fetchSource('autobrush-shopify-sales',(query,rows)=>query.includes('GROUP BY day SINCE')?rows.map(row=>({...row,net_sales:'101'})):rows)).rejects.toThrow(/reconcile/i);
 });
 it('uses the same completed-hour cutoff for details and independent daily authority',async()=>{
  const queries:string[]=[],batch=await fetchSource('autobrush-shopify-sales',undefined,queries,'2026-10-22');
  expect(queries.every(query=>query.includes('hour_of_day < 13'))).toBe(true);
  expect(batch.coverageThrough).toBe('2026-10-22T17:00:00Z');
  expect(batch.rows.every(row=>Date.parse(row.end!)<=Date.parse('2026-10-22T17:00:00Z'))).toBe(true);
 });
 it('rejects incomplete financial exports at the explicit sentinel',async()=>{
  await expect(fetchSource('autobrush-shopify-sales',(query,rows)=>query.includes('day,hour_of_day')?Array.from({length:10000},()=>rows[0]):rows)).rejects.toThrow(/incomplete|row limit/i);
 });
 it('enforces the final observation bound after adding hourly headline measures',async()=>{
  const failure=await fetchSource('autobrush-shopify-sales',(query,rows)=>{
   const zero={net_sales:'0',gross_sales:'0',discounts:'0',returns:'0',orders:'0'};
   return query.includes('sales_channel')?Array.from({length:416},(_,index)=>({...rows[0],...zero,sales_channel:`Channel ${index}`})):rows.map(row=>({...row,...zero}));
  }).then(()=>'',error=>(error as Error).message);
  expect(failure).toMatch(/observation limit|50000/i);
 });
 it('repairs overlapping hourly orders with independent cumulative period cuts',async()=>{
  const queries:string[]=[],batch=await fetchSource('autobrush-shopify-sales',(query,rows)=>{
   if(query.startsWith('FROM sales SHOW orders'))return query.includes('hour_of_day < 1 ')?[]:[{...rows[0],orders:'6'}];
   if(query.includes('day,hour_of_day'))return [{...rows[0],hour_of_day:'1',...financials},{...rows[0],hour_of_day:'2',net_sales:'0',gross_sales:'0',discounts:'0',returns:'0',orders:'1'}];
   return /GROUP BY day,sales_channel/.test(query)?[{...rows[0],...financials}]:rows;
  },queries);
  expect(queries.filter(query=>query.startsWith('FROM sales SHOW orders'))).toHaveLength(24);
  expect(total(batch,'overview','orders')).toBe(6);
  expect(batch.rows.find(row=>row.dataset==='overview'&&row.metric==='orders'&&row.start==='2026-10-21T05:00:00Z')?.value).toBe(6);
 });
});

describe('Autobrush Shopify human all-market sessions and public pages',()=>{
 it('uses human sessions globally and retains public page countries independently',async()=>{
  const queries:string[]=[],batch=await fetchSource('autobrush-shopify-sessions',undefined,queries);
  expect(queries).toHaveLength(4);
  expect(queries.every(query=>query.includes("human_or_bot_session = 'human'")&&!query.includes("session_country = 'United States'"))).toBe(true);
  expect(total(batch,'overview','sessions')).toBe(20);expect(total(batch,'funnels','sessions')).toBe(12);
  expect(batch.rows.find(row=>row.dataset==='funnels'&&row.dimensions.market==='CA')?.dimensions.page).toBe('/collections/adult');
  expect(new Set(batch.rows.filter(row=>row.dataset==='funnels').map(row=>row.dimensions.market))).toEqual(new Set(['US','CA','UK']));
  expect(batch.rows.every(row=>!JSON.stringify(row.dimensions).includes('private'))).toBe(true);
  expect(()=>validateRegisteredBatch(batch,qualified(batch,'autobrush-shopify-sessions'))).not.toThrow();
 });
 it.each(['/account/private','/orders/123','/checkout/private','/a/loop_subscriptions/customer/123','/apps/loop_subscriptions/customer/123','/customer/123','/customers/123','/nested/loop_subscriptions/customer/123','/%61ccount/private','/%2561ccount/private','/%ZZ'])('rejects private or malformed landing path %s',async path=>{
  await expect(fetchSource('autobrush-shopify-sessions',(query,rows)=>query.includes('landing_page_path,session_country')?rows.map(row=>({...row,landing_page_path:path})):rows)).rejects.toThrow(/Private|Invalid.*path/i);
 });
 it.each(['autobrush-shopify-sessions','autobrush-shopify-traffic'])('rejects numeric-store-prefixed private portals in %s',async provider=>{
  for(const path of ['/123456/orders/[private]','/123456/checkouts/[private]','/123456/checkout/[private]','/123456/account/[private]','/123456/accounts/[private]','/123456/customers/[private]','/%31%32%33%34%35%36/%6frders/[private]','/%2531%2532%2533%2534%2535%2536/%256frders/[private]']){
   const failure=await fetchSource(provider,(query,rows)=>query.includes('landing_page_path,session_country')?rows.map(row=>({...row,landing_page_path:path})):rows).then(()=>'',error=>(error as Error).message);
   expect(failure).toMatch(/Private landing page/i);
  }
 });
 it.each(['autobrush-shopify-sessions','autobrush-shopify-traffic'])('applies identical private-portal exclusions before every public aggregate in %s',async provider=>{
  const queries:string[]=[];await fetchSource(provider,undefined,queries);
  const predicates=queries.filter(query=>query.includes('landing_page_path NOT')).map(query=>query.match(/ WHERE (.+?) GROUP BY /)![1]);
  expect(predicates).toHaveLength(provider==='autobrush-shopify-sessions'?2:3);
  expect(new Set(predicates).size).toBe(1);
  for(const predicate of predicates)for(const path of ['/orders/','/checkout/','/checkouts/','/account/','/accounts/','/customer/','/customers/'])expect(predicate).toContain(`landing_page_path NOT CONTAINS '${path}'`);
 });
 it('fails unreconciled, invalid-date and truncated session exports',async()=>{
  await expect(fetchSource('autobrush-shopify-sessions',(query,rows)=>query.includes('GROUP BY day SINCE')&&!query.includes('landing_page_path NOT')?rows.map(row=>({...row,sessions:'21'})):rows)).rejects.toThrow(/reconcile/i);
  await expect(fetchSource('autobrush-shopify-sessions',(query,rows)=>query.includes('day,hour_of_day')?rows.map(row=>({...row,day:'2026-10-20'})):rows)).rejects.toThrow(/date/i);
  await expect(fetchSource('autobrush-shopify-sessions',(query,rows)=>query.includes('landing_page_path,session_country')?Array.from({length:10000},()=>rows[0]):rows)).rejects.toThrow(/incomplete|row limit/i);
 });
 it('refuses a current incomplete hour rather than filling it in',async()=>{
  await expect(fetchSource('autobrush-shopify-sessions',undefined,[],'2026-10-22',now,'13')).rejects.toThrow(/last full store hour/i);
  await expect(fetchSource('autobrush-shopify-sales',undefined,[],'2026-10-22',new Date('2026-10-22T04:30:00Z'))).rejects.toThrow(/first complete store hour/i);
 });
 it.each([
  ['2026-03-08','2026-03-09T16:00:00Z','3','2026-03-08T05:00:00Z','2026-03-09T04:00:00Z',23],
  ['2026-11-01','2026-11-02T17:00:00Z','1','2026-11-01T04:00:00Z','2026-11-02T05:00:00Z',24],
 ])('preserves the closed-day UTC interval across DST on %s',async(sourceDate,at,hour,start,end,hours)=>{
  const batch=await fetchSource('autobrush-shopify-sessions',undefined,[],sourceDate,new Date(at),hour),sessionRows=batch.rows.filter(row=>row.dataset==='overview'&&row.metric==='sessions');
  expect(sessionRows).toHaveLength(hours);expect(sessionRows[0].start).toBe(start);expect(batch.coverageThrough).toBe(end);
  if(sourceDate==='2026-11-01')expect(sessionRows.find(row=>row.start==='2026-11-01T05:00:00Z')?.end).toBe('2026-11-01T07:00:00Z');
 });
 it('keeps a repeated current DST hour unqualified until both occurrences have ended',async()=>{
  const queries:string[]=[],batch=await fetchSource('autobrush-shopify-sessions',undefined,queries,'2026-11-01',new Date('2026-11-01T06:30:00Z'),'0');
  expect(queries.every(query=>query.includes('hour_of_day < 1'))).toBe(true);expect(batch.coverageThrough).toBe('2026-11-01T05:00:00Z');
 });
});

describe('Autobrush traffic and billing-country markets',()=>{
 it('preserves hourly country/device/UTM traffic globally with public-page reconciliation',async()=>{
  const queries:string[]=[],batch=await fetchSource('autobrush-shopify-traffic',undefined,queries);
  expect(total(batch,'traffic','sessions')).toBe(12);
  expect(batch.rows.find(row=>row.dimensions.market==='CA')?.dimensions).toEqual({page:'/collections/adult',market:'CA',device:'mobile',source:'google',utm_source:'google',utm_medium:'cpc',utm_campaign:'Kids'});
  expect(queries.every(query=>query.includes("human_or_bot_session = 'human'")&&!query.includes("session_country = 'United States'"))).toBe(true);
  expect(()=>validateRegisteredBatch(batch,qualified(batch,'autobrush-shopify-traffic'))).not.toThrow();
 });
 it('rejects truncated traffic, private paths, and an inconsistent daily public-page total',async()=>{
  await expect(fetchSource('autobrush-shopify-traffic',(query,rows)=>query.includes('session_device_type')?Array.from({length:40000},()=>rows[0]):rows)).rejects.toThrow(/incomplete|row limit/i);
  await expect(fetchSource('autobrush-shopify-traffic',(query,rows)=>query.includes('session_device_type')?rows.map(row=>({...row,landing_page_path:'/customer/123'})):rows)).rejects.toThrow(/Private landing page/i);
  await expect(fetchSource('autobrush-shopify-traffic',(query,rows)=>query.includes('GROUP BY day SINCE')?rows.map(row=>({...row,sessions:'13'})):rows)).rejects.toThrow(/reconcile/i);
 });
 it('keeps global session countries independent from billing-country sales',async()=>{
  const queries:string[]=[],batch=await fetchSource('autobrush-shopify-markets',undefined,queries);
  expect(batch.rows.every(row=>row.dataset==='markets')).toBe(true);
  expect(total(batch,'markets','revenue')).toBe(100);expect(total(batch,'markets','orders')).toBe(6);expect(total(batch,'markets','sessions')).toBe(20);
  expect(batch.rows.find(row=>row.metric==='revenue'&&row.value&&row.dimensions.market==='CA')).toMatchObject({value:70,population:'shopify_sales'});
  expect(batch.rows.find(row=>row.metric==='converting_sessions'&&row.value&&row.dimensions.market==='UK')).toMatchObject({value:1,population:'human_online_store_sessions'});
  expect(queries.filter(query=>query.startsWith('FROM sessions')).every(query=>!query.includes("session_country = 'United States'"))).toBe(true);
  expect(()=>validateRegisteredBatch(batch,qualified(batch,'autobrush-shopify-markets'))).not.toThrow();
 });
 it('rejects missing, duplicated, truncated and inconsistent market cohorts',async()=>{
  for(const edit of [
   (query:string,rows:Row[])=>query.startsWith('FROM sessions')&&query.includes('day,hour_of_day,session_country')?rows.slice(0,2):rows,
   (query:string,rows:Row[])=>query.startsWith('FROM sessions')&&query.includes('day,hour_of_day,session_country')?[...rows,rows[0]]:rows,
   (query:string,rows:Row[])=>query.startsWith('FROM sessions')&&query.includes('day,hour_of_day,session_country')?Array.from({length:10000},()=>rows[0]):rows,
   (query:string,rows:Row[])=>query.startsWith('FROM sessions')&&query.includes('GROUP BY day SINCE')?rows.map(row=>({...row,sessions:'21'})):rows,
  ])await expect(fetchSource('autobrush-shopify-markets',edit)).rejects.toThrow(/reconcile|Duplicate|incomplete|row limit/i);
 });
 it('rejects country totals that disagree even when the global session total matches',async()=>{
  await expect(fetchSource('autobrush-shopify-markets',(query,rows)=>query.startsWith('FROM sessions')&&query.includes('GROUP BY day,session_country ')?rows.map(row=>({...row,sessions:row.session_country==='United States'?'11':row.session_country==='Canada'?'5':row.sessions})):rows)).rejects.toThrow(/independent country totals/i);
 });
 it('fails provider parse errors and missing tables without returning a partial batch',async()=>{
  for(const result of [{parseErrors:['unknown field'],tableData:null},{parseErrors:[],tableData:null}]){
   const network=(async(_input,init)=>JSON.parse(String(init?.body)).query.includes('shop {')?Response.json({data:{shop:{myshopifyDomain:'ama-brushh.myshopify.com',ianaTimezone:'America/New_York',currencyCode:'USD'}}}):Response.json({data:{shopifyqlQuery:result}})) as typeof fetch;
   await expect(fetchAutobrushShopifySource(connection(),client,window,'autobrush-fixture-token',network,Date.now()+10000,now)).rejects.toThrow(/query rejected|table missing/i);
  }
 });
 it('rejects unqualified identity, incomplete pagination and invalid hourly intervals',async()=>{
  const batch=await fetchSource('autobrush-shopify-sales');
  for(const invalid of [{...batch,clientId:'beam'},{...batch,complete:false},{...batch,nextCursor:'next'},{...batch,rows:batch.rows.map(row=>({...row,start:'invalid'}))}])expect(()=>autobrushShopifyQualification(invalid,'autobrush-shopify-sales')).toThrow(/qualified|grain/i);
  expect(()=>autobrushShopifyQualification(batch,'autobrush-shopify-products')).toThrow(/qualified|profile/i);
 });
});
