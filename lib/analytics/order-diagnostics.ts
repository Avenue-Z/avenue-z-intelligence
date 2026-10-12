import type {MetricSeriesPoint} from './visualization';
export type DiagnosticRow={dimensions:Record<string,string>;metrics:Record<string,number|null>};
export const ORDER_STREAM_LABELS:Record<string,string>={one_time:'One-time web orders',first_subscription:'First subscription web orders',recurring_renewal:'Tagged recurring renewals',unclassified:'Unclassified web orders'};
const order=['one_time','first_subscription','recurring_renewal','unclassified'];
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const divide=(n:number|null,d:number|null)=>n!==null&&d!==null&&d>0?n/d:null;
function sum(rows:DiagnosticRow[],metric:string){let value=0;for(const row of rows){const next=row.metrics[metric];if(!finite(next))return null;value+=next;}return rows.length&&Number.isFinite(value)?value:null;}
function grouped(rows:DiagnosticRow[],dimension:string){const groups=new Map<string,DiagnosticRow[]>();for(const row of rows){const key=row.dimensions[dimension];if(!key)continue;const group=groups.get(key);if(group)group.push(row);else groups.set(key,[row]);}return groups;}

/** The prepared metric bags retain the server's currency, population and
 * duplicate guards. Renewals never fall back to acquisition metric names. */
export function orderStreamRows(rows:DiagnosticRow[]){
 return [...grouped(rows,'order_stream')].map(([stream,values])=>{
  const prefix=stream==='recurring_renewal'?'recurring_':'',revenue=sum(values,`${prefix}revenue`),orders=sum(values,`${prefix}orders`),units=sum(values,`${prefix}units`);
  return {stream,label:ORDER_STREAM_LABELS[stream]??stream,revenue,orders,units,aov:divide(revenue,orders),unitsPerOrder:divide(units,orders)};
 }).sort((a,b)=>order.indexOf(a.stream)-order.indexOf(b.stream));
}
export function orderStreamSeries(rows:DiagnosticRow[],metric:'revenue'|'orders'|'units'|'aov'|'unitsPerOrder'):MetricSeriesPoint[]{
 return [...grouped(rows,'store_date')].sort(([a],[b])=>a.localeCompare(b)).map(([date,values])=>({date,...Object.fromEntries(orderStreamRows(values).map(row=>[row.stream,row[metric]]))}));
}
export function renewalMixRows(rows:DiagnosticRow[]){
 return [...grouped(rows,'reported_currency')].sort(([a],[b])=>a.localeCompare(b)).map(([currency,values])=>{
  const orders=sum(values,'renewal_orders'),units=sum(values,'renewal_units'),refundMoney=sum(values,'renewal_refund_money'),billedRevenue=sum(values,'renewal_billed_revenue');
  return {currency,orders,units,refundMoney,billedRevenue,unitsPerOrder:divide(units,orders),refundedAmountShare:divide(refundMoney,billedRevenue)};
 });
}
export function renewalMixSeries(rows:DiagnosticRow[],metric:'orders'|'units'|'refundedAmountShare'):MetricSeriesPoint[]{
 return [...grouped(rows,'store_date')].sort(([a],[b])=>a.localeCompare(b)).map(([date,values])=>({date,...Object.fromEntries(renewalMixRows(values).map(row=>[row.currency,row[metric]]))}));
}
export function hygieneRows(rows:DiagnosticRow[]){
 return [...grouped(rows,'promo_code')].sort(([a],[b])=>a.localeCompare(b)).map(([code,values])=>{
  const withOrders=sum(values,'orders_with_promo'),withoutOrders=sum(values,'orders_without_promo'),withRevenue=sum(values,'revenue_with_promo'),withoutRevenue=sum(values,'revenue_without_promo');
  return {code,withOrders,withoutOrders,withRevenue,withoutRevenue,withPromoAov:divide(withRevenue,withOrders),withoutPromoAov:divide(withoutRevenue,withoutOrders),promoOrders:sum(values,'promo_orders'),zeroOrders:sum(values,'promo_zero_orders'),cancelledOrders:sum(values,'promo_cancelled_orders'),units:sum(values,'promo_units'),cancelledUnits:sum(values,'promo_cancelled_units')};
 });
}
export function hygieneSeries(rows:DiagnosticRow[]):MetricSeriesPoint[]{
 return [...grouped(rows,'store_date')].sort(([a],[b])=>a.localeCompare(b)).map(([date,values])=>({date,...Object.fromEntries(['promo_orders','promo_zero_orders','promo_cancelled_orders','promo_units','promo_cancelled_units'].map(metric=>[metric,sum(values,metric)]))}));
}
