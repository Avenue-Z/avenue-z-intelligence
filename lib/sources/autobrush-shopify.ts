import type {Client,Connection,Observation,SourceBatch} from '../analytics/contracts';
import {dayWindow} from '../analytics/windows';
import {boundedRows,checkDate,hourlySessionCutoff,localHourInterval,normalizeHourlySessions,numeric,observation,privateSessionPage,publicSessionPages,reconcile,sanitizePage,sessionCount,sessionMetrics,sourceBatch,sourceMarket,type KindWindow,type Raw} from './kind-patches';
import {fetchShopifyGraphQL} from './shopify-graphql';
import {fetchShopifyHourlyCommerce,type ShopifyCommerceKind} from './shopify-hourly-commerce';
import {hourlyTrafficQueries,normalizeHourlyTraffic} from './shopify-hourly-traffic';
import type {RegisteredContract} from './registered-contract';

export const AUTOBRUSH_SHOPIFY_ENDPOINT='https://ama-brushh.myshopify.com/admin/api/2026-07/graphql.json';
const providers=['autobrush-shopify-sales','autobrush-shopify-products','autobrush-shopify-sessions','autobrush-shopify-traffic','autobrush-shopify-markets'] as const;
const humanSessions="human_or_bot_session = 'human'";
// Shopify can prefix private portal routes with a numeric store identity.
// Exclude those segments before aggregation, including independent totals.
const privatePortalSegments=['orders','checkout','checkouts','account','accounts','customer','customers'];
const publicPages=`${publicSessionPages} AND landing_page_path NOT STARTS WITH '/a/loop_subscriptions' AND landing_page_path NOT STARTS WITH '/apps/loop_subscriptions' AND landing_page_path NOT STARTS WITH '/customer/' AND landing_page_path NOT STARTS WITH '/customers/'${privatePortalSegments.map(segment=>` AND landing_page_path NOT CONTAINS '/${segment}/'`).join('')}`;
const moneyFields={net_sales:'revenue',gross_sales:'gross',discounts:'discounts',returns:'refunds',orders:'orders'};
type Runner=(query:string,large?:boolean)=>Promise<Raw[]>;

function identity(connection:Connection,client:Client,token:string,w:KindWindow,now:Date){
 if(connection.clientId!=='autobrush'||client.id!=='autobrush'||client.timezone!=='America/New_York'||client.currency!=='USD')throw Error('Autobrush Shopify reporting identity mismatch');
 if(connection.endpoint!==AUTOBRUSH_SHOPIFY_ENDPOINT)throw Error('Autobrush Shopify endpoint is fixed');
 if(!providers.includes(connection.provider as typeof providers[number]))throw Error('Unknown Autobrush Shopify provider');
 if(typeof token!=='string'||!token.trim())throw Error('Autobrush Shopify token is missing');
 if(w.from!==w.to)throw Error('Autobrush Shopify requires one complete store day per batch');
 checkDate(w.to,w);dayWindow(w.to,client.timezone);
 const cutoff=hourlySessionCutoff(client.timezone,now);
 if(w.to>cutoff.date)throw Error('Autobrush Shopify window extends beyond the current store day');
 if(w.to===cutoff.date&&!cutoff.hour)throw Error('The first complete store hour is not available yet');
}
function suffix(w:KindWindow){return `SINCE ${w.to} UNTIL ${w.to} ORDER BY day ASC LIMIT 10000`;}
function completedHourWhere(client:Client,w:KindWindow,now:Date){const cutoff=hourlySessionCutoff(client.timezone,now);return w.to===cutoff.date?` AND hour_of_day < ${cutoff.hour}`:'';}
function marketQuery(query:string){return query.replace(/GROUP BY ([^ ]+)/,(_all,group:string)=>`GROUP BY ${group.replaceAll('sales_channel','billing_country')}`);}
function requirePublicPages(rows:Raw[]){
 for(const row of rows){
  let path=sanitizePage(String(row.landing_page_path??'/'));
  // Decode before testing private route prefixes, including double-encoded
  // portal paths. Never return a raw customer route in analytics dimensions.
  try{
   for(let attempt=0;attempt<4;attempt++){
    const decoded=decodeURIComponent(path);
    if(decoded===path)break;
    path=decoded;
    if(attempt===3)throw Error('excessive encoding');
   }
  }catch{throw Error('Invalid Autobrush landing page path');}
  if(privateSessionPage(path)||/(?:^|\/)(?:orders|checkouts?|accounts?|customers?|loop_subscriptions)(?:\/|$)/i.test(path))throw Error('Private landing page returned by Autobrush public session query');
 }
}

async function commerce(kind:ShopifyCommerceKind,client:Client,w:KindWindow,run:Runner,now:Date,market=false){
 const batch=await fetchShopifyHourlyCommerce(kind,client,w,async query=>{
  const rows=await run(market?marketQuery(query):query);
  return market?rows.map(row=>({...row,sales_channel:row.billing_country})):rows;
 },now);
 const eligible=completedHourWhere(client,w,now),authority=await run(`FROM sales SHOW ${Object.keys(moneyFields).join(',')}${eligible?` WHERE ${eligible.slice(5)}`:''} GROUP BY day ${suffix(w)}`);
 if(authority.length!==1)throw Error('One independent daily Autobrush financial total is required');
 checkDate(authority[0].day,w);
 for(const [field,metric] of Object.entries(moneyFields)){
  const expected=numeric(authority[0][field])*(metric==='discounts'||metric==='refunds'?-1:1);
  // An order containing several products overlaps across product groups;
  // each product/channel still reconciles inside the shared normalizer.
  if(kind==='products'&&metric==='orders')continue;
  reconcile(expected,batch.rows.filter(row=>row.metric===metric).reduce((sum,row)=>sum+(row.value??0),0));
 }
 if(market)return {...batch,rows:batch.rows.map(row=>({...row,dataset:'markets',dimensions:{market:sourceMarket(row.dimensions.stream)}})),dimensions:['market']};
 if(kind==='products')return batch;
 const rows=[...batch.rows],hours=new Map<string,{base:Observation;revenue:number;orders:number;online_store_revenue:number;online_store_orders:number}>();
 for(const row of rows){
  const key=row.start!,group=hours.get(key)??{base:row,revenue:0,orders:0,online_store_revenue:0,online_store_orders:0};
  if(row.metric==='revenue'||row.metric==='orders'){
   group[row.metric]+=row.value??0;
   if(row.dimensions.stream==='Online Store')group[row.metric==='revenue'?'online_store_revenue':'online_store_orders']+=row.value??0;
  }
  hours.set(key,group);
 }
 for(const {base,...metrics} of hours.values())for(const [metric,value] of Object.entries(metrics))rows.push({...base,dataset:'overview',metric,value,dimensions:{},definition:metric.startsWith('online_store_')?'shopify_online_store_net_sales':'shopify_net_sales_all_channels',population:metric.startsWith('online_store_')?'shopify_online_store_sales':'shopify_sales',currency:metric.endsWith('orders')?null:client.currency});
 if(rows.length>50000)throw Error('Autobrush Shopify sales exceed the observation limit');
 return {...batch,rows};
}

async function sessions(client:Client,w:KindWindow,run:Runner,now:Date){
 const show=Object.keys(sessionMetrics).join(','),eligible=completedHourWhere(client,w,now),end=suffix(w);
 const hourly=await run(`FROM sessions SHOW ${show} WHERE ${humanSessions}${eligible} GROUP BY day,hour_of_day ${end}`);
 const daily=await run(`FROM sessions SHOW ${show} WHERE ${humanSessions}${eligible} GROUP BY day ${end}`);
 const pages=await run(`FROM sessions SHOW ${show} WHERE ${publicPages}${eligible} GROUP BY day,hour_of_day,landing_page_path,session_country ${end}`);
 const pageDaily=await run(`FROM sessions SHOW ${show} WHERE ${publicPages}${eligible} GROUP BY day ${end}`);
 if([hourly,daily,pages,pageDaily].some(rows=>rows.length>=10000))throw Error('Autobrush sessions export is incomplete or exceeds its row limit');
 requirePublicPages(pages);
 return normalizeHourlySessions({hourly,daily,pages,pageDaily},client,w,now);
}

/** Session country and billing country are separate populations. Country
 * sessions reconcile both to country-day totals and an independent store-day
 * total; financial orders never become a session conversion numerator. */
async function marketSessions(client:Client,w:KindWindow,run:Runner,now:Date){
 const show=Object.keys(sessionMetrics).join(','),where=`${humanSessions}${completedHourWhere(client,w,now)}`,end=suffix(w);
 const hourly=await run(`FROM sessions SHOW ${show} WHERE ${where} GROUP BY day,hour_of_day,session_country ${end}`);
 const daily=await run(`FROM sessions SHOW ${show} WHERE ${where} GROUP BY day,session_country ${end}`);
 const authority=await run(`FROM sessions SHOW ${show} WHERE ${where} GROUP BY day ${end}`);
 if([hourly,daily,authority].some(rows=>rows.length>=10000))throw Error('Autobrush market sessions export is incomplete or exceeds its row limit');
 if(authority.length!==1||!daily.length)throw Error('One complete independent daily Autobrush market session total is required');
 checkDate(authority[0].day,w);
 const cutoff=hourlySessionCutoff(client.timezone,now),limit=w.to===cutoff.date?cutoff.hour:24,through=w.to===cutoff.date?cutoff.through:dayWindow(w.to,client.timezone).end;
 const groups=new Map<string,Raw>(),hours=new Map<string,Raw>();
 for(const row of daily){
  checkDate(row.day,w);const market=sourceMarket(row.session_country);
  if(groups.has(market))throw Error('Duplicate independent Autobrush market session aggregate');
  for(const field of Object.keys(sessionMetrics))sessionCount(row[field]);groups.set(market,row);
 }
 for(const row of hourly){
  checkDate(row.day,w);const hour=numeric(row.hour_of_day),interval=localHourInterval(w.to,hour,client.timezone),market=sourceMarket(row.session_country),key=JSON.stringify([market,hour]);
  if(!Number.isInteger(hour)||hour<0||hour>=limit||!interval||Date.parse(interval.end)>Date.parse(through))throw Error('Invalid Autobrush market session hour');
  if(hours.has(key))throw Error('Duplicate Autobrush market session hour');
  if(!groups.has(market))throw Error('Autobrush market sessions do not reconcile with independent country totals');
  for(const field of Object.keys(sessionMetrics))sessionCount(row[field]);hours.set(key,row);
 }
 for(const field of Object.keys(sessionMetrics)){
  const expected=sessionCount(authority[0][field]);
  if(expected!==daily.reduce((sum,row)=>sum+sessionCount(row[field]),0)||expected!==hourly.reduce((sum,row)=>sum+sessionCount(row[field]),0))throw Error('Autobrush market sessions do not reconcile with independent daily totals');
  for(const [market,group] of groups){
   let count=0;for(let hour=0;hour<limit;hour++){const row=hours.get(JSON.stringify([market,hour]));if(row)count+=sessionCount(row[field]);}
   if(sessionCount(group[field])!==count)throw Error('Autobrush market sessions do not reconcile with independent country totals');
  }
 }
 const rows:Observation[]=[];
 for(const market of groups.keys())for(let hour=0;hour<limit;hour++){
  const interval=localHourInterval(w.to,hour,client.timezone);if(!interval)continue;
  const row=hours.get(JSON.stringify([market,hour]));
  for(const [field,metric] of Object.entries(sessionMetrics))rows.push(observation(w.to,'markets',metric,row?sessionCount(row[field]):0,'shopify_human_sessions','human_online_store_sessions',null,{market},interval));
 }
 rows.push(...rows.filter(row=>row.metric==='converting_sessions').map(row=>({...row,metric:'completed_checkouts'})));
 return rows;
}

/** Uses only the Autobrush offline grant supplied by the native runner. The
 * fixed store identity is checked independently before querying analytics. */
export async function fetchAutobrushShopifySource(connection:Connection,client:Client,w:KindWindow,token:string,fetcher:typeof fetch=fetch,deadline=Date.now()+180000,now=new Date()):Promise<SourceBatch>{
 identity(connection,client,token,w,now);
 const provider:string=connection.provider,config={SHOP_DOMAIN:'ama-brushh.myshopify.com',SHOPIFY_ADMIN_TOKEN:token};
 const data=await fetchShopifyGraphQL(config,'query { shop { ianaTimezone currencyCode myshopifyDomain } }',fetcher,deadline);
 if(data?.shop?.myshopifyDomain!==config.SHOP_DOMAIN||data?.shop?.ianaTimezone!==client.timezone||data?.shop?.currencyCode!==client.currency)throw Error('Autobrush Shopify store identity mismatch');
 const run:Runner=async(query,large=false)=>{
  const result=await fetchShopifyGraphQL(config,`query { shopifyqlQuery(query: ${JSON.stringify(query)}) { tableData { columns { name dataType } rows } parseErrors } }`,fetcher,deadline,large?16000000:6000000);
  if(result?.shopifyqlQuery?.parseErrors?.length)throw Error('Autobrush ShopifyQL query rejected; source schema needs review');
  const table=result?.shopifyqlQuery?.tableData;
  if(!table||!Array.isArray(table.columns))throw Error('Autobrush ShopifyQL table missing');
  return boundedRows(table.rows);
 };
 if(provider==='autobrush-shopify-sales'||provider==='autobrush-shopify-products')return commerce(provider==='autobrush-shopify-sales'?'sales':'products',client,w,run,now);
 if(provider==='autobrush-shopify-sessions')return sessions(client,w,run,now);
 if(provider==='autobrush-shopify-markets'){
  const batch=await commerce('sales',client,w,run,now,true),rows=[...batch.rows,...await marketSessions(client,w,run,now)];
  return sourceBatch(client,rows,batch.coverageThrough!,[],'hourly');
 }
 const queries=hourlyTrafficQueries(w.to,client.timezone,now),scope=(query:string)=>query.replace(publicSessionPages,publicPages);
 const detail=await run(scope(queries.detail),true),hourly=await run(scope(queries.hourly)),daily=await run(scope(queries.daily));
 requirePublicPages(detail);
 return normalizeHourlyTraffic({detail,hourly,daily},client,w,now);
}

export function autobrushShopifyQualification(batch:SourceBatch,provider:string):RegisteredContract{
 if(batch.clientId!=='autobrush'||!providers.includes(provider as typeof providers[number])||batch.timezone!=='America/New_York'||batch.currency!=='USD'||!batch.complete||batch.nextCursor||batch.grain!=='hourly'||!batch.rows.length||!Number.isFinite(Date.parse(batch.coverageThrough??'')))throw Error('Autobrush Shopify batch is not qualified');
 const datasets=provider==='autobrush-shopify-sales'?['revenue','overview']:provider==='autobrush-shopify-products'?['products']:provider==='autobrush-shopify-sessions'?['overview','funnels']:provider==='autobrush-shopify-traffic'?['traffic']:['markets'];
 const profiles=new Map<string,RegisteredContract['profiles'][number]>();
 for(const row of batch.rows){
  if(!datasets.includes(row.dataset)||!row.population)throw Error('Autobrush Shopify profile is not qualified for this provider');
  const profile={dataset:row.dataset,metric:row.metric,population:row.population,definition:row.definition,currency:row.currency,dimensions:Object.keys(row.dimensions).sort(),hourly:true},key=`${row.dataset}:${row.metric}`,prior=profiles.get(key);
  if(!row.start||!row.end||!Number.isFinite(Date.parse(row.start))||!Number.isFinite(Date.parse(row.end))||Date.parse(row.start)>=Date.parse(row.end)||Date.parse(row.end)>Date.parse(batch.coverageThrough!)||prior&&JSON.stringify(prior)!==JSON.stringify(profile))throw Error('Autobrush Shopify metric grain is inconsistent');
  profiles.set(key,profile);
 }
 return {clientId:'autobrush',queryId:`${provider}:v1`,timezone:batch.timezone,currency:batch.currency,hourlyGrain:true,requiresHourly:true,channels:batch.channels,requiredChannels:[],dimensions:batch.dimensions,requiredDimensions:batch.dimensions,paginationComplete:true,reconciled:true,reconciliationEvidence:'Complete single-store-day ShopifyQL exports stay below explicit truncation sentinels. Every emitted measure reconciles to independent daily aggregates with identical all-channel or human all-market populations and completed-hour predicates. Country sessions reconcile independently per country and store day. Commerce distinct orders use cumulative period cuts when hourly sums overlap; product orders retain their explicit overlap definition. Public page exports exclude customer and subscription portals.',profiles:[...profiles.values()]};
}
