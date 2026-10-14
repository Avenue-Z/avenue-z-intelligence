import type {Client,SourceBatch} from '../analytics/contracts';
import {dayWindow,shiftDate} from '../analytics/windows';
import {localHourInterval} from '../sources/kind-patches';
import type {RegisteredContract} from '../sources/registered-contract';
import {rechargeCancellationDefinition,rechargeCancellationPopulation} from '../sources/recharge-cancellations';
import {rechargeCreatedDefinition,rechargeNewSubscriptionPopulation,rechargeSameDayCancellationDefinition,rechargeSameDayCancellationEventDefinition,rechargeCancellationEventDefinition,rechargeCancellationEventPopulation} from '../sources/recharge-subscription-cohort';

export const rechargeHistoryAllowance=8*1024*1024,rechargeHistoryReserveLimit=23000000000;
const profiles=[['subscription_cancellations',rechargeCancellationDefinition,rechargeCancellationPopulation],['new_subscriptions',rechargeCreatedDefinition,rechargeNewSubscriptionPopulation],['same_day_subscription_cancellations',rechargeSameDayCancellationDefinition,rechargeNewSubscriptionPopulation],['same_day_subscription_cancellation_events',rechargeSameDayCancellationEventDefinition,rechargeNewSubscriptionPopulation],['subscription_cancellation_events',rechargeCancellationEventDefinition,rechargeCancellationEventPopulation]] as const;
export class HistoryCapacityDeferral extends Error{}
export function boundedRechargeContract(contract:RegisteredContract){
 const metrics=new Set(contract.profiles.map(profile=>profile.metric));
 return contract.hourlyGrain&&[3,5].includes(contract.profiles.length)&&metrics.size===contract.profiles.length&&profiles.slice(0,3).every(([metric])=>metrics.has(metric))&&contract.profiles.every(profile=>{
  const known=profiles.find(([metric])=>metric===profile.metric);return !!known&&profile.dataset==='subscriptionEvents'&&profile.hourly&&profile.currency===null&&!profile.dimensions.length&&profile.definition===known[1]&&profile.population===known[2];
 });
}
export function recentRechargeHistoryDate(date:string,today:string){return /^\d{4}-\d{2}-\d{2}$/.test(date)&&date>=shiftDate(today,-30)&&date<today;}
export function rechargeHistoryFits(bytes:number){return bytes+rechargeHistoryAllowance<rechargeHistoryReserveLimit;}
export function validateBoundedRechargeHistory(batch:SourceBatch,contract:RegisteredContract,client:Client,date:string){
 const reject=()=>{throw new HistoryCapacityDeferral('Bounded Recharge historical capture needs a smaller complete count-only batch');};
 if(!boundedRechargeContract(contract)||batch.clientId!==client.id||batch.timezone!==client.timezone||batch.currency!==client.currency||!batch.complete||batch.grain!=='hourly'||batch.dimensions.length||batch.channels.length||batch.nextCursor||batch.rows.length>125||new TextEncoder().encode(JSON.stringify(batch)).byteLength>256*1024||!(Date.parse(batch.coverageThrough??'')>=Date.parse(dayWindow(date,client.timezone).end)))reject();
 const intervals=new Map<string,string>();for(let hour=0;hour<24;hour++){const interval=localHourInterval(date,hour,client.timezone);if(interval)intervals.set(interval.start,interval.end);}
 const seen=new Map<string,Set<string>>();
 for(const row of batch.rows){const known=contract.profiles.find(profile=>profile.metric===row.metric),start=row.start??'';
  if(row.date!==date||row.dataset!=='subscriptionEvents'||row.quality!=='complete'||row.currency!==null||Object.keys(row.dimensions).length||typeof row.value!=='number'||!Number.isSafeInteger(row.value)||row.value<0||!known||row.definition!==known.definition||row.population!==known.population||intervals.get(start)!==row.end)reject();
  const hours=seen.get(row.metric)??new Set<string>();if(hours.has(start))reject();hours.add(start);seen.set(row.metric,hours);
 }
 if(![3,5].includes(seen.size)||!profiles.slice(0,3).every(([metric])=>seen.has(metric))||[...seen.values()].some(hours=>hours.size!==intervals.size))reject();
}
