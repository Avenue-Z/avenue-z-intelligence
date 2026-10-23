import type {ClientRecord} from '../../components/analytics/records';
import type {QueryFilters} from './contracts';
import {buildAlertQueue} from './alerts';
import {buildBeamSpend} from './beam-spend';
import {finiteMetric,timestamp} from './display';
import {change} from './metrics';
import {liveReportingDate} from './reporting-date';
import {contextSeries,trendContextRange,type TrendContextMode} from './trend-context';
import {shiftDate} from './windows';
import {reviewHref} from '../reviews/document';

export const PORTFOLIO_METRICS=[
 {key:'revenue',label:'Revenue',unit:'currency'},
 {key:'orders',label:'Orders',unit:'count'},
 {key:'sessions',label:'Sessions',unit:'count'},
 {key:'cvr',label:'Conversion rate',unit:'percent'},
 {key:'aov',label:'Average order value',unit:'currency'},
 {key:'spend',label:'Media spend',unit:'currency'},
] as const;
export type PortfolioMetricKey=typeof PORTFOLIO_METRICS[number]['key'];
export type PortfolioPoint={date:string;comparisonDate:string;value:number|null;previous:number|null;change:number|null};
export type PortfolioMetric={value:number|null;previous:number|null;change:number|null;tone:'positive'|'negative'|'neutral'};
type MediaReport={date:string;spend:number|null;currency:string|null;asOf:string|null;timezone:string|null;quality:string;sourceId:string};
type PortfolioRecord=ClientRecord&{resolvedFilters?:QueryFilters;portfolioMediaReports?:MediaReport[]};
const metricValue=(value:number|null|undefined)=>finiteMetric(value)?value:null;
function delta(value:number|null,previous:number|null){return metricValue(change(value,previous));}
function pair(value:number|null,previous:number|null,key:PortfolioMetricKey,comparable=true):PortfolioMetric{
 const difference=comparable?delta(value,previous):null;
 return {value,previous,change:difference,tone:difference===null||difference===0||key==='spend'?'neutral':difference>0?'positive':'negative'};
}
function reportValue(reports:MediaReport[],date:string,currency:string){
 const matches=reports.filter(row=>row.date===date),row=matches.length===1?matches[0]:null;
 const value=row&&row.currency===currency?metricValue(row.spend):null;
 // Complete provider reports keep their own calendar. They never establish a
 // matched Shopify hour or an all-channel efficiency verdict.
 const closed=value!==null&&row?.quality==='complete'&&!!row.asOf&&Number.isFinite(Date.parse(row.asOf))&&row.asOf.slice(0,10)>date;
 return {value,closed};
}
function reportTotal(reports:MediaReport[],from:string,to:string,currency:string){
 let value=0,reported=0,complete=true;
 for(let date=from;date<=to;date=shiftDate(date,1)){const point=reportValue(reports,date,currency);if(point.value!==null){value+=point.value;reported++;}complete&&=point.closed;}
 return {value:reported?value:null,complete,reported,expected:Math.round((Date.parse(to)-Date.parse(from))/86400000)+1};
}
function seriesPoints(record:PortfolioRecord,filters:QueryFilters,key:PortfolioMetricKey,window:TrendContextMode):PortfolioPoint[]{
 const range=trendContextRange(filters,window,record.comparison.from),media=key==='spend'&&['beam','autobrush'].includes(record.client.id),dataset=media?'media':'overview';
 const matchedContext=!media&&filters.mode==='partial'&&window!=='selected';
 const current=contextSeries(record.datasetSeries[dataset]??[],record.trendDatasetSeries[dataset]??[],range,matchedContext);
 const previous=contextSeries(record.comparisonDatasetSeries[dataset]??[],record.trendComparisonDatasetSeries[dataset]??[],{from:range.comparisonFrom,to:range.comparisonTo},matchedContext);
 const read=(rows:typeof current,date:string)=>{const matches=rows.filter(row=>row.date===date);if(matches.length!==1)return null;const point=matches[0];return metricValue(media?(point.metrics.platform_spend!=null&&point.metrics.spend!=null?null:point.metrics.platform_spend??point.metrics.spend):point.summary[key]);};
 const points:PortfolioPoint[]=[];
 for(let date=range.from,comparisonDate=range.comparisonFrom;date<=range.to;date=shiftDate(date,1),comparisonDate=shiftDate(comparisonDate,1)){
  const reports=record.portfolioMediaReports;
  if(media&&reports){const a=reportValue(reports,date,record.client.currency),b=reportValue(reports,comparisonDate,record.client.currency);points.push({date,comparisonDate,value:a.value,previous:b.value,change:a.closed&&b.closed?delta(a.value,b.value):null});}
  else {const value=read(current,date),prior=read(previous,comparisonDate);points.push({date,comparisonDate,value,previous:prior,change:media?null:delta(value,prior)});}
 }
 return points;
}

/** Portfolio comparisons stay inside each brand's financial and traffic cohort.
 * No sum of mixed revenue bases or average of client conversion rates is exposed. */
export function buildPortfolioOverview(records:PortfolioRecord[],filters:QueryFilters,options:{metric?:PortfolioMetricKey;window?:TrendContextMode}={}){
 const metric=PORTFOLIO_METRICS.find(item=>item.key===(options.metric??'revenue'))??PORTFOLIO_METRICS[0],window=options.window??'7d';
 const alerts=buildAlertQueue(records,filters,{includeLatestReview:true}).filter(alert=>alert.severity!=='watch');
 const brands=records.map(record=>{
  const liveDate=filters.period==='today'?liveReportingDate(record.connections,'overview',record.client.timezone):null;
  const resolved=record.resolvedFilters??(liveDate?{...filters,from:liveDate,to:liveDate}:filters);
  const metrics=Object.fromEntries(PORTFOLIO_METRICS.map(({key})=>[key,pair(metricValue(record.metrics[key]),metricValue(record.prior[key]),key)])) as Record<PortfolioMetricKey,PortfolioMetric>;
  let spendNote='';
  if(['beam','autobrush'].includes(record.client.id)){
   if(record.portfolioMediaReports){const current=reportTotal(record.portfolioMediaReports,resolved.from,resolved.to,record.client.currency),prior=reportTotal(record.portfolioMediaReports,record.comparison.from,record.comparison.to,record.client.currency);metrics.spend=pair(current.value,prior.value,'spend',resolved.mode==='closed'&&current.complete&&prior.complete);
    const asOf=record.portfolioMediaReports.filter(row=>row.date>=resolved.from&&row.date<=resolved.to&&row.asOf).map(row=>row.asOf!).sort().at(-1);spendNote=`${current.reported<current.expected?'Reported subtotal · ':''}${current.reported}/${current.expected} report dates${prior.reported<prior.expected?` · Comparison subtotal ${prior.reported}/${prior.expected} dates`:''}${asOf?` · Cached ${timestamp(asOf,record.client.timezone)}`:''}${record.connections.some(source=>['beam-motion','autobrush-motion'].includes(source.provider)&&source.error)?' · Refresh retry pending':''}`;
   }
   else {const spend=buildBeamSpend(record,resolved);metrics.spend=pair(spend.current.spend,spend.previous.spend,'spend',false);}
  }
  const latest=record.reviews.filter(review=>review.current).sort((a,b)=>b.storeDate.localeCompare(a.storeDate)||b.createdAt.localeCompare(a.createdAt))[0],priorities=alerts.filter(alert=>alert.clientId===record.client.id);
  const scope=record.client.id==='beam'?'Net sales ex. Faire · US human traffic':record.client.id==='autobrush'?'All-channel net sales · global human traffic':record.client.id==='kind-patches'?'Web nonrecurring · global human traffic':record.client.config.revenueDefinition.replaceAll('_',' ');
  return {id:record.client.id,name:record.client.name,color:record.client.color,currency:record.client.currency,timezone:record.client.timezone,from:resolved.from,to:resolved.to,comparisonFrom:record.comparison.from,comparisonTo:record.comparison.to,cutoff:record.cutoff??null,scope,spendScope:['beam','autobrush'].includes(record.client.id)?'Motion · Meta · provider report dates · account timezone unverified':record.client.config.spendChannels.join(' + '),spendNote,href:`/clients/${encodeURIComponent(record.client.id)}?${new URLSearchParams({...resolved,view:'overview'})}`,review:latest?{href:reviewHref(record.client.id,latest.id),date:latest.storeDate}:null,metrics,priorities:priorities.length,unassigned:priorities.filter(alert=>!alert.owner).length,points:seriesPoints(record,resolved,metric.key,window),revenuePoints:seriesPoints(record,resolved,'revenue',window)};
 });
 const growing=brands.filter(brand=>(brand.metrics.revenue.change??0)>0),declining=brands.filter(brand=>(brand.metrics.revenue.change??0)<0);
 return {brands,counts:{growing:growing.length,declining:declining.length,flat:brands.filter(brand=>brand.metrics.revenue.change===0).length,unavailable:brands.filter(brand=>brand.metrics.revenue.change===null).length,priorities:alerts.length,unassigned:alerts.filter(alert=>!alert.owner).length},alerts,movers:{improving:[...growing].sort((a,b)=>b.metrics.revenue.change!-a.metrics.revenue.change!),declining:[...declining].sort((a,b)=>a.metrics.revenue.change!-b.metrics.revenue.change!)},metric,window,mixedCurrencies:new Set(brands.map(brand=>brand.currency)).size>1};
}
export type PortfolioBrand=ReturnType<typeof buildPortfolioOverview>['brands'][number];
