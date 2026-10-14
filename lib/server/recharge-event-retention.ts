import type{Observation}from'../analytics/contracts';
import type{RegisteredContract}from'../sources/registered-contract';
import{dayWindow}from'../analytics/windows';
import{localHourInterval}from'../sources/kind-patches';
import{rechargeCancellationDefinition,rechargeCancellationPopulation}from'../sources/recharge-cancellations';
import{rechargeCreatedDefinition,rechargeSameDayCancellationDefinition,rechargeSameDayCancellationEventDefinition,rechargeCancellationEventDefinition,rechargeNewSubscriptionPopulation,rechargeCancellationEventPopulation}from'../sources/recharge-subscription-cohort';
const profiles=[['subscription_cancellations',rechargeCancellationDefinition,rechargeCancellationPopulation],['new_subscriptions',rechargeCreatedDefinition,rechargeNewSubscriptionPopulation],['same_day_subscription_cancellations',rechargeSameDayCancellationDefinition,rechargeNewSubscriptionPopulation],['same_day_subscription_cancellation_events',rechargeSameDayCancellationEventDefinition,rechargeNewSubscriptionPopulation],['subscription_cancellation_events',rechargeCancellationEventDefinition,rechargeCancellationEventPopulation]] as const;
export const rechargeExactEventMetrics=new Set<string>(profiles.slice(3).map(profile=>profile[0]));
export function expiredRechargeEventDay(date:string,timezone:string,asOf:string){const now=Date.parse(asOf),window=dayWindow(date,timezone);return Number.isFinite(now)&&Date.parse(window.end)<=now&&Date.parse(window.start)<now-168*3600000;}
/** Prove each original hourly profile covers this entire closed store day.
 * Retain its immutable snapshot as a whole; never merge or refresh old events. */
export function completeRechargeEventDay(rows:Observation[],date:string,timezone:string,sourceId:string,contract:RegisteredContract,exact:boolean){
 const required=profiles.slice(0,exact?5:3),expected=new Set<string>(),seen=new Set<string>(),totals=new Map<string,number>(),end=Date.parse(dayWindow(date,timezone).end);
 for(const[metric,definition,population]of required){const profile=contract.profiles.find(profile=>profile.dataset==='subscriptionEvents'&&profile.metric===metric);if(!profile||!profile.hourly||profile.definition!==definition||profile.population!==population||profile.currency!==null||profile.dimensions.length)return false;for(let hour=0;hour<24;hour++){const interval=localHourInterval(date,hour,timezone);if(interval)expected.add(`${metric}:${Date.parse(interval.start)}:${Date.parse(interval.end)}`);}}
 for(const row of rows){if(!row||typeof row!=='object'||!row.dimensions||typeof row.dimensions!=='object'||Array.isArray(row.dimensions))return false;const profile=required.find(([metric])=>metric===row.metric);if(!profile||row.dataset!=='subscriptionEvents'||row.date!==date||row.sourceId!==sourceId||row.definition!==profile[1]||row.population!==profile[2]||row.currency!==null||Object.keys(row.dimensions).length||row.quality!=='complete'||typeof row.value!=='number'||!Number.isInteger(row.value)||row.value<0||!row.coverageThrough||!Number.isFinite(Date.parse(row.coverageThrough))||Date.parse(row.coverageThrough)<end||!Number.isFinite(Date.parse(row.retrievedAt)))return false;
  const key=`${row.metric}:${Date.parse(row.start??'')}:${Date.parse(row.end??'')}`;if(!expected.has(key)||seen.has(key))return false;seen.add(key);totals.set(row.metric,(totals.get(row.metric)??0)+row.value);
 }
 return seen.size===expected.size&&(totals.get('same_day_subscription_cancellations')??0)<=(totals.get('new_subscriptions')??0)&&(!exact||(totals.get('same_day_subscription_cancellation_events')??0)<=(totals.get('new_subscriptions')??0));
}
