import {z} from 'zod';
import type {Client,Observation,SourceBatch} from '../analytics/contracts';
import type {RegisteredContract} from './registered-contract';
import {dayWindow,todayIn} from '../analytics/windows';
import {observation,sourceDates,trafficLabel,providerJson} from './kind-patches';
import {validateBatch} from './qualification';

export const BEAM_INTELLIGEMS_ORGANIZATION='d6ad5167-0729-4e0f-8269-4d8c0a390dbd';
export const beamIntelligemsConfiguration=z.object({apiKey:z.string().min(1),organizationId:z.literal(BEAM_INTELLIGEMS_ORGANIZATION).default(BEAM_INTELLIGEMS_ORGANIZATION)});
export type BeamIntelligemsConnection={id:string;clientId:string};
const base='https://api.intelligems.io/v25-10-beta';
const definition='intelligems_us_experiment_all_products_all_currencies_daily_visitors_zscore3';
const population='intelligems_exposed_experiment_visitors';
const dimensions=['report_date','experiment_id','experiment','variant_id','variant','status','is_control','market','analysis_scope'];
const metrics=['visitors','orders','conversion_rate','conversion_rate_ci_low','conversion_rate_ci_high','conversion_rate_lift','conversion_rate_lift_ci_low','conversion_rate_lift_ci_high','conversion_rate_probability_to_beat_control','conversion_rate_probability_best'];
type Experiment={id:string;name:string;category:string;status:string;startedAtTs:number|null;endedAtTs?:number|null;pausedAtTs?:number|null;isDeleted?:boolean;organizationId:string};
type StatisticalMetric={value?:number|null;ci_low?:number|null;ci_high?:number|null;p2bb?:number|null;p2bc?:number|null;uplift?:StatisticalMetric|null};
type Variant={id:string;name:string;isControl:boolean};
type ExperimentResult={experienceId:string;datasetId:string;metrics:{variation_id:string;audience?:string;dt?:string;n_visitors?:StatisticalMetric;n_orders?:StatisticalMetric;conversion_rate?:StatisticalMetric|null}[];variations:Variant[];nextCursor?:string;hasNextPage?:boolean};
type Catalog={experiencesList:Experiment[];page:number;limit:number;total:number;totalPages:number};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function number(v:unknown){if(typeof v!=='number'||!Number.isFinite(v))throw Error('Intelligems returned invalid experiment metrics');return v;}
function probability(v:unknown){const n=number(v);if(n<0||n>1)throw Error('Intelligems returned invalid experiment probability');return n;}
function count(v:unknown){const n=number(v);if(!Number.isSafeInteger(n)||n<0)throw Error('Intelligems returned invalid experiment counts');return n;}
function id(v:unknown):v is string{return typeof v==='string'&&/^[a-f\d-]{36}$/i.test(v);}
function identity(c:BeamIntelligemsConnection,client:Client){if(c.clientId!=='beam'||client.id!=='beam'||client.timezone!=='America/New_York'||client.currency!=='USD')throw Error('Intelligems Beam identity mismatch');}
async function request(path:string,key:string,body:Record<string,unknown>|undefined,fetcher:typeof fetch,deadline:number){return providerJson(fetcher,`${base}${path}`,{method:body?'POST':'GET',headers:{'intelligems-access-token':key,...body?{'Content-Type':'application/json'}:{}},...body?{body:JSON.stringify(body)}:{}},deadline);}

/** Visitor experiment reporting is independent of Shopify human-session funnels. */
export async function fetchBeamIntelligemsSource(connection:BeamIntelligemsConnection,client:Client,w:{from:string;to:string},apiKey:string,fetcher:typeof fetch=fetch,deadline=Date.now()+240000,now=new Date()):Promise<SourceBatch>{
 identity(connection,client);if(!apiKey||/[\r\n]/.test(apiKey))throw Error('Intelligems credential is missing or invalid');const dates=sourceDates(w),today=todayIn(client.timezone,now);if(!dates.length||w.to>today)throw Error('Intelligems source window is invalid');
 const experiments:Experiment[]=[],seen=new Set<string>();let expectedTotal:number|undefined,expectedPages:number|undefined;
 for(let page=1;page<=100;page++){
  const result=await request(`/experiences-list?category=experiment&limit=20&page=${page}`,apiKey,undefined,fetcher,deadline) as Catalog;
  if(!record(result)||!Array.isArray(result.experiencesList)||result.page!==page||result.limit!==20||!Number.isSafeInteger(result.total)||result.total<0||result.total>2000||!Number.isSafeInteger(result.totalPages)||result.totalPages<0||result.totalPages>100)throw Error('Intelligems experiment pagination is invalid');
  if(expectedTotal===undefined){expectedTotal=result.total;expectedPages=result.totalPages;}else if(result.total!==expectedTotal||result.totalPages!==expectedPages)throw Error('Intelligems experiment catalog changed during pagination');
  for(const ex of result.experiencesList){if(!record(ex)||!id(ex.id)||seen.has(ex.id)||ex.organizationId!==BEAM_INTELLIGEMS_ORGANIZATION||ex.category!=='experiment'||!['pending','started','ended','paused'].includes(ex.status))throw Error('Intelligems experiment identity or pagination changed');seen.add(ex.id);experiments.push(ex);}
  if(page>=Math.max(1,result.totalPages)){if(experiments.length!==result.total)throw Error('Intelligems experiment pagination is incomplete');break;}
  if(!result.experiencesList.length)throw Error('Intelligems experiment pagination is incomplete');
 }
 if(experiments.length!==expectedTotal)throw Error('Intelligems experiment pagination is incomplete');const rows:Observation[]=[];
 for(const date of dates){
  const window=dayWindow(date,client.timezone),start=Date.parse(window.start),end=Math.min(Date.parse(window.end),now.getTime());
  const eligible=experiments.filter(ex=>{const lifetimeEnd=ex.status==='paused'?ex.pausedAtTs:ex.endedAtTs;return ex.status!=='pending'&&!ex.isDeleted&&typeof ex.startedAtTs==='number'&&ex.startedAtTs<end&&(lifetimeEnd===null||lifetimeEnd===undefined||typeof lifetimeEnd==='number'&&lifetimeEnd>start);});
  for(const experiment of eligible){
   const result=await request(`/analytics/resource/${experiment.id}`,apiKey,{view:'overview',startTs:String(Math.floor(start/1000)),endTs:String(Math.floor(end/1000)),analyticsViewType:'sitewide_orders',filters:{countryCodes:['US'],experimentProductsOnly:false,maxZScore:3}},fetcher,deadline) as ExperimentResult;
   if(!record(result)||result.experienceId!==experiment.id||result.datasetId!=='variation_overview'||!Array.isArray(result.metrics)||!Array.isArray(result.variations)||result.metrics.length>100||result.variations.length>100||result.nextCursor||result.hasNextPage===true)throw Error('Intelligems returned an incomplete experiment overview');
   const variants=new Map<string,Variant>();for(const v of result.variations){if(!record(v)||!id(v.id)||variants.has(v.id)||typeof v.name!=='string'||typeof v.isControl!=='boolean')throw Error('Intelligems experiment variation identity changed');variants.set(v.id,v);}
   if(result.metrics.length&&[...variants.values()].filter(v=>v.isControl).length!==1)throw Error('Intelligems experiment control identity is missing');
   const reported=new Set<string>();for(const m of result.metrics){
    if(!record(m)||!id(m.variation_id)||!variants.has(m.variation_id)||reported.has(m.variation_id)||m.audience!==undefined||m.dt!==undefined)throw Error('Intelligems experiment overview grain changed');reported.add(m.variation_id);const v=variants.get(m.variation_id)!;
    const d={report_date:date,experiment_id:experiment.id,experiment:trafficLabel(experiment.name),variant_id:v.id,variant:trafficLabel(v.name),status:experiment.status,is_control:String(v.isControl),market:'US',analysis_scope:'store_day_all_products_all_currencies_zscore3'};
    const add=(metric:string,value:number)=>rows.push({...observation(date,'experiments',metric,value,definition,population,null,d),sourceId:connection.id,retrievedAt:now.toISOString(),coverageThrough:null,quality:date<today?'complete':'partial'});
    if(m.n_visitors?.value!==undefined&&m.n_visitors.value!==null)add('visitors',count(m.n_visitors.value));
    if(m.n_orders?.value!==undefined&&m.n_orders.value!==null)add('orders',count(m.n_orders.value));
    const cr=m.conversion_rate;if(cr!==undefined&&cr!==null){if(!record(cr))throw Error('Intelligems conversion metric is invalid');if(cr.value!==undefined&&cr.value!==null)add('conversion_rate',probability(cr.value));
     if(cr.ci_low!==undefined&&cr.ci_high!==undefined&&cr.ci_low!==null&&cr.ci_high!==null){const low=probability(cr.ci_low),high=probability(cr.ci_high);if(low>high)throw Error('Intelligems confidence interval is inverted');add('conversion_rate_ci_low',low);add('conversion_rate_ci_high',high);}
     if(cr.p2bb!==undefined&&cr.p2bb!==null)add('conversion_rate_probability_best',probability(cr.p2bb));
     if(!v.isControl){if(cr.p2bc!==undefined&&cr.p2bc!==null)add('conversion_rate_probability_to_beat_control',probability(cr.p2bc));if(record(cr.uplift)){if(cr.uplift.value!==undefined&&cr.uplift.value!==null)add('conversion_rate_lift',number(cr.uplift.value));if(cr.uplift.ci_low!==undefined&&cr.uplift.ci_high!==undefined&&cr.uplift.ci_low!==null&&cr.uplift.ci_high!==null){const low=number(cr.uplift.ci_low),high=number(cr.uplift.ci_high);if(low>high)throw Error('Intelligems confidence interval is inverted');add('conversion_rate_lift_ci_low',low);add('conversion_rate_lift_ci_high',high);}}}
    }
   }
   if(result.metrics.length&&reported.size!==variants.size)throw Error('Intelligems experiment variation report is incomplete');
  }
 }
 return validateBatch({clientId:client.id,timezone:client.timezone,currency:client.currency,channels:[],dimensions,grain:'daily',complete:true,coverageThrough:null,nextCursor:null,rows},client.id);
}
export function beamIntelligemsQualification(batch:SourceBatch):RegisteredContract {
 if(batch.clientId!=='beam'||!batch.complete||batch.nextCursor||batch.grain!=='daily')throw Error('Intelligems qualification requires complete daily Beam experiment reporting');
 return {clientId:batch.clientId,queryId:'beam-intelligems:daily-experiments-v1',timezone:batch.timezone,currency:batch.currency,hourlyGrain:false,channels:[],requiredChannels:[],dimensions,requiredDimensions:dimensions,paginationComplete:true,reconciled:true,reconciliationEvidence:'Authenticated fixed Beam organization. Complete page-based experiment catalog with stable totals and duplicate detection; started, paused and ended experiments selected by overlap with each requested New York calendar day. POST overview contains exact experiment/variation/control identities. US country filter, all experiment products disabled explicitly, all currencies and Z-score 3. Visitor counts and provider-reported conversion rates, 95% intervals and probabilities retain their experiment population; no causal verdict is inferred from daily subsets. Monetary outcomes omitted because currency filters are silently ignored on experience analytics. latestRunTs may be zero, so source coverage is not asserted. An empty complete catalog produces no invented experiment rows.',profiles:metrics.map(metric=>({dataset:'experiments',metric,population,definition,currency:null,dimensions,hourly:false}))};
}
