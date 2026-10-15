import {env} from '@avenue/runtime';
import type {AccessScope,Client,Connection} from '../analytics/contracts';
import {dayWindow,shiftDate,todayIn} from '../analytics/windows';
import {fingerprint} from '../reviews/build';
import {getStore} from '../server/access';
import {serverSecret} from '../server/secrets';
import type {Store} from '../server/store';
import {fetchKindSource} from '../sources/kind-fetch';
import {assertSourceActivation,validateRegisteredBatch,type RegisteredContract} from '../sources/registered-contract';
import {historicalHourlyProviders,hourlyHistoryWindow,planHistoricalHourlyJobs,supportsHourlyHistory} from './hourly-history';
import {DailyScheduler} from './scheduler';
import {pruneArchivedMaterializations,readRecentWritingCapture} from './archive-materialization-retention';
import {ShopifyRateLimitError} from '../sources/shopify-graphql';
import {retryPublication} from './publication-retry';
import {boundedRechargeContract,HistoryCapacityDeferral,recentRechargeHistoryDate,rechargeHistoryFits,validateBoundedRechargeHistory} from './bounded-recharge-history';

const STORAGE_SAFETY_BYTES=22000000000;
type HistoryBudget={maxJobs:number;deadline:number};
type HistoryResult={completed:string[];failed:{id:string;error:string}[];skipped?:string;storageBytes?:number;maintenance?:Awaited<ReturnType<typeof pruneArchivedMaterializations>>};
type EligibleSource={source:Connection;client:Client;contract:RegisteredContract};
type HistoryJob={id:string;sourceId:string;clientId:string;attempts:number;leaseUntil:string|null};
class CurrentSourceWorkDeferral extends Error{}
function requiredBudget(provider:string){return provider==='kind-recharge-cancellations'?180000:provider==='kind-triple-whale'?200000:['kind-meta-performance','kind-shopify-traffic'].includes(provider)?300000:provider==='kind-shopify-products'?90000:30000;}
function budgetFailure(error:unknown){
 // Only known transport/deadline failures qualify. Data and authorization
 // failures remain real failures even if their processing finished late.
 for(let depth=0;depth<4&&error instanceof Error;depth++,error=error.cause){
  if(/HTTP \d{3}|not configured|qualification|unregistered|registered|invalid|mismatch|reconcil|pagination|row limit|identity|filter/i.test(error.message))return false;
  if(error.name==='TimeoutError'||error.name==='AbortError'||['Source synchronization deadline reached','Source publication budget elapsed','Provider request timed out or could not be reached','Database request timed out'].includes(error.message))return true;
  const code=(error as Error&{code?:unknown}).code;
  if(typeof code==='string'&&['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN'].includes(code))return true;
 }
 return false;
}

async function currentSourcesDue(store:Store,scope:AccessScope){return !!await store.first("SELECT j.id FROM jobs j JOIN connections c ON c.id=j.sourceId AND c.organizationId=j.organizationId AND c.clientId=j.clientId WHERE j.organizationId=? AND j.clientId='kind-patches' AND c.enabled=1 AND j.id NOT LIKE '%:hourly-history:____-__-__' AND j.status IN ('pending','running') AND j.dueAt<=? LIMIT 1",scope.organizationId,new Date().toISOString());}

async function storageBytes(store:Store){
 const [pages,size,free]=await Promise.all([store.first<{page_count:number}>('PRAGMA page_count'),store.first<{page_size:number}>('PRAGMA page_size'),store.first<{freelist_count:number}>('PRAGMA freelist_count')]);
 if(!pages||!size||!free||!Number.isFinite(pages.page_count)||!Number.isFinite(size.page_size)||!Number.isFinite(free.freelist_count)||size.page_size<=0||pages.page_count<free.freelist_count)throw Error('Historical storage capacity unavailable');
 return (pages.page_count-free.freelist_count)*size.page_size;
}

/** Historical jobs have their own runner lease and claim only closed-day work.
 * At most two distinct providers download at once. Durable fact publication is
 * serialized to avoid multiplying the database's large write batches. */
export async function runHourlyHistoryBatch(store:Store,scope:AccessScope,budget:HistoryBudget):Promise<HistoryResult>{
 const out:HistoryResult={completed:[],failed:[]};
 if(!['admin','service'].includes(scope.role)||!scope.permittedClientIds.includes('kind-patches'))return out;
 if(await currentSourcesDue(store,scope))return {...out,skipped:'current-source-work'};
 const clients=await store.clients(scope.organizationId),eligible=new Map<string,EligibleSource>();
 for(const source of await store.connections(scope.organizationId,'kind-patches')){
  const client=clients.find(value=>value.id===source.clientId);
  if(!client||!source.enabled||!historicalHourlyProviders.has(source.provider)||!scope.permittedClientIds.includes(source.clientId))continue;
  try{const contract=assertSourceActivation(source,await store.qualification(scope.organizationId,source.id),client);if(supportsHourlyHistory(source.provider,contract))eligible.set(source.id,{source,client,contract});}catch{/* Invalid activations are never claimed. */}
 }
 if(!eligible.size)return out;
 const active=new Set<string>();let claimed=0,claimTail=Promise.resolve(),persistTail=Promise.resolve(),shopifyCooldownUntil=0;
 const claim=async()=>{
  const previous=claimTail;let release!:()=>void;claimTail=new Promise<void>(resolve=>{release=resolve;});await previous;
  try{
   if(claimed>=budget.maxJobs||Date.now()+30000>budget.deadline||out.skipped)return null;
   if(await currentSourcesDue(store,scope)){out.skipped='current-source-work';return null;}
   const storage=await storageBytes(store);out.storageBytes=storage;
   const limited=storage>=STORAGE_SAFETY_BYTES;
   const capacityEligible=[...eligible.values()].filter(value=>!limited||value.source.provider==='kind-recharge-cancellations'&&boundedRechargeContract(value.contract)&&rechargeHistoryFits(storage));
   if(limited&&!capacityEligible.length){out.skipped='storage-capacity';return null;}
   const available=capacityEligible.filter(value=>!active.has(value.source.provider)&&(!value.source.provider.startsWith('kind-shopify-')||Date.now()>=shopifyCooldownUntil)&&Date.now()+requiredBudget(value.source.provider)<=budget.deadline);
   if(!available.length)return null;
   const now=new Date().toISOString(),sourceIds=available.map(value=>value.source.id),today=todayIn(available[0].client.timezone,new Date(now));
   // Fill recent comparisons before older archives, including sources added
   // after the initial queue. Keep immutable due times and benchmark ordering
   // within each band; AppLovin retains its oldest-date priority in that band.
   const job=await store.first<HistoryJob>(`SELECT j.id,j.sourceId,j.clientId,j.attempts,j.leaseUntil FROM jobs j JOIN connections c ON c.id=j.sourceId AND c.organizationId=j.organizationId WHERE j.organizationId=? AND j.clientId='kind-patches' AND j.sourceId IN (${sourceIds.map(()=>'?').join(',')}) AND j.id LIKE '%:hourly-history:____-__-__' AND substr(j.id,-10)>=? AND substr(j.id,-10)<? AND (c.provider<>'kind-applovin' OR substr(j.id,-10)>=?) AND ((j.status='pending' AND j.dueAt<=?) OR (j.status='running' AND j.leaseUntil<?)) ORDER BY CASE WHEN substr(j.id,-10)>=? THEN 0 WHEN substr(j.id,-10)>=? THEN 1 ELSE 2 END,CASE WHEN c.provider='kind-applovin' THEN 0 ELSE 1 END,CASE WHEN c.provider='kind-applovin' THEN substr(j.id,-10) ELSE j.dueAt END,j.dueAt,j.id LIMIT 1`,scope.organizationId,...sourceIds,shiftDate(today,-30),today,shiftDate(today,-28),now,now,shiftDate(today,-7),shiftDate(today,-30));
   if(!job)return null;
   const window=hourlyHistoryWindow(eligible.get(job.sourceId)!.client.timezone),leaseUntil=new Date(Date.now()+900000).toISOString(),updated=await store.run("UPDATE jobs SET status='running',leaseUntil=?,attempts=attempts+1 WHERE id=? AND organizationId=? AND substr(id,-10)>=? AND substr(id,-10)<? AND ((status='pending' AND dueAt<=?) OR (status='running' AND leaseUntil<?))",leaseUntil,job.id,scope.organizationId,eligible.get(job.sourceId)!.source.provider==='kind-applovin'?shiftDate(window.today,-28):window.from,window.today,now,now);
   if(!updated.meta.changes)return null;
   const value=eligible.get(job.sourceId)!;active.add(value.source.provider);claimed++;return {job:{...job,attempts:job.attempts+1,leaseUntil},...value};
  }finally{release();}
 };
 const publish=async(work:()=>Promise<unknown>)=>{
  const previous=persistTail;let release!:()=>void;persistTail=new Promise<void>(resolve=>{release=resolve;});await previous;
  try{return await work();}finally{release();}
 };
 const worker=async()=>{
  for(;;){const capture=await claim();if(!capture)return;const {job,source,client,contract}=capture;let completing=false;
   try{
    const prefix=`${scope.organizationId}:${source.id}:hourly-history:`,date=job.id.startsWith(prefix)?job.id.slice(prefix.length):'',today=todayIn(client.timezone);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>=today||date<shiftDate(today,source.provider==='kind-applovin'?-28:-30))throw Error('Historical source window is invalid');
    const secret=serverSecret(source.secretRef);if(!secret)throw Error(`Server secret ${source.secretRef} is not configured`);if(!env.BUCKET)throw Error('Snapshot archive unavailable');
    const window={from:date,to:date},resumed=await readRecentWritingCapture(store,scope,source,client,window,{deadline:budget.deadline}),batch=resumed?.batch??await fetchKindSource(source,client,window,secret,fetch,budget.deadline);
    const smallRecharge=source.provider==='kind-recharge-cancellations'&&boundedRechargeContract(contract);
    if(smallRecharge)validateBoundedRechargeHistory(batch,contract,client,date);
    validateRegisteredBatch(batch,contract);
    if(!batch.complete||!batch.coverageThrough||Date.parse(batch.coverageThrough)<Date.parse(dayWindow(date,client.timezone).end)||batch.rows.some(row=>row.date!==date))throw Error('Historical capture did not cover the complete store day');
    const hash=resumed?.hash??await fingerprint(batch),key=`snapshots/${scope.organizationId}:${client.id}:${source.id}:${hash}.json`;
    if(!resumed)await env.BUCKET.put(key,JSON.stringify(batch),{httpMetadata:{contentType:'application/json'}});
    const capturedAt=resumed?.retrievedAt??new Date().toISOString();
    await publish(async()=>{
     const storage=await storageBytes(store);out.storageBytes=storage;
     const retained=hourlyHistoryWindow(client.timezone),retainedFrom=source.provider==='kind-applovin'?shiftDate(retained.today,-28):retained.from;
     if(date<retainedFrom){
      const auditId=`history-window-claimed:${job.id}:${retainedFrom}:${job.attempts}`;
      await store.run("INSERT INTO audit(id,organizationId,clientId,actorId,action,payload,createdAt) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE id=? AND organizationId=? AND status='running' AND attempts=? AND leaseUntil=?) ON CONFLICT(id) DO NOTHING",auditId,scope.organizationId,client.id,scope.actorId,'history.window.cancel_verified',JSON.stringify({jobId:job.id,sourceId:source.id,retainedFrom,originalAttempts:job.attempts,originalLeaseUntil:job.leaseUntil}),new Date().toISOString(),job.id,scope.organizationId,job.attempts,job.leaseUntil);
      await store.run("UPDATE jobs SET status='cancelled',leaseUntil=NULL WHERE id=? AND organizationId=? AND status='running' AND attempts=? AND leaseUntil=? AND EXISTS(SELECT 1 FROM audit WHERE id=? AND organizationId=? AND clientId=? AND action='history.window.cancel_verified' AND json_extract(payload,'$.jobId')=? AND json_extract(payload,'$.retainedFrom')=? AND json_extract(payload,'$.originalLeaseUntil')=?)",job.id,scope.organizationId,job.attempts,job.leaseUntil,auditId,scope.organizationId,client.id,job.id,retainedFrom,job.leaseUntil);
      throw Error('Historical day left the retained store window');
     }
     if(storage>=STORAGE_SAFETY_BYTES&&!(smallRecharge&&recentRechargeHistoryDate(date,today)&&rechargeHistoryFits(storage)))throw new HistoryCapacityDeferral('Historical storage capacity reserved for current ingestion');
     return store.persistBatch(scope.organizationId,source.id,batch,hash,capturedAt,window,{publicationDeadline:budget.deadline,...(['kind-shopify-traffic','kind-meta-performance'].includes(source.provider)?{factPageSize:500 as const,beforeFactPage:async()=>{if(await currentSourcesDue(store,scope))throw new CurrentSourceWorkDeferral('Current source work has priority');}}:{})});
    });
    completing=true;await retryPublication('history.complete',budget.deadline,()=>store.finish(job.id));out.completed.push(job.id);
   }catch(error){
    const message=error instanceof Error?error.message:'Historical capture failed';
    if(error instanceof CurrentSourceWorkDeferral){
     out.skipped='current-source-work';
     await store.run("UPDATE jobs SET status='pending',attempts=MAX(0,attempts-1),dueAt=?,error=NULL,leaseUntil=NULL WHERE id=? AND organizationId=? AND status='running' AND attempts=? AND leaseUntil=?",new Date(Date.now()+5*60000).toISOString(),job.id,scope.organizationId,job.attempts,job.leaseUntil);
     continue;
    }
    if(message==='Historical day left the retained store window'){out.skipped='retention-window';continue;}
    if(completing&&budgetFailure(error)){
     // A successful acknowledgment can commit before its response times out.
     // Verify that outcome before any generic retry could change it back.
     const durable=await store.first<{status:string}>('SELECT status FROM jobs WHERE id=? AND organizationId=?',job.id,scope.organizationId);
     if(durable?.status==='complete'){out.completed.push(job.id);continue;}
    }
    if(Date.now()>=budget.deadline&&budgetFailure(error)){
     out.skipped='budget';
     // Refund only this exact running claim. A late response must not clear a
     // newer lease, spend a failure attempt, or reopen an already complete job.
     await store.run("UPDATE jobs SET status='pending',attempts=MAX(0,attempts-1),dueAt=?,error=?,leaseUntil=NULL WHERE id=? AND organizationId=? AND status='running' AND attempts=? AND leaseUntil=?",new Date(Date.now()+5*60000).toISOString(),message,job.id,scope.organizationId,job.attempts,job.leaseUntil);
     continue;
    }else if(error instanceof HistoryCapacityDeferral){
     out.skipped='storage-capacity';
     await store.run("UPDATE jobs SET status='pending',attempts=MAX(0,attempts-1),dueAt=?,error=?,leaseUntil=NULL WHERE id=? AND organizationId=? AND status='running'",new Date(Date.now()+5*60000).toISOString(),message,job.id,scope.organizationId);
     continue;
    }else if(error instanceof ShopifyRateLimitError&&source.provider.startsWith('kind-shopify-')){
     const delay=Math.min(3600000,Math.max(60000,Number.isFinite(error.retryAfterMs)?error.retryAfterMs:60000));shopifyCooldownUntil=Math.max(shopifyCooldownUntil,Date.now()+delay);
     // Budget pressure defers valid dates, rather than spending their bounded
     // failure attempts or immediately claiming more work from the same bucket.
     await store.run("UPDATE jobs SET status='pending',attempts=MAX(0,attempts-1),dueAt=?,error=?,leaseUntil=NULL WHERE id=? AND organizationId=? AND status='running'",new Date(shopifyCooldownUntil).toISOString(),message,job.id,scope.organizationId);
    }else if(/HTTP (401|403)|not configured|qualification|Unregistered|Registered|window is invalid/.test(message))await store.finish(job.id,message);
    else await store.retry(job.id,job.attempts,message,new Date().toISOString());out.failed.push({id:job.id,error:message});
   }
   finally{active.delete(source.provider);}
  }
 };
 const workers=await Promise.allSettled([worker(),worker()]);
 // Keep the runner lease until every started worker has settled, including
 // when one database call fails before another provider capture completes.
 const rejected=workers.find(result=>result.status==='rejected');if(rejected?.status==='rejected')throw rejected.reason;
 return out;
}

export async function hourlyHistoryTick():Promise<HistoryResult>{
 const store=getStore(),organizationId=serverSecret('APP_ORGANIZATION_ID')||'avenue-z';
 const organization=await store.first<{initialized:number}>('SELECT initialized FROM organizations WHERE id=?',organizationId);if(!organization?.initialized)throw Error('Workspace must be initialized before historical jobs run');
 const scope:AccessScope={organizationId,actorId:'application-history-scheduler',role:'service',permittedClientIds:['kind-patches']};
 if(await currentSourcesDue(store,scope))return {skipped:'current-source-work',completed:[],failed:[]};
 const scheduler=new DailyScheduler(store),id=`${organizationId}:hourly-history`,token=await scheduler.acquire(id,new Date().toISOString(),900000);
 if(!token)return {skipped:'already-running',completed:[],failed:[]};
 try{
  if(await currentSourcesDue(store,scope))return {skipped:'current-source-work',completed:[],failed:[]};
  const started=Date.now();let maintenance:HistoryResult['maintenance'];
  if(await storageBytes(store)>=18000000000){
   const maintenanceStarted=Date.now();
   try{maintenance=await pruneArchivedMaterializations(store,scope,{maxSnapshots:8,maxRows:250000,deadline:started+180000,monthlyRetention:true});console.info('Historical archive maintenance',{ms:Date.now()-maintenanceStarted,...maintenance});}
   catch(error){console.warn('Historical archive maintenance deferred',{kind:error instanceof Error?error.name:'Unknown',ms:Date.now()-maintenanceStarted});}
  }
  await planHistoricalHourlyJobs(store,scope);const result=await runHourlyHistoryBatch(store,scope,{maxJobs:40,deadline:started+700000});return {...result,...maintenance?{maintenance}:{}};
 }
 finally{await scheduler.release(id,token);}
}
