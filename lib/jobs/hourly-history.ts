import type {AccessScope} from '../analytics/contracts';
import {dayWindow,shiftDate,todayIn} from '../analytics/windows';
import type {Store} from '../server/store';
import {assertSourceActivation} from '../sources/registered-contract';

const providers=new Set(['kind-shopify-sales','kind-shopify-products','kind-shopify-traffic','kind-meta-performance','kind-applovin']);
export type HourlyHistoryPlan={eligibleSources:number;missingDays:number;queued:number};

function datesByPriority(today:string,days:number){
 const offsets=[1,7,28,30,2,8,29,31,...Array.from({length:days},(_,index)=>index+1)];
 return [...new Set(offsets.filter(offset=>offset<=days).map(offset=>shiftDate(today,-offset)))];
}

/** Queue durable repairs without reading an attribution export or changing source
 * health. The first fact lookup uses observations' snapshot/date/rowKey index.
 * Repeated ticks and concurrent planners cannot reset an existing job. */
export async function planHistoricalHourlyJobs(store:Store,scope:AccessScope,now=new Date()):Promise<HourlyHistoryPlan>{
 const result:HourlyHistoryPlan={eligibleSources:0,missingDays:0,queued:0};
 if(!['admin','service'].includes(scope.role)||!scope.permittedClientIds.includes('kind-patches'))return result;
 const client=(await store.clients(scope.organizationId)).find(value=>value.id==='kind-patches');
 if(!client)return result;
 const today=todayIn(client.timezone,now),jobs:{id:string;clientId:string;sourceId:string;dueAt:string}[]=[];
 for(const source of await store.connections(scope.organizationId,client.id)){
  if(!source.enabled||!providers.has(source.provider)||!scope.permittedClientIds.includes(source.clientId))continue;
  let contract;
  try{contract=assertSourceActivation(source,await store.qualification(scope.organizationId,source.id),client);}catch{continue;}
  if(!contract.hourlyGrain||!contract.profiles.every(profile=>profile.hourly))continue;
  result.eligibleSources++;
  const dates=datesByPriority(today,source.provider==='kind-applovin'?28:61),firstFacts=await store.all<{date:string;payload:string|null;complete:number;coverageThrough:string|null}>(
   "SELECT c.date,s.complete,s.coverageThrough,(SELECT o.payload FROM observations o WHERE o.snapshotId=c.snapshotId AND o.date=c.date ORDER BY o.rowKey LIMIT 1) AS payload FROM current_snapshots c JOIN snapshots s ON s.id=c.snapshotId AND s.organizationId=c.organizationId AND s.clientId=c.clientId AND s.sourceId=c.sourceId AND s.status='ready' WHERE c.organizationId=? AND c.clientId=? AND c.sourceId=? AND c.date BETWEEN ? AND ?",
   scope.organizationId,client.id,source.id,shiftDate(today,-dates.length),shiftDate(today,-1)
  );
  const byDate=new Map(firstFacts.map(value=>[value.date,value]));
  for(const [rank,date] of dates.entries()){
   const captured=byDate.get(date);let fact;try{fact=JSON.parse(captured?.payload??'null');}catch{/* Invalid legacy facts need a qualified replacement. */}
   const profile=fact&&contract.profiles.find(value=>value.dataset===fact.dataset&&value.metric===fact.metric),paidProvider=source.provider==='kind-meta-performance'||source.provider==='kind-applovin';
   if(captured?.complete&&captured.coverageThrough&&Date.parse(captured.coverageThrough)>=Date.parse(dayWindow(date,client.timezone).end)&&fact?.start&&fact?.end&&Number.isFinite(Date.parse(fact.start))&&Date.parse(fact.end)>Date.parse(fact.start)&&(!paidProvider||profile?.definition===fact.definition))continue;
   result.missingDays++;
   jobs.push({id:`${scope.organizationId}:${source.id}:hourly-history:${date}`,clientId:client.id,sourceId:source.id,dueAt:new Date(now.getTime()-(61-rank)).toISOString()});
  }
 }
 if(jobs.length){
  const inserted=await store.run("INSERT INTO jobs(id,organizationId,clientId,sourceId,status,attempts,dueAt) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.clientId'),json_extract(value,'$.sourceId'),'pending',0,json_extract(value,'$.dueAt') FROM json_each(?) WHERE 1 ON CONFLICT(id) DO NOTHING",scope.organizationId,JSON.stringify(jobs));
  result.queued=inserted.meta.changes;
 }
 return result;
}
