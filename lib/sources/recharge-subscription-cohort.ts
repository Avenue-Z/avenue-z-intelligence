import {Temporal} from '@js-temporal/polyfill';
import type {Client,Observation,SourceBatch} from '../analytics/contracts';
import {dayWindow,todayIn} from '../analytics/windows';
import {hourlySessionCutoff,localHourInterval,observation,providerJson,sourceBatch,sourceDates,type KindConfig,type KindWindow} from './kind-patches';
import {subscriptionIdentity,utcInstant} from './recharge-cancellations';

export const rechargeNewSubscriptionPopulation='recharge_new_subscription_records';
export const rechargeCreatedDefinition='recharge_all_status_subscription_records_created_at_utc_to_store_date';
export const rechargeSameDayCancellationDefinition='recharge_current_cancelled_created_same_store_day_cancelled_at_utc_excludes_reactivated';
export async function fetchRechargeSubscriptionCohort(client:Client,config:KindConfig,window:KindWindow,fetcher:typeof fetch,deadline:number,asOf=new Date()):Promise<SourceBatch>{
 const dates=sourceDates(window),today=todayIn(client.timezone,asOf);if(!dates.length||window.to>today)throw Error('Recharge creation cohort window is invalid');
 const start=Temporal.Instant.from(dayWindow(window.from,client.timezone).start),through=window.to<today?dayWindow(window.to,client.timezone).end:hourlySessionCutoff(client.timezone,asOf).through,cutoff=Temporal.Instant.from(through),minimum=start.subtract({seconds:2}),maximum=cutoff.add({seconds:2}),headers={'X-Recharge-Access-Token':config.RECHARGE_ADMIN_TOKEN,'X-Recharge-Version':'2021-11'};
 const historical=window.to<today,recordLimit=historical?250000:50000,createdCounts=new Map<string,number>(),cancelledCounts=new Map<string,number>(),seen=new Map<string,string>(),cursors=new Set<string>();let cursor='',complete=false,seenRows=0,createdTotal=0,cancelledTotal=0;
 for(let page=0;page<recordLimit/250;page++){
  const params=new URLSearchParams(cursor?{limit:'250',cursor}:{limit:'250',created_at_min:minimum.toString().replace(/Z$/,''),created_at_max:maximum.toString().replace(/Z$/,'')});
  const response=await providerJson(fetcher,`https://api.rechargeapps.com/subscriptions?${params}`,{headers},deadline,0,historical?(cursor?60000:180000):25000);
  if(!Array.isArray(response.subscriptions)||response.subscriptions.length>250)throw Error('Recharge creation cohort page exceeds the limit');
  if(!Object.hasOwn(response,'next_cursor')||response.next_cursor!==null&&typeof response.next_cursor!=='string')throw Error('Recharge creation cohort pagination metadata missing');
  for(const record of response.subscriptions){
   if(++seenRows>recordLimit)throw Error('Recharge creation cohort export exceeds its row limit');
   if(!record||typeof record!=='object'||!['active','cancelled','expired'].includes(String(record.status).toLowerCase()))throw Error('Recharge creation cohort status missing or invalid');
   const id=subscriptionIdentity(record.id);let created;try{created=utcInstant(record.created_at);}catch{throw Error('Recharge creation timestamp missing or invalid');}
   if(Temporal.Instant.compare(created,minimum)<0||Temporal.Instant.compare(created,maximum)>0)throw Error('Recharge creation timestamp filter was not honored');
   const cancelled=String(record.status).toLowerCase()==='cancelled'?utcInstant(record.cancelled_at):null;
   if(cancelled&&Temporal.Instant.compare(cancelled,created)<0)throw Error('Recharge cancellation precedes subscription creation');
   const fingerprint=JSON.stringify([created.toString(),cancelled?.toString()??null,String(record.status).toLowerCase()]),previous=seen.get(id);if(previous){if(previous!==fingerprint)throw Error('Recharge creation cohort changed during pagination');continue;}seen.set(id,fingerprint);
   if(Temporal.Instant.compare(created,start)<0||Temporal.Instant.compare(created,cutoff)>=0)continue;
   const localCreated=created.toZonedDateTimeISO(client.timezone),date=localCreated.toPlainDate().toString(),createdKey=`${date}:${localCreated.hour}`;createdCounts.set(createdKey,(createdCounts.get(createdKey)??0)+1);createdTotal++;
   if(!cancelled||Temporal.Instant.compare(cancelled,cutoff)>=0)continue;
   const localCancelled=cancelled.toZonedDateTimeISO(client.timezone);if(localCancelled.toPlainDate().toString()!==date)continue;
   // Cancellation-hour buckets make an earlier matched cutoff exclude later
   // cancellations, even when their subscriptions were created in the morning.
   const cancelledKey=`${date}:${localCancelled.hour}`;cancelledCounts.set(cancelledKey,(cancelledCounts.get(cancelledKey)??0)+1);cancelledTotal++;
  }
  const next=response.next_cursor;if(next===null||next===''){complete=true;break;}if(next.length>2000||next===cursor||cursors.has(next)||page===recordLimit/250-1)throw Error('Recharge creation cohort pagination did not complete or advance');cursors.add(next);cursor=next;
 }
 if(!complete)throw Error('Recharge creation cohort pagination did not complete');
 const rows:Observation[]=[];for(const date of dates)for(let hour=0;hour<24;hour++){const interval=localHourInterval(date,hour,client.timezone);if(!interval||Temporal.Instant.compare(Temporal.Instant.from(interval.end),cutoff)>0)continue;for(const [metric,counts,definition] of [['new_subscriptions',createdCounts,rechargeCreatedDefinition],['same_day_subscription_cancellations',cancelledCounts,rechargeSameDayCancellationDefinition]] as const)rows.push({...observation(date,'subscriptionEvents',metric,counts.get(`${date}:${hour}`)??0,definition,rechargeNewSubscriptionPopulation,null,{},interval),quality:date===today?'partial':'complete'});}
 const sum=(metric:string)=>rows.filter(row=>row.metric===metric).reduce((n,row)=>n+(row.value??0),0);if(sum('new_subscriptions')!==createdTotal||sum('same_day_subscription_cancellations')!==cancelledTotal||cancelledTotal>createdTotal)throw Error('Recharge creation cohort hourly counts did not reconcile');return sourceBatch(client,rows,through,[],'hourly');
}
