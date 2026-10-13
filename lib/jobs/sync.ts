import {env} from '@avenue/runtime';
import {getStore} from '../server/access';
import type {AccessScope,Client} from '../analytics/contracts';
import {todayIn,shiftDate,dayWindow} from '../analytics/windows';
import {assertSourceActivation,validateRegisteredBatch} from '../sources/registered-contract';
import {fetchGateway} from '../sources/gateway';
import {fetchKindBatches,fetchKindSource} from '../sources/kind-fetch';
import {planHistoricalHourlyJobs} from './hourly-history';
import {fingerprint,reviewPayload} from '../reviews/build';
import {queryClient} from '../analytics/query';
import {Temporal} from '@js-temporal/polyfill';
import {serverSecret} from '../server/secrets';
import {generateAIReview} from '../ai/server';
import type {ScheduledReviewLease} from '../server/store';
export {serverSecret} from '../server/secrets';
// Leave enough of the shared source-run budget for a bounded provider request
// (25 seconds) plus setup. Later jobs stay pending for the next native tick.
const MINIMUM_SOURCE_CLAIM_BUDGET_MS=30000;
// These large hourly feeds repair closed dates through durable history jobs.
// Their routine captures must not re-download comparison days before other
// current feeds get a turn in the shared native scheduler.
const INDEPENDENT_HISTORY_PROVIDERS=new Set(['kind-shopify-sales','kind-shopify-products','kind-shopify-traffic','kind-meta-performance','kind-applovin']);
export async function enqueueDue(scope:AccessScope,forceClient?:string){const s=getStore(),now=new Date();for(const c of await s.connections(scope.organizationId)){if(!c.enabled||!scope.permittedClientIds.includes(c.clientId)||forceClient&&forceClient!==c.clientId)continue;const last=c.lastSuccess?Date.parse(c.lastSuccess):0;if(forceClient||Math.floor(now.getTime()/(c.pollMinutes*60000))>Math.floor(last/(c.pollMinutes*60000))){const bucket=forceClient?`manual:${crypto.randomUUID()}`:String(Math.floor(now.getTime()/(c.pollMinutes*60000)));await s.enqueue(scope.organizationId,c.clientId,c.id,bucket,now.toISOString());}}if(!forceClient)await planHistoricalHourlyJobs(s,scope,now);}
export async function generateReview(scope:AccessScope,client:Client,date:string,job?:ScheduledReviewLease){return generateAIReview(scope,client.id,{from:date,to:date,mode:client.config.reviewMode,compare:'previous',view:'overview',market:'',stream:'',source:'',device:'',page:''},job);}
export async function runSyncBatch(scope:AccessScope,budget={maxJobs:7,deadline:Date.now()+110000}){const s=getStore(),clients=await s.clients(scope.organizationId),out:{completed:string[];failed:{id:string;error:string}[]}={completed:[],failed:[]};
  for(let n=0;n<budget.maxJobs&&Date.now()<budget.deadline;n++){
    const remaining=budget.deadline-Date.now();if(remaining<MINIMUM_SOURCE_CLAIM_BUDGET_MS||!scope.permittedClientIds.length)break;
    const now=new Date().toISOString(),next=await s.first<{provider:string}>(`SELECT c.provider FROM jobs j LEFT JOIN connections c ON c.id=j.sourceId AND c.organizationId=j.organizationId WHERE j.organizationId=? AND j.id NOT LIKE '%:hourly-history:____-__-__' AND j.clientId IN (${scope.permittedClientIds.map(()=>'?').join(',')}) AND ((j.status='pending' AND j.dueAt<=?) OR (j.status='running' AND j.leaseUntil<?)) ORDER BY CASE WHEN j.id LIKE '%:hourly-history:____-__-__' THEN 1 ELSE 0 END,j.dueAt LIMIT 1`,scope.organizationId,...scope.permittedClientIds,now,now);
    const required=['kind-meta-performance','kind-shopify-traffic'].includes(next?.provider??'')?200000:['kind-shopify-sales','kind-shopify-products','kind-shopify-funnels'].includes(next?.provider??'')?90000:MINIMUM_SOURCE_CLAIM_BUDGET_MS;
    if(remaining<required)break;
    const j=await s.claim(now,scope.organizationId,scope.permittedClientIds,900000,true);if(!j)break;if(!scope.permittedClientIds.includes(j.clientId)){await s.finish(j.id,'Source access denied');continue;}
    const historyPrefix=`${scope.organizationId}:${j.sourceId}:hourly-history:`,historyDate=String(j.id).startsWith(historyPrefix)?String(j.id).slice(historyPrefix.length):null;let currentPublished=false;
    try{const source=(await s.connections(scope.organizationId,j.clientId)).find(c=>c.id===j.sourceId&&c.enabled),client=clients.find(c=>c.id===j.clientId);if(!source||!client)throw new Error('Source is disabled or unavailable');const qualified=assertSourceActivation(source,await s.qualification(scope.organizationId,source.id),client);const secret=serverSecret(source.secretRef);if(!secret)throw new Error(`Server secret ${source.secretRef} is not configured`);
      const date=todayIn(client.timezone);if(historyDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(historyDate)||historyDate>=date||historyDate<shiftDate(date,source.provider==='kind-applovin'?-28:-61)||!['kind-shopify-sales','kind-shopify-products','kind-shopify-traffic','kind-meta-performance','kind-applovin'].includes(source.provider)))throw Error('Historical source window is invalid');
      const window=historyDate?{from:historyDate,to:historyDate}:client.id==='kind-patches'&&INDEPENDENT_HISTORY_PROVIDERS.has(source.provider)?{from:date,to:date}:{from:shiftDate(date,source.provider==='kind-shopify-hourly'?-1:source.lastSuccess?-6:-59),to:date};if(!env.BUCKET)throw new Error('Snapshot archive unavailable');let coverage:string|null=null;
      const batches=historyDate?(async function*(){yield {batch:await fetchKindSource(source,client,window,secret,fetch,budget.deadline),window};})():source.provider==='gateway'?(async function*(){yield {batch:await fetchGateway(source,client,window,secret,fetch,budget.deadline),window};})():fetchKindBatches(source,client,window,secret,fetch,budget.deadline);
      for await(const {batch,window:actualWindow} of batches){
        validateRegisteredBatch(batch,qualified);const hash=await fingerprint(batch),key=`snapshots/${scope.organizationId}:${client.id}:${source.id}:${hash}.json`;
        await env.BUCKET.put(key,JSON.stringify(batch),{httpMetadata:{contentType:'application/json'}});await s.persistBatch(scope.organizationId,source.id,batch,hash,new Date().toISOString(),actualWindow);
        if(batch.coverageThrough&&(!coverage||Date.parse(batch.coverageThrough)>Date.parse(coverage)))coverage=batch.coverageThrough;
        // Once today's complete query is durably archived and published, its
        // freshness is independent of optional historical repairs that follow.
        if(!historyDate&&batch.complete&&actualWindow.to===date&&batch.coverageThrough&&Date.parse(batch.coverageThrough)>Date.parse(dayWindow(date,client.timezone).start)){
          await s.run('UPDATE connections SET lastSuccess=?,coverageThrough=?,error=NULL WHERE id=? AND organizationId=?',new Date().toISOString(),batch.coverageThrough,source.id,scope.organizationId);currentPublished=true;
        }
      }
      if(!historyDate)await s.run('UPDATE connections SET lastSuccess=?,coverageThrough=?,error=NULL WHERE id=? AND organizationId=?',new Date().toISOString(),coverage,source.id,scope.organizationId);await s.finish(j.id);out.completed.push(j.id);
    }catch(e){const error=(e as Error).message;if(!historyDate&&!currentPublished)await s.run('UPDATE connections SET error=? WHERE id=? AND organizationId=?',error,j.sourceId,scope.organizationId);if(/HTTP (401|403)|not configured|disabled or unavailable|qualification|Unregistered|Registered/.test(error))await s.finish(j.id,error);else await s.retry(j.id,j.attempts,error,new Date().toISOString());out.failed.push({id:j.id,error});}
  }
  return out;
}
