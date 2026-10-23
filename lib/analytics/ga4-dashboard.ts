import {ga4Profile,ga4Dimensions,type Ga4ClientId,type Ga4Profile} from './ga4-profile';
import {ga4PageLabel} from './ga4-page-privacy';
import type {QueryFilters} from './contracts';
import type {Ga4CachedReport} from '../server/ga4-report-cache';
import type {Ga4Report,Ga4ReportRow} from '../sources/ga4-data';
import {comparisonPeriod,shiftDate,todayIn} from './windows';

export type Ga4Summary={sessions:number|null;engagedSessions:number|null;purchases:number|null;revenue:number|null};
export type Ga4DashboardGroup={label:string;current:Ga4Summary;previous:Ga4Summary};
type GroupCounts={pages:number;sources:number;markets:number;devices:number};
export type Ga4Dashboard={
 from:string;to:string;comparison:{from:string;to:string};timezone:string;currency:'USD';propertyId:string;clientId?:Ga4ClientId;streamId?:string|null;latestCapturedAt:string|null;matchedThroughHour:number|null;
 coverage:{requestedDays:number;capturedDays:number;missingDates:string[];availableFrom:string|null;availableTo:string|null};
 current:Ga4Summary;previous:Ga4Summary;daily:{date:string;comparisonDate:string;current:Ga4Summary;previous:Ga4Summary}[];
 pages:Ga4DashboardGroup[];sources:Ga4DashboardGroup[];markets:Ga4DashboardGroup[];devices:Ga4DashboardGroup[];
 filterOptions:{markets:string[];sources:string[];devices:string[];pages:string[]};
 groupCounts?:GroupCounts;filterOptionCounts?:GroupCounts;
 quality:{sampled:boolean;thresholded:boolean;dataLossFromOtherRow:boolean;restricted:boolean;truncated:boolean};
};
export type Ga4DashboardOptions={nowMs?:number;availableDays?:{storeDate:string;kind:string;capturedAt:string}[];completeGroups?:boolean;clientId?:Ga4ClientId};

const metricNames=['sessions','engagedSessions','ecommercePurchases','purchaseRevenue'] as const;
const groupDimensions={pages:'landingPage',sources:'sessionSource',markets:'countryId',devices:'deviceCategory'} as const;
const families=Object.keys(groupDimensions) as (keyof typeof groupDimensions)[];
const limits:GroupCounts={pages:200,sources:100,markets:500,devices:500};
const byteLength=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
function bounded<T>(values:T[],limit:number,selected:string,label:(value:T)=>string){
 const result=values.slice(0,limit),chosen=selected?values.find(value=>label(value)===selected):undefined;
 if(chosen!==undefined&&!result.some(value=>label(value)===selected))result[Math.min(result.length,limit-1)]=chosen;
 return result;
}
const empty=():Ga4Summary=>({sessions:null,engagedSessions:null,purchases:null,revenue:null});
const zero=():Ga4Summary=>({sessions:0,engagedSessions:0,purchases:0,revenue:0});
const dates=(from:string,to:string)=>{const result:string[]=[];for(let date=from;date<=to;date=shiftDate(date,1))result.push(date);return result;};
function checkedDate(value:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||shiftDate(value,0)!==value)throw Error('Invalid GA4 date');return value;}

export function parseGa4DashboardFilters(params:URLSearchParams,nowMs=Date.now(),clientId:Ga4ClientId='beam'):QueryFilters{
 const {timezone}=ga4Profile(clientId);
 if(!Number.isFinite(nowMs)||params.toString().length>16384)throw Error('Invalid GA4 query');
 for(const key of ['from','to','compare','compareFrom','compareTo','mode','market','stream','source','device','page','period'])if(params.getAll(key).length>1)throw Error('Duplicate GA4 filter');
 if(params.get('stream'))throw Error('GA4 does not support sales-channel filters');
 const today=todayIn(timezone,new Date(nowMs)),live=params.get('period')==='today',from=checkedDate(live?today:params.get('from')||today),to=checkedDate(live?today:params.get('to')||from);
 const days=(Date.parse(to)-Date.parse(from))/86400000+1;
 if(days<1||days>30||to>today)throw Error('Choose up to 30 GA4 reporting days ending today or earlier');
 const compare=params.get('compare')||'previous',mode=params.get('mode')||(to===today?'partial':'closed');
 if(!['previous','weekday','fourWeeks','thirtyDays','custom'].includes(compare)||!['closed','partial'].includes(mode))throw Error('Invalid GA4 comparison or mode');
 const dimension=(key:string,max=512)=>{const value=params.get(key)||'';if(value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw Error('Invalid GA4 dimension');return value;};
 const result:QueryFilters={from,to,compare:compare as QueryFilters['compare'],mode:mode as QueryFilters['mode'],market:dimension('market',120),stream:'',source:dimension('source'),device:dimension('device',120),page:ga4PageLabel(dimension('page',2048)),view:'ga4',...live?{period:'today' as const}:{}};
 if(compare==='custom'){result.compareFrom=checkedDate(params.get('compareFrom')||shiftDate(from,-days));if(params.get('compareTo'))result.compareTo=checkedDate(params.get('compareTo')!);}
 const comparison=comparisonPeriod(result);if(comparison.to>today)throw Error('GA4 comparison cannot include future dates');
 if(compare==='custom')result.compareTo=comparison.to;
 return result;
}

function sumRows(rows:Ga4ReportRow[]):Ga4Summary{
 const result=zero();for(const row of rows)for(const [key,metric] of [['sessions','sessions'],['engagedSessions','engagedSessions'],['purchases','ecommercePurchases'],['revenue','purchaseRevenue']] as const){const value=row.metrics[metric];if(typeof value!=='number'||!Number.isFinite(value))throw Error('Invalid cached GA4 metric');result[key]=result[key]!+value;if(!Number.isFinite(result[key]))throw Error('Invalid cached GA4 total');}
 return result;
}
function sumSummaries(values:Ga4Summary[]):Ga4Summary{
 if(values.some(value=>value.sessions===null))return empty();
 const result=zero();for(const value of values)for(const key of ['sessions','engagedSessions','purchases','revenue'] as const)result[key]=result[key]!+value[key]!;
 return result;
}
function validateReport(item:Ga4CachedReport,profile:Ga4Profile){
 const {timezone,currency}=profile;
 const report=item.report,dimensions=ga4Dimensions(profile,item.kind);
 if(report.metadata.timeZone!==timezone||report.metadata.currencyCode!==currency||report.rowCount!==report.rows.length||report.dimensionHeaders.map(header=>header.name).sort().join(',')!==[...dimensions].sort().join(',')||report.metricHeaders.map(header=>header.name).sort().join(',')!==[...metricNames].sort().join(',')||item.kind==='total'&&report.rows.length>1)throw Error('Invalid cached GA4 report');
 const seen=new Set<string>();
 for(const row of report.rows){
  if(Object.keys(row.dimensions).sort().join(',')!==[...dimensions].sort().join(','))throw Error('Invalid cached GA4 dimensions');
  if(item.kind!=='total'&&(!/^\d{10}$/.test(row.dimensions.dateHour)||row.dimensions.dateHour.slice(0,8)!==item.storeDate.replaceAll('-','')||Number(row.dimensions.dateHour.slice(8))>23))throw Error('Invalid cached GA4 hour');
  if(profile.streamId&&row.dimensions.streamId!==profile.streamId)throw Error('Invalid cached GA4 stream');
  const key=JSON.stringify(dimensions.map(name=>row.dimensions[name]));if(seen.has(key))throw Error('Duplicate cached GA4 row');seen.add(key);
 }
}

/** Only the additive metrics in retained GA reports are pooled. Missing days
 * invalidate a period; an empty, coherently captured report supplies real zero. */
export function buildGa4Dashboard(reports:Ga4CachedReport[],requested:QueryFilters,options:Ga4DashboardOptions={}):Ga4Dashboard{
 const profile=ga4Profile(options.clientId),{timezone,currency,propertyId}=profile;
 const nowMs=options.nowMs??Date.now(),filters=parseGa4DashboardFilters(new URLSearchParams(Object.entries(requested).filter((entry):entry is [string,string]=>typeof entry[1]==='string')),nowMs,profile.clientId);
 const today=todayIn(timezone,new Date(nowMs)),retentionFrom=shiftDate(today,-29),comparison=comparisonPeriod(filters),selectedDates=dates(filters.from,filters.to),previousDates=dates(comparison.from,comparison.to);
 const retained=reports.filter(item=>item.storeDate>=retentionFrom&&item.storeDate<=today),metadata=options.availableDays??retained.map(({storeDate,kind,capturedAt})=>({storeDate,kind,capturedAt}));
 const metadataByDay=new Map<string,typeof metadata>();for(const item of metadata)if(item.storeDate>=retentionFrom&&item.storeDate<=today){const values=metadataByDay.get(item.storeDate);if(values)values.push(item);else metadataByDay.set(item.storeDate,[item]);}
 const coherent=new Map<string,string>();for(const [date,items]of metadataByDay)if(items.length===3&&new Set(items.map(item=>item.kind)).size===3&&items.every(item=>['total','hourly','detail'].includes(item.kind)&&item.capturedAt===items[0].capturedAt&&Number.isFinite(Date.parse(item.capturedAt))))coherent.set(date,items[0].capturedAt);
 const byDay=new Map<string,Map<string,Ga4Report|null>>();for(const item of retained){
  validateReport(item,profile);if(coherent.get(item.storeDate)!==item.capturedAt)continue;
  let day=byDay.get(item.storeDate);if(!day){day=new Map();byDay.set(item.storeDate,day);}day.set(item.kind,day.has(item.kind)?null:item.report);
 }
 const partial=filters.mode==='partial'&&filters.to===today,hourlyToday=byDay.get(today)?.get('hourly'),storeHour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date(nowMs)));
 const reportedHours=hourlyToday?.rows.map(row=>Number(row.dimensions.dateHour.slice(8)))??[],lastReported=reportedHours.length?Math.max(...reportedHours):null;
 const candidate=lastReported===null?null:Math.min(storeHour,lastReported),matchedThroughHour=partial&&candidate!==null&&candidate>0?candidate:null;
 const filtered=!!(filters.market||filters.source||filters.device||filters.page),chartLimit=partial?matchedThroughHour:24;
 const periodLimit=(date:string,lastDate:string)=>partial&&date===lastDate?matchedThroughHour:24;
 const details=new Map<string,Ga4ReportRow[]|null>(),summaries=new Map<string,Ga4Summary>();
 const eligible=(date:string,limit:number|null)=>date>=retentionFrom&&date<=today&&coherent.has(date)&&!(filters.mode==='closed'&&date===today)&&limit!==null;
 function detailRows(date:string,limit:number|null){
  const key=`${date}:${limit}`;if(details.has(key))return details.get(key)!;
  const report=eligible(date,limit)?byDay.get(date)?.get('detail'):null;
  const rows=report?report.rows.filter(row=>Number(row.dimensions.dateHour.slice(8))<limit!&&(!filters.market||row.dimensions.countryId===filters.market)&&(!filters.source||row.dimensions.sessionSource===filters.source)&&(!filters.device||row.dimensions.deviceCategory===filters.device)&&(!filters.page||row.dimensions.landingPage===filters.page)):null;
  details.set(key,rows);return rows;
 }
 function summary(date:string,limit:number|null=chartLimit){
  const key=`${date}:${limit}`;if(summaries.has(key))return summaries.get(key)!;
  let rows:Ga4ReportRow[]|null=null;
  if(filtered)rows=detailRows(date,limit);
  else if(eligible(date,limit)){const report=byDay.get(date)?.get(limit===24?'total':'hourly');if(report)rows=limit===24?report.rows:report.rows.filter(row=>Number(row.dimensions.dateHour.slice(8))<limit!);}
  const result=rows===null?empty():sumRows(rows);summaries.set(key,result);return result;
 }
 function grouped(period:string[],dimension:string){
  const groups=new Map<string,Ga4ReportRow[]>();let complete=true;
  for(const date of period){const rows=detailRows(date,periodLimit(date,period.at(-1)!));if(rows===null){complete=false;continue;}for(const row of rows){const label=row.dimensions[dimension],group=groups.get(label);if(group)group.push(row);else groups.set(label,[row]);}}
  return {complete,groups:new Map([...groups].map(([label,rows])=>[label,sumRows(rows)]))};
 }
 function groups(dimension:string):Ga4DashboardGroup[]{
  const current=grouped(selectedDates,dimension),previous=grouped(previousDates,dimension);
  return [...new Set([...current.groups.keys(),...previous.groups.keys()])].map(label=>({label,current:current.complete?current.groups.get(label)??zero():empty(),previous:previous.complete?previous.groups.get(label)??zero():empty()})).sort((a,b)=>(b.current.sessions??b.previous.sessions??-1)-(a.current.sessions??a.previous.sessions??-1)||(b.previous.sessions??-1)-(a.previous.sessions??-1)||a.label.localeCompare(b.label));
 }
 const quality={sampled:false,thresholded:false,dataLossFromOtherRow:false,restricted:false,truncated:false};
 for(const item of retained)if(coherent.get(item.storeDate)===item.capturedAt){const m=item.report.metadata;quality.sampled ||= !!m.samplingMetadatas?.some(sample=>BigInt(sample.samplesReadCount)<BigInt(sample.samplingSpaceSize));quality.thresholded ||= m.subjectToThresholding===true;quality.dataLossFromOtherRow ||= m.dataLossFromOtherRow===true;quality.restricted ||= !!m.schemaRestrictionResponse?.activeMetricRestrictions?.length;quality.truncated ||= !!m.dataTruncationReasons?.length;}
 const filterOptions={markets:[] as string[],sources:[] as string[],devices:[] as string[],pages:[] as string[]};
 const selected={pages:filters.page,sources:filters.source,markets:filters.market,devices:filters.device},groupCounts={} as GroupCounts,filterOptionCounts={} as GroupCounts,breakdowns={} as Record<keyof GroupCounts,Ga4DashboardGroup[]>;
 for(const family of families){
  const dimension=groupDimensions[family],allGroups=groups(dimension),volume=new Map<string,number>();
  for(const day of byDay.values())for(const row of day.get('detail')?.rows??[])volume.set(row.dimensions[dimension],0);
  // Rank options from the whole selected/comparison population, independent of
  // active dimension filters, so alternative choices remain discoverable.
  for(const period of [selectedDates,previousDates])for(const date of period){const limit=periodLimit(date,period.at(-1)!);if(!eligible(date,limit))continue;for(const row of byDay.get(date)?.get('detail')?.rows??[])if(Number(row.dimensions.dateHour.slice(8))<limit!)volume.set(row.dimensions[dimension],(volume.get(row.dimensions[dimension])??0)+row.metrics.sessions);}
  const labels=[...volume.keys()].sort((a,b)=>volume.get(b)!-volume.get(a)!||a.localeCompare(b));
  groupCounts[family]=allGroups.length;filterOptionCounts[family]=labels.length;
  // Platform retrieval pages these complete aggregates after its requested
  // ranking; the public dashboard keeps its existing count and byte bounds.
  breakdowns[family]=options.completeGroups?allGroups:bounded(allGroups,limits[family],selected[family],value=>value.label);
  filterOptions[family]=bounded(labels,limits[family],selected[family],value=>value);
 }
 const capturedDates=selectedDates.filter(date=>summary(date,periodLimit(date,filters.to)).sessions!==null),available=[...coherent.keys()].sort(),captures=capturedDates.map(date=>coherent.get(date)!).sort((a,b)=>Date.parse(a)-Date.parse(b)),offset=Math.round((Date.parse(comparison.from)-Date.parse(filters.from))/86400000);
 const result:Ga4Dashboard={from:filters.from,to:filters.to,comparison:{from:comparison.from,to:comparison.to},timezone,currency,propertyId,clientId:profile.clientId,streamId:profile.streamId,latestCapturedAt:captures.at(-1)??null,matchedThroughHour,
  coverage:{requestedDays:selectedDates.length,capturedDays:capturedDates.length,missingDates:selectedDates.filter(date=>!capturedDates.includes(date)),availableFrom:available[0]??null,availableTo:available.at(-1)??null},
  current:sumSummaries(selectedDates.map(date=>summary(date,periodLimit(date,filters.to)))),previous:sumSummaries(previousDates.map(date=>summary(date,periodLimit(date,comparison.to)))),daily:dates(shiftDate(filters.to,-29),filters.to).map(date=>({date,comparisonDate:shiftDate(date,offset),current:summary(date),previous:summary(shiftDate(date,offset))})),
  ...breakdowns,filterOptions,groupCounts,filterOptionCounts,quality};
 // Long or multibyte labels can exceed a count-only budget. Trim the lowest
 // volume tails, retaining exact selected labels and every authoritative KPI.
 if(options.completeGroups)return result;
 let bytes=byteLength(result);
 while(bytes>=950000){
  const candidates=families.flatMap(family=>{
   const groups=result[family],options=result.filterOptions[family],groupIndex=groups.findLastIndex(value=>value.label!==selected[family]),optionIndex=options.findLastIndex(value=>value!==selected[family]);
   return [...groupIndex>=0?[{values:groups,index:groupIndex,bytes:byteLength(groups[groupIndex])}]:[],...optionIndex>=0?[{values:options,index:optionIndex,bytes:byteLength(options[optionIndex])}]:[]];
  }).sort((a,b)=>b.bytes*b.values.length-a.bytes*a.values.length);
  if(!candidates.length)break;const remove=candidates[0];bytes-=remove.bytes+(remove.values.length>1?1:0);remove.values.splice(remove.index,1);
 }
 return result;
}
