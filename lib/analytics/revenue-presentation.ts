import {finiteMetric} from './display';
import {change,ratio} from './metrics';
import {shiftDate,dayWindow} from './windows';
import type {MetricSeriesPoint} from './visualization';

export type RevenueDailyPoint={date:string;metrics:Record<string,number|null>;summary:{aov:number|null}};
export type RevenueHourlyPoint=RevenueDailyPoint&{start:string;end:string};
export type RevenueMetric='revenue'|'orders'|'aov';
export type RevenueTotals={revenue:number|null;orders:number|null;aov:number|null;coveredDays:number;expectedDays:number};
export function revenueSeries(points:RevenueDailyPoint[]):MetricSeriesPoint[]{
 return points.map(point=>({date:point.date,revenue:finiteMetric(point.metrics.revenue)?point.metrics.revenue:null,orders:finiteMetric(point.metrics.orders)?point.metrics.orders:null,aov:finiteMetric(point.summary.aov)?point.summary.aov:null}));
}

/** Missing days must not turn into plausible but incomplete period totals.
 * AOV is weighted by matching orders; it is never an average of daily AOVs.
 */
export function revenuePeriodTotals(points:RevenueDailyPoint[],from:string,to:string):RevenueTotals{
 const days=new Map(points.filter(point=>point.date>=from&&point.date<=to).map(point=>[point.date,point]));
 let expectedDays=0,coveredDays=0,revenue:number|null=0,orders:number|null=0;
 for(let date=from;date<=to;date=shiftDate(date,1)){
  expectedDays++;const point=days.get(date),dailyRevenue=point?.metrics.revenue,dailyOrders=point?.metrics.orders;
  if(finiteMetric(dailyRevenue)&&finiteMetric(dailyOrders))coveredDays++;
  revenue=finiteMetric(revenue)&&finiteMetric(dailyRevenue)?revenue+dailyRevenue:null;
  orders=finiteMetric(orders)&&finiteMetric(dailyOrders)?orders+dailyOrders:null;
 }
 return {revenue,orders,aov:ratio(revenue,orders),coveredDays,expectedDays};
}
export function revenueMetricChange(current:number|null,previous:number|null){
 return {absolute:finiteMetric(current)&&finiteMetric(previous)?current-previous:null,relative:change(current,previous)};
}
/** Single-day inspection keeps the real calendar context. No shifted fake
 * intraday points and no substitution of web merchandise revenue for net sales.
 */
export function revenueContextSeries(history:MetricSeriesPoint[],selected:MetricSeriesPoint[],from:string,to:string):MetricSeriesPoint[]{
 const values=new Map(history.filter(point=>point.date>=from&&point.date<=to).map(point=>[point.date,point]));
 for(const point of selected)if(point.date>=from&&point.date<=to)values.set(point.date,point);
 const result:MetricSeriesPoint[]=[];
 for(let date=from;date<=to;date=shiftDate(date,1)){const point=values.get(date);result.push({date,revenue:typeof point?.revenue==='number'&&finiteMetric(point.revenue)?point.revenue:null,orders:typeof point?.orders==='number'&&finiteMetric(point.orders)?point.orders:null,aov:typeof point?.aov==='number'&&finiteMetric(point.aov)?point.aov:null});}
 return result;
}
/** Align actual intervals by store clock, retaining fall-back occurrences.
 * A comparison-only hour never becomes a zero-value selected observation.
 */
export function revenueHourlySeries(selected:RevenueHourlyPoint[],comparison:RevenueHourlyPoint[],timezone:string):MetricSeriesPoint[]{
 const clock=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}),offset=new Intl.DateTimeFormat('en-US',{timeZone:timezone,timeZoneName:'shortOffset'});
 const bucket=(points:RevenueHourlyPoint[])=>{const occurrences=new Map<string,number>(),rows=new Map<string,{point?:RevenueHourlyPoint;start:string;clock:string;occurrence:number}>();if(!points.length)return rows;const ordered=[...points].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)),first=Date.parse(ordered[0].start),last=Date.parse(ordered.at(-1)!.start),byStart=new Map(ordered.map(point=>[Date.parse(point.start),point]));for(let instant=Date.parse(dayWindow(ordered[0].date,timezone).start);instant<=last;instant+=3600000){const start=new Date(instant).toISOString(),local=clock.format(new Date(instant)),occurrence=occurrences.get(local)??0;occurrences.set(local,occurrence+1);if(instant>=first)rows.set(`${local}:${occurrence}`,{point:byStart.get(instant),start,clock:local,occurrence});}return rows;};
 const current=bucket(selected),prior=bucket(comparison),keys=[...new Set([...current.keys(),...prior.keys()])].sort();
 return keys.map(key=>{const currentHour=current.get(key),priorHour=prior.get(key),point=currentHour?.point,previous=priorHour?.point,local=currentHour?.clock??priorHour!.clock,repeated=keys.some(other=>other!==key&&other.startsWith(`${local}:`)),instant=point?.start??previous?.start??currentHour?.start??priorHour!.start,label=repeated?`${local} · ${offset.formatToParts(new Date(instant)).find(part=>part.type==='timeZoneName')?.value??''}`:local;
  return {date:point?.start??`hour:${key}`,start:point?.start??null,end:point?.end??null,hourLabel:label,comparisonDate:previous?.start??null,comparisonEnd:previous?.end??null,revenue:finiteMetric(point?.metrics.revenue)?point!.metrics.revenue:null,orders:finiteMetric(point?.metrics.orders)?point!.metrics.orders:null,aov:finiteMetric(point?.summary.aov)?point!.summary.aov:null,comparison_revenue:finiteMetric(previous?.metrics.revenue)?previous!.metrics.revenue:null,comparison_orders:finiteMetric(previous?.metrics.orders)?previous!.metrics.orders:null,comparison_aov:finiteMetric(previous?.summary.aov)?previous!.summary.aov:null};
 });
}
