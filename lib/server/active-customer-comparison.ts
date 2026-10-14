import type {ActiveCustomerComparison,Client,Observation} from '../analytics/contracts';
import {activeCustomerBaselineHour,rawActiveCustomerSnapshot,validActiveCustomerComparison} from '../analytics/active-customer-comparison';
import {assertSourceActivation} from '../sources/registered-contract';
import type {Store} from './store';
type Gate={provider:string;enabled:number;sourceVersion:number;id:string;name:string;slug:string;timezone:string;currency:string;color:string;config:string;version:number;connectionVersion:number;clientVersion:number;payload:string};
/** Optional evidence from retained immutable counts, never a historical API read. */
export async function readActiveCustomerComparison(store:Store,org:string,clientId:string,current:Observation,warmDeadline?:number):Promise<ActiveCustomerComparison|undefined>{
 if(clientId!=='kind-patches'||!rawActiveCustomerSnapshot(current))return;
 const deadline=Math.min(Date.now()+5000,warmDeadline??Infinity);if(Date.now()>=deadline)return;let expired=false,timer:ReturnType<typeof setTimeout>|undefined;
 const active=()=>!expired&&Date.now()<deadline;
 const load=async()=>{
  const gate=await store.first<Gate>(`SELECT c.provider,c.enabled,c.version AS sourceVersion,cl.id,cl.name,cl.slug,cl.timezone,cl.currency,cl.color,cl.config,cl.version,q.connectionVersion,q.clientVersion,q.payload FROM connections c JOIN clients cl ON cl.organizationId=c.organizationId AND cl.id=c.clientId JOIN qualifications q ON q.organizationId=c.organizationId AND q.clientId=c.clientId AND q.sourceId=c.id WHERE c.organizationId=? AND c.clientId=? AND c.id=? AND q.version=(SELECT MAX(version) FROM qualifications WHERE organizationId=? AND sourceId=?) LIMIT 1`,org,clientId,current.sourceId,org,current.sourceId);
  if(!active()||!gate||gate.provider!=='kind-recharge'||!gate.enabled)return;
  const client:Client={...gate,config:JSON.parse(gate.config)},contract=assertSourceActivation({version:gate.sourceVersion},{connectionVersion:gate.connectionVersion,clientVersion:gate.clientVersion,payload:JSON.parse(gate.payload)},client),profile=contract.profiles.find(value=>value.dataset===current.dataset&&value.metric===current.metric);
  if(!profile||profile.hourly||profile.definition!==current.definition||profile.population!==current.population||profile.currency!==current.currency||JSON.stringify([...profile.dimensions].sort())!==JSON.stringify(Object.keys(current.dimensions).sort()))return;
  const hour=activeCustomerBaselineHour(current,gate.timezone);if(hour.currentDate!==current.date||!active())return;
  const prefix=`${org}:${clientId}:${current.sourceId}:`,upper=`${org}:${clientId}:${current.sourceId};`,key=JSON.stringify([current.dataset,current.metric,current.start,current.end,Object.entries(current.dimensions).sort()]);
  const candidates=await store.all<{id:string;retrievedAt:string;coverageThrough:string;payload:string|null}>(`WITH candidates AS MATERIALIZED (SELECT id,retrievedAt,coverageThrough FROM snapshots WHERE id>=? AND id<? AND organizationId=? AND clientId=? AND sourceId=? AND status='ready' AND complete=1 AND julianday(coverageThrough)>=julianday(?) AND julianday(coverageThrough)<julianday(?) ORDER BY ABS(julianday(coverageThrough)-julianday(?)),retrievedAt DESC LIMIT 8) SELECT c.id,c.retrievedAt,c.coverageThrough,o.payload FROM candidates c LEFT JOIN observations o ON o.snapshotId=c.id AND o.date=? AND o.rowKey=? ORDER BY ABS(julianday(c.coverageThrough)-julianday(?)),c.retrievedAt DESC`,prefix,upper,org,clientId,current.sourceId,hour.start,hour.end,hour.target,hour.date,key,hour.target);
  if(!active())return;
  for(const candidate of candidates){
   if(!candidate.payload)continue;let row:unknown;try{row=JSON.parse(candidate.payload);}catch{continue;}
   if(!rawActiveCustomerSnapshot(row)||row.date!==hour.date||row.sourceId!==current.sourceId||row.retrievedAt!==candidate.retrievedAt||row.coverageThrough!==candidate.coverageThrough)continue;
   const delta=current.value-row.value,comparison:ActiveCustomerComparison={baseline:{value:row.value,asOf:row.coverageThrough,retrievedAt:row.retrievedAt,snapshotId:candidate.id},delta,relativeChange:row.value?delta/row.value:null,alignment:'same-store-hour'};
   if(validActiveCustomerComparison(comparison,current,gate.timezone,prefix))return comparison;
  }
 };
 try{return await Promise.race([load().catch(()=>undefined),new Promise<undefined>(resolve=>{timer=setTimeout(()=>{expired=true;resolve(undefined);},Math.max(0,deadline-Date.now()));})]);}finally{if(timer)clearTimeout(timer);}
}
