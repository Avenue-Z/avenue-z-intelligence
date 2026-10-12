import {env} from '@avenue/runtime';
import {getStore} from '../server/access';
import {serverSecret} from '../server/secrets';
import type {AccessScope,Connection} from '../analytics/contracts';
import {todayIn,shiftDate} from '../analytics/windows';
import {fingerprint} from '../reviews/build';
import {sourceDefinition,kindQualification} from './kind-patches';
import {fetchKindBatches} from './kind-fetch';
import {requireQualifiedSource,validateRegisteredBatch} from './registered-contract';
export async function connectKindSource(scope:AccessScope,clientId:string,provider:string){
 if(scope.role!=='admin'||!scope.permittedClientIds.includes(clientId))throw new Error('Administrator access required');
 const def=sourceDefinition(provider,clientId),s=getStore(),secret=serverSecret('SOURCE_KIND_PATCHES_SCRIPT');if(!secret)throw new Error('Secure Kind Patches source configuration is not available');
 let client=(await s.clients(scope.organizationId)).find(c=>c.id===clientId);if(!client)throw new Error('Client unavailable');
 if(!client.config.spendChannels.includes('applovin')){const config={...client.config,spendChannels:[...client.config.spendChannels,'applovin']};const update=await s.run('UPDATE clients SET config=?,version=version+1 WHERE id=? AND organizationId=? AND version=?',JSON.stringify(config),client.id,scope.organizationId,client.version);if(!update.meta.changes)throw new Error('Client changed; reload before connecting');client={...client,config,version:client.version+1};await s.audit(scope.organizationId,client.id,scope.actorId,'client.spend_scope_updated',{channels:config.spendChannels});}
 const id=`${scope.organizationId}:${clientId}:${def.provider}`,old=(await s.connections(scope.organizationId,clientId)).find(c=>c.id===id);if(old?.enabled&&old.lastSuccess)return {connected:true,alreadyConnected:true};
 await s.run('INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,version) VALUES(?,?,?,?,?,?,?,?,0,1) ON CONFLICT(id) DO NOTHING',id,scope.organizationId,clientId,def.name,def.provider,def.endpoint,'SOURCE_KIND_PATCHES_SCRIPT',def.pollMinutes);
 const source=(await s.connections(scope.organizationId,clientId)).find(c=>c.id===id)!;
 try{
  const to=todayIn(client.timezone),deadline=Date.now()+180000;let count=0,coverageThrough:string|null=null,q:any;
  if(!env.BUCKET)throw new Error('Snapshot archive unavailable');
  for await(const {batch,window} of fetchKindBatches(source,client,{from:shiftDate(to,-59),to},secret,fetch,deadline)){
   const contract=requireQualifiedSource(kindQualification(batch,def.provider),client);validateRegisteredBatch(batch,contract);q=contract;
   const hash=await fingerprint(batch),now=new Date().toISOString();await env.BUCKET.put(`snapshots/${scope.organizationId}:${client.id}:${source.id}:${hash}.json`,JSON.stringify(batch),{httpMetadata:{contentType:'application/json'}});await s.persistBatch(scope.organizationId,source.id,batch,hash,now,window);count+=batch.rows.length;coverageThrough=batch.coverageThrough;
  }
  if(!q||!coverageThrough)throw new Error('Provider returned no qualified snapshots');
  await s.saveQualification(scope.organizationId,client.id,source.id,source.version,client.version,q,scope.actorId);const now=new Date().toISOString();
  await s.run('UPDATE connections SET enabled=1,lastSuccess=?,coverageThrough=?,error=NULL WHERE id=? AND organizationId=?',now,coverageThrough,id,scope.organizationId);
  await s.audit(scope.organizationId,client.id,scope.actorId,'source.connected',{id,provider:def.provider,rows:count,coverageThrough});
  return {connected:true,rows:count};
 }catch(e){const error=(e as Error).message;await s.run('UPDATE connections SET enabled=0,error=? WHERE id=? AND organizationId=?',error,id,scope.organizationId);return {connected:false,error};}
}
