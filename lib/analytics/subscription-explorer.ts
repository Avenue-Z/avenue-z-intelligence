import {Temporal} from '@js-temporal/polyfill';
import {ratio} from './metrics';

export type SubscriptionDay={date:string;metrics:Record<string,number|null>};
export type SubscriptionRange={from:string;to:string};
export type SubscriptionMetric='recurring_revenue'|'recurring_orders'|'aov'|'recurring_refund_orders'|'refund_rate'|'recurring_cancelled_orders'|'cancellation_rate'|'subscription_cancellations';
export const subscriptionMetrics:{id:SubscriptionMetric;label:string;unit:'currency'|'number'|'rate';color:string;definition:string}[]=[
 {id:'recurring_revenue',label:'Renewal revenue',unit:'currency',color:'#4368c4',definition:'Recurring order revenue excluding shipping and tax, before refunds'},
 {id:'recurring_orders',label:'Renewal orders',unit:'number',color:'#567fbb',definition:'Orders tagged Subscription Recurring Order'},
 {id:'aov',label:'Renewal AOV',unit:'currency',color:'#7567af',definition:'Recurring revenue divided by matching recurring orders'},
 {id:'subscription_cancellations',label:'Subscriptions cancelled',unit:'number',color:'#ba6772',definition:'Reported currently cancelled Recharge subscription records by cancellation date in the store timezone; reactivation can remove historical records'},
 {id:'recurring_cancelled_orders',label:'Cancelled renewal orders',unit:'number',color:'#b58365',definition:'Renewal orders placed in the period that now have cancellation status; this is an order-date cohort'},
 {id:'cancellation_rate',label:'Renewal-order cancellation rate',unit:'rate',color:'#b58365',definition:'Cancelled renewal orders divided by recurring orders in the same order-date cohort'},
 {id:'recurring_refund_orders',label:'Refunded renewal orders',unit:'number',color:'#b29b62',definition:'Renewal orders placed in the period with a refund; this is an order-date cohort'},
 {id:'refund_rate',label:'Refunded-order rate',unit:'rate',color:'#b29b62',definition:'Refunded renewal orders divided by recurring orders in the same order-date cohort'},
];
const rawMetrics=['recurring_revenue','recurring_orders','recurring_refund_orders','recurring_cancelled_orders','subscription_cancellations'];
function finite(value:unknown):value is number{return typeof value==='number'&&Number.isFinite(value);}
function calendarDates(range:SubscriptionRange){
 const from=Temporal.PlainDate.from(range.from),to=Temporal.PlainDate.from(range.to),days=from.until(to).days;
 if(days<0||days>730)throw new Error('Select a subscription period of at most two years');
 return Array.from({length:days+1},(_,index)=>from.add({days:index}).toString());
}
function byDate(rows:SubscriptionDay[],dates:string[]){
 const allowed=new Set(dates),result=new Map<string,Record<string,number|null>>();
 for(const row of rows){if(!allowed.has(row.date))continue;const prior=result.get(row.date);if(prior){const invalid=Object.fromEntries([...new Set([...Object.keys(prior),...Object.keys(row.metrics)])].map(key=>[key,null]));result.set(row.date,invalid);}else result.set(row.date,row.metrics);}
 return result;
}
export function subscriptionMetricValue(metrics:Record<string,number|null>,metric:SubscriptionMetric):number|null{
 if(['aov','refund_rate','cancellation_rate'].includes(metric)&&Object.hasOwn(metrics,metric))return finite(metrics[metric])?metrics[metric]:null;
 if(metric==='aov')return ratio(metrics.recurring_revenue,metrics.recurring_orders);
 if(metric==='refund_rate')return ratio(metrics.recurring_refund_orders,metrics.recurring_orders);
 if(metric==='cancellation_rate')return ratio(metrics.recurring_cancelled_orders,metrics.recurring_orders);
 return finite(metrics[metric])?metrics[metric]:null;
}
function periodSummary(dates:string[],commerce:Map<string,Record<string,number|null>>,events:Map<string,Record<string,number|null>>){
 const metrics:Record<string,number|null>={},coverage:Record<string,{reportedDays:number;totalDays:number}>={};
 for(const metric of rawMetrics){const source=metric==='subscription_cancellations'?events:commerce,values=dates.flatMap(date=>source.has(date)&&Object.hasOwn(source.get(date)!,metric)?[source.get(date)![metric]]:[]);const known=values.filter(finite);metrics[metric]=values.length&&values.every(finite)?known.reduce((sum,value)=>sum+value,0):null;coverage[metric]={reportedDays:known.length,totalDays:dates.length};}
 for(const [metric,numerator] of [['aov','recurring_revenue'],['refund_rate','recurring_refund_orders'],['cancellation_rate','recurring_cancelled_orders']]){const numeratorDates=dates.filter(date=>commerce.has(date)&&Object.hasOwn(commerce.get(date)!,numerator)),denominatorDates=dates.filter(date=>commerce.has(date)&&Object.hasOwn(commerce.get(date)!,'recurring_orders')),matched=JSON.stringify(numeratorDates)===JSON.stringify(denominatorDates);metrics[metric]=matched?ratio(metrics[numerator],metrics.recurring_orders):null;coverage[metric]={reportedDays:dates.filter(date=>finite(commerce.get(date)?.[numerator])&&finite(commerce.get(date)?.recurring_orders)).length,totalDays:dates.length};}
 return {metrics,coverage};
}
export function buildSubscriptionExplorer({current,comparison,range,comparisonRange,currentEvents=[],comparisonEvents=[]}:{current:SubscriptionDay[];comparison:SubscriptionDay[];range:SubscriptionRange;comparisonRange:SubscriptionRange;currentEvents?:SubscriptionDay[];comparisonEvents?:SubscriptionDay[]}){
 const selectedDates=calendarDates(range),previousDates=calendarDates(comparisonRange),commerce=byDate(current,selectedDates),prior=byDate(comparison,previousDates),events=byDate(currentEvents,selectedDates),priorEvents=byDate(comparisonEvents,previousDates);
 const rawDay=(date:string|null,source:Map<string,Record<string,number|null>>,eventSource:Map<string,Record<string,number|null>>)=>Object.fromEntries(rawMetrics.map(metric=>{const value=date?(metric==='subscription_cancellations'?eventSource:source).get(date)?.[metric]:null;return [metric,finite(value)?value:null];}));
 return {points:selectedDates.map((date,index)=>({date,comparisonDate:previousDates[index]??null,selected:rawDay(date,commerce,events),comparison:rawDay(previousDates[index]??null,prior,priorEvents)})),current:periodSummary(selectedDates,commerce,events),previous:periodSummary(previousDates,prior,priorEvents),range,comparisonRange};
}
