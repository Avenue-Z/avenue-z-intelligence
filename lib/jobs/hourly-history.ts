import type {AccessScope} from '../analytics/contracts';
import {dayWindow,shiftDate,todayIn} from '../analytics/windows';
import type {Store} from '../server/store';
import {assertSourceActivation,type RegisteredContract} from '../sources/registered-contract';

export const historicalHourlyProviders=new Set(['kind-shopify-sales','kind-shopify-products','kind-shopify-traffic','kind-meta-performance','kind-applovin','kind-recharge-cancellations','kind-triple-whale']);
const rechargeCohortMetrics=['new_subscriptions','same_day_subscription_cancellations'];
const marketMetrics=['revenue','orders','new_orders'];
export function supportsHourlyHistory(provider:string,contract:RegisteredContract){return contract.hourlyGrain&&contract.profiles.every(profile=>profile.hourly)&&(provider!=='kind-recharge-cancellations'||rechargeCohortMetrics.every(metric=>contract.profiles.some(profile=>profile.dataset==='subscriptionEvents'&&profile.metric===metric)))&&(provider!=='kind-triple-whale'||marketMetrics.every(metric=>contract.profiles.some(profile=>profile.dataset==='markets'&&profile.metric===metric&&profile.dimensions.length===1&&profile.dimensions[0]==='market')));}
function matchesProfile(fact:unknown,contract:RegisteredContract){if(!fact||typeof fact!=='object')return false;const value=fact as {dataset:string;metric:string;start?:string;end?:string;definition:string;population:string;currency:string|null},profile=contract.profiles.find(profile=>profile.dataset===value.dataset&&profile.metric===value.metric);return !!value.start&&!!value.end&&Number.isFinite(Date.parse(value.start))&&Date.parse(value.end)>Date.parse(value.start)&&Date.parse(value.end)-Date.parse(value.start)<=7200000&&!!profile?.hourly&&profile.definition===value.definition&&profile.population===value.population&&profile.currency===value.currency;}
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
 const today=todayIn(client.timezone,now),jobs:{id:string;clientId:string;sourceId:string;dueAt:string}[]=[],capturedJobIds:string[]=[];
 for(const source of await store.connections(scope.organizationId,client.id)){
  if(!source.enabled||!historicalHourlyProviders.has(source.provider)||!scope.permittedClientIds.includes(source.clientId))continue;
  let contract;
  try{contract=assertSourceActivation(source,await store.qualification(scope.organizationId,source.id),client);}catch{continue;}
  if(!supportsHourlyHistory(source.provider,contract))continue;
  result.eligibleSources++;
  const cohortMetrics=source.provider==='kind-recharge-cancellations'?rechargeCohortMetrics:source.provider==='kind-triple-whale'?marketMetrics:[],cohortDataset=source.provider==='kind-triple-whale'?'markets':'subscriptionEvents';
  const cohortSelect=cohortMetrics.map((metric,index)=>`,(SELECT o.payload FROM observations o WHERE o.snapshotId=c.snapshotId AND o.date=c.date AND json_extract(o.payload,'$.dataset')='${cohortDataset}' AND json_extract(o.payload,'$.metric')='${metric}' ORDER BY o.rowKey LIMIT 1) AS cohort${index}`).join(''),dates=datesByPriority(today,source.provider==='kind-applovin'?28:61),firstFacts=await store.all<{date:string;payload:string|null;complete:number;coverageThrough:string|null;cohort0?:string|null;cohort1?:string|null;cohort2?:string|null}>(
   `SELECT c.date,s.complete,s.coverageThrough,(SELECT o.payload FROM observations o WHERE o.snapshotId=c.snapshotId AND o.date=c.date ORDER BY o.rowKey LIMIT 1) AS payload${cohortSelect} FROM current_snapshots c JOIN snapshots s ON s.id=c.snapshotId AND s.organizationId=c.organizationId AND s.clientId=c.clientId AND s.sourceId=c.sourceId AND s.status='ready' WHERE c.organizationId=? AND c.clientId=? AND c.sourceId=? AND c.date BETWEEN ? AND ?`,
   scope.organizationId,client.id,source.id,shiftDate(today,-dates.length),shiftDate(today,-1)
  );
  const byDate=new Map(firstFacts.map(value=>[value.date,value]));
  for(const [rank,date] of dates.entries()){
   const captured=byDate.get(date);let fact;try{fact=JSON.parse(captured?.payload??'null');}catch{/* Invalid legacy facts need a qualified replacement. */}
   const cohortComplete=[captured?.cohort0,captured?.cohort1,captured?.cohort2].slice(0,cohortMetrics.length).every(payload=>{try{const row=JSON.parse(payload??'null');return matchesProfile(row,contract)&&(source.provider!=='kind-triple-whale'||row.date===date&&row.quality==='complete'&&typeof row.value==='number'&&Number.isFinite(row.value)&&/^(?:[A-Z]{2}|Unknown)$/.test(row.dimensions?.market??'')&&Object.keys(row.dimensions).length===1);}catch{return false;}});
   if(captured?.complete&&captured.coverageThrough&&Date.parse(captured.coverageThrough)>=Date.parse(dayWindow(date,client.timezone).end)&&matchesProfile(fact,contract)&&cohortComplete){
    capturedJobIds.push(`${scope.organizationId}:${source.id}:hourly-history:${date}`);continue;
   }
   result.missingDays++;
   jobs.push({id:`${scope.organizationId}:${source.id}:hourly-history:${date}`,clientId:client.id,sourceId:source.id,dueAt:new Date(now.getTime()-(61-rank)).toISOString()});
  }
 }
 // A routine qualified capture can satisfy a previously queued repair. Only
 // pending jobs whose actual closed hourly facts now exist may complete here;
 // active leases and failed/completed audit records remain untouched.
 if(capturedJobIds.length)await store.run("UPDATE jobs SET status='complete',error=NULL,leaseUntil=NULL WHERE organizationId=? AND clientId=? AND status='pending' AND id IN (SELECT value FROM json_each(?))",scope.organizationId,client.id,JSON.stringify(capturedJobIds));
 if(jobs.length){
  const inserted=await store.run("INSERT INTO jobs(id,organizationId,clientId,sourceId,status,attempts,dueAt) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.clientId'),json_extract(value,'$.sourceId'),'pending',0,json_extract(value,'$.dueAt') FROM json_each(?) WHERE 1 ON CONFLICT(id) DO NOTHING",scope.organizationId,JSON.stringify(jobs));
  result.queued=inserted.meta.changes;
 }
 return result;
}
