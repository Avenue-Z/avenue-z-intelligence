import {Temporal} from '@js-temporal/polyfill';
import type {Client,Observation,SourceBatch} from '../analytics/contracts';
import {dayWindow,todayIn} from '../analytics/windows';
import {hourlySessionCutoff,localHourInterval,observation,sourceBatch,sourceDates,type KindConfig,type KindWindow} from './kind-patches';
import {rechargeProviderJson} from './recharge-provider-json';
import {subscriptionIdentity,utcInstant} from './recharge-cancellations';

export const rechargeNewSubscriptionPopulation='recharge_new_subscription_records';
export const rechargeCreatedDefinition='recharge_all_status_subscription_records_created_at_utc_to_store_date';
export const rechargeSameDayCancellationDefinition='recharge_current_cancelled_created_same_store_day_cancelled_at_utc_excludes_reactivated';
export const rechargeSameDayCancellationEventDefinition='recharge_subscription_cancelled_events_first_same_creation_store_day_at_utc_includes_reactivated';
export const rechargeCancellationEventDefinition='recharge_subscription_cancelled_events_first_per_subscription_store_day_at_utc_includes_reactivated';
export const rechargeCancellationEventPopulation='recharge_subscription_cancellation_events';
async function fetchCancellationEventCounts(client:Client,config:KindConfig,dates:string[],created:Map<string,Temporal.Instant>,cutoff:Temporal.Instant,fetcher:typeof fetch,deadline:number){
 const cohortCounts=new Map<string,number>(),calendarCounts=new Map<string,number>();if(!dates.length)return {cohortCounts,calendarCounts};
 const start=Temporal.Instant.from(dayWindow(dates[0],client.timezone).start),minimum=start.subtract({seconds:2}),maximum=cutoff.add({seconds:2}),allowedDates=new Set(dates),headers={'X-Recharge-Access-Token':config.RECHARGE_ADMIN_TOKEN,'X-Recharge-Version':'2021-11'};
 const seen=new Map<string,string>(),first=new Map<string,Temporal.Instant>(),firstCalendar=new Map<string,Temporal.Instant>(),cursors=new Set<string>(),recordLimit=50000;let cursor='',complete=false,seenRows=0;
 for(let page=0;page<recordLimit/250;page++){
  const params=new URLSearchParams(cursor?{limit:'250',cursor}:{limit:'250',object_type:'subscription',verbs:'cancelled',created_at_min:minimum.toString().replace(/Z$/,''),created_at_max:maximum.toString().replace(/Z$/,'')});
  const response=await rechargeProviderJson(fetcher,`https://api.rechargeapps.com/events?${params}`,{headers},deadline,'retained-events',!!cursor);
  if(!Array.isArray(response.events)||response.events.length>250)throw Error('Recharge cancellation event page exceeds the limit');
  if(!Object.hasOwn(response,'next_cursor')||response.next_cursor!==null&&typeof response.next_cursor!=='string')throw Error('Recharge cancellation event pagination metadata missing');
  for(const event of response.events){
   if(++seenRows>recordLimit)throw Error('Recharge cancellation event export exceeds its row limit');
   if(!event||typeof event!=='object'||event.object_type!=='subscription'||event.verb!=='cancelled')throw Error('Recharge cancellation event filter was not honored');
   const eventId=subscriptionIdentity(event.id),subscriptionId=subscriptionIdentity(event.object_id);let cancelled;try{cancelled=utcInstant(event.created_at);}catch{throw Error('Recharge cancellation event timestamp missing or invalid');}
   if(Temporal.Instant.compare(cancelled,minimum)<0||Temporal.Instant.compare(cancelled,maximum)>0)throw Error('Recharge cancellation event time filter was not honored');
   const fingerprint=JSON.stringify([subscriptionId,cancelled.toString()]),previous=seen.get(eventId);if(previous){if(previous!==fingerprint)throw Error('Recharge cancellation event changed during pagination');continue;}seen.set(eventId,fingerprint);
   if(Temporal.Instant.compare(cancelled,start)<0||Temporal.Instant.compare(cancelled,cutoff)>=0)continue;
   const cancellationDate=cancelled.toZonedDateTimeISO(client.timezone).toPlainDate().toString();if(!allowedDates.has(cancellationDate))continue;
   const calendarKey=`${cancellationDate}:${subscriptionId}`,earliestCalendar=firstCalendar.get(calendarKey);if(!earliestCalendar||Temporal.Instant.compare(cancelled,earliestCalendar)<0)firstCalendar.set(calendarKey,cancelled);
   const creation=created.get(subscriptionId);if(!creation)continue;
   if(Temporal.Instant.compare(cancelled,creation)<0)throw Error('Recharge cancellation event precedes subscription creation');
   const date=creation.toZonedDateTimeISO(client.timezone).toPlainDate().toString();if(!allowedDates.has(date)||cancelled.toZonedDateTimeISO(client.timezone).toPlainDate().toString()!==date)continue;
   const earliest=first.get(subscriptionId);if(!earliest||Temporal.Instant.compare(cancelled,earliest)<0)first.set(subscriptionId,cancelled);
  }
  const next=response.next_cursor;if(next===null||next===''){complete=true;break;}if(next.length>2000||next===cursor||cursors.has(next)||page===recordLimit/250-1)throw Error('Recharge cancellation event pagination did not complete or advance');cursors.add(next);cursor=next;
 }
 if(!complete)throw Error('Recharge cancellation event pagination did not complete');
 for(const [events,counts] of [[first,cohortCounts],[firstCalendar,calendarCounts]] as const)for(const cancelled of events.values()){const local=cancelled.toZonedDateTimeISO(client.timezone),key=`${local.toPlainDate()}:${local.hour}`;counts.set(key,(counts.get(key)??0)+1);}
 return {cohortCounts,calendarCounts};
}
export async function fetchRechargeSubscriptionCohort(client:Client,config:KindConfig,window:KindWindow,fetcher:typeof fetch,deadline:number,asOf=new Date()):Promise<SourceBatch>{
 const dates=sourceDates(window),today=todayIn(client.timezone,asOf);if(!dates.length||window.to>today)throw Error('Recharge creation cohort window is invalid');
 const start=Temporal.Instant.from(dayWindow(window.from,client.timezone).start),through=window.to<today?dayWindow(window.to,client.timezone).end:hourlySessionCutoff(client.timezone,asOf).through,cutoff=Temporal.Instant.from(through),minimum=start.subtract({seconds:2}),maximum=cutoff.add({seconds:2}),headers={'X-Recharge-Access-Token':config.RECHARGE_ADMIN_TOKEN,'X-Recharge-Version':'2021-11'};
 const retentionStart=Temporal.Instant.from(asOf.toISOString()).subtract({hours:168}),eventDates=dates.filter(date=>Temporal.Instant.compare(Temporal.Instant.from(dayWindow(date,client.timezone).start),retentionStart)>=0),eventDateSet=new Set(eventDates);
 const historical=window.to<today,recordLimit=historical?250000:50000,createdCounts=new Map<string,number>(),cancelledCounts=new Map<string,number>(),createdSubscriptions=new Map<string,Temporal.Instant>(),seen=new Map<string,string>(),cursors=new Set<string>();let cursor='',complete=false,seenRows=0,createdTotal=0,cancelledTotal=0;
 for(let page=0;page<recordLimit/250;page++){
  const params=new URLSearchParams(cursor?{limit:'250',cursor}:{limit:'250',created_at_min:minimum.toString().replace(/Z$/,''),created_at_max:maximum.toString().replace(/Z$/,'')});
  const response=await rechargeProviderJson(fetcher,`https://api.rechargeapps.com/subscriptions?${params}`,{headers},deadline,'creation-cohort',!!cursor,historical?(cursor?60000:180000):25000);
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
   const localCreated=created.toZonedDateTimeISO(client.timezone),date=localCreated.toPlainDate().toString(),createdKey=`${date}:${localCreated.hour}`;createdCounts.set(createdKey,(createdCounts.get(createdKey)??0)+1);createdSubscriptions.set(id,created);createdTotal++;
   if(!cancelled||Temporal.Instant.compare(cancelled,cutoff)>=0)continue;
   const localCancelled=cancelled.toZonedDateTimeISO(client.timezone);if(localCancelled.toPlainDate().toString()!==date)continue;
   // Cancellation-hour buckets make an earlier matched cutoff exclude later
   // cancellations, even when their subscriptions were created in the morning.
   const cancelledKey=`${date}:${localCancelled.hour}`;cancelledCounts.set(cancelledKey,(cancelledCounts.get(cancelledKey)??0)+1);cancelledTotal++;
  }
  const next=response.next_cursor;if(next===null||next===''){complete=true;break;}if(next.length>2000||next===cursor||cursors.has(next)||page===recordLimit/250-1)throw Error('Recharge creation cohort pagination did not complete or advance');cursors.add(next);cursor=next;
 }
 if(!complete)throw Error('Recharge creation cohort pagination did not complete');
 const {cohortCounts,calendarCounts}=await fetchCancellationEventCounts(client,config,eventDates,createdSubscriptions,cutoff,fetcher,deadline);
 const rows:Observation[]=[];for(const date of dates)for(let hour=0;hour<24;hour++){const interval=localHourInterval(date,hour,client.timezone);if(!interval||Temporal.Instant.compare(Temporal.Instant.from(interval.end),cutoff)>0)continue;for(const [metric,counts,definition,population] of [['new_subscriptions',createdCounts,rechargeCreatedDefinition,rechargeNewSubscriptionPopulation],['same_day_subscription_cancellations',cancelledCounts,rechargeSameDayCancellationDefinition,rechargeNewSubscriptionPopulation],...eventDateSet.has(date)?[['same_day_subscription_cancellation_events',cohortCounts,rechargeSameDayCancellationEventDefinition,rechargeNewSubscriptionPopulation] as const,['subscription_cancellation_events',calendarCounts,rechargeCancellationEventDefinition,rechargeCancellationEventPopulation] as const]:[]] as const)rows.push({...observation(date,'subscriptionEvents',metric,counts.get(`${date}:${hour}`)??0,definition,population,null,{},interval),quality:date===today?'partial':'complete'});}
 const sum=(metric:string)=>rows.filter(row=>row.metric===metric).reduce((n,row)=>n+(row.value??0),0),eventTotal=[...cohortCounts.values()].reduce((n,value)=>n+value,0),calendarTotal=[...calendarCounts.values()].reduce((n,value)=>n+value,0);if(sum('new_subscriptions')!==createdTotal||sum('same_day_subscription_cancellations')!==cancelledTotal||cancelledTotal>createdTotal||sum('same_day_subscription_cancellation_events')!==eventTotal||eventTotal>createdTotal||sum('subscription_cancellation_events')!==calendarTotal)throw Error('Recharge creation cohort hourly counts did not reconcile');return sourceBatch(client,rows,through,[],'hourly');
}
