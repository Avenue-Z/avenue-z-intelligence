import {env,runtimePlatform} from '@avenue/runtime';
import {getStore} from '../server/access';
import type {AccessScope,Client} from '../analytics/contracts';
import {todayIn,shiftDate,dayWindow} from '../analytics/windows';
import {assertSourceActivation,validateRegisteredBatch} from '../sources/registered-contract';
import {fetchGateway} from '../sources/gateway';
import {fetchKindBatches,fetchKindSource,kindSourceDates} from '../sources/kind-fetch';
import {closedSessionDatesToSkip} from './closed-session-dates';
import {planHistoricalHourlyJobs} from './hourly-history';
import {fingerprint,reviewPayload} from '../reviews/build';
import {queryClient} from '../analytics/query';
import {Temporal} from '@js-temporal/polyfill';
import {serverSecret} from '../server/secrets';
import {generateAIReview} from '../ai/server';
import type {ScheduledReviewLease} from '../server/store';
import {retryPublication} from './publication-retry';
import {AppLovinSettlingHourError} from '../sources/hourly-paid-media';
export {serverSecret} from '../server/secrets';
// Leave enough of the shared source-run budget for a bounded provider request
// (25 seconds) plus setup. Later jobs stay pending for the next native tick.
const MINIMUM_SOURCE_CLAIM_BUDGET_MS=30000;
// These large hourly feeds repair closed dates through durable history jobs.
// Their routine captures must not re-download comparison days before other
// current feeds get a turn in the shared native scheduler.
const INDEPENDENT_HISTORY_PROVIDERS=new Set(['kind-shopify-sales','kind-shopify-products','kind-shopify-traffic','kind-meta-performance','kind-applovin']);
// Native history planning belongs to the independent history cron, after its
// current-work guard. It must not delay or prevent a current source claim.
export async function enqueueDue(scope:AccessScope,forceClient?:string){const s=getStore(),now=new Date();for(const c of await s.connections(scope.organizationId)){if(!c.enabled||!scope.permittedClientIds.includes(c.clientId)||forceClient&&forceClient!==c.clientId)continue;const last=c.lastSuccess?Date.parse(c.lastSuccess):0;if(forceClient||Math.floor(now.getTime()/(c.pollMinutes*60000))>Math.floor(last/(c.pollMinutes*60000))){const bucket=forceClient?`manual:${crypto.randomUUID()}`:String(Math.floor(now.getTime()/(c.pollMinutes*60000)));await s.enqueue(scope.organizationId,c.clientId,c.id,bucket,now.toISOString());}}if(!forceClient&&runtimePlatform!=='vercel')await planHistoricalHourlyJobs(s,scope,now);}
export async function generateReview(scope:AccessScope,client:Client,date:string,job?:ScheduledReviewLease){return generateAIReview(scope,client.id,{from:date,to:date,mode:client.config.reviewMode,compare:'previous',view:'overview',market:'',stream:'',source:'',device:'',page:''},job);}
export async function runSyncBatch(scope:AccessScope,budget={maxJobs:7,deadline:Date.now()+110000}){const s=getStore(),clients=await s.clients(scope.organizationId),out:{completed:string[];failed:{id:string;error:string}[]}={completed:[],failed:[]};
  for(let n=0;n<budget.maxJobs&&Date.now()<budget.deadline;n++){
    const remaining=budget.deadline-Date.now();if(remaining<MINIMUM_SOURCE_CLAIM_BUDGET_MS||!scope.permittedClientIds.length)break;
    const now=new Date().toISOString(),next=await s.first<{provider:string}>(`SELECT c.provider FROM jobs j LEFT JOIN connections c ON c.id=j.sourceId AND c.organizationId=j.organizationId WHERE j.organizationId=? AND j.id NOT LIKE '%:hourly-history:____-__-__' AND j.clientId IN (${scope.permittedClientIds.map(()=>'?').join(',')}) AND ((j.status='pending' AND j.dueAt<=?) OR (j.status='running' AND j.leaseUntil<?)) ORDER BY CASE WHEN j.id LIKE '%:hourly-history:____-__-__' THEN 1 ELSE 0 END,j.dueAt LIMIT 1`,scope.organizationId,...scope.permittedClientIds,now,now);
    const required=next?.provider==='kind-recharge-cancellations'?180000:next?.provider==='kind-meta-performance'?500000:next?.provider==='kind-shopify-traffic'?400000:['kind-shopify-sales','kind-shopify-products','kind-shopify-funnels'].includes(next?.provider??'')?90000:MINIMUM_SOURCE_CLAIM_BUDGET_MS;
    // The provider lookup itself may wait behind publication. Reserve the
    // measured capture budget against the clock immediately before claiming.
    if(budget.deadline-Date.now()<required)break;
    const j=await s.claim(now,scope.organizationId,scope.permittedClientIds,900000,true);if(!j)break;if(!scope.permittedClientIds.includes(j.clientId)){await s.finish(j.id,'Source access denied');continue;}
    const historyPrefix=`${scope.organizationId}:${j.sourceId}:hourly-history:`,historyDate=String(j.id).startsWith(historyPrefix)?String(j.id).slice(historyPrefix.length):null;let currentPublished=false,completing=false;
    try{const source=(await s.connections(scope.organizationId,j.clientId)).find(c=>c.id===j.sourceId&&c.enabled),client=clients.find(c=>c.id===j.clientId);if(!source||!client)throw new Error('Source is disabled or unavailable');const qualified=assertSourceActivation(source,await s.qualification(scope.organizationId,source.id),client);const secret=serverSecret(source.secretRef);if(!secret)throw new Error(`Server secret ${source.secretRef} is not configured`);
      const date=todayIn(client.timezone);if(historyDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(historyDate)||historyDate>=date||historyDate<shiftDate(date,source.provider==='kind-applovin'?-28:-61)||!['kind-shopify-sales','kind-shopify-products','kind-shopify-traffic','kind-meta-performance','kind-applovin'].includes(source.provider)))throw Error('Historical source window is invalid');
      const window=historyDate?{from:historyDate,to:historyDate}:client.id==='kind-patches'&&INDEPENDENT_HISTORY_PROVIDERS.has(source.provider)?{from:date,to:date}:{from:shiftDate(date,source.provider==='kind-shopify-hourly'?-1:source.lastSuccess?-6:-59),to:date};if(!env.BUCKET)throw new Error('Snapshot archive unavailable');let coverage:string|null=null;
      const skipClosedDates=runtimePlatform==='vercel'&&!historyDate&&!j.id.includes(':manual:')&&source.lastSuccess&&['kind-shopify-hourly','kind-shopify-funnels'].includes(source.provider)?await closedSessionDatesToSkip(s,scope.organizationId,client,source,qualified,kindSourceDates(source,client,window),new Date()):undefined;
      if(skipClosedDates?.size)console.info('Reusing settled session captures',{provider:source.provider,closedDays:skipClosedDates.size});
      const batches=historyDate?(async function*(){yield {batch:await fetchKindSource(source,client,window,secret,fetch,budget.deadline),window};})():source.provider==='gateway'?(async function*(){yield {batch:await fetchGateway(source,client,window,secret,fetch,budget.deadline),window};})():fetchKindBatches(source,client,window,secret,fetch,budget.deadline,skipClosedDates);
      for await(const {batch,window:actualWindow} of batches){
        validateRegisteredBatch(batch,qualified);const hash=await fingerprint(batch),key=`snapshots/${scope.organizationId}:${client.id}:${source.id}:${hash}.json`;
        await env.BUCKET.put(key,JSON.stringify(batch),{httpMetadata:{contentType:'application/json'}});
        const capturedAt=new Date().toISOString();
        await s.persistBatch(scope.organizationId,source.id,batch,hash,capturedAt,actualWindow,{publicationDeadline:budget.deadline});
        if(batch.coverageThrough&&(!coverage||Date.parse(batch.coverageThrough)>Date.parse(coverage)))coverage=batch.coverageThrough;
        // Once today's complete query is durably archived and published, its
        // freshness is independent of optional historical repairs that follow.
        if(!historyDate&&batch.complete&&actualWindow.to===date&&batch.coverageThrough&&Date.parse(batch.coverageThrough)>Date.parse(dayWindow(date,client.timezone).start)){
          const publishedAt=new Date().toISOString();
          await retryPublication('source.freshness',budget.deadline,()=>s.run('UPDATE connections SET lastSuccess=?,coverageThrough=?,error=NULL WHERE id=? AND organizationId=?',publishedAt,batch.coverageThrough,source.id,scope.organizationId));currentPublished=true;
        }
      }
      if(!historyDate){const publishedAt=new Date().toISOString();await retryPublication('source.freshness',budget.deadline,()=>s.run('UPDATE connections SET lastSuccess=?,coverageThrough=?,error=NULL WHERE id=? AND organizationId=?',publishedAt,coverage,source.id,scope.organizationId));}
      completing=true;
      const completed=await retryPublication('source.complete',budget.deadline,()=>s.run("UPDATE jobs SET status='complete',error=NULL,leaseUntil=NULL WHERE id=? AND organizationId=? AND status='running' AND attempts=? AND leaseUntil=?",j.id,scope.organizationId,j.attempts,j.leaseUntil));
      if(completed.meta.changes)out.completed.push(j.id);
      else if((await s.first<{status:string}>('SELECT status FROM jobs WHERE id=? AND organizationId=?',j.id,scope.organizationId))?.status==='complete')out.completed.push(j.id);
    }catch(e){const error=(e as Error).message;
      if(e instanceof Error&&error==='Source publication budget elapsed'&&Date.now()>=budget.deadline){
        // An exhausted scheduler budget is not a provider-health failure.
        // Refund only this claim, without reopening completion or clearing a
        // newer lease. Previously confirmed source freshness remains intact.
        await s.run("UPDATE jobs SET status='pending',attempts=MAX(0,attempts-1),dueAt=?,error=?,leaseUntil=NULL WHERE id=? AND organizationId=? AND status='running' AND attempts=? AND leaseUntil=?",new Date(Date.now()+5*60000).toISOString(),error,j.id,scope.organizationId,j.attempts,j.leaseUntil);
        continue;
      }
      if(completing){
        const durable=await s.first<{status:string;attempts:number;leaseUntil:string|null}>('SELECT status,attempts,leaseUntil FROM jobs WHERE id=? AND organizationId=?',j.id,scope.organizationId);
        if(durable?.status==='complete'){
          if(e instanceof Error&&(e.name==='TimeoutError'||error==='Database request timed out'))out.completed.push(j.id);
          else out.failed.push({id:j.id,error});
          continue;
        }
        if(durable?.status!=='running'||durable.attempts!==j.attempts||durable.leaseUntil!==j.leaseUntil)continue;
      }
      if(e instanceof AppLovinSettlingHourError&&!historyDate&&next?.provider==='kind-applovin'){
        // No reconciled new-day interval exists yet. Preserve the previous
        // capture and health until a real capture succeeds; provider lag must
        // not consume the bounded attempts reserved for actual failures.
        await s.run("UPDATE jobs SET status='pending',attempts=?,dueAt=?,error=?,leaseUntil=NULL WHERE id=? AND organizationId=? AND status='running'",Math.max(0,j.attempts-1),new Date(Date.now()+e.retryAfterMs).toISOString(),error,j.id,scope.organizationId);out.failed.push({id:j.id,error});continue;
      }
      if(!historyDate&&!currentPublished)await s.run('UPDATE connections SET error=? WHERE id=? AND organizationId=?',error,j.sourceId,scope.organizationId);if(/HTTP (401|403)|not configured|disabled or unavailable|qualification|Unregistered|Registered/.test(error))await s.finish(j.id,error);else await s.retry(j.id,j.attempts,error,new Date().toISOString());out.failed.push({id:j.id,error});}
  }
  return out;
}
