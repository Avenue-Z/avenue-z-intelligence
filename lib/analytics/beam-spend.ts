import type {ClientRecord} from '../../components/analytics/records';
import type {QueryFilters} from './contracts';
import {finiteMetric} from './display';
import {ratio} from './metrics';
import {contextSeries,trendContextRange,type TrendContextMode} from './trend-context';
import {shiftDate,todayIn} from './windows';
import type {MetricSeriesPoint} from './visualization';

type Point=ClientRecord['datasetSeries'][string][number];
const metric=(value:number|null|undefined)=>finiteMetric(value)?value:null;
function dailySpend(point:Point){
 const platform=metric(point.metrics.platform_spend),matched=metric(point.metrics.spend);
 return platform!==null&&matched!==null?null:platform??matched;
}
function reportPeriod(points:Point[],from:string,to:string,today:string){
 let total=0,reportedDays=0,expectedDays=0;
 for(let date=from;date<=to;date=shiftDate(date,1)){
  expectedDays++;const matches=points.filter(point=>point.date===date),value=matches.length===1?dailySpend(matches[0]):null;
  if(value!==null){total+=value;reportedDays++;}
 }
 return {spend:reportedDays?total:null,reportedDays,expectedDays,complete:reportedDays===expectedDays,closed:to<today};
}
export function buildBeamSpend(record:ClientRecord,filters:QueryFilters,now=new Date()){
 const today=todayIn(record.client.timezone,now),current=reportPeriod(record.datasetSeries.media??[],filters.from,filters.to,today),previous=reportPeriod(record.comparisonDatasetSeries.media??[],record.comparison.from,record.comparison.to,today);
 const media=record.views.media?.details??(filters.view==='media'?record.details:[]),asOf=media.map(row=>row.dimensions.provider_as_of).filter(value=>value&&Number.isFinite(Date.parse(value))).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1)??null;
 return {current,previous,comparable:current.complete&&previous.complete&&current.closed&&previous.closed,asOf};
}
export function beamSpendChartContext(record:ClientRecord,filters:QueryFilters,window:TrendContextMode){
 const dates=trendContextRange(filters,window,record.comparison.from),flatten=(point:Point):MetricSeriesPoint=>({date:point.date,spend:dailySpend(point)});
 // Motion reports have their own daily clock, independent of Shopify's cutoff.
 const current=contextSeries(record.datasetSeries.media??[],record.trendDatasetSeries.media??[],dates).map(flatten);
 const previous=contextSeries(record.comparisonDatasetSeries.media??[],record.trendComparisonDatasetSeries.media??[],{from:dates.comparisonFrom,to:dates.comparisonTo}).map(flatten);
 return {current,previous,...dates};
}
export function beamCreativeRows(record:ClientRecord,groupBy:'ad'|'campaign'|'adset'='ad',previous=false){
 const rows=previous?record.comparisonViews?.creatives?.details??[]:record.views.creatives?.details??[];
 const groups=new Map<string,{name:string;campaign:string;spend:number|null;impressions:number|null;clicks:number|null}>();
 for(const row of rows){
  const id=row.dimensions[`${groupBy}_id`];if(!id)continue;
  const item=groups.get(id),spend=metric(row.metrics.motion_ad_spend),impressions=metric(row.metrics.motion_ad_impressions),clicks=metric(row.metrics.motion_ad_clicks);
  const sum=(a:number|null,b:number|null)=>a!==null&&b!==null?a+b:null;
  groups.set(id,{name:row.dimensions[groupBy]||id,campaign:row.dimensions.campaign||'',spend:item?sum(item.spend,spend):spend,impressions:item?sum(item.impressions,impressions):impressions,clicks:item?sum(item.clicks,clicks):clicks});
 }
 return [...groups].map(([id,row])=>({id,...row,ctr:ratio(row.clicks,row.impressions),cpc:ratio(row.spend,row.clicks)})).sort((a,b)=>(b.spend??-1)-(a.spend??-1)||a.name.localeCompare(b.name));
}
