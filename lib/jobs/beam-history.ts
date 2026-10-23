import type {AccessScope} from '../analytics/contracts';
import type {Store} from '../server/store';
import {todayIn,shiftDate,dayWindow} from '../analytics/windows';
import {isBeamProvider} from '../sources/beam-sources';
import {assertSourceActivation} from '../sources/registered-contract';

const RECOVERY_COOLDOWN_MS=60*60000;
type FailedHistoryJob={id:string;attempts:number;dueAt:string;error:string|null};
function transientFailure(error:string|null){
 if(!error||/\b(?:auth(?:entication|orization)?|unauthorized|forbidden|config(?:uration)?|qualifi(?:cation|ed)|validation|schema|invalid|malformed|unregistered|mismatch|credentials?|tokens?|secrets?|expired|revoked|permissions?|syntax)\b/i.test(error))return false;
 const http=[...error.matchAll(/\bHTTP\s+(\d{3})\b/gi)].map(match=>Number(match[1]));
 if(http.some(status=>status<500&&status!==408&&status!==429))return false;
 return error==='Source synchronization deadline reached'||error==='Provider rate limited; retry after its cooldown'||http.some(status=>status===408||status===429||status>=500&&status<=599)||/\b(?:timed out|timeout|fetch failed|network (?:request failed|error|failure|failed|unavailable)|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up)\b/i.test(error);
}

/** Only complete, published days satisfy history. Exact failed repairs may
 * restart one hour after their stored dueAt when the failure is transient and
 * source qualification is still current. The last error remains until success. */
export async function planBeamHistory(store:Store,scope:AccessScope,now=new Date()){
 if(!scope.permittedClientIds.includes('beam')||!['admin','service'].includes(scope.role))return 0;
 const client=(await store.clients(scope.organizationId)).find(value=>value.id==='beam');if(!client)return 0;
 const today=todayIn(client.timezone,now),from=shiftDate(today,-29),sources=(await store.connections(scope.organizationId,'beam')).filter(source=>source.enabled&&isBeamProvider(source.provider));
 const pointers=await store.all<{sourceId:string;date:string;complete:number;coverageThrough:string|null;retrievedAt:string}>("SELECT p.sourceId,p.date,s.complete,s.coverageThrough,s.retrievedAt FROM current_snapshots p JOIN snapshots s ON s.id=p.snapshotId AND s.status='ready' WHERE p.organizationId=? AND p.clientId='beam' AND p.date>=? AND p.date<?",scope.organizationId,from,today);
 const failed=await store.all<FailedHistoryJob>("SELECT id,attempts,dueAt,error FROM jobs WHERE organizationId=? AND clientId='beam' AND status='failed' AND id=organizationId||':'||sourceId||':hourly-history:'||substr(id,-10) AND substr(id,-10)>=? AND substr(id,-10)<?",scope.organizationId,from,today);
 const failedById=new Map(failed.map(job=>[job.id,job])),qualifiedSources=new Map<string,{version:number}|null>();
 const priority=[shiftDate(today,-1),shiftDate(today,-7),...Array.from({length:29},(_,index)=>shiftDate(today,-index-1))],dates=[...new Set(priority)];let queued=0;
 for(const date of dates)for(const source of sources){
  const day=pointers.find(pointer=>pointer.sourceId===source.id&&pointer.date===date),end=Date.parse(dayWindow(date,client.timezone).end);
  const complete=day&&day.complete&&(source.provider.startsWith('beam-shopify-')?Date.parse(day.coverageThrough??'')>=end:Date.parse(day.retrievedAt)>=end);
  if(complete)continue;
  const id=`${scope.organizationId}:${source.id}:hourly-history:${date}`,job=failedById.get(id),dueAt=new Date(now.getTime()+queued).toISOString();
  if(job&&Number.isFinite(Date.parse(job.dueAt))&&now.getTime()-Date.parse(job.dueAt)>=RECOVERY_COOLDOWN_MS&&transientFailure(job.error)){
   let qualified=qualifiedSources.get(source.id);
   if(qualified===undefined){
    const record=await store.qualification(scope.organizationId,source.id);qualified=null;
    try{assertSourceActivation(source,record,client);qualified={version:record.version};}catch{/* Permanent activation failures need a reviewed qualification. */}
    qualifiedSources.set(source.id,qualified);
   }
   if(qualified)await store.run("UPDATE jobs SET status='pending',attempts=0,dueAt=?,leaseUntil=NULL WHERE id=? AND organizationId=? AND clientId='beam' AND sourceId=? AND status='failed' AND attempts=? AND dueAt=? AND error=? AND EXISTS(SELECT 1 FROM connections c JOIN clients cl ON cl.organizationId=c.organizationId AND cl.id=c.clientId JOIN qualifications q ON q.organizationId=c.organizationId AND q.sourceId=c.id WHERE c.organizationId=jobs.organizationId AND c.id=jobs.sourceId AND c.clientId='beam' AND c.enabled=1 AND c.provider=? AND c.version=? AND cl.version=? AND q.version=? AND q.connectionVersion=c.version AND q.clientVersion=cl.version AND q.version=(SELECT MAX(latest.version) FROM qualifications latest WHERE latest.organizationId=c.organizationId AND latest.sourceId=c.id))",dueAt,id,scope.organizationId,source.id,job.attempts,job.dueAt,job.error,source.provider,source.version,client.version,qualified.version);
  }
  await store.enqueue(scope.organizationId,'beam',source.id,`hourly-history:${date}`,dueAt);queued++;
 }
 await store.run("UPDATE jobs SET status='cancelled',error='Outside rolling 30-day detail retention' WHERE organizationId=? AND clientId='beam' AND status='pending' AND id LIKE '%:hourly-history:____-__-__' AND substr(id,-10)<?",scope.organizationId,from);
 return queued;
}

