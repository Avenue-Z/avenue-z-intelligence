import {Temporal} from '@js-temporal/polyfill';
import {fetchRechargeCancellations} from './recharge-cancellations';
import {fetchRechargeSubscriptionCohort} from './recharge-subscription-cohort';
import {fetchShopifyHourlyCommerce} from './shopify-hourly-commerce';
import {hourlyTrafficQueries,normalizeHourlyTraffic} from './shopify-hourly-traffic';
import {fetchAppLovinHourlySpend,fetchMetaHourlyPerformance} from './hourly-paid-media';
import {normalizeTwHourlyMarkets} from './tw-hourly-markets';
import {normalizeTwDiagnostics,twDiagnosticsQueries} from './tw-diagnostics';
import {fetchShopifyGraphQL} from './shopify-graphql';
import type {Client,Connection,SourceBatch} from '../analytics/contracts';
import {dayWindow,shiftDate,todayIn} from '../analytics/windows';
import {validateBatch} from './qualification';
import {sourceDefinition,kindConfiguration,sourceBatch,observation,numeric,boundedRows,checkDate,normalizeHourlyCommerce,normalizeHourlySessions,normalizeSpendCrossCheck,hourlySessionCutoff,sessionMetrics,publicSessionPages,sourceDates,localHourInterval,providerJson,type KindConfig,type KindWindow,type Raw} from './kind-patches';
async function triple(c:KindConfig,query:string,w:KindWindow,fetcher:typeof fetch,deadline:number){return boundedRows(await providerJson(fetcher,'https://api.triplewhale.com/api/v2/orcabase/api/sql',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':c.TRIPLE_WHALE_SQL_KEY},body:JSON.stringify({shopId:c.SHOP_DOMAIN,query,currency:'USD',period:{startDate:w.from,endDate:w.to}})},deadline));}
async function shop(c:KindConfig,query:string,fetcher:typeof fetch,deadline:number,responseLimit:6000000|16000000=6000000){return fetchShopifyGraphQL(c,query,fetcher,deadline,responseLimit);}
async function shopifyql(c:KindConfig,query:string,fetcher:typeof fetch,deadline:number,responseLimit:6000000|16000000=6000000){const data=await shop(c,`query { shopifyqlQuery(query: ${JSON.stringify(query)}) { tableData { columns { name dataType } rows } parseErrors } }`,fetcher,deadline,responseLimit);if(data?.shopifyqlQuery?.parseErrors?.length)throw new Error('ShopifyQL query rejected; source schema needs review');const table=data?.shopifyqlQuery?.tableData;if(!table||!Array.isArray(table.columns))throw new Error('ShopifyQL table missing');return boundedRows(table.rows);}
export async function fetchKindSource(connection:Connection,client:Client,w:KindWindow,secret:string,fetcher:typeof fetch=fetch,deadline=Date.now()+180000,asOf=new Date()):Promise<SourceBatch>{
 const def=sourceDefinition(connection.provider,client.id);if(new URL(connection.endpoint).toString()!==new URL(def.endpoint).toString())throw new Error('Kind Patches provider endpoint is fixed');let c:KindConfig;try{c=kindConfiguration.parse(JSON.parse(secret));}catch{throw new Error('Kind Patches server configuration is invalid');}if(client.currency!=='USD'||client.timezone!==c.META_TIME_ZONE)throw new Error('Kind Patches reporting identity changed');const now=asOf,today=todayIn(client.timezone,now);
 if(connection.provider==='kind-triple-whale-diagnostics'){
  const window=effectiveKindWindow(connection,client,w,now),responses=[];for(const query of twDiagnosticsQueries(client,window,now))responses.push(await triple(c,query,window,fetcher,deadline));
  return normalizeTwDiagnostics({streams:responses[0],daily:responses[1],currencies:responses[2]},client,window,now);
 }
 if(connection.provider==='kind-triple-whale-summary'){
  const period=effectiveKindWindow(connection,client,w,now),cutoff=hourlySessionCutoff(client.timezone,now),current=period.to===cutoff.date,interval={start:dayWindow(period.to,client.timezone).start,end:current?cutoff.through:dayWindow(period.to,client.timezone).end};
  const summary=await providerJson(fetcher,def.endpoint,{method:'POST',headers:{'Content-Type':'application/json','x-api-key':c.TRIPLE_WHALE_SUMMARY_KEY},body:JSON.stringify({shopDomain:c.SHOP_DOMAIN,period:{start:period.to,end:period.to},todayHour:current?cutoff.hour+1:25})},deadline,0,55000);
  const daily=await triple(c,`SELECT event_date,channel,SUM(spend) AS spend FROM ads_table WHERE event_date BETWEEN @startDate AND @endDate${current?` AND toInt32(event_hour) < ${cutoff.hour}`:''} GROUP BY event_date,channel ORDER BY event_date,channel LIMIT 50000`,period,fetcher,deadline);
  return normalizeSpendCrossCheck(summary,daily,client,period.to,interval);
 }
 if(connection.provider==='kind-triple-whale'){
  const window=effectiveKindWindow(connection,client,w,now);
  const clock=Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(client.timezone),eligible=`event_date BETWEEN @startDate AND @endDate AND (event_date < '${today}' OR toInt32(event_hour) < ${clock.hour})`,scope="order_revenue > 0 AND source_name = 'web' AND NOT arrayExists(t -> t = 'Subscription Recurring Order', tags)",measures='SUM(order_revenue - shipping_price - taxes) AS revenue, COUNT(DISTINCT order_id) AS orders, SUM(IF(is_new_customer, 1, 0)) AS new_orders';
  const queries=[
   ()=>
   triple(c,`SELECT event_date,event_hour,shop_timezone,${measures} FROM orders_table WHERE ${eligible} AND ${scope} GROUP BY event_date,event_hour,shop_timezone ORDER BY event_date,event_hour LIMIT 50000`,window,fetcher,deadline),
   ()=>triple(c,`SELECT event_date,${measures} FROM orders_table WHERE ${eligible} AND ${scope} GROUP BY event_date ORDER BY event_date LIMIT 50000`,window,fetcher,deadline),
   ()=>triple(c,`SELECT event_date,event_hour,channel,SUM(spend) AS spend FROM ads_table WHERE ${eligible} GROUP BY event_date,event_hour,channel ORDER BY event_date,event_hour,channel LIMIT 50000`,window,fetcher,deadline),
   ()=>triple(c,`SELECT event_date,channel,SUM(spend) AS spend FROM ads_table WHERE ${eligible} GROUP BY event_date,channel ORDER BY event_date,channel LIMIT 50000`,window,fetcher,deadline),
   ()=>triple(c,`SELECT event_date,event_hour,billing_country_code,${measures} FROM orders_table WHERE ${eligible} AND ${scope} GROUP BY event_date,event_hour,billing_country_code ORDER BY event_date,event_hour,billing_country_code LIMIT 50000`,window,fetcher,deadline),
   ()=>triple(c,`SELECT event_date,billing_country_code,${measures} FROM orders_table WHERE ${eligible} AND ${scope} GROUP BY event_date,billing_country_code ORDER BY event_date,billing_country_code LIMIT 50000`,window,fetcher,deadline),
   ()=>triple(c,`SELECT event_date,event_hour,SUM(order_revenue-shipping_price-taxes) AS recurring_revenue,COUNT(DISTINCT order_id) AS recurring_orders,COUNT(DISTINCT IF(refund_money > 0,order_id,NULL)) AS recurring_refund_orders,COUNT(DISTINCT IF(cancelled_at IS NOT NULL,order_id,NULL)) AS recurring_cancelled_orders FROM orders_table WHERE ${eligible} AND arrayExists(t -> t = 'Subscription Recurring Order', tags) GROUP BY event_date,event_hour ORDER BY event_date,event_hour LIMIT 50000`,window,fetcher,deadline)
  ];
  const responses=[];for(const query of queries)responses.push(await query());const [hourly,daily,ads,adDaily,regionHourly,regionDaily,recurring]=responses;
  const out=normalizeHourlyCommerce({hourly,daily,ads,adDaily},client,window,now);
  out.rows.push(...normalizeTwHourlyMarkets({hourly:regionHourly,daily:regionDaily,commerceHourly:hourly},client,window,out.coverageThrough!));
  for(const r of recurring){checkDate(r.event_date,window);const interval=localHourInterval(r.event_date,numeric(r.event_hour),client.timezone);if(!interval)throw new Error('Recurring data contains a skipped local hour');if(Date.parse(interval.end)>Date.parse(out.coverageThrough!))continue;for(const metric of ['recurring_revenue','recurring_orders','recurring_refund_orders','recurring_cancelled_orders'])out.rows.push(observation(r.event_date,'subscriptions',metric,numeric(r[metric]),'tagged_recurring_excl_tax_shipping_before_refunds_order_date_cohort','subscription_recurring',metric==='recurring_revenue'?client.currency:null,{}, interval));}
  return validateBatch(out,client.id);
 }
 if(connection.provider.startsWith('kind-shopify-')){
  const identity=await shop(c,'query { shop { ianaTimezone currencyCode myshopifyDomain } }',fetcher,deadline);if(identity?.shop?.ianaTimezone!==client.timezone||identity?.shop?.currencyCode!==client.currency||identity?.shop?.myshopifyDomain!==c.SHOP_DOMAIN)throw new Error('Shopify store identity mismatch');
  if(connection.provider==='kind-shopify-traffic'){
   if(w.from!==w.to)throw new Error('Hourly traffic requires one store day per batch');
   const queries=hourlyTrafficQueries(w.to,client.timezone,now),detail=await shopifyql(c,queries.detail,fetcher,deadline,16000000),hourly=await shopifyql(c,queries.hourly,fetcher,deadline),daily=await shopifyql(c,queries.daily,fetcher,deadline);
   return normalizeHourlyTraffic({detail,hourly,daily},client,w,now);
  }
  if(connection.provider==='kind-shopify-hourly'||connection.provider==='kind-shopify-funnels'){
   const window=effectiveKindWindow(connection,client,w,now),cutoff=hourlySessionCutoff(client.timezone,now),show=Object.keys(sessionMetrics).join(','),hourly:Raw[]=[],daily:Raw[]=[],pages:Raw[]=[],pageDaily:Raw[]=[];
   for(const date of sourceDates(window)){
    const suffix=`SINCE ${date} UNTIL ${date} ORDER BY day ASC LIMIT 50000`,eligible=date===cutoff.date?` AND hour_of_day < ${cutoff.hour}`:'',human=`human_or_bot_session = 'human'${eligible}`,publicPages=`${publicSessionPages}${eligible}`;
    hourly.push(...await shopifyql(c,`FROM sessions SHOW ${show} WHERE ${human} GROUP BY day,hour_of_day ${suffix}`,fetcher,deadline));
    daily.push(...await shopifyql(c,`FROM sessions SHOW ${show} WHERE ${human} GROUP BY day ${suffix}`,fetcher,deadline));
    pages.push(...await shopifyql(c,`FROM sessions SHOW ${show} WHERE ${publicPages} GROUP BY day,hour_of_day,landing_page_path,session_country ${suffix}`,fetcher,deadline));
    pageDaily.push(...await shopifyql(c,`FROM sessions SHOW ${show} WHERE ${publicPages} GROUP BY day ${suffix}`,fetcher,deadline));
   }
   return normalizeHourlySessions({hourly,daily,pages,pageDaily},client,window,now);
  }
  if(connection.provider==='kind-shopify-sales'||connection.provider==='kind-shopify-products')return fetchShopifyHourlyCommerce(connection.provider==='kind-shopify-sales'?'sales':'products',client,w,query=>shopifyql(c,query,fetcher,deadline),now);
  throw new Error('Unknown Shopify source');
 }
 if(connection.provider==='kind-applovin')return fetchAppLovinHourlySpend(client,c,w,fetcher,deadline,now);
 if(connection.provider==='kind-meta'||connection.provider==='kind-meta-performance'){
  const identity=await providerJson(fetcher,`${def.endpoint}/${c.META_API_VERSION}/act_${c.META_AD_ACCOUNT_ID}?fields=id,currency,timezone_name`,{headers:{Authorization:`Bearer ${c.META_ACCESS_TOKEN}`}},deadline);if(identity.currency!==client.currency||identity.timezone_name!==client.timezone)throw new Error('Meta account identity mismatch');
  if(connection.provider==='kind-meta-performance')return fetchMetaHourlyPerformance(client,c,w,fetcher,deadline,now);
  const ids=new Set<string>(),creatives=new Set<string>();let after='';for(let page=0;page<50;page++){const params=new URLSearchParams({fields:'id,creative{id},effective_status',limit:'1000',effective_status:'["ACTIVE"]',...after?{after}:{}}),j=await providerJson(fetcher,`${def.endpoint}/${c.META_API_VERSION}/act_${c.META_AD_ACCOUNT_ID}/ads?${params}`,{headers:{Authorization:`Bearer ${c.META_ACCESS_TOKEN}`}},deadline);if(!Array.isArray(j.data))throw new Error('Meta inventory missing');for(const r of j.data){if(ids.has(r.id))throw new Error('Duplicate Meta inventory page');if(r.effective_status==='ACTIVE'){ids.add(r.id);if(r.creative?.id)creatives.add(r.creative.id);}}if(!j.paging?.next)return sourceBatch(client,[observation(today,'media','active_ads',ids.size,'current_meta_active_inventory_not_historical','meta_current_inventory',null,{channel:'meta'}),observation(today,'media','active_creatives',creatives.size,'current_meta_active_inventory_not_historical','meta_current_inventory',null,{channel:'meta'})],now.toISOString(),['meta']);const next=j.paging?.cursors?.after;if(!next||next===after)throw new Error('Meta pagination did not advance');after=next;}throw new Error('Meta pagination did not complete');
 }
 const headers={'X-Recharge-Access-Token':c.RECHARGE_ADMIN_TOKEN,'X-Recharge-Version':'2021-11'},store=await providerJson(fetcher,`${def.endpoint}/store`,{headers},deadline);if(store?.store?.platform_domain!==c.SHOP_DOMAIN||store?.store?.storefront_domain!=='kindpatches.com'||store?.store?.test_mode!==false)throw new Error('Recharge store identity mismatch');if(connection.provider==='kind-recharge-cancellations'){const window=effectiveKindWindow(connection,client,w,now),cancellations=await fetchRechargeCancellations(client,c,window,fetcher,deadline,now),cohort=await fetchRechargeSubscriptionCohort(client,c,window,fetcher,deadline,now);if(cancellations.coverageThrough!==cohort.coverageThrough)throw new Error('Recharge creation and cancellation cutoffs differ');return validateBatch({...cancellations,rows:[...cancellations.rows,...cohort.rows]},client.id);}const count=await providerJson(fetcher,`${def.endpoint}/customers/count?status=ACTIVE`,{headers:{...headers,'X-Recharge-Version':'2021-01'}},deadline),value=numeric(count.count);if(!Number.isInteger(value)||value<0)throw new Error('Invalid Recharge active-customer count');return sourceBatch(client,[observation(today,'subscriptions','active_customers',value,'recharge_raw_active_customers_not_subscription_count_or_baseline_adjusted','recharge_active_customers',null,{source:'recharge'})],now.toISOString());
}

const hourlyProviders=new Set(['kind-triple-whale','kind-triple-whale-diagnostics','kind-shopify-hourly','kind-shopify-funnels','kind-shopify-traffic','kind-shopify-sales','kind-shopify-products','kind-meta-performance','kind-applovin']);
export function kindSourceDates(connection:Connection,client:Client,w:KindWindow,asOf=new Date()){
 const window=effectiveKindWindow(connection,client,w,asOf);if(window.from>window.to)throw new Error('Requested source window has no completed store hours');
 if(w.from===w.to)return [window.to];
 const offsets=connection.provider==='kind-meta-performance'?[0]:[0,-1,-7,-28,-30];
 const dates=[...new Set(offsets.map(offset=>shiftDate(window.to,offset)))];
 if(connection.provider==='kind-triple-whale'||connection.provider==='kind-triple-whale-diagnostics')for(let offset=-6;offset<=0;offset++)dates.push(shiftDate(window.to,offset));
 const earliest=connection.provider==='kind-applovin'?shiftDate(todayIn('UTC',asOf),-29):null;
 return [...new Set(dates)].filter(date=>!earliest||dayWindow(date,client.timezone).start.slice(0,10)>=earliest).sort((a,b)=>b.localeCompare(a));
}
export async function* fetchKindBatches(connection:Connection,client:Client,w:KindWindow,secret:string,fetcher:typeof fetch=fetch,deadline=Date.now()+180000){
 const asOf=new Date(),actualWindow=effectiveKindWindow(connection,client,w,asOf);
 if(hourlyProviders.has(connection.provider)){
  const dates=kindSourceDates(connection,client,w,asOf);
  const historicalHeadroom=connection.provider==='kind-shopify-traffic'?120000:connection.provider==='kind-shopify-products'?60000:connection.provider==='kind-shopify-sales'?20000:connection.provider==='kind-meta-performance'?120000:connection.provider==='kind-applovin'?10000:10000;
  for(const [index,day] of dates.entries()){
   // Current data must reach durable storage before optional historical repairs.
   // Missing history is handled by independent single-day history jobs; running
   // out of historical headroom is a successful current source refresh.
   if(index>0&&deadline-Date.now()<historicalHeadroom)break;
   for(let attempt=0;attempt<3;attempt++)try{yield {batch:await fetchKindSource(connection,client,{from:day,to:day},secret,fetcher,deadline,asOf),window:{from:day,to:day}};break;}catch(error){if(attempt===2||!(error as Error).message.includes('reconcile')||Date.now()+5000>=deadline)throw error;}
  }
  // A current Meta report can take most of one source-run budget. Prioritize
  // today, then refresh one retained benchmark only when a full report fits.
  if(connection.provider==='kind-meta-performance'&&w.from!==w.to&&actualWindow.to===todayIn(client.timezone,asOf)&&deadline-Date.now()>=120000){
   const hour=Temporal.Instant.from(asOf.toISOString()).toZonedDateTimeISO(client.timezone).hour,day=shiftDate(actualWindow.to,-[1,7,28,30][hour%4]);
   yield {batch:await fetchKindSource(connection,client,{from:day,to:day},secret,fetcher,deadline,asOf),window:{from:day,to:day}};
  }
 }else{
  for(let attempt=0;attempt<3;attempt++)try{yield {batch:await fetchKindSource(connection,client,w,secret,fetcher,deadline,asOf),window:actualWindow};return;}catch(error){if(attempt===2||!(error as Error).message.includes('reconcile')||Date.now()+5000>=deadline)throw error;}
 }
}

export function effectiveKindWindow(connection:Connection,client:Client,w:KindWindow,now=new Date()){
 const today=todayIn(client.timezone,now),hour=hourlySessionCutoff(client.timezone,now).hour,completedTo=hour?today:shiftDate(today,-1),to=w.to<completedTo?w.to:completedTo;
 if(connection.provider==='kind-triple-whale-diagnostics')return {from:w.from>shiftDate(to,-59)?w.from:shiftDate(to,-59),to};
 if(hourlyProviders.has(connection.provider)){
  // Routine single-day polls still refresh a real complete store day during
  // hour zero. Its capture ends at midnight; no new-day hours are invented.
  if(!hour&&w.from===today&&w.to===today)return {from:completedTo,to:completedTo};
  return {from:w.from>shiftDate(to,-61)?w.from:shiftDate(to,-61),to};
 }
 if(connection.provider==='kind-triple-whale-summary')return {from:to,to};
 if(connection.provider==='kind-recharge-cancellations'){const minimum=shiftDate(to,w.to<today?-61:-2);return {from:w.from>minimum?w.from:minimum,to};}
 if(connection.provider==='kind-meta'||connection.provider==='kind-recharge')return {from:today,to:today};
 return w;
}
