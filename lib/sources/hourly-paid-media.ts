import {Temporal} from '@js-temporal/polyfill';
import type {Client,Observation,SourceBatch} from '../analytics/contracts';
import {dayWindow,todayIn} from '../analytics/windows';
import {boundedRows,checkDate,hourlySessionCutoff,localHourInterval,numeric,observation,providerJson,reconcile,sourceBatch,sourceMarket,type KindConfig,type KindWindow,type Raw} from './kind-patches';
import {validateBatch} from './qualification';

export const metaHourlyDefinition='meta_per_ad_platform_account_attribution_pixel_purchase_store_hour';
export const appLovinHourlyDefinition='applovin_platform_cost_utc_hours_to_store_day_not_headline_spend';
export const metaHourlyDimensions=['channel','ad_id','ad','campaign_id','campaign','reporting_timezone','attribution'];
export const appLovinHourlyDimensions=['campaign','campaign_id','market','channel','reporting_timezone'];
const metaHourField='hourly_stats_aggregated_by_advertiser_time_zone';
const metaMetrics=['meta_ad_spend','meta_ad_impressions','meta_ad_clicks','meta_ad_pixel_purchases','meta_ad_pixel_purchase_value'] as const;
export const META_AD_HOURLY_GROUP_LIMIT=39999;
function storeCut(client:Client,w:KindWindow,now:Date){
 if(w.from!==w.to)throw new Error('Hourly paid media requires one store day per batch');
 const cutoff=hourlySessionCutoff(client.timezone,now);if(w.to>cutoff.date)throw new Error('Hourly paid media extends beyond the current store day');
 if(w.to===cutoff.date&&!cutoff.hour)throw new Error('The first complete store hour is not available yet');
 return {date:w.to,limit:w.to===cutoff.date?cutoff.hour:24,through:w.to===cutoff.date?cutoff.through:dayWindow(w.to,client.timezone).end,start:dayWindow(w.to,client.timezone).start};
}
function safeLabel(value:unknown){let text=String(value??'Unknown').trim()||'Unknown';if(/[^\s/@]+@[^\s/]+\.[^\s/]+/.test(text))return '[private]';if(/^https?:\/\//i.test(text)){try{const url=new URL(text);text=`${url.origin}${url.pathname}`;}catch{return '[invalid]';}}return text.replace(/[A-Za-z0-9_=-]{28,}/g,'[private]').slice(0,200);}
function count(value:unknown){const n=numeric(value);if(!Number.isSafeInteger(n)||n<0)throw new Error('Invalid paid-media delivery count');return n;}
// Meta omits impressions/clicks on some conversion-only hourly rows. Zero
// candidates are accepted only within the registered account reconciliation
// bounds; an explicit null is still rejected as an unknown provider value.
function metaDeliveryCount(value:unknown){return value===undefined?0:count(value);}
function cost(value:unknown){const n=numeric(value);if(n<0)throw new Error('Invalid paid-media spend');return n;}
function metaHour(row:Raw,date:string){checkDate(row.date_start,{from:date,to:date});if(row.date_stop!==date)throw new Error('Meta reporting window mismatch');const match=String(row[metaHourField]??'').match(/^(\d{2}):00:00 - (\d{2}):59:59$/);if(!match||match[1]!==match[2]||Number(match[1])>23)throw new Error('Invalid Meta advertiser hour');return Number(match[1]);}
function purchases(values:unknown){if(!Array.isArray(values))return null;const matching=values.filter(row=>row.action_type==='offsite_conversion.fb_pixel_purchase');if(matching.length>1)throw new Error('Duplicate Meta purchase action');return matching.length?cost(matching[0].value):0;}
/** The current open provider hour is discarded on both sides. Pixel attribution
 * remains a platform outcome; none of these rows replaces commerce or MER. */
class MetaHourlyReconciliationError extends Error{constructor(readonly hour:number,field:string){super(`Meta hourly ${field} does not reconcile with independent account totals`);}}
export function normalizeMetaHourlyPerformance(input:{ads:Raw[];account:Raw[]},client:Client,w:KindWindow,now=new Date(),settledThrough?:string):SourceBatch{
 const cut=storeCut(client,w,now),live=w.to===todayIn(client.timezone,now);
 if(settledThrough){const prior=localHourInterval(cut.date,cut.limit-1,client.timezone)?.start;if(!live||settledThrough!==prior||Date.parse(settledThrough)<=Date.parse(cut.start))throw new Error('Invalid Meta settled-hour boundary');cut.limit--;cut.through=settledThrough;}
 if(input.ads.length>META_AD_HOURLY_GROUP_LIMIT||input.account.length>24)throw new Error('Meta hourly report is incomplete or exceeds its row limit');boundedRows(input.ads);boundedRows(input.account);
 const accounts=new Map<number,Raw>(),ads=new Map<string,{raw:Raw;hour:number}>(),delivery=new Map<number,{spend:number;impressions:number;clicks:number;ads:number}>();
 for(const row of input.account){const hour=metaHour(row,cut.date);if(accounts.has(hour))throw new Error('Duplicate Meta account hour');accounts.set(hour,row);}
 for(const row of input.ads){const hour=metaHour(row,cut.date);if(!/^\d+$/.test(String(row.ad_id))||!/^\d+$/.test(String(row.campaign_id)))throw new Error('Meta ad identity missing');const key=`${hour}:${row.ad_id}`;if(ads.has(key))throw new Error('Duplicate Meta ad hour');ads.set(key,{raw:row,hour});if(hour>=cut.limit)continue;const interval=localHourInterval(cut.date,hour,client.timezone);if(!interval)throw new Error('Meta reporting contains a skipped store hour');const old=delivery.get(hour)??{spend:0,impressions:0,clicks:0,ads:0};old.spend+=cost(row.spend);old.impressions+=metaDeliveryCount(row.impressions);old.clicks+=metaDeliveryCount(row.clicks);old.ads++;delivery.set(hour,old);}
 for(let hour=0;hour<cut.limit;hour++){
  const actual=delivery.get(hour)??{spend:0,impressions:0,clicks:0,ads:0},expected=accounts.get(hour);
  if(!localHourInterval(cut.date,hour,client.timezone)){if(expected||actual.ads)throw new Error('Meta reporting contains a skipped store hour');continue;}
  // Each reported ad spend is rounded to cents. Reconcile only the maximum
  // mathematical penny-rounding error, plus the explicit live revision bound.
  const spend=expected?cost(expected.spend):0;if(Math.abs(spend-actual.spend)>Math.max(.02,(actual.ads+1)*.005,live?Math.max(spend,actual.spend)*.001:0)+1e-9)throw new MetaHourlyReconciliationError(hour,'spend');
  // Independent live reports can receive late platform revisions during the
  // asynchronous report computation. The registered 0.1% bound applies only
  // to today's completed hours; historical delivery counts remain exact.
  for(const field of ['impressions','clicks'] as const){const value=expected?count(expected[field]):0;if(Math.abs(value-actual[field])>(live?Math.max(value,actual[field])*.001:0))throw new MetaHourlyReconciliationError(hour,'delivery');}
 }
 const rows:Observation[]=[];for(const {raw,hour} of ads.values()){
  if(hour>=cut.limit)continue;const interval=localHourInterval(cut.date,hour,client.timezone)!;
  const dimensions={channel:'meta',ad_id:String(raw.ad_id),ad:safeLabel(raw.ad_name),campaign_id:String(raw.campaign_id),campaign:safeLabel(raw.campaign_name),reporting_timezone:client.timezone,attribution:'account'};
  const values=[cost(raw.spend),metaDeliveryCount(raw.impressions),metaDeliveryCount(raw.clicks),purchases(raw.actions),purchases(raw.action_values)];
  for(let i=0;i<metaMetrics.length;i++)rows.push({...observation(cut.date,'creatives',metaMetrics[i],values[i]??0,metaHourlyDefinition,'meta_platform_ad_report',i===0||i===4?client.currency:null,dimensions,interval),value:values[i]});
 }
 return validateBatch({clientId:client.id,timezone:client.timezone,currency:client.currency,rows,coverageThrough:cut.through,channels:['meta'],grain:'hourly',dimensions:metaHourlyDimensions,complete:true,nextCursor:null},client.id,{kindMetaHourly:true});
}

/** AppLovin reports UTC dates, so a Stockholm store day requires the preceding
 * UTC evening. Preserve its UTC reporting label while storing exact intervals. */
export function appLovinUTCWindow(client:Client,w:KindWindow,now=new Date()){
 const cut=storeCut(client,w,now),from=cut.start.slice(0,10),to=new Date(Date.parse(cut.through)-1).toISOString().slice(0,10);
 if(from<Temporal.PlainDate.from(todayIn('UTC',now)).subtract({days:29}).toString())throw new Error('AppLovin hourly data is only available for the past 30 UTC days');
 return {...cut,from,to};
}
function appHour(row:Raw,window:{from:string;to:string}){checkDate(row.day,window);const match=String(row.hour??'').match(/^(\d{2}):00$/);if(!match||Number(match[1])>23)throw new Error('Invalid AppLovin UTC hour');const start=`${row.day}T${match[1]}:00:00Z`,end=Temporal.Instant.from(start).add({hours:1}).toString();return {start,end};}
class AppLovinHourlyReconciliationError extends Error{constructor(readonly hour:string){super('AppLovin hourly spend does not reconcile with independent hour totals');}}
export class AppLovinSettlingHourError extends Error{
 readonly retryAfterMs=300000;
 constructor(){super('AppLovin latest completed hour is still settling');this.name='AppLovinSettlingHourError';}
}
export function normalizeAppLovinHourlySpend(input:{hourly:Raw[];totals:Raw[]},client:Client,w:KindWindow,now=new Date(),settledThrough?:string):SourceBatch{
 const window=appLovinUTCWindow(client,w,now);if(settledThrough){if(!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(settledThrough)||Date.parse(settledThrough)!==Date.parse(window.through)-3600000||Date.parse(settledThrough)<=Date.parse(window.start)||w.to!==todayIn(client.timezone,now))throw new Error('Invalid AppLovin settled-hour boundary');window.through=settledThrough;}
 if(client.currency!=='USD')throw new Error('AppLovin report cost requires USD currency');boundedRows(input.hourly);boundedRows(input.totals);
 const totals=new Map<string,number>(),spend=new Map<string,number>(),seen=new Set<string>(),rows:Observation[]=[];
 for(const raw of input.totals){const interval=appHour(raw,window);if(totals.has(interval.start))throw new Error('Duplicate independent AppLovin hour');totals.set(interval.start,cost(raw.cost));}
 for(const raw of input.hourly){const interval=appHour(raw,window),dimensions={campaign:safeLabel(raw.campaign),campaign_id:String(raw.campaign_id_external??''),market:sourceMarket(String(raw.country??'Unknown').toUpperCase()),channel:'applovin',reporting_timezone:'UTC'},key=JSON.stringify([interval.start,dimensions]);if(seen.has(key))throw new Error('Duplicate AppLovin campaign-country hour');seen.add(key);const value=cost(raw.cost);spend.set(interval.start,(spend.get(interval.start)??0)+value);
  if(Date.parse(interval.start)<Date.parse(window.start)||Date.parse(interval.end)>Date.parse(window.through))continue;
  rows.push(observation(window.date,'media','platform_spend',value,appLovinHourlyDefinition,'applovin_platform_report',client.currency,dimensions,interval));
 }
 for(const start of new Set([...totals.keys(),...spend.keys()])){
  if(Date.parse(start)<Date.parse(window.start)||Date.parse(start)+3600000>Date.parse(window.through))continue;
  try{reconcile(totals.get(start)??0,spend.get(start)??0);}catch{throw new AppLovinHourlyReconciliationError(start);}
 }
 return {...sourceBatch(client,rows,window.through,['applovin'],'hourly'),dimensions:appLovinHourlyDimensions};
}

async function metaPages(config:KindConfig,client:Client,w:KindWindow,level:'ad'|'account',fetcher:typeof fetch,deadline:number){
 const rows:Raw[]=[],common={time_range:JSON.stringify({since:w.from,until:w.to}),time_increment:'1',use_account_attribution_setting:'true',breakdowns:metaHourField,fields:level==='ad'?'date_start,date_stop,ad_id,ad_name,campaign_id,campaign_name,spend,impressions,clicks,actions,action_values':'date_start,date_stop,spend,impressions,clicks',level,limit:'1000'},seen=new Set<string>(),headers={Authorization:`Bearer ${config.META_ACCESS_TOKEN}`},base=`https://graph.facebook.com/${config.META_API_VERSION}`;let after='',endpoint=`${base}/act_${config.META_AD_ACCOUNT_ID}/insights`;
 // Conversion breakdown computation exceeds Meta's synchronous server timeout
 // on this account. Its official asynchronous reporting endpoint retains the
 // exact same query, attribution and completed-hour validation.
 if(level==='ad'){
  const report=await providerJson(fetcher,endpoint,{method:'POST',headers,body:new URLSearchParams({...common,async:'true'})},deadline,0,55000);
  if(!/^\d+$/.test(String(report.report_run_id??'')))throw new Error('Meta hourly report identity missing');
  let complete=false;for(let poll=0;poll<40;poll++){
   const state=await providerJson(fetcher,`${base}/${report.report_run_id}?fields=async_status,async_percent_completion`,{headers},deadline);
   if(state.async_status==='Job Completed'){complete=true;break;}
   if(!['Job Not Started','Job Started','Job Running'].includes(state.async_status))throw new Error('Meta hourly asynchronous report failed');
   if(Date.now()+3500>=deadline)throw new Error('Meta hourly report did not complete before synchronization deadline');
   await new Promise(resolve=>setTimeout(resolve,3000));
  }
  if(!complete)throw new Error('Meta hourly report did not complete');endpoint=`${base}/${report.report_run_id}/insights`;
 }
 for(let page=0;page<40;page++){
  const params=new URLSearchParams({...level==='account'?common:{limit:'1000'},...after?{after}:{}}),data=await providerJson(fetcher,`${endpoint}?${params}`,{headers},deadline,0,55000);
  if(!Array.isArray(data.data))throw new Error('Meta hourly report missing');rows.push(...data.data);if(rows.length>META_AD_HOURLY_GROUP_LIMIT)throw new Error('Meta hourly report exceeds its row limit');if(!data.paging?.next)return rows;
  const next=data.paging?.cursors?.after;if(typeof next!=='string'||!next||seen.has(next))throw new Error('Meta hourly pagination did not complete');seen.add(next);after=next;
 }
 throw new Error('Meta hourly pagination did not complete');
}
export async function fetchMetaHourlyPerformance(client:Client,config:KindConfig,w:KindWindow,fetcher:typeof fetch=fetch,deadline=Date.now()+120000,now=new Date()){
 storeCut(client,w,now);if(config.META_TIME_ZONE!==client.timezone)throw new Error('Meta reporting timezone mismatch');
 const [ads,account]=await Promise.all([metaPages(config,client,w,'ad',fetcher,deadline),metaPages(config,client,w,'account',fetcher,deadline)]);
 try{return normalizeMetaHourlyPerformance({ads,account},client,w,now);}catch(error){
  const cut=storeCut(client,w,now);if(!(error instanceof MetaHourlyReconciliationError)||error.hour!==cut.limit-1||w.to!==todayIn(client.timezone,now))throw error;
  return normalizeMetaHourlyPerformance({ads,account},client,w,now,localHourInterval(cut.date,cut.limit-1,client.timezone)!.start);
 }
}
async function appPages(config:KindConfig,window:{from:string;to:string},columns:string,fetcher:typeof fetch,deadline:number){
 // Default report ordering can change between offset requests, repeating some
 // rows and omitting others. Fetch the existing bounded report in one response;
 // reaching its cap remains an error, and duplicate/hour-total checks still run.
 const params=new URLSearchParams({api_key:config.APPLOVIN_REPORT_KEY,start:window.from,end:window.to,format:'json',report_type:'advertiser',columns,not_zero:'1',limit:'40000',offset:'0'}),data=await providerJson(fetcher,`https://r.applovin.com/report?${params}`,{},deadline,0,55000);
 if(data.code!==200||!Array.isArray(data.results))throw new Error('AppLovin hourly report rejected');
 if(data.results.length>=40000)throw new Error('AppLovin hourly report exceeds its row limit');
 return data.results as Raw[];
}
export async function fetchAppLovinHourlySpend(client:Client,config:KindConfig,w:KindWindow,fetcher:typeof fetch=fetch,deadline=Date.now()+120000,now=new Date()){
 const window=appLovinUTCWindow(client,w,now),[hourly,totals]=await Promise.all([appPages(config,window,'day,hour,campaign,campaign_id_external,country,cost',fetcher,deadline),appPages(config,window,'day,hour,cost',fetcher,deadline)]);
 try{return normalizeAppLovinHourlySpend({hourly,totals},client,w,now);}catch(error){
  // The provider's newest completed hour can still settle independently at
  // different aggregation levels. A verified earlier cutoff is publishable;
  // its exact coverage is retained and every older hour must still reconcile.
  const previous=Temporal.Instant.from(window.through).subtract({hours:1}).toString();
  if(!(error instanceof AppLovinHourlyReconciliationError)||error.hour!==previous||w.to!==todayIn(client.timezone,now))throw error;
  if(Date.parse(previous)<=Date.parse(window.start))throw new AppLovinSettlingHourError();
  return normalizeAppLovinHourlySpend({hourly,totals},client,w,now,previous);
 }
}
