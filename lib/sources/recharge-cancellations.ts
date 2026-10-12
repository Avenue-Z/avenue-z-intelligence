import {Temporal} from '@js-temporal/polyfill';
import type {Client,Observation,SourceBatch} from '../analytics/contracts';
import {dayWindow,todayIn} from '../analytics/windows';
import {hourlySessionCutoff,localHourInterval,observation,providerJson,sourceBatch,sourceDates,type KindConfig,type KindWindow} from './kind-patches';

export const rechargeCancellationDefinition='recharge_current_cancelled_subscription_records_cancelled_at_utc_to_store_date_excludes_reactivated';
export const rechargeCancellationPopulation='recharge_cancelled_subscription_records';
function utcInstant(value:unknown){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value))throw new Error('Recharge cancellation timestamp missing or invalid');
 // Recharge's API standards specify UTC date-times from version 2021-11.
 // Explicit offsets are respected; omitted offsets are interpreted as UTC.
 const iso=value.replace(' ','T');try{return Temporal.Instant.from(/(?:Z|[+-]\d{2}:\d{2})$/.test(iso)?iso:`${iso}Z`);}catch{throw new Error('Recharge cancellation timestamp missing or invalid');}
}
function subscriptionIdentity(value:unknown){if(typeof value==='number'&&(!Number.isSafeInteger(value)||value<=0)||!/^\d+$/.test(String(value))||String(value)==='0')throw new Error('Recharge subscription identity missing or invalid');return String(value);}
export async function fetchRechargeCancellations(client:Client,config:KindConfig,window:KindWindow,fetcher:typeof fetch,deadline:number,asOf=new Date()):Promise<SourceBatch>{
 const dates=sourceDates(window);if(!dates.length)throw new Error('Recharge cancellation window is empty');
 const today=todayIn(client.timezone,asOf);if(window.to>today)throw new Error('Recharge cancellation window extends into the future');
 const start=Temporal.Instant.from(dayWindow(window.from,client.timezone).start),minimum=start.subtract({seconds:2}),through=window.to<today?dayWindow(window.to,client.timezone).end:hourlySessionCutoff(client.timezone,asOf).through,cutoff=Temporal.Instant.from(through),headers={'X-Recharge-Access-Token':config.RECHARGE_ADMIN_TOKEN,'X-Recharge-Version':'2021-11'};
 const base={status:'cancelled',limit:'250',updated_at_min:minimum.toString().replace(/Z$/,'')},seenCursors=new Set<string>(),events=new Map<string,string>(),counts=new Map<string,number>();let cursor='',complete=false,eligible=0,seenRows=0;
 for(let page=0;page<200;page++){
  // Larger historical cursor scans sometimes need longer than the normal
  // polling request. The whole source deadline still caps each request/retry.
  const requestTimeout=window.to<today&&dates.length>3?60000:25000;
  const params=new URLSearchParams(cursor?{limit:'250',cursor}:base),response=await providerJson(fetcher,`https://api.rechargeapps.com/subscriptions?${params}`,{headers},deadline,0,requestTimeout);
  if(!Array.isArray(response.subscriptions)||response.subscriptions.length>250)throw new Error('Recharge subscriptions response exceeds the page limit');
  if(!Object.hasOwn(response,'next_cursor')||response.next_cursor!==null&&typeof response.next_cursor!=='string')throw new Error('Recharge cancellation pagination metadata missing');
  for(const record of response.subscriptions){
   if(++seenRows>50000)throw new Error('Recharge cancellation export exceeds its row limit');
   if(!record||typeof record!=='object'||String(record.status).toLowerCase()!=='cancelled'||!record.cancelled_at)throw new Error('Recharge status filter did not return cancelled subscription records');
   const id=subscriptionIdentity(record.id),cancelled=utcInstant(record.cancelled_at),updated=utcInstant(record.updated_at),at=cancelled.toString();
   if(Temporal.Instant.compare(updated,minimum)<0)throw new Error('Recharge updated timestamp filter was not honored');
   if(Number(cancelled.epochMilliseconds)-Number(updated.epochMilliseconds)>1000)throw new Error('Recharge cancellation timestamp exceeds the validated updated-time ordering');
   const previous=events.get(id);if(previous){if(previous!==at)throw new Error('Recharge subscription cancellation changed during pagination');continue;}events.set(id,at);
   if(Temporal.Instant.compare(cancelled,start)<0||Temporal.Instant.compare(cancelled,cutoff)>=0)continue;
   const local=cancelled.toZonedDateTimeISO(client.timezone),date=local.toPlainDate().toString(),key=`${date}:${local.hour}`;counts.set(key,(counts.get(key)??0)+1);eligible++;
  }
  const next=response.next_cursor;if(next===null||next===''){complete=true;break;}
  if(next.length>2000||next===cursor||seenCursors.has(next)||page===199)throw new Error('Recharge cancellation pagination did not complete or advance');
  seenCursors.add(next);cursor=next;
 }
 if(!complete)throw new Error('Recharge cancellation pagination did not complete');
 const rows:Observation[]=[];
 for(const date of dates)for(let hour=0;hour<24;hour++){
  const interval=localHourInterval(date,hour,client.timezone);if(!interval||Temporal.Instant.compare(Temporal.Instant.from(interval.end),cutoff)>0)continue;
  rows.push({...observation(date,'subscriptionEvents','subscription_cancellations',counts.get(`${date}:${hour}`)??0,rechargeCancellationDefinition,rechargeCancellationPopulation,null,{},interval),quality:date===today?'partial':'complete'});
 }
 if(rows.reduce((sum,row)=>sum+(row.value??0),0)!==eligible)throw new Error('Recharge cancellation buckets do not reconcile to unique reported cancellation records');
 return sourceBatch(client,rows,through,[],'hourly');
}
