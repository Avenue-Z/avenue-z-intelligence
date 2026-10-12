import {Temporal} from '@js-temporal/polyfill';
import {fetchRechargeCancellations} from './recharge-cancellations';
import {normalizeTwDiagnostics,twDiagnosticsQueries} from './tw-diagnostics';
import type {Client,Connection,Observation,SourceBatch} from '../analytics/contracts';
import {dayWindow,shiftDate,todayIn} from '../analytics/windows';
import {validateBatch} from './qualification';
import {sourceDefinition,kindConfiguration,sourceBatch,observation,numeric,boundedRows,checkDate,sourceMarket,sanitizePage,privateSessionPage,reconcileSessions,normalizeHourlyCommerce,normalizeHourlySessions,normalizeTraffic,TRAFFIC_GROUP_LIMIT,normalizeSpendCrossCheck,normalizeMetaPerformance,hourlySessionCutoff,sessionMetrics,publicSessionPages,sourceDates,localHourInterval,commerce,providerJson,type KindConfig,type KindWindow,type Raw} from './kind-patches';
async function triple(c:KindConfig,query:string,w:KindWindow,fetcher:typeof fetch,deadline:number){return boundedRows(await providerJson(fetcher,'https://api.triplewhale.com/api/v2/orcabase/api/sql',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':c.TRIPLE_WHALE_SQL_KEY},body:JSON.stringify({shopId:c.SHOP_DOMAIN,query,currency:'USD',period:{startDate:w.from,endDate:w.to}})},deadline));}
async function shop(c:KindConfig,query:string,fetcher:typeof fetch,deadline:number){const j=await providerJson(fetcher,`https://${c.SHOP_DOMAIN}/admin/api/2026-07/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':c.SHOPIFY_ADMIN_TOKEN},body:JSON.stringify({query})},deadline);if(j.errors?.length)throw new Error('Shopify GraphQL request rejected');return j.data;}
async function shopifyql(c:KindConfig,query:string,fetcher:typeof fetch,deadline:number){const data=await shop(c,`query { shopifyqlQuery(query: ${JSON.stringify(query)}) { tableData { columns { name dataType } rows } parseErrors } }`,fetcher,deadline);if(data?.shopifyqlQuery?.parseErrors?.length)throw new Error('ShopifyQL query rejected; source schema needs review');const table=data?.shopifyqlQuery?.tableData;if(!table||!Array.isArray(table.columns))throw new Error('ShopifyQL table missing');return boundedRows(table.rows);}
function dailyRows(raw:Raw[],w:KindWindow,dataset:string,fields:Record<string,string>,definition:string,population:string,client:Client,dimensions:(r:Raw)=>Record<string,string>){const out=[];const money=new Set(['revenue','gross','discounts','refunds']),seen=new Set<string>();for(const r of raw){checkDate(r.day,w);const dim=dimensions(r),key=JSON.stringify([r.day,Object.entries(dim).sort()]);if(seen.has(key))throw new Error('Duplicate provider daily aggregate');seen.add(key);for(const [field,metric] of Object.entries(fields)){let v=numeric(r[field]);if(metric==='discounts'||metric==='refunds')v=-v;out.push(observation(r.day,dataset,metric,v,definition,population,money.has(metric)?client.currency:null,dim));}}return out;}
export async function fetchKindSource(connection:Connection,client:Client,w:KindWindow,secret:string,fetcher:typeof fetch=fetch,deadline=Date.now()+45000,asOf=new Date()):Promise<SourceBatch>{
 const def=sourceDefinition(connection.provider,client.id);if(new URL(connection.endpoint).toString()!==new URL(def.endpoint).toString())throw new Error('Kind Patches provider endpoint is fixed');let c:KindConfig;try{c=kindConfiguration.parse(JSON.parse(secret));}catch{throw new Error('Kind Patches server configuration is invalid');}if(client.currency!=='USD'||client.timezone!==c.META_TIME_ZONE)throw new Error('Kind Patches reporting identity changed');const now=asOf,today=todayIn(client.timezone,now),closedTo=w.to<today?w.to:shiftDate(today,-1),closed={from:w.from,to:closedTo};
 if(connection.provider==='kind-triple-whale-diagnostics'){
  const window=effectiveKindWindow(connection,client,w,now),responses=[];for(const query of twDiagnosticsQueries(client,window,now))responses.push(await triple(c,query,window,fetcher,deadline));
  return normalizeTwDiagnostics({streams:responses[0],daily:responses[1],currencies:responses[2]},client,window,now);
 }
 if(connection.provider==='kind-triple-whale-summary'){
  const period={from:closedTo,to:closedTo},summary=await providerJson(fetcher,def.endpoint,{method:'POST',headers:{'Content-Type':'application/json','x-api-key':c.TRIPLE_WHALE_SUMMARY_KEY},body:JSON.stringify({shopDomain:c.SHOP_DOMAIN,period:{start:closedTo,end:closedTo},todayHour:25})},deadline);
  const daily=await triple(c,'SELECT event_date,channel,SUM(spend) AS spend FROM ads_table WHERE event_date BETWEEN @startDate AND @endDate GROUP BY event_date,channel ORDER BY event_date,channel LIMIT 50000',period,fetcher,deadline);
  return normalizeSpendCrossCheck(summary,daily,client,closedTo);
 }
 if(connection.provider==='kind-triple-whale'){
  const clock=Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(client.timezone),eligible=`event_date BETWEEN @startDate AND @endDate AND (event_date < '${today}' OR toInt32(event_hour) < ${clock.hour})`,scope="order_revenue > 0 AND source_name = 'web' AND NOT arrayExists(t -> t = 'Subscription Recurring Order', tags)",measures='SUM(order_revenue - shipping_price - taxes) AS revenue, COUNT(DISTINCT order_id) AS orders, SUM(IF(is_new_customer, 1, 0)) AS new_orders';
  const queries=[
   ()=>
   triple(c,`SELECT event_date,event_hour,shop_timezone,${measures} FROM orders_table WHERE ${eligible} AND ${scope} GROUP BY event_date,event_hour,shop_timezone ORDER BY event_date,event_hour LIMIT 50000`,w,fetcher,deadline),
   ()=>triple(c,`SELECT event_date,${measures} FROM orders_table WHERE ${eligible} AND ${scope} GROUP BY event_date ORDER BY event_date LIMIT 50000`,w,fetcher,deadline),
   ()=>triple(c,`SELECT event_date,event_hour,channel,SUM(spend) AS spend FROM ads_table WHERE ${eligible} GROUP BY event_date,event_hour,channel ORDER BY event_date,event_hour,channel LIMIT 50000`,w,fetcher,deadline),
   ()=>triple(c,`SELECT event_date,channel,SUM(spend) AS spend FROM ads_table WHERE ${eligible} GROUP BY event_date,channel ORDER BY event_date,channel LIMIT 50000`,w,fetcher,deadline),
   ()=>triple(c,`SELECT event_date,billing_country_code,${measures} FROM orders_table WHERE ${eligible} AND ${scope} GROUP BY event_date,billing_country_code ORDER BY event_date LIMIT 50000`,w,fetcher,deadline),
   ()=>triple(c,`SELECT event_date,event_hour,SUM(order_revenue-shipping_price-taxes) AS recurring_revenue,COUNT(DISTINCT order_id) AS recurring_orders,COUNT(DISTINCT IF(refund_money > 0,order_id,NULL)) AS recurring_refund_orders,COUNT(DISTINCT IF(cancelled_at IS NOT NULL,order_id,NULL)) AS recurring_cancelled_orders FROM orders_table WHERE ${eligible} AND arrayExists(t -> t = 'Subscription Recurring Order', tags) GROUP BY event_date,event_hour ORDER BY event_date,event_hour LIMIT 50000`,w,fetcher,deadline)
  ];
  const responses=[];for(const query of queries)responses.push(await query());const [hourly,daily,ads,adDaily,regions,recurring]=responses;
  const out=normalizeHourlyCommerce({hourly,daily,ads,adDaily},client,w,now);
  for(const r of regions){checkDate(r.event_date,w);for(const metric of ['revenue','orders','new_orders'])out.rows.push(observation(r.event_date,'markets',metric,numeric(r[metric]),commerce,'web_nonrecurring',metric==='revenue'?client.currency:null,{market:sourceMarket(r.billing_country_code)}));}
  for(const r of recurring){checkDate(r.event_date,w);const interval=localHourInterval(r.event_date,numeric(r.event_hour),client.timezone);if(!interval)throw new Error('Recurring data contains a skipped local hour');if(Date.parse(interval.end)>Date.parse(out.coverageThrough!))continue;for(const metric of ['recurring_revenue','recurring_orders','recurring_refund_orders','recurring_cancelled_orders'])out.rows.push(observation(r.event_date,'subscriptions',metric,numeric(r[metric]),'tagged_recurring_excl_tax_shipping_before_refunds_order_date_cohort','subscription_recurring',metric==='recurring_revenue'?client.currency:null,{}, interval));}
  return validateBatch(out,client.id);
 }
 if(connection.provider.startsWith('kind-shopify-')){
  const identity=await shop(c,'query { shop { ianaTimezone currencyCode myshopifyDomain } }',fetcher,deadline);if(identity?.shop?.ianaTimezone!==client.timezone||identity?.shop?.currencyCode!==client.currency||identity?.shop?.myshopifyDomain!==c.SHOP_DOMAIN)throw new Error('Shopify store identity mismatch');
  if(connection.provider==='kind-shopify-traffic'){
   const window={from:closedTo,to:closedTo},show=Object.keys(sessionMetrics).join(','),suffix=`SINCE ${closedTo} UNTIL ${closedTo} ORDER BY day ASC LIMIT ${TRAFFIC_GROUP_LIMIT+1}`;
   const raw=await shopifyql(c,`FROM sessions SHOW ${show} WHERE ${publicSessionPages} GROUP BY day,landing_page_path,session_country,session_device_type,referrer_source,utm_source,utm_medium,utm_campaign ${suffix}`,fetcher,deadline);
   const daily=await shopifyql(c,`FROM sessions SHOW ${show} WHERE ${publicSessionPages} GROUP BY day ${suffix}`,fetcher,deadline);
   return normalizeTraffic(raw,daily,client,window);
  }
  if(connection.provider==='kind-shopify-hourly'){
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
  const fields={net_sales:'revenue',gross_sales:'gross',discounts:'discounts',returns:'refunds',orders:'orders'};
  if(connection.provider==='kind-shopify-sales'){
   const raw=await shopifyql(c,`FROM sales SHOW net_sales,gross_sales,discounts,returns,orders GROUP BY day,sales_channel SINCE ${closed.from} UNTIL ${closed.to} ORDER BY day ASC LIMIT 50000`,fetcher,deadline);
   return sourceBatch(client,dailyRows(raw,closed,'revenue',fields,'shopify_net_sales_all_channels','shopify_sales',client,r=>({stream:String(r.sales_channel??'Unknown')})),dayWindow(closedTo,client.timezone).end);
  }
  if(connection.provider==='kind-shopify-products'){
   closed.from=closed.from>shiftDate(closed.to,-29)?closed.from:shiftDate(closed.to,-29);const raw=await shopifyql(c,`FROM sales SHOW net_sales,gross_sales,discounts,returns,orders GROUP BY day,product_title_at_time_of_sale,sales_channel SINCE ${closed.from} UNTIL ${closed.to} ORDER BY day ASC LIMIT 50000`,fetcher,deadline);
   return sourceBatch(client,dailyRows(raw,closed,'products',fields,'shopify_product_net_sales_orders_may_overlap','shopify_product_sales',client,r=>({product:String(r.product_title_at_time_of_sale??'Unknown'),stream:String(r.sales_channel??'Unknown')})),dayWindow(closedTo,client.timezone).end);
  }
  closed.from=closed.from>shiftDate(closed.to,-8)?closed.from:shiftDate(closed.to,-8);
  const metrics=sessionMetrics,sessionSuffix=`SINCE ${closed.from} UNTIL ${closed.to} ORDER BY day ASC LIMIT 50000`,publicPages=publicSessionPages;
  const pages:Raw[]=[];
  // Read complete days separately to keep Shopify's page exports bounded.
  for(let day=closed.from;day<=closed.to;day=shiftDate(day,1))pages.push(...await shopifyql(c,`FROM sessions SHOW ${Object.keys(metrics).join(',')} WHERE ${publicPages} GROUP BY day,landing_page_path,session_country SINCE ${day} UNTIL ${day} ORDER BY day ASC LIMIT 50000`,fetcher,deadline));
  const [pageTotals,totals]=await Promise.all([
   shopifyql(c,`FROM sessions SHOW ${Object.keys(metrics).join(',')} WHERE ${publicPages} GROUP BY day ${sessionSuffix}`,fetcher,deadline),
   shopifyql(c,`FROM sessions SHOW ${Object.keys(metrics).join(',')} WHERE human_or_bot_session = 'human' GROUP BY day ${sessionSuffix}`,fetcher,deadline)
  ]);
  for(const r of pageTotals)for(const m of Object.keys(metrics))reconcileSessions(numeric(r[m]),pages.filter(p=>p.day===r.day).reduce((s,p)=>s+numeric(p[m]),0));
  const collapsed=new Map<string,Raw>();for(const p of pages){const path=sanitizePage(String(p.landing_page_path??'/'));if(privateSessionPage(path))throw new Error('Private landing page returned by public session query');const country=sourceMarket(p.session_country),key=JSON.stringify([p.day,path,country]),old=collapsed.get(key);if(old)for(const m of Object.keys(metrics))old[m]=numeric(old[m])+numeric(p[m]);else collapsed.set(key,{...p,landing_page_path:path,session_country:country});}
  const rows=[...dailyRows([...collapsed.values()],closed,'funnels',metrics,'shopify_human_public_landing_pages','human_public_landing_page_sessions',client,r=>({page:String(r.landing_page_path),market:String(r.session_country)})),...dailyRows(totals,closed,'overview',metrics,'shopify_human_sessions','human_online_store_sessions',client,()=>({}))];rows.push(...rows.filter(r=>r.metric==='converting_sessions').map(r=>({...r,metric:'completed_checkouts'})));
  return sourceBatch(client,rows,dayWindow(closedTo,client.timezone).end);
 }
 if(connection.provider==='kind-applovin'){
  const from=w.from>shiftDate(todayIn('UTC',now),-44)?w.from:shiftDate(todayIn('UTC',now),-44),to=w.to<todayIn('UTC',now)?w.to:shiftDate(todayIn('UTC',now),-1),rows:Observation[]=[],seen=new Set<string>();
  for(let page=0;page<20;page++){const params=new URLSearchParams({api_key:c.APPLOVIN_REPORT_KEY,start:from,end:to,format:'json',report_type:'advertiser',columns:'day,campaign,campaign_id_external,country,cost',not_zero:'1',limit:'1000',offset:String(page*1000)}),j=await providerJson(fetcher,`${def.endpoint}?${params}`,{},deadline,0,55000);if(j.code!==200||!Array.isArray(j.results))throw new Error('AppLovin report rejected');for(const r of j.results){checkDate(r.day,{from,to});const dim={campaign:String(r.campaign??'Unknown'),campaign_id:String(r.campaign_id_external??''),market:sourceMarket(String(r.country??'Unknown').toUpperCase()),channel:'applovin',reporting_timezone:'UTC'},key=JSON.stringify([r.day,dim]);if(seen.has(key))throw new Error('Duplicate AppLovin report page');seen.add(key);rows.push(observation(r.day,'media','platform_spend',numeric(r.cost),'applovin_utc_report_cost_not_store_day_mer','applovin_platform_report',client.currency,dim));}if(j.results.length<1000)return sourceBatch(client,rows,dayWindow(to,'UTC').end,['applovin']);}throw new Error('AppLovin pagination did not complete');
 }
 if(connection.provider==='kind-meta'||connection.provider==='kind-meta-performance'){
  const identity=await providerJson(fetcher,`${def.endpoint}/${c.META_API_VERSION}/act_${c.META_AD_ACCOUNT_ID}?fields=id,currency,timezone_name`,{headers:{Authorization:`Bearer ${c.META_ACCESS_TOKEN}`}},deadline);if(identity.currency!==client.currency||identity.timezone_name!==client.timezone)throw new Error('Meta account identity mismatch');
  if(connection.provider==='kind-meta-performance'){
   const headers={Authorization:`Bearer ${c.META_ACCESS_TOKEN}`},common={time_range:JSON.stringify({since:closedTo,until:closedTo}),time_increment:'1',use_account_attribution_setting:'true'},ads:Raw[]=[];let after='';
   for(let page=0;page<10;page++){const params=new URLSearchParams({...common,fields:'date_start,date_stop,ad_id,ad_name,campaign_id,campaign_name,spend,impressions,clicks,actions,action_values',level:'ad',limit:'500',...after?{after}:{}}),j=await providerJson(fetcher,`${def.endpoint}/${c.META_API_VERSION}/act_${c.META_AD_ACCOUNT_ID}/insights?${params}`,{headers},deadline);if(!Array.isArray(j.data))throw new Error('Meta ad performance missing');ads.push(...j.data);if(ads.length>=5000)throw new Error('Meta ad report exceeds its row limit');if(!j.paging?.next)break;const next=j.paging?.cursors?.after;if(!next||next===after||page===9)throw new Error('Meta ad performance pagination did not complete');after=next;}
   const params=new URLSearchParams({...common,fields:'date_start,date_stop,spend,impressions,clicks',level:'account',limit:'2'}),account=await providerJson(fetcher,`${def.endpoint}/${c.META_API_VERSION}/act_${c.META_AD_ACCOUNT_ID}/insights?${params}`,{headers},deadline);if(!Array.isArray(account.data)||account.paging?.next)throw new Error('Meta account totals are incomplete');return normalizeMetaPerformance(ads,account.data,client,closedTo,identity.timezone_name);
  }
  const ids=new Set<string>(),creatives=new Set<string>();let after='';for(let page=0;page<50;page++){const params=new URLSearchParams({fields:'id,creative{id},effective_status',limit:'1000',effective_status:'["ACTIVE"]',...after?{after}:{}}),j=await providerJson(fetcher,`${def.endpoint}/${c.META_API_VERSION}/act_${c.META_AD_ACCOUNT_ID}/ads?${params}`,{headers:{Authorization:`Bearer ${c.META_ACCESS_TOKEN}`}},deadline);if(!Array.isArray(j.data))throw new Error('Meta inventory missing');for(const r of j.data){if(ids.has(r.id))throw new Error('Duplicate Meta inventory page');if(r.effective_status==='ACTIVE'){ids.add(r.id);if(r.creative?.id)creatives.add(r.creative.id);}}if(!j.paging?.next)return sourceBatch(client,[observation(today,'media','active_ads',ids.size,'current_meta_active_inventory_not_historical','meta_current_inventory',null,{channel:'meta'}),observation(today,'media','active_creatives',creatives.size,'current_meta_active_inventory_not_historical','meta_current_inventory',null,{channel:'meta'})],now.toISOString(),['meta']);const next=j.paging?.cursors?.after;if(!next||next===after)throw new Error('Meta pagination did not advance');after=next;}throw new Error('Meta pagination did not complete');
 }
 const headers={'X-Recharge-Access-Token':c.RECHARGE_ADMIN_TOKEN,'X-Recharge-Version':'2021-11'},store=await providerJson(fetcher,`${def.endpoint}/store`,{headers},deadline);if(store?.store?.platform_domain!==c.SHOP_DOMAIN||store?.store?.storefront_domain!=='kindpatches.com'||store?.store?.test_mode!==false)throw new Error('Recharge store identity mismatch');if(connection.provider==='kind-recharge-cancellations')return fetchRechargeCancellations(client,c,effectiveKindWindow(connection,client,w,now),fetcher,deadline,now);const count=await providerJson(fetcher,`${def.endpoint}/customers/count?status=ACTIVE`,{headers:{...headers,'X-Recharge-Version':'2021-01'}},deadline),value=numeric(count.count);if(!Number.isInteger(value)||value<0)throw new Error('Invalid Recharge active-customer count');return sourceBatch(client,[observation(today,'subscriptions','active_customers',value,'recharge_raw_active_customers_not_subscription_count_or_baseline_adjusted','recharge_active_customers',null,{source:'recharge'})],now.toISOString());
}

function threeClosedCuts(closedTo:string){return [...new Set([shiftDate(closedTo,-7),shiftDate(closedTo,-1),closedTo])];}
export async function* fetchKindBatches(connection:Connection,client:Client,w:KindWindow,secret:string,fetcher:typeof fetch=fetch,deadline=Date.now()+90000){
 const asOf=new Date(),actualWindow=effectiveKindWindow(connection,client,w,asOf);
 if(connection.provider==='kind-shopify-traffic'||connection.provider==='kind-shopify-funnels'){
  // These three closed-day cuts supply yesterday, its previous day, and its
  // same weekday comparison without polling a large attribution export.
  for(const day of threeClosedCuts(actualWindow.to))yield {batch:await fetchKindSource(connection,client,{from:day,to:day},secret,fetcher,deadline,asOf),window:{from:day,to:day}};
 }else if(connection.provider==='kind-shopify-hourly'){
  for(let day=actualWindow.from;day<=actualWindow.to;day=shiftDate(day,1)){
   for(let attempt=0;attempt<3;attempt++)try{yield {batch:await fetchKindSource(connection,client,{from:day,to:day},secret,fetcher,deadline,asOf),window:{from:day,to:day}};break;}catch(e){if(attempt===2||!(e as Error).message.includes('reconcile')||Date.now()+5000>=deadline)throw e;}
  }
 }else{
  for(let attempt=0;attempt<3;attempt++)try{yield {batch:await fetchKindSource(connection,client,w,secret,fetcher,deadline,asOf),window:actualWindow};return;}catch(e){if(attempt===2||!(e as Error).message.includes('reconcile')||Date.now()+5000>=deadline)throw e;}
 }
}

export function effectiveKindWindow(connection:Connection,client:Client,w:KindWindow,now=new Date()){
 const today=todayIn(client.timezone,now),closedTo=w.to<today?w.to:shiftDate(today,-1);
 if(connection.provider==='kind-triple-whale-diagnostics'){const hour=Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(client.timezone).hour,to=w.to<today?w.to:hour?today:shiftDate(today,-1);return {from:w.from>shiftDate(to,-59)?w.from:shiftDate(to,-59),to};}
 if(connection.provider==='kind-shopify-traffic'||connection.provider==='kind-shopify-funnels')return {from:shiftDate(closedTo,-7),to:closedTo};
 if(connection.provider==='kind-triple-whale-summary')return {from:closedTo,to:closedTo};
 if(connection.provider==='kind-meta-performance')return {from:closedTo,to:closedTo};
 if(connection.provider==='kind-shopify-hourly'){const to=w.to<today?w.to:today;return {from:w.from>shiftDate(to,-8)?w.from:shiftDate(to,-8),to};}
 if(connection.provider==='kind-shopify-sales')return {from:w.from,to:closedTo};
 if(connection.provider==='kind-shopify-products')return {from:w.from>shiftDate(closedTo,-29)?w.from:shiftDate(closedTo,-29),to:closedTo};
 if(connection.provider==='kind-applovin'){const utc=todayIn('UTC',now);return {from:w.from>shiftDate(utc,-44)?w.from:shiftDate(utc,-44),to:w.to<utc?w.to:shiftDate(utc,-1)};}
 if(connection.provider==='kind-recharge-cancellations'){const to=w.to<today?w.to:today,minimum=shiftDate(to,w.to<today?-61:-2);return {from:w.from>minimum?w.from:minimum,to};}
 if(connection.provider==='kind-meta'||connection.provider==='kind-recharge')return {from:today,to:today};
 return w;
}
