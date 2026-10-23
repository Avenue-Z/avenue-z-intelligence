import type {ClientRecord} from '../../components/analytics/records';
import type {QueryFilters} from './contracts';
import {finiteMetric} from './display';
import {ratio} from './metrics';
import {shiftDate} from './windows';
import {contextSeries,trendContextRange,type TrendContextMode} from './trend-context';
import type {MetricSeriesPoint} from './visualization';

type Detail=ClientRecord['details'][number];
type DatasetPoint=ClientRecord['datasetSeries'][string][number];
type RateBasis='matched-counts'|'reported'|'unavailable';
const value=(metric:number|null|undefined)=>finiteMetric(metric)?metric:null;
const keysWithin=(row:Detail,keys:string[])=>Object.keys(row.dimensions).every(key=>keys.includes(key));

/** Channel totals and dimensional breakdowns overlap. Use one exact scope. */
function channelRow(rows:Detail[],name:string){
 const matching=rows.filter(row=>row.dimensions.stream===name||row.dimensions.channel===name);
 if(matching.some(row=>row.dimensions.stream&&row.dimensions.channel&&row.dimensions.stream!==row.dimensions.channel))return null;
 const exact=matching.filter(row=>keysWithin(row,['stream','channel']));
 return exact.length===1?exact[0]:null;
}
function dailyTotal(points:DatasetPoint[],metric:string,from:string,to:string){
 let total=0;
 for(let date=from;date<=to;date=shiftDate(date,1)){
  const matching=points.filter(point=>point.date===date),amount=matching.length===1?value(matching[0].metrics[metric]):null;
  if(amount===null)return null;total+=amount;
 }
 return value(total);
}
function trafficValue(row:Detail|null,singleDay:boolean,allowReported:boolean){
 const sessions=value(row?.summary.sessions),converting=value(row?.metrics.converting_sessions),qualified=value(row?.summary.cvr);
 // Compact historical details do not retain daily count coverage.
 const calculated=singleDay&&qualified!==null&&sessions!==null&&sessions>0&&converting!==null&&converting>=0&&converting<=sessions?ratio(converting,sessions):null;
 const reported=allowReported&&singleDay?value(row?.metrics.reported_conversion_rate):null;
 const cvr=calculated??(reported!==null&&reported>=0&&reported<=1?reported:null);
 return {sessions,cvr,rateBasis:(calculated!==null?'matched-counts':cvr!==null?'reported':'unavailable') as RateBasis};
}
function exactUsRow(rows:Detail[],page?:string){
 const exact=rows.filter(row=>row.dimensions.market==='US'&&(page===undefined?!row.dimensions.page:row.dimensions.page===page)&&keysWithin(row,page===undefined?['market']:['market','page']));
 return exact.length===1?exact[0]:null;
}

/** Presentation from the authorized, already matched workspace frame. */
export function buildBeamOverview(record:ClientRecord,filters:QueryFilters){
 const historical=record.sourceQuality?.historical===true;
 const revenueRows=record.views.revenue?.details??[],previousRevenueRows=record.comparisonViews?.revenue?.details??[];
 const funnelRows=record.views.funnels?.details??record.details,previousFunnelRows=record.comparisonViews?.funnels?.details??[];
 const onlyMeta=record.client.config.spendChannels.length===1&&record.client.config.spendChannels[0].toLowerCase()==='meta';
 function period(previous:boolean){
  const metrics=previous?record.prior:record.metrics,rows=previous?previousRevenueRows:revenueRows,trafficRows=previous?previousFunnelRows:funnelRows;
  const from=previous?record.comparison.from:filters.from,to=previous?record.comparison.to:filters.to,singleDay=from===to,series=(previous?record.comparisonDatasetSeries:record.datasetSeries).overview??[];
  const online=channelRow(rows,'Online Store');
  const onlineRevenue=dailyTotal(series,'online_store_revenue',from,to),onlineOrders=dailyTotal(series,'online_store_orders',from,to);
  const onlineStoreNetSales=onlineRevenue??value(online?.summary.revenue),onlineStoreOrders=onlineOrders??value(online?.summary.orders);
  const onlineCovered=onlineRevenue!==null&&onlineOrders!==null||singleDay&&online!==null;
  const allChannelNetSales=value(metrics.revenue),allChannelOrders=value(metrics.orders);
  const matches=(metric:string,total:number|null)=>{const daily=dailyTotal(series,metric,from,to);return daily!==null&&total!==null&&Math.abs(daily-total)<=Number.EPSILON*Math.max(1,Math.abs(daily),Math.abs(total))*Math.max(1,series.length);};
  const revenueCovered=singleDay||matches('revenue',allChannelNetSales),ordersCovered=singleDay||matches('orders',allChannelOrders);
  const metaSpend=filters.mode==='closed'?(onlyMeta?value(metrics.spend):value(channelRow((previous?record.comparisonViews:record.views)?.media?.details??[],'Meta')?.summary.spend)):null;
  // Motion's daily account report is not a confirmed store-hour spend feed.
  const arithmeticMatched=historical&&filters.mode==='closed'&&revenueCovered&&(singleDay||onlyMeta&&matches('spend',metaSpend));
  const reportedTraffic=trafficValue(exactUsRow(trafficRows),singleDay,historical);
  const overviewSessions=value(metrics.sessions),sessions=overviewSessions??reportedTraffic.sessions;
  const conversionDays=series.filter(point=>point.date>=from&&point.date<=to);
  const matchingCounts=overviewSessions!==null&&matches('sessions',overviewSessions)&&dailyTotal(series,'converting_sessions',from,to)!==null&&conversionDays.every(point=>value(point.summary.cvr)!==null||point.metrics.sessions===0&&point.metrics.converting_sessions===0);
  const liveCvr=matchingCounts?value(metrics.cvr):null;
  const traffic=overviewSessions!==null?{sessions,cvr:liveCvr,rateBasis:(liveCvr!==null?'matched-counts':'unavailable') as RateBasis}:reportedTraffic;
  return {allChannelNetSales,allChannelOrders,allChannelAov:revenueCovered&&ordersCovered?ratio(allChannelNetSales,allChannelOrders):null,onlineStoreNetSales,onlineStoreOrders,onlineStoreAov:onlineCovered?ratio(onlineStoreNetSales,onlineStoreOrders):null,onlineStoreComparable:singleDay||onlineRevenue!==null,onlineStoreOrdersComparable:singleDay||onlineOrders!==null,metaSpend,allChannelMer:arithmeticMatched?ratio(allChannelNetSales,metaSpend):null,onlineStoreMer:arithmeticMatched&&onlineCovered?ratio(onlineStoreNetSales,metaSpend):null,usHumanSessions:traffic.sessions,usCvr:traffic.cvr,usCvrBasis:traffic.rateBasis};
 }
 const current=period(false),previous=period(true);
 const channels=[...new Set(revenueRows.flatMap(row=>[row.dimensions.stream,row.dimensions.channel].filter(Boolean)))].filter(channel=>!['faire','total','all channels'].includes(channel.toLowerCase()));
 const revenueMix=channels.flatMap(channel=>{
  const row=channelRow(revenueRows,channel),revenue=value(row?.summary.revenue);
  return revenue===null?[]:[{channel,revenue,share:filters.from===filters.to?ratio(revenue,current.allChannelNetSales):null,orders:value(row?.summary.orders)}];
 }).sort((a,b)=>b.revenue-a.revenue);
 const pages=[...new Set(funnelRows.filter(row=>row.dimensions.market==='US'&&row.dimensions.page).map(row=>row.dimensions.page))].flatMap(page=>{
  const row=exactUsRow(funnelRows,page);if(!row)return [];
  const current=trafficValue(row,filters.from===filters.to,historical),previous=trafficValue(exactUsRow(previousFunnelRows,page),record.comparison.from===record.comparison.to,historical);
  return current.sessions===null&&current.cvr===null?[]:[{page,...current,previousSessions:previous.sessions,previousCvr:previous.cvr}];
 }).sort((a,b)=>(b.sessions??-1)-(a.sessions??-1));
 const trendByDate=new Map<string,ClientRecord['series']>();
 for(const point of record.series){const points=trendByDate.get(point.date);if(points)points.push(point);else trendByDate.set(point.date,[point]);}
 const trend=[...trendByDate].sort(([a],[b])=>a.localeCompare(b)).map(([date,points])=>({date,revenue:points.length===1?value(points[0].revenue):null,spend:onlyMeta&&points.length===1?value(points[0].spend):null,mer:null}));
 return {current,previous,historical,revenueMix,pages,trend,hasTrend:trend.some(point=>point.revenue!==null||point.spend!==null)};
}

/** Same context controls and matched-hour history as the other workspaces. */
export function beamOverviewChartContext(record:ClientRecord,filters:QueryFilters,window:TrendContextMode){
 const dates=trendContextRange(filters,window,record.comparison.from),matched=filters.mode==='partial'&&window!=='selected';
 const flatten=(point:DatasetPoint):MetricSeriesPoint=>({date:point.date,...point.metrics,...point.summary,online_store_revenue:value(point.metrics.online_store_revenue),online_store_orders:value(point.metrics.online_store_orders)});
 const current=contextSeries(record.datasetSeries.overview??[],record.trendDatasetSeries.overview??[],dates,matched).map(flatten);
 const previous=contextSeries(record.comparisonDatasetSeries.overview??[],record.trendComparisonDatasetSeries.overview??[],{from:dates.comparisonFrom,to:dates.comparisonTo},matched).map(flatten);
 return {current,previous,...dates};
}
