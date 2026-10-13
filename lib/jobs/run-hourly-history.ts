import {env} from '@avenue/runtime';
import type {AccessScope,Client,Connection} from '../analytics/contracts';
import {dayWindow,shiftDate,todayIn} from '../analytics/windows';
import {fingerprint} from '../reviews/build';
import {getStore} from '../server/access';
import {serverSecret} from '../server/secrets';
import type {Store} from '../server/store';
import {fetchKindSource} from '../sources/kind-fetch';
import {assertSourceActivation,validateRegisteredBatch,type RegisteredContract} from '../sources/registered-contract';
import {historicalHourlyProviders,planHistoricalHourlyJobs} from './hourly-history';
import {DailyScheduler} from './scheduler';
import {pruneArchivedMaterializations} from './archive-materialization-retention';
import {ShopifyRateLimitError} from '../sources/shopify-graphql';
import {retryPublication} from './publication-retry';

const STORAGE_SAFETY_BYTES=22000000000;
type HistoryBudget={maxJobs:number;deadline:number};
type HistoryResult={completed:string[];failed:{id:string;error:string}[];skipped?:string;storageBytes?:number;maintenance?:Awaited<ReturnType<typeof pruneArchivedMaterializations>>};
type EligibleSource={source:Connection;client:Client;contract:RegisteredContract};
type HistoryJob={id:string;sourceId:string;clientId:string;attempts:number};
function requiredBudget(provider:string){return ['kind-meta-performance','kind-shopify-traffic'].includes(provider)?300000:provider==='kind-shopify-products'?90000:30000;}

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
 const clients=await store.clients(scope.organizationId),eligible=new Map<string,EligibleSource>();
 for(const source of await store.connections(scope.organizationId,'kind-patches')){
  const client=clients.find(value=>value.id===source.clientId);
  if(!client||!source.enabled||!historicalHourlyProviders.has(source.provider)||!scope.permittedClientIds.includes(source.clientId))continue;
  try{const contract=assertSourceActivation(source,await store.qualification(scope.organizationId,source.id),client);if(contract.hourlyGrain&&contract.profiles.every(profile=>profile.hourly))eligible.set(source.id,{source,client,contract});}catch{/* Invalid activations are never claimed. */}
 }
 if(!eligible.size)return out;
 const active=new Set<string>();let claimed=0,claimTail=Promise.resolve(),persistTail=Promise.resolve(),shopifyCooldownUntil=0;
 const claim=async()=>{
  const previous=claimTail;let release!:()=>void;claimTail=new Promise<void>(resolve=>{release=resolve;});await previous;
  try{
   if(claimed>=budget.maxJobs||Date.now()+30000>budget.deadline||out.skipped)return null;
   const storage=await storageBytes(store);out.storageBytes=storage;
   if(storage>=STORAGE_SAFETY_BYTES){out.skipped='storage-capacity';return null;}
   const available=[...eligible.values()].filter(value=>!active.has(value.source.provider)&&(!value.source.provider.startsWith('kind-shopify-')||Date.now()>=shopifyCooldownUntil)&&Date.now()+requiredBudget(value.source.provider)<=budget.deadline);
   if(!available.length)return null;
   const now=new Date().toISOString(),sourceIds=available.map(value=>value.source.id);
   // AppLovin's oldest allowed dates can expire during a long initial backfill.
   // Capture them first; other providers retain comparison-day priority.
   const job=await store.first<HistoryJob>(`SELECT j.id,j.sourceId,j.clientId,j.attempts FROM jobs j JOIN connections c ON c.id=j.sourceId AND c.organizationId=j.organizationId WHERE j.organizationId=? AND j.clientId='kind-patches' AND j.sourceId IN (${sourceIds.map(()=>'?').join(',')}) AND j.id LIKE '%:hourly-history:____-__-__' AND ((j.status='pending' AND j.dueAt<=?) OR (j.status='running' AND j.leaseUntil<?)) ORDER BY CASE WHEN c.provider='kind-applovin' THEN 0 ELSE 1 END,CASE WHEN c.provider='kind-applovin' THEN substr(j.id,-10) ELSE j.dueAt END,j.dueAt,j.id LIMIT 1`,scope.organizationId,...sourceIds,now,now);
   if(!job)return null;
   const leaseUntil=new Date(Date.now()+900000).toISOString(),updated=await store.run("UPDATE jobs SET status='running',leaseUntil=?,attempts=attempts+1 WHERE id=? AND organizationId=? AND ((status='pending' AND dueAt<=?) OR (status='running' AND leaseUntil<?))",leaseUntil,job.id,scope.organizationId,now,now);
   if(!updated.meta.changes)return null;
   const value=eligible.get(job.sourceId)!;active.add(value.source.provider);claimed++;return {job:{...job,attempts:job.attempts+1},...value};
  }finally{release();}
 };
 const publish=async(work:()=>Promise<unknown>)=>{
  const previous=persistTail;let release!:()=>void;persistTail=new Promise<void>(resolve=>{release=resolve;});await previous;
  try{return await work();}finally{release();}
 };
 const worker=async()=>{
  for(;;){const capture=await claim();if(!capture)return;const {job,source,client,contract}=capture;
   try{
    const prefix=`${scope.organizationId}:${source.id}:hourly-history:`,date=job.id.startsWith(prefix)?job.id.slice(prefix.length):'',today=todayIn(client.timezone);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>=today||date<shiftDate(today,source.provider==='kind-applovin'?-28:-61))throw Error('Historical source window is invalid');
    const secret=serverSecret(source.secretRef);if(!secret)throw Error(`Server secret ${source.secretRef} is not configured`);if(!env.BUCKET)throw Error('Snapshot archive unavailable');
    const window={from:date,to:date},batch=await fetchKindSource(source,client,window,secret,fetch,budget.deadline);
    validateRegisteredBatch(batch,contract);
    if(!batch.complete||!batch.coverageThrough||Date.parse(batch.coverageThrough)<Date.parse(dayWindow(date,client.timezone).end)||batch.rows.some(row=>row.date!==date))throw Error('Historical capture did not cover the complete store day');
    const hash=await fingerprint(batch),key=`snapshots/${scope.organizationId}:${client.id}:${source.id}:${hash}.json`;
    await env.BUCKET.put(key,JSON.stringify(batch),{httpMetadata:{contentType:'application/json'}});
    const capturedAt=new Date().toISOString();
    await publish(()=>retryPublication('history.capture',budget.deadline,()=>store.persistBatch(scope.organizationId,source.id,batch,hash,capturedAt,window)));
    await retryPublication('history.complete',budget.deadline,()=>store.finish(job.id));out.completed.push(job.id);
   }catch(error){
    const message=error instanceof Error?error.message:'Historical capture failed';
    if(error instanceof ShopifyRateLimitError&&source.provider.startsWith('kind-shopify-')){
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
 const scope:AccessScope={organizationId,actorId:'application-history-scheduler',role:'service',permittedClientIds:['kind-patches']},scheduler=new DailyScheduler(store),id=`${organizationId}:hourly-history`,token=await scheduler.acquire(id,new Date().toISOString(),900000);
 if(!token)return {skipped:'already-running',completed:[],failed:[]};
 try{
  const started=Date.now();let maintenance:HistoryResult['maintenance'];
  if(await storageBytes(store)>=18000000000){
   const maintenanceStarted=Date.now();
   try{maintenance=await pruneArchivedMaterializations(store,scope,{maxSnapshots:8,maxRows:250000,deadline:started+180000});console.info('Historical archive maintenance',{ms:Date.now()-maintenanceStarted,...maintenance});}
   catch(error){console.warn('Historical archive maintenance deferred',{kind:error instanceof Error?error.name:'Unknown',ms:Date.now()-maintenanceStarted});}
  }
  await planHistoricalHourlyJobs(store,scope);const result=await runHourlyHistoryBatch(store,scope,{maxJobs:40,deadline:started+700000});return {...result,...maintenance?{maintenance}:{}};
 }
 finally{await scheduler.release(id,token);}
}
