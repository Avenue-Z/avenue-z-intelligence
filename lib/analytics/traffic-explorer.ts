import type {ClientAnalytics} from './query';

export type ExplorerRow=Pick<ClientAnalytics['details'][number],'key'|'dimensions'|'metrics'|'summary'>&{zeroDenominatorRates?:string[]};
export type ExplorerMetric='sessions'|'converting_sessions'|'atc_sessions'|'checkouts'|'completed_checkouts'|'cvr'|'atc'|'checkoutCompletion'|'revenue'|'orders'|'aov'|'refunds'|'discounts';
export type ExplorerSeriesPoint={date:string;metrics:Record<string,number|null>;summary?:Partial<ClientAnalytics['details'][number]['summary']>};
export type ExplorerGroup={key:string;label:string;metrics:Record<string,number|null>;summary:Partial<ExplorerRow['summary']>;segments:number};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const additive=['sessions','atc_sessions','checkouts','converting_sessions','completed_checkouts','revenue','orders','refunds','discounts'];
const rateParts:Partial<Record<ExplorerMetric,[string,string]>>={cvr:['converting_sessions','sessions'],atc:['atc_sessions','sessions'],checkoutCompletion:['completed_checkouts','checkouts'],aov:['revenue','orders']};
const divide=(n:unknown,d:unknown)=>finite(n)&&finite(d)&&d>0?n/d:null;

/** UTM is a declared landing parameter, not a verified paid-channel attribution. */
export function trafficChannel(dimensions:Record<string,string>){
 const utm=dimensions.utm_source?.trim();
 if(utm){const raw=utm.toLowerCase(),brand=['meta','facebook','fb','instagram','ig'].includes(raw)?'Meta':['tiktok','tik_tok'].includes(raw)?'TikTok':['google','googleads','google_ads'].includes(raw)?'Google':utm;return `${brand} · UTM`;}
 return dimensions.source?`${dimensions.source} · referrer`:'Unspecified source';
}

/** Aggregate a single prepared dataset only. A missing count never becomes zero. */
export function aggregateExplorerRows(rows:ExplorerRow[],dimension:string):ExplorerGroup[]{
 const groups=new Map<string,{rows:ExplorerRow[];label:string}>();
 for(const row of rows){const label=dimension==='traffic_channel'?trafficChannel(row.dimensions):dimension==='all'?'Selected scope':row.dimensions[dimension]||'Unspecified';const group=groups.get(label);if(group)group.rows.push(row);else groups.set(label,{rows:[row],label});}
 return [...groups].map(([key,group])=>{
  const metrics:Record<string,number|null>={};
  for(const metric of additive){let total=0,complete=true;for(const row of group.rows){const v=row.metrics[metric];if(!finite(v)){complete=false;break;}total+=v;}metrics[metric]=complete?total:null;}
  const summary:Partial<ExplorerRow['summary']>={};
  for(const [metric,parts] of Object.entries(rateParts)){const key=metric as keyof ExplorerRow['summary'];summary[key]=group.rows.every(row=>finite(row.summary[key])||row.metrics[parts[0]]===0&&row.metrics[parts[1]]===0||row.zeroDenominatorRates?.includes(metric)&&finite(row.metrics[parts[0]])&&row.metrics[parts[1]]===0)?divide(metrics[parts[0]],metrics[parts[1]]):null;}
  return {key,label:group.label,metrics,summary,segments:group.rows.length};
 });
}

export function explorerMetric(row:{metrics:Record<string,number|null>;summary?:Partial<ClientAnalytics['details'][number]['summary']>},metric:ExplorerMetric):number|null{
 const parts=rateParts[metric];
 if(parts){if(row.summary&&Object.prototype.hasOwnProperty.call(row.summary,metric)){const qualified=row.summary[metric as keyof NonNullable<typeof row.summary>];return finite(qualified)?qualified:null;}return divide(row.metrics[parts[0]],row.metrics[parts[1]]);}
 const value=row.metrics[metric];return finite(value)?value:null;
}

export function alignExplorerSeries(current:ExplorerSeriesPoint[],previous:ExplorerSeriesPoint[],metric:ExplorerMetric,range:{from:string;to:string;comparisonFrom:string}){
 const currentByDate=new Map(current.map(point=>[point.date,point])),previousByDate=new Map(previous.map(point=>[point.date,point]));
 const start=Date.parse(`${range.from}T00:00:00Z`),end=Date.parse(`${range.to}T00:00:00Z`),comparison=Date.parse(`${range.comparisonFrom}T00:00:00Z`);
 if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(comparison)||end<start)return [];
 const points=[];
 for(let time=start,offset=0;time<=end;time+=86400000,offset++){
  const date=new Date(time).toISOString().slice(0,10),comparisonDate=new Date(comparison+offset*86400000).toISOString().slice(0,10),a=currentByDate.get(date),b=previousByDate.get(comparisonDate);
  points.push({date,comparisonDate,current:a?explorerMetric(a,metric):null,previous:b?explorerMetric(b,metric):null});
 }
 return points;
}
