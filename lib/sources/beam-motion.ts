import {z} from 'zod';
import type {Client,Observation,SourceBatch} from '../analytics/contracts';
import type {RegisteredContract} from './registered-contract';
import {dayWindow,todayIn} from '../analytics/windows';
import {sourceDates,observation} from './kind-patches';
import {validateBatch} from './qualification';
import {motionMcpCall} from './motion-mcp';

export const BEAM_MOTION_ORGANIZATION='681244cb525792672d188127';
export const BEAM_MOTION_WORKSPACE='681244fa7b5bf830fcc1443c';
export const BEAM_META_ACCOUNT='289851516154147';
export const beamMotionConfiguration=z.object({clientId:z.string().min(1),reportingTimezone:z.string().optional()});
export type BeamMotionConnection={id:string;clientId:string;reportingTimezone?:string};
const definition='motion_meta_account_spend_provider_date_cached';
const creativeDefinition='motion_meta_per_ad_delivery_provider_date_cached';
const mediaDimensions=['channel','reporting_timezone','provider_as_of'];
const metadata=new WeakMap<SourceBatch,{asOf:string[];matched:boolean;accountOnlyDates:string[]}>();
type MotionAd={ad:Record<string,string>;insights:Record<string,number>;adIds?:unknown;groupKey?:unknown;numberAds?:unknown};
type MotionAggregate=Record<string,number>&{date_start:string;adIds:string[]};
type MotionReport={reportPercentCompletion:number;lastCachedTime:string;pagination:{totalCount:number;offset:number;nextOffset:number|null};data:{insights:MotionAd[];aggregatedInsights:MotionAggregate}};
type MotionPayload={contractVersion:string;status:string;pollAfterMs?:number;nextCursor?:string|null;data?:{organizations?:{id:string;workspaces?:{id:string}[]}[];data?:{insightsResult?:MotionReport}}};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
// These are provider-owned marketing labels, not customer URLs or traffic
// identifiers. Dates, creative IDs and underscore-based naming stay readable.
function marketingLabel(value:unknown){
 if(typeof value!=='string')return 'Unnamed';
 return value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,' ').replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi,'[private]').replace(/\s+/g,' ').trim().slice(0,300)||'Unnamed';
}
function finite(v:unknown){if(typeof v!=='number'||!Number.isFinite(v)||v<0)throw Error('Motion returned invalid delivery metrics');return v;}
function count(v:unknown){const n=finite(v);if(!Number.isSafeInteger(n))throw Error('Motion returned invalid delivery counts');return n;}
function identity(connection:BeamMotionConnection,client:Client){if(connection.clientId!=='beam'||client.id!=='beam'||client.timezone!=='America/New_York'||client.currency!=='USD')throw Error('Motion Beam identity mismatch');if(connection.reportingTimezone!==undefined&&connection.reportingTimezone!==client.timezone)throw Error('Motion reporting timezone does not match the store');}
function timestamp(v:unknown){if(typeof v!=='string'||!Number.isFinite(Date.parse(v)))throw Error('Motion cache timestamp missing');return new Date(v).toISOString();}
function reconcile(expected:number,actual:number,money=false){if(Math.abs(expected-actual)>(money?Math.max(.02,Math.abs(expected)*1e-8):0))throw Error('Motion paginated ads do not reconcile to the full account aggregate');}
function missingAdCache(response:MotionPayload,report:Record<string,unknown>,values:Record<string,unknown>,pagination:Record<string,unknown>){
 return response.nextCursor===null&&report.reportPercentCompletion===100&&report.isLiveData===true&&report.cacheHit===true&&report.lastCachedTime===undefined&&values.aggregatedInsights===undefined&&Array.isArray(values.insights)&&values.insights.length===0&&pagination.totalCount===0&&pagination.offset===0&&pagination.nextOffset===null;
}
async function read(token:string,tool:'get_auth_context'|'get_creative_insights',args:Record<string,unknown>,fetcher:typeof fetch,deadline:number){if(Date.now()>=deadline)throw Error('Motion source synchronization deadline reached');const r=await motionMcpCall(token,tool,args,async(input,init)=>{const remaining=deadline-Date.now();if(remaining<=0)throw Error('Deadline reached');return fetcher(input,{...init,signal:AbortSignal.any([init?.signal??new AbortController().signal,AbortSignal.timeout(remaining)])});});if(!record(r)||r.contractVersion!=='v1')throw Error('Motion returned an invalid report');return r as MotionPayload;}

/** Motion exposes calendar-date cached reports, not exact store-hour spend. */
export async function fetchBeamMotionSource(connection:BeamMotionConnection,client:Client,w:{from:string;to:string},accessToken:string,fetcher:typeof fetch=fetch,deadline=Date.now()+240000,now=new Date()):Promise<SourceBatch>{
 identity(connection,client);const dates=sourceDates(w);if(!dates.length)throw Error('Motion source window is invalid');const today=todayIn(client.timezone,now);if(w.to>today)throw Error('Motion source window includes a future date');
 const auth=await read(accessToken,'get_auth_context',{},fetcher,deadline);
 if(auth.status!=='success'||!auth.data?.organizations?.some((o)=>o.id===BEAM_MOTION_ORGANIZATION&&o.workspaces?.some((s)=>s.id===BEAM_MOTION_WORKSPACE)))throw Error('Motion authorization does not include the Beam workspace');
 const rows:Observation[]=[],cacheTimes:string[]=[],accountOnlyDates:string[]=[],matched=connection.reportingTimezone===client.timezone;let covered:string|null=null;
 for(const date of dates){
  const args={organizationId:BEAM_MOTION_ORGANIZATION,workspaceId:BEAM_MOTION_WORKSPACE,insightType:'SPEND',datePreset:'CUSTOM',startDate:date,endDate:date,withAggregatedInsights:true,includeCreativeUrls:false,includeNorthbeam:false,insightGroups:['defaultKpiMetrics'],groupBy:'adId',limit:25};
  for(let attempt=0;attempt<2;attempt++){
  const ads:MotionAd[]=[],seen=new Set<string>(),members=new Set<string>(),groups=new Set<string>(),cursors=new Set<string>();let grouping:'adId'|'name'=attempt===0?'adId':'name',cursor:string|undefined,total:number|undefined,aggregate:MotionAggregate|undefined,asOf:string|undefined,waits=0;
  for(let page=0;page<400;){
   const response=await read(accessToken,'get_creative_insights',{...args,groupBy:grouping,...cursor?{cursor}:{}},fetcher,deadline);
   if(response.status==='waiting'){if(++waits>8)throw Error('Motion report is still compiling');const delay=Math.min(5000,Math.max(100,Number(response.pollAfterMs)||1000));if(Date.now()+delay>=deadline)throw Error('Motion report compilation exceeded the source deadline');await new Promise(r=>setTimeout(r,delay));continue;}
   if(response.status!=='success')throw Error('Motion report is unavailable');const report=response.data?.data?.insightsResult,values=report?.data,pagination=report?.pagination;
   if(!record(report)||report.reportPercentCompletion!==100||!record(values)||!Array.isArray(values.insights)||!record(pagination)||!Number.isSafeInteger(pagination.totalCount)||pagination.totalCount<0||pagination.totalCount>9999||pagination.offset!==ads.length)throw Error('Motion report pagination is incomplete or invalid');
   // The documented name grouping can retain a complete stored report while
   // the adId route returns this empty live-cache placeholder. It supplies
   // account totals only: grouped metrics cannot become per-ad delivery facts.
   if(grouping==='adId'&&page===0&&missingAdCache(response,report,values,pagination)){grouping='name';waits=0;continue;}
   const currentAsOf=timestamp(report.lastCachedTime);if(Date.parse(currentAsOf)>now.getTime()+300000)throw Error('Motion cache timestamp is in the future');
   if(total===undefined){total=pagination.totalCount;aggregate=values.aggregatedInsights;asOf=currentAsOf;if(!record(aggregate)||aggregate.date_start!==`${date}T00:00:00.000Z`||!Array.isArray(aggregate.adIds)||aggregate.adIds.some((id:unknown)=>typeof id!=='string'||!/^\d+$/.test(id))||new Set(aggregate.adIds).size!==aggregate.adIds.length||(grouping==='adId'?aggregate.adIds.length!==total:aggregate.adIds.length<total||aggregate.adIds.length>9999))throw Error('Motion full account aggregate is missing');finite(aggregate.spend);count(aggregate.impressions);count(aggregate.clicks_all);}
   else if(pagination.totalCount!==total||currentAsOf!==asOf||finite(values.aggregatedInsights?.spend)!==aggregate!.spend)throw Error('Motion report changed during pagination');
   if(grouping==='name'&&(['impressions','clicks_all'].some(key=>finite(values.aggregatedInsights?.[key])!==aggregate![key])||values.aggregatedInsights?.date_start!==aggregate!.date_start||!Array.isArray(values.aggregatedInsights?.adIds)||JSON.stringify([...values.aggregatedInsights.adIds].sort())!==JSON.stringify([...aggregate!.adIds].sort())))throw Error('Motion report changed during pagination');
   for(const ad of values.insights){if(!record(ad)||!record(ad.ad)||ad.ad.dataSourceFacebookId!==BEAM_META_ACCOUNT||!/^\d+$/.test(ad.ad.adId)||seen.has(ad.ad.adId)||!record(ad.insights))throw Error('Motion ad identity or pagination changed');for(const key of ['adsetId','campaignId'])if(!/^\d+$/.test(ad.ad[key]))throw Error('Motion ad hierarchy missing');finite(ad.insights.spend);count(ad.insights.impressions);count(ad.insights.clicks_all);
    if(grouping==='name'){
     const ids=ad.adIds,insightIds=ad.insights.adIds,key=ad.groupKey;
     if(typeof key!=='string'||!key.length||key.length>1024||groups.has(key)||!Array.isArray(ids)||!ids.length||ad.numberAds!==ids.length||!Array.isArray(insightIds)||insightIds.length!==ids.length||new Set(insightIds).size!==ids.length||!ids.includes(ad.ad.adId))throw Error('Motion name-group membership is invalid');
     for(const id of ids){if(typeof id!=='string'||!/^\d+$/.test(id)||members.has(id)||!insightIds.includes(id))throw Error('Motion name-group membership is invalid');members.add(id);}groups.add(key);
    }
    seen.add(ad.ad.adId);ads.push(ad);
   }
   page++;const next=response.nextCursor;if(next!==null&&(typeof next!=='string'||!next.length||next.length>1024||cursors.has(next)))throw Error('Motion report pagination cursor is invalid');
   if(next===null){if(ads.length!==total||pagination.nextOffset!==null)throw Error('Motion report pagination did not finish');break;}
   if(ads.length>=total||!values.insights.length||pagination.nextOffset!==ads.length)throw Error('Motion report pagination is incomplete');cursors.add(next);cursor=next;
  }
  const population=grouping==='name'?members:seen;
  if(!aggregate||!asOf||ads.length!==total||population.size!==aggregate.adIds.length||aggregate.adIds.some((id:unknown)=>typeof id!=='string'||!population.has(id)))throw Error('Motion complete ad population is missing');
  for(const metric of ['spend','impressions','clicks_all'])reconcile(aggregate[metric],ads.reduce((sum,ad)=>sum+ad.insights[metric],0),metric==='spend');
  const closed=date<today,end=closed?dayWindow(date,client.timezone).end:null,through=matched?end:null;
  // A complete page set can still be an intraday capture of a now-closed
  // date. Retry only after all primary controls pass; never publish that dip.
  if(end&&Date.parse(asOf)<Date.parse(end)){if(grouping==='adId')continue;throw Error('Motion name-group cache predates the end of the reported date');}
  const common={channel:'meta',reporting_timezone:matched?client.timezone:'provider_account_timezone_unverified',provider_as_of:asOf};
  const add=(dataset:string,metric:string,value:number,currency:string|null,dimensions:Record<string,string>,def:string,population:string)=>{rows.push({...observation(date,dataset,metric,value,def,population,currency,dimensions),sourceId:connection.id,retrievedAt:now.toISOString(),coverageThrough:through,quality:closed?'complete':'partial'});};
  add('media',matched&&closed?'spend':'platform_spend',aggregate.spend,client.currency,common,definition,'motion_meta_account_report');
  if(matched&&closed)add('overview','spend',aggregate.spend,client.currency,{},'motion_meta_only_spend_closed_store_day','motion_meta_account_report');
  if(grouping==='name')accountOnlyDates.push(date);
  else for(const ad of ads){const d={...common,ad_id:ad.ad.adId,ad:marketingLabel(ad.ad.adName),adset_id:ad.ad.adsetId,adset:marketingLabel(ad.ad.adsetName),campaign_id:ad.ad.campaignId,campaign:marketingLabel(ad.ad.campaignName)};for(const [metric,field]of Object.entries({motion_ad_spend:'spend',motion_ad_impressions:'impressions',motion_ad_clicks:'clicks_all'}))add('creatives',metric,ad.insights[field],metric==='motion_ad_spend'?client.currency:null,d,creativeDefinition,'motion_meta_ad_report');}
  cacheTimes.push(asOf);if(through)covered=through;break;
  }
 }
 const batch=validateBatch({clientId:client.id,timezone:client.timezone,currency:client.currency,channels:['meta'],dimensions:[...new Set(rows.flatMap(r=>Object.keys(r.dimensions)))],grain:'daily',complete:true,coverageThrough:covered,nextCursor:null,rows},client.id);metadata.set(batch,{asOf:cacheTimes,matched,accountOnlyDates});return batch;
}
export function beamMotionQualification(batch:SourceBatch):RegisteredContract {
 if(batch.clientId!=='beam'||batch.grain!=='daily'||!batch.complete||batch.nextCursor)throw Error('Motion qualification requires complete daily Beam reporting');
 const profiles=new Map<string,RegisteredContract['profiles'][number]>();for(const r of batch.rows){const p={dataset:r.dataset,metric:r.metric,population:r.population!,definition:r.definition,currency:r.currency,dimensions:Object.keys(r.dimensions),hourly:false};profiles.set(`${r.dataset}:${r.metric}`,p);}
 if(!profiles.size)profiles.set('media:platform_spend',{dataset:'media',metric:'platform_spend',population:'motion_meta_account_report',definition,currency:batch.currency,dimensions:mediaDimensions,hourly:false});
 const meta=metadata.get(batch);return {clientId:batch.clientId,queryId:'beam-motion:provider-calendar-day-v1',timezone:batch.timezone,currency:batch.currency,hourlyGrain:false,channels:['meta'],requiredChannels:['meta'],dimensions:batch.dimensions,requiredDimensions:batch.dimensions,paginationComplete:true,reconciled:true,reconciliationEvidence:`Authenticated fixed Beam workspace and Meta account. Complete bounded ad or name-group pagination reconciles spend, impressions and all clicks to the independent full account aggregate. ${meta?.accountOnlyDates.length?`Name-group member unions match the account population; account spend only on ${meta.accountOnlyDates.join(', ')}; per-ad delivery remains unavailable. `:''}USD verified in provider settings. Cached provider date reporting; cache as-of ${meta?.asOf.join(', ')??'retained in provider_as_of dimensions'}. ${meta?.matched?'Account reporting timezone independently configured equal to store timezone; only closed days provide headline Meta-only spend.':'Account timezone remains unverified; platform date metrics only, no store-day headline spend.'} Exact hourly spend and same-hour MER are unavailable from Motion MCP.`,profiles:[...profiles.values()]};
}
