import {env} from 'cloudflare:workers';
import {getStore} from '../server/access';
import type {AccessScope,Client} from '../analytics/contracts';
import {todayIn,shiftDate} from '../analytics/windows';
import {assertSourceActivation,validateRegisteredBatch} from '../sources/registered-contract';
import {fetchGateway} from '../sources/gateway';
import {fetchKindBatches} from '../sources/kind-fetch';
import {fingerprint,reviewPayload} from '../reviews/build';
import {queryClient} from '../analytics/query';
import {Temporal} from '@js-temporal/polyfill';
import {serverSecret} from '../server/secrets';
import {generateAIReview} from '../ai/server';
export {serverSecret} from '../server/secrets';
export async function enqueueDue(scope:AccessScope,forceClient?:string){const s=getStore(),now=new Date();for(const c of await s.connections(scope.organizationId)){if(!c.enabled||!scope.permittedClientIds.includes(c.clientId)||forceClient&&forceClient!==c.clientId)continue;const last=c.lastSuccess?Date.parse(c.lastSuccess):0;if(forceClient||Math.floor(now.getTime()/(c.pollMinutes*60000))>Math.floor(last/(c.pollMinutes*60000))){const bucket=forceClient?`manual:${crypto.randomUUID()}`:String(Math.floor(now.getTime()/(c.pollMinutes*60000)));await s.enqueue(scope.organizationId,c.clientId,c.id,bucket,now.toISOString());}}}
export async function generateReview(scope:AccessScope,client:Client,date:string){return generateAIReview(scope,client.id,{from:date,to:date,mode:client.config.reviewMode,compare:'previous',view:'overview',market:'',stream:'',source:'',device:'',page:''});}
export async function runSyncBatch(scope:AccessScope,budget={maxJobs:7,deadline:Date.now()+110000}){const s=getStore(),clients=await s.clients(scope.organizationId),out:{completed:string[];failed:{id:string;error:string}[]}={completed:[],failed:[]};
  for(let n=0;n<budget.maxJobs&&Date.now()<budget.deadline;n++){const j=await s.claim(new Date().toISOString(),scope.organizationId,scope.permittedClientIds);if(!j)break;if(!scope.permittedClientIds.includes(j.clientId)){await s.finish(j.id,'Source access denied');continue;}
    try{const source=(await s.connections(scope.organizationId,j.clientId)).find(c=>c.id===j.sourceId&&c.enabled),client=clients.find(c=>c.id===j.clientId);if(!source||!client)throw new Error('Source is disabled or unavailable');const qualified=assertSourceActivation(source,await s.qualification(scope.organizationId,source.id),client);const secret=serverSecret(source.secretRef);if(!secret)throw new Error(`Server secret ${source.secretRef} is not configured`);
      const date=todayIn(client.timezone),window={from:shiftDate(date,source.lastSuccess?-6:-59),to:date};if(!env.BUCKET)throw new Error('Snapshot archive unavailable');let coverage:string|null=null;
      const batches=source.provider==='gateway'?(async function*(){yield {batch:await fetchGateway(source,client,window,secret,fetch,budget.deadline),window};})():fetchKindBatches(source,client,window,secret,fetch,budget.deadline);
      for await(const {batch,window:actualWindow} of batches){validateRegisteredBatch(batch,qualified);const hash=await fingerprint(batch),key=`snapshots/${scope.organizationId}:${client.id}:${source.id}:${hash}.json`;await env.BUCKET.put(key,JSON.stringify(batch),{httpMetadata:{contentType:'application/json'}});await s.persistBatch(scope.organizationId,source.id,batch,hash,new Date().toISOString(),actualWindow);coverage=batch.coverageThrough;}
      await s.run('UPDATE connections SET lastSuccess=?,coverageThrough=?,error=NULL WHERE id=? AND organizationId=?',new Date().toISOString(),coverage,source.id,scope.organizationId);await s.finish(j.id);out.completed.push(j.id);
    }catch(e){const error=(e as Error).message;await s.run('UPDATE connections SET error=? WHERE id=? AND organizationId=?',error,j.sourceId,scope.organizationId);if(/HTTP (401|403)|not configured|disabled or unavailable|qualification|Unregistered|Registered/.test(error))await s.finish(j.id,error);else await s.retry(j.id,j.attempts,error,new Date().toISOString());out.failed.push({id:j.id,error});}
  }
  return out;
}
