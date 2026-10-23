import type {Client,Connection,Observation,SourceBatch} from '../analytics/contracts';
import {dayWindow} from '../analytics/windows';
import {boundedRows,checkDate,hourlySessionCutoff,localHourInterval,normalizeHourlySessions,numeric,observation,privateSessionPage,publicSessionPages,reconcile,sanitizePage,sessionCount,sessionMetrics,sourceBatch,sourceMarket,type KindWindow,type Raw} from './kind-patches';
import {fetchShopifyGraphQL} from './shopify-graphql';
import {fetchShopifyHourlyCommerce,type ShopifyCommerceKind} from './shopify-hourly-commerce';
import {hourlyTrafficQueries,normalizeHourlyTraffic} from './shopify-hourly-traffic';
import type {RegisteredContract} from './registered-contract';

export const BEAM_SHOPIFY_ENDPOINT='https://beamtlc.myshopify.com/admin/api/2026-07/graphql.json';
const providers=['beam-shopify-sales','beam-shopify-products','beam-shopify-sessions','beam-shopify-traffic','beam-shopify-markets'] as const;
const salesPopulation='beam_shopify_sales_excluding_faire',salesDefinition='beam_shopify_net_sales_all_channels_excluding_faire';
const usPopulation='human_us_online_store_sessions',publicUsPopulation='human_us_public_landing_page_sessions';
const salesWhere="sales_channel != 'Faire: Sell Wholesale'",usWhere="human_or_bot_session = 'human' AND session_country = 'United States'";
export const beamPublicSessionPages=`${publicSessionPages} AND landing_page_path NOT STARTS WITH '/a/loop_subscriptions' AND landing_page_path NOT STARTS WITH '/apps/loop_subscriptions' AND landing_page_path NOT STARTS WITH '/customer/' AND landing_page_path NOT STARTS WITH '/customers/'`;
const moneyFields={net_sales:'revenue',gross_sales:'gross',discounts:'discounts',returns:'refunds',orders:'orders'};
type Runner=(query:string,large?:boolean)=>Promise<Raw[]>;

function identity(connection:Connection,client:Client,token:string,w:KindWindow,now:Date){
 if(connection.clientId!=='beam'||client.id!=='beam'||client.timezone!=='America/New_York'||client.currency!=='USD')throw Error('Beam Shopify reporting identity mismatch');
 if(connection.endpoint!==BEAM_SHOPIFY_ENDPOINT)throw Error('Beam Shopify endpoint is fixed');
 if(!providers.includes(connection.provider as typeof providers[number]))throw Error('Unknown Beam Shopify provider');
 if(typeof token!=='string'||!token.trim())throw Error('Beam Shopify token is missing');
 if(w.from!==w.to)throw Error('Beam Shopify requires one complete store day per batch');
 checkDate(w.to,w);dayWindow(w.to,client.timezone);
 const cutoff=hourlySessionCutoff(client.timezone,now);
 if(w.to>cutoff.date)throw Error('Beam Shopify window extends beyond the current store day');
 if(w.to===cutoff.date&&!cutoff.hour)throw Error('The first complete store hour is not available yet');
}
function scopedCommerceQuery(query:string,market=false){
 const scoped=query.includes(' WHERE ')?query.replace(' WHERE ',` WHERE ${salesWhere} AND `):query.replace(' GROUP BY ',` WHERE ${salesWhere} GROUP BY `);
 // Replace the grouping dimension only: the channel exclusion remains intact.
 return market?scoped.replace(/GROUP BY ([^ ]+)/,(_all,group:string)=>`GROUP BY ${group.replaceAll('sales_channel','billing_country')}`):scoped;
}
function suffix(w:KindWindow){return `SINCE ${w.to} UNTIL ${w.to} ORDER BY day ASC LIMIT 10000`;}
function completedHourWhere(client:Client,w:KindWindow,now:Date){const cutoff=hourlySessionCutoff(client.timezone,now);return w.to===cutoff.date?` AND hour_of_day < ${cutoff.hour}`:'';}
function renameSessions(batch:SourceBatch){return {...batch,rows:batch.rows.map(row=>({...row,definition:row.dataset==='overview'?'shopify_human_us_sessions':row.dataset==='funnels'?'shopify_human_us_public_landing_pages':'shopify_human_us_public_landing_page_traffic',population:row.dataset==='overview'?usPopulation:publicUsPopulation}))};}
function requireUs(rows:Raw[]){if(rows.some(row=>row.session_country!==undefined&&sourceMarket(row.session_country)!=='US'))throw Error('Shopify returned a country outside the qualified human US population');}
function requirePublicPages(rows:Raw[]){
 for(const row of rows){
  let path=sanitizePage(String(row.landing_page_path??'/'));
  try{path=decodeURIComponent(path);}catch{throw Error('Invalid Beam landing page path');}
  if(privateSessionPage(path)||/(?:^|\/)loop_subscriptions(?:\/|$)/i.test(path)||/^\/customers?(?:\/|$)/i.test(path))throw Error('Private landing page returned by Beam public session query');
 }
}

async function commerce(kind:ShopifyCommerceKind,client:Client,w:KindWindow,run:Runner,now:Date,market=false){
 const batch=await fetchShopifyHourlyCommerce(kind,client,w,async query=>{
  const rows=await run(scopedCommerceQuery(query,market));
  if(!market&&rows.some(row=>row.sales_channel==='Faire: Sell Wholesale'))throw Error('Shopify returned excluded Faire sales');
  return market?rows.map(row=>({...row,sales_channel:row.billing_country})):rows;
 },now);
 const authority=await run(`FROM sales SHOW ${Object.keys(moneyFields).join(',')} WHERE ${salesWhere}${completedHourWhere(client,w,now)} GROUP BY day ${suffix(w)}`);
 if(authority.length!==1)throw Error('One independent daily Beam financial total is required');
 checkDate(authority[0].day,w);
 for(const [field,metric] of Object.entries(moneyFields)){
  const expected=numeric(authority[0][field])*(metric==='discounts'||metric==='refunds'?-1:1);
  // An order can contain several products. Product orders reconcile per
  // product/channel inside the shared normalizer and never to unique orders.
  if(kind==='products'&&metric==='orders')continue;
  reconcile(expected,batch.rows.filter(row=>row.metric===metric).reduce((sum,row)=>sum+(row.value??0),0));
 }
 const definition=kind==='products'?'beam_shopify_product_net_sales_excluding_faire_orders_may_overlap':salesDefinition,population=kind==='products'?'beam_shopify_product_sales_excluding_faire':salesPopulation;
 const rows=batch.rows.map(row=>({...row,definition,population,...market?{dataset:'markets',dimensions:{market:sourceMarket(row.dimensions.stream)}}:{}}));
 if(market)return {...batch,rows,dimensions:['market']};
 if(kind==='products')return {...batch,rows};
 const hours=new Map<string,{base:Observation;revenue:number;orders:number;online_store_revenue:number;online_store_orders:number}>();
 for(const row of rows){
  const key=row.start!;const group=hours.get(key)??{base:row,revenue:0,orders:0,online_store_revenue:0,online_store_orders:0};
  if(row.metric==='revenue'||row.metric==='orders'){
   group[row.metric]+=row.value??0;
   if(row.dimensions.stream==='Online Store')group[row.metric==='revenue'?'online_store_revenue':'online_store_orders']+=row.value??0;
  }
  hours.set(key,group);
 }
 for(const {base,...metrics} of hours.values())for(const [metric,value] of Object.entries(metrics))rows.push({...base,dataset:'overview',metric,value,dimensions:{},definition:metric.startsWith('online_store_')?'beam_shopify_online_store_net_sales':salesDefinition,population:metric.startsWith('online_store_')?'beam_shopify_online_store_sales':salesPopulation,currency:metric.endsWith('orders')?null:client.currency});
 return {...batch,rows};
}

async function sessions(client:Client,w:KindWindow,run:Runner,now:Date){
 const show=Object.keys(sessionMetrics).join(','),eligible=completedHourWhere(client,w,now),end=suffix(w);
 const hourly=await run(`FROM sessions SHOW ${show} WHERE ${usWhere}${eligible} GROUP BY day,hour_of_day ${end}`);
 const daily=await run(`FROM sessions SHOW ${show} WHERE ${usWhere}${eligible} GROUP BY day ${end}`);
 const pages=await run(`FROM sessions SHOW ${show} WHERE ${beamPublicSessionPages} AND session_country = 'United States'${eligible} GROUP BY day,hour_of_day,landing_page_path,session_country ${end}`);
 const pageDaily=await run(`FROM sessions SHOW ${show} WHERE ${beamPublicSessionPages} AND session_country = 'United States'${eligible} GROUP BY day ${end}`);
 if([hourly,daily,pages,pageDaily].some(rows=>rows.length>=10000))throw Error('Beam sessions export is incomplete or exceeds its row limit');
 requireUs(pages);requirePublicPages(pages);
 return renameSessions(normalizeHourlySessions({hourly,daily,pages,pageDaily},client,w,now));
}

/** Market funnel metrics retain the human US session cohort independently of
 * the financial billing-country population; financial orders never become a
 * session conversion numerator. */
async function marketSessions(client:Client,w:KindWindow,run:Runner,now:Date){
 const show=Object.keys(sessionMetrics).join(','),where=`${usWhere}${completedHourWhere(client,w,now)}`,end=suffix(w);
 const hourly=await run(`FROM sessions SHOW ${show} WHERE ${where} GROUP BY day,hour_of_day ${end}`),daily=await run(`FROM sessions SHOW ${show} WHERE ${where} GROUP BY day ${end}`);
 if(hourly.length>=10000||daily.length!==1)throw Error('One complete independent daily Beam market session total is required');
 checkDate(daily[0].day,w);
 const cutoff=hourlySessionCutoff(client.timezone,now),limit=w.to===cutoff.date?cutoff.hour:24,through=w.to===cutoff.date?cutoff.through:dayWindow(w.to,client.timezone).end;
 const hours=new Map<number,Raw>();
 for(const row of hourly){
  checkDate(row.day,w);const hour=numeric(row.hour_of_day),interval=localHourInterval(w.to,hour,client.timezone);
  if(!Number.isInteger(hour)||hour<0||hour>=limit||!interval||Date.parse(interval.end)>Date.parse(through))throw Error('Invalid Beam market session hour');
  if(hours.has(hour))throw Error('Duplicate Beam market session hour');
  for(const field of Object.keys(sessionMetrics))sessionCount(row[field]);hours.set(hour,row);
 }
 for(const field of Object.keys(sessionMetrics))if(sessionCount(daily[0][field])!==hourly.reduce((sum,row)=>sum+sessionCount(row[field]),0))throw Error('Beam market sessions do not reconcile with independent daily totals');
 const rows:Observation[]=[];
 for(let hour=0;hour<limit;hour++){
  const interval=localHourInterval(w.to,hour,client.timezone);if(!interval)continue;
  for(const [field,metric] of Object.entries(sessionMetrics))rows.push(observation(w.to,'markets',metric,hours.has(hour)?sessionCount(hours.get(hour)![field]):0,'shopify_human_us_sessions',usPopulation,null,{market:'US'},interval));
 }
 rows.push(...rows.filter(row=>row.metric==='converting_sessions').map(row=>({...row,metric:'completed_checkouts'})));
 return rows;
}

/** Uses the encrypted Beam grant supplied by the native source runner. No KP
 * configuration, credentials, app state, or browser token is consulted. */
export async function fetchBeamShopifySource(connection:Connection,client:Client,w:KindWindow,token:string,fetcher:typeof fetch=fetch,deadline=Date.now()+180000,now=new Date()):Promise<SourceBatch>{
 identity(connection,client,token,w,now);
 const provider:string=connection.provider;
 const config={SHOP_DOMAIN:'beamtlc.myshopify.com',SHOPIFY_ADMIN_TOKEN:token};
 const data=await fetchShopifyGraphQL(config,'query { shop { ianaTimezone currencyCode myshopifyDomain } }',fetcher,deadline);
 if(data?.shop?.myshopifyDomain!==config.SHOP_DOMAIN||data?.shop?.ianaTimezone!==client.timezone||data?.shop?.currencyCode!==client.currency)throw Error('Beam Shopify store identity mismatch');
 const run:Runner=async(query,large=false)=>{
  const result=await fetchShopifyGraphQL(config,`query { shopifyqlQuery(query: ${JSON.stringify(query)}) { tableData { columns { name dataType } rows } parseErrors } }`,fetcher,deadline,large?16000000:6000000);
  if(result?.shopifyqlQuery?.parseErrors?.length)throw Error('Beam ShopifyQL query rejected; source schema needs review');
  const table=result?.shopifyqlQuery?.tableData;
  if(!table||!Array.isArray(table.columns))throw Error('Beam ShopifyQL table missing');
  return boundedRows(table.rows);
 };
 if(provider==='beam-shopify-sales'||provider==='beam-shopify-products')return commerce(provider==='beam-shopify-sales'?'sales':'products',client,w,run,now);
 if(provider==='beam-shopify-sessions')return sessions(client,w,run,now);
 if(provider==='beam-shopify-markets'){
  const batch=await commerce('sales',client,w,run,now,true),rows=[...batch.rows,...await marketSessions(client,w,run,now)];
  return sourceBatch(client,rows,batch.coverageThrough!,[],'hourly');
 }
 const queries=hourlyTrafficQueries(w.to,client.timezone,now),scope=(query:string)=>query.replace(publicSessionPages,beamPublicSessionPages).replace("human_or_bot_session = 'human'",usWhere);
 const detail=await run(scope(queries.detail),true),hourly=await run(scope(queries.hourly)),daily=await run(scope(queries.daily));requireUs(detail);requirePublicPages(detail);
 return renameSessions(normalizeHourlyTraffic({detail,hourly,daily},client,w,now));
}

export function beamShopifyQualification(batch:SourceBatch,provider:string):RegisteredContract{
 if(batch.clientId!=='beam'||!providers.includes(provider as typeof providers[number])||batch.timezone!=='America/New_York'||batch.currency!=='USD'||!batch.complete||batch.nextCursor||batch.grain!=='hourly'||!batch.rows.length)throw Error('Beam Shopify batch is not qualified');
 const profiles=new Map<string,RegisteredContract['profiles'][number]>();
 for(const row of batch.rows){
  const profile={dataset:row.dataset,metric:row.metric,population:row.population!,definition:row.definition,currency:row.currency,dimensions:Object.keys(row.dimensions).sort(),hourly:true},key=`${row.dataset}:${row.metric}`,prior=profiles.get(key);
  if(!row.start||!row.end||Date.parse(row.start)>=Date.parse(row.end)||prior&&JSON.stringify(prior)!==JSON.stringify(profile))throw Error('Beam Shopify metric grain is inconsistent');
  profiles.set(key,profile);
 }
 return {clientId:'beam',queryId:`${provider}:v1`,timezone:batch.timezone,currency:batch.currency,hourlyGrain:true,requiresHourly:true,channels:batch.channels,requiredChannels:[],dimensions:batch.dimensions,requiredDimensions:batch.dimensions,paginationComplete:true,reconciled:true,reconciliationEvidence:'Complete single-store-day ShopifyQL exports remain below explicit truncation sentinels. Every emitted measure reconciles to independent daily aggregates using identical population and completed-hour predicates. Commerce distinct orders use cumulative period cuts when hourly sums overlap; product orders retain their explicit product overlap definition.',profiles:[...profiles.values()]};
}
