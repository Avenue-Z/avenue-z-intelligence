import {env,runtimePlatform} from '@avenue/runtime';
import {getStore} from '../server/access';
import type {AccessScope,Client,SourceBatch} from '../analytics/contracts';
import {todayIn,shiftDate,dayWindow} from '../analytics/windows';
import {assertSourceActivation,validateRegisteredBatch} from '../sources/registered-contract';
import {fetchGateway} from '../sources/gateway';
import {isBeamProvider} from '../sources/beam-fetch';
import {isAutobrushProvider} from '../sources/autobrush-fetch';
import {fetchAutobrushCaptures} from './autobrush-captures';
const nativeBrandProvider=(provider:string)=>isBeamProvider(provider)||isAutobrushProvider(provider);
import {fetchBeamCaptures} from './beam-captures';
import {fetchKindBatches,fetchKindSource,kindSourceDates} from '../sources/kind-fetch';
import {retainedRechargeCreations} from '../server/recharge-creation-retention';
import {hourlySessionCutoff} from '../sources/kind-patches';
import {closedSessionDatesToSkip} from './closed-session-dates';
import {planHistoricalHourlyJobs} from './hourly-history';
import {fingerprint} from '../reviews/build';
import {serverSecret} from '../server/secrets';
import {generateAIReview} from '../ai/server';
import type {Store,ScheduledReviewLease} from '../server/store';
import {retryPublication} from './publication-retry';
import {AppLovinSettlingHourError} from '../sources/hourly-paid-media';
import {readRecentWritingCapture} from './archive-materialization-retention';
export {serverSecret} from '../server/secrets';
// Leave enough of the shared source-run budget for a bounded provider request
// (25 seconds) plus setup. Later jobs stay pending for the next native tick.
const MINIMUM_SOURCE_CLAIM_BUDGET_MS=30000;
type SourceCapture={batch:SourceBatch;window:{from:string;to:string};resumedCapture?:{hash:string;retrievedAt:string}};
// These large hourly feeds repair closed dates through durable history jobs.
// Their routine captures must not re-download comparison days before other
// current feeds get a turn in the shared native scheduler.
const INDEPENDENT_HISTORY_PROVIDERS=new Set(['kind-shopify-sales','kind-shopify-products','kind-shopify-traffic','kind-meta-performance','kind-applovin']);
const HOURLY_KIND_PROVIDERS=new Set([...INDEPENDENT_HISTORY_PROVIDERS,'kind-triple-whale','kind-triple-whale-summary','kind-triple-whale-diagnostics','kind-shopify-hourly','kind-shopify-funnels','kind-recharge-cancellations']);
// Native history planning belongs to the independent history cron, after its
// current-work guard. It must not delay or prevent a current source claim.
export async function enqueueDue(scope:AccessScope,forceClient?:string,store?:Store){
 const s=store??getStore(),now=new Date(),cutoffs=new Map<string,number|null>();
 for(const c of await s.connections(scope.organizationId)){
  if(!c.enabled||!scope.permittedClientIds.includes(c.clientId)||forceClient&&forceClient!==c.clientId)continue;
  const last=c.lastSuccess?Date.parse(c.lastSuccess):0,timestampDue=Math.floor(now.getTime()/(c.pollMinutes*60000))>Math.floor(last/(c.pollMinutes*60000));let coverageDue=false;
  // Publication may cross into the next poll bucket while its capture still
  // ends at the prior hour. Keep that completed store hour eligible for polling.
  if(!forceClient&&!timestampDue&&(c.clientId==='kind-patches'&&HOURLY_KIND_PROVIDERS.has(c.provider)||c.clientId==='beam'&&c.provider.startsWith('beam-shopify-')||c.clientId==='autobrush'&&c.provider.startsWith('autobrush-shopify-'))){
   if(!cutoffs.has(c.clientId)){const client=await s.first<{timezone:string}>('SELECT timezone FROM clients WHERE organizationId=? AND id=?',scope.organizationId,c.clientId);cutoffs.set(c.clientId,client?Date.parse(hourlySessionCutoff(client.timezone,now).through):null);}
   const cutoff=cutoffs.get(c.clientId);coverageDue=cutoff!=null&&Date.parse(c.coverageThrough??'')<cutoff;
  }
  if(forceClient||timestampDue||coverageDue){const bucket=forceClient?`manual:${crypto.randomUUID()}`:String(Math.floor(now.getTime()/(c.pollMinutes*60000)));await s.enqueue(scope.organizationId,c.clientId,c.id,bucket,now.toISOString());}
 }
 if(!forceClient&&runtimePlatform!=='vercel')await planHistoricalHourlyJobs(s,scope,now);
}
export async function generateReview(scope:AccessScope,client:Client,date:string,job?:ScheduledReviewLease){return generateAIReview(scope,client.id,{from:date,to:date,mode:client.config.reviewMode,compare:'previous',view:'overview',market:'',stream:'',source:'',device:'',page:''},job);}
export async function runSyncBatch(scope:AccessScope,budget:{maxJobs:number;deadline:number;includeHistory?:boolean}={maxJobs:7,deadline:Date.now()+110000},store?:Store){const s=store??getStore(),clients=await s.clients(scope.organizationId),out:{completed:string[];failed:{id:string;error:string}[]}={completed:[],failed:[]};
  for(let n=0;n<budget.maxJobs&&Date.now()<budget.deadline;n++){
    const remaining=budget.deadline-Date.now();if(remaining<MINIMUM_SOURCE_CLAIM_BUDGET_MS||!scope.permittedClientIds.length)break;
    const now=new Date().toISOString(),next=await s.first<{provider:string}>(`SELECT c.provider FROM jobs j LEFT JOIN connections c ON c.id=j.sourceId AND c.organizationId=j.organizationId WHERE j.organizationId=? ${budget.includeHistory?'':"AND j.id NOT LIKE '%:hourly-history:____-__-__'"} AND j.clientId IN (${scope.permittedClientIds.map(()=>'?').join(',')}) AND ((j.status='pending' AND j.dueAt<=?) OR (j.status='running' AND j.leaseUntil<?)) ORDER BY CASE WHEN j.id LIKE '%:hourly-history:____-__-__' THEN 1 ELSE 0 END,j.dueAt LIMIT 1`,scope.organizationId,...scope.permittedClientIds,now,now);
    const required=next?.provider==='kind-recharge-cancellations'?180000:next?.provider==='kind-meta-performance'?500000:['kind-shopify-traffic','beam-shopify-traffic','autobrush-shopify-traffic'].includes(next?.provider??'')?400000:['kind-shopify-sales','kind-shopify-products','kind-shopify-funnels','beam-shopify-sales','beam-shopify-products','beam-shopify-markets','beam-motion','beam-intelligems','autobrush-shopify-sales','autobrush-shopify-products','autobrush-shopify-sessions','autobrush-shopify-markets','autobrush-motion','autobrush-intelligems'].includes(next?.provider??'')?90000:MINIMUM_SOURCE_CLAIM_BUDGET_MS;
    // The provider lookup itself may wait behind publication. Reserve the
    // measured capture budget against the clock immediately before claiming.
    if(budget.deadline-Date.now()<required)break;
    const j=await s.claim(now,scope.organizationId,scope.permittedClientIds,900000,!budget.includeHistory);if(!j)break;if(!scope.permittedClientIds.includes(j.clientId)){await s.finish(j.id,'Source access denied');continue;}
    const historyPrefix=`${scope.organizationId}:${j.sourceId}:hourly-history:`,historyDate=String(j.id).startsWith(historyPrefix)?String(j.id).slice(historyPrefix.length):null;let currentPublished=false,completing=false,provider=next?.provider??'unknown',storagePhase:'facts'|'freshness'|'resume-catchup'|'completion'|null=null;
    try{const source=(await s.connections(scope.organizationId,j.clientId)).find(c=>c.id===j.sourceId&&c.enabled),client=clients.find(c=>c.id===j.clientId);if(!source||!client)throw new Error('Source is disabled or unavailable');provider=source.provider;const providerDateSource=client.id==='autobrush'&&['autobrush-motion','autobrush-intelligems'].includes(source.provider);const qualified=assertSourceActivation(source,await s.qualification(scope.organizationId,source.id),client);const secret=serverSecret(source.secretRef);if(!secret)throw new Error(`Server secret ${source.secretRef} is not configured`);
      const date=todayIn(client.timezone);if(historyDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(historyDate)||historyDate>=date||historyDate<shiftDate(date,nativeBrandProvider(source.provider)?-29:source.provider==='kind-applovin'?-28:-61)||!nativeBrandProvider(source.provider)&&!['kind-shopify-sales','kind-shopify-products','kind-shopify-traffic','kind-meta-performance','kind-applovin'].includes(source.provider)))throw Error('Historical source window is invalid');
      const window=historyDate?{from:historyDate,to:historyDate}:nativeBrandProvider(source.provider)?{from:shiftDate(date,-1),to:date}:client.id==='kind-patches'&&INDEPENDENT_HISTORY_PROVIDERS.has(source.provider)?{from:date,to:date}:{from:shiftDate(date,source.provider==='kind-shopify-hourly'?-1:source.lastSuccess?-6:-59),to:date};if(!env.BUCKET)throw new Error('Snapshot archive unavailable');let coverage:string|null=null;
      let currentAnchor:string|null=null;
      const closedRepairs=runtimePlatform==='vercel'&&!historyDate&&!j.id.includes(':manual:')&&source.lastSuccess?{deadline:null as number|null}:undefined;
      const skipClosedDates=runtimePlatform==='vercel'&&!historyDate&&!j.id.includes(':manual:')&&source.lastSuccess&&['kind-shopify-hourly','kind-shopify-funnels'].includes(source.provider)?await closedSessionDatesToSkip(s,scope.organizationId,client,source,qualified,kindSourceDates(source,client,window),new Date()):undefined;
      if(skipClosedDates?.size)console.info('Reusing settled session captures',{provider:source.provider,closedDays:skipClosedDates.size});
      const retainedCreations=source.provider==='kind-recharge-cancellations'?await retainedRechargeCreations(s,scope,client,window,budget.deadline):[];
      const resumed=runtimePlatform==='vercel'&&!nativeBrandProvider(source.provider)?await readRecentWritingCapture(s,scope,source,client,window,{deadline:budget.deadline}):null;
      let replayedCapture=!!resumed;
      const batches:AsyncIterable<SourceCapture>=isAutobrushProvider(source.provider)?fetchAutobrushCaptures(source,client,window,s,scope,serverSecret,fetch,budget.deadline):isBeamProvider(source.provider)?fetchBeamCaptures(source,client,window,s,scope,serverSecret,fetch,budget.deadline):resumed?(async function*(){yield {batch:resumed.batch,window};})():historyDate?(async function*(){yield {batch:await fetchKindSource(source,client,window,secret,fetch,budget.deadline,undefined,retainedCreations),window};})():source.provider==='gateway'?(async function*(){yield {batch:await fetchGateway(source,client,window,secret,fetch,budget.deadline),window};})():fetchKindBatches(source,client,window,secret,fetch,budget.deadline,skipClosedDates,closedRepairs,retainedCreations);
      for await(const captured of batches){
        const {batch,window:actualWindow}=captured,frozen=captured.resumedCapture??resumed;
        replayedCapture ||= !!frozen;
        // The generator selects the mandatory anchor after optional reuse reads;
        // use its actual date if those reads crossed a completed-hour boundary.
        currentAnchor??=actualWindow.to;
        validateRegisteredBatch(batch,qualified);
        if(providerDateSource&&(batch.clientId!==client.id||batch.grain!=='daily'||!batch.complete||batch.nextCursor||batch.coverageThrough!==null||actualWindow.from!==actualWindow.to||batch.rows.some(row=>row.date!==actualWindow.to||row.start||row.end||row.coverageThrough!==null)))throw Error('Autobrush provider-date capture is incomplete or invalid');
        const hash=frozen?.hash??await fingerprint(batch),key=`snapshots/${scope.organizationId}:${client.id}:${source.id}:${hash}.json`;
        if(!frozen)await env.BUCKET.put(key,JSON.stringify(batch),{httpMetadata:{contentType:'application/json'}});
        const capturedAt=frozen?.retrievedAt??new Date().toISOString();
        storagePhase='facts';
        await s.persistBatch(scope.organizationId,source.id,batch,hash,capturedAt,actualWindow,{publicationDeadline:budget.deadline,...(runtimePlatform==='vercel'?{factPageSize:100 as const}:['kind-shopify-traffic','kind-meta-performance','beam-shopify-traffic','autobrush-shopify-traffic'].includes(source.provider)?{factPageSize:500 as const}:{})});
        storagePhase=null;
        if(batch.coverageThrough&&(!coverage||Date.parse(batch.coverageThrough)>Date.parse(coverage)))coverage=batch.coverageThrough;
        // Once today's complete query is durably archived and published, its
        // freshness is independent of optional historical repairs that follow.
        // Autobrush's daily provider reports acknowledge retrieval/publication
        // success while retaining unknown store-hour coverage.
        const providerDateAnchor=providerDateSource&&actualWindow.to===todayIn(client.timezone);
        if(!historyDate&&batch.complete&&actualWindow.to===currentAnchor&&(providerDateAnchor||batch.coverageThrough&&Date.parse(batch.coverageThrough)>Date.parse(dayWindow(currentAnchor,client.timezone).start))){
          const publishedAt=new Date().toISOString();
          storagePhase='freshness';
          await retryPublication('source.freshness',budget.deadline,()=>s.run('UPDATE connections SET lastSuccess=?,coverageThrough=?,error=NULL WHERE id=? AND organizationId=?',publishedAt,batch.coverageThrough,source.id,scope.organizationId));currentPublished=true;storagePhase=null;
          if(closedRepairs)closedRepairs.deadline??=Math.min(Date.now()+60000,budget.deadline-MINIMUM_SOURCE_CLAIM_BUDGET_MS);
        }
      }
      if(!historyDate&&providerDateSource&&!currentPublished)throw Error('Autobrush current provider-date capture was not published');
      if(!historyDate){const publishedAt=new Date().toISOString();storagePhase='freshness';await retryPublication('source.freshness',budget.deadline,()=>s.run('UPDATE connections SET lastSuccess=?,coverageThrough=?,error=NULL WHERE id=? AND organizationId=?',publishedAt,coverage,source.id,scope.organizationId));storagePhase=null;}
      if(replayedCapture&&!historyDate&&coverage&&Date.parse(coverage)<Date.parse(hourlySessionCutoff(client.timezone).through)){
        // Completing an older immutable capture does not satisfy this poll
        // bucket. Keep the exact owned job eligible: enqueueDue cannot reopen
        // its immutable id after completion, even when coverage is still due.
        storagePhase='resume-catchup';
        await retryPublication('source.resume.catchup',budget.deadline,()=>s.run("UPDATE jobs SET status='pending',attempts=MAX(0,attempts-1),dueAt=?,error=NULL,leaseUntil=NULL WHERE id=? AND organizationId=? AND status='running' AND attempts=? AND leaseUntil=?",new Date(Date.now()+5*60000).toISOString(),j.id,scope.organizationId,j.attempts,j.leaseUntil));
        continue;
      }
      completing=true;storagePhase='completion';
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
      if(!historyDate&&storagePhase&&e instanceof Error&&(e.name==='TimeoutError'||error==='Database request timed out')){
        // Only database publication and acknowledgment calls set this phase.
        // Provider fetch/validation failures keep their bounded failure policy.
        // Preserve immutable staged facts and refund only this exact claim;
        // repeated storage stalls must not permanently close its hourly bucket.
        console.warn('Source storage publication deferred',{provider,phase:storagePhase,kind:'TimeoutError'});
        await s.run("UPDATE jobs SET status='pending',attempts=MAX(0,attempts-1),dueAt=?,error=?,leaseUntil=NULL WHERE id=? AND organizationId=? AND status='running' AND attempts=? AND leaseUntil=?",new Date(Date.now()+5*60000).toISOString(),error,j.id,scope.organizationId,j.attempts,j.leaseUntil);
        continue;
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
