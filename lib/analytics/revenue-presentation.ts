import {finiteMetric} from './display';
import {change,ratio} from './metrics';
import {shiftDate} from './windows';
import type {MetricSeriesPoint} from './visualization';

export type RevenueDailyPoint={date:string;metrics:Record<string,number|null>;summary:{aov:number|null}};
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
