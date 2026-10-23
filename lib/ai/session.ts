import {getStore,requireClientAccess} from '../server/access';
import {parseFilters} from '../server/workspace';
import {fingerprint} from '../reviews/build';
import type {AccessScope,QueryFilters} from '../analytics/contracts';
import type {Store} from '../server/store';

type Session={scope:AccessScope;s:Store;scopeKey:string;filters:QueryFilters;clients:string[];reviewId:string|null};
function storedFilters(value:unknown):QueryFilters|null{
 if(typeof value!=='string')return null;
 try{const parsed=JSON.parse(value);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as QueryFilters:null;}catch{return null;}
}

/** Composer metadata and history never require the source observation archive. */
export async function loadAISession(clientId:string|undefined,requested:QueryFilters,reviewId?:string,existingScope?:AccessScope,store?:Store):Promise<Session>{
 let filters=parseFilters(new URLSearchParams({...requested}));
 const scope=existingScope??await requireClientAccess(clientId,false,store),s=store??getStore();
 if(clientId&&!scope.permittedClientIds.includes(clientId))throw Error('Client access denied');
 if(reviewId&&!clientId)throw Error('Client identity required for a review');
 const clients=(await s.clients(scope.organizationId)).filter(client=>scope.permittedClientIds.includes(client.id)&&(!clientId||client.id===clientId));
 let names=clients.map(client=>client.name),clientIds=clients.map(client=>client.id).sort();
 if(reviewId&&clientId){
  // Extract only a few scalar fields. A frozen review may hold megabytes of
  // evidence; restoring that archive belongs to the actual answer request.
  const saved=await s.first(`SELECT id,storeDate,
   json_extract(payload,'$.filters') AS reportFilters,
   json_type(payload,'$.evidence') AS evidenceType,
   json_extract(payload,'$.evidence.format') AS evidenceFormat,
   json_extract(payload,'$.evidence.context.filters') AS contextFilters,
   json_array_length(json_extract(payload,'$.evidence.context.clients')) AS contextClientCount,
   json_extract(payload,'$.evidence.context.clients[0].client.id') AS contextClientId,
   json_extract(payload,'$.evidence.context.clients[0].client.name') AS contextClientName,
   json_extract(payload,'$.evidence.filters') AS legacyFilters,
   json_array_length(json_extract(payload,'$.evidence.clients')) AS legacyClientCount,
   json_extract(payload,'$.evidence.clients[0].client.id') AS legacyClientId,
   json_extract(payload,'$.evidence.clients[0].client.name') AS legacyClientName
   FROM reviews WHERE organizationId=? AND clientId=? AND id=?`,scope.organizationId,clientId,reviewId);
  if(!saved)throw Error('Review access denied');
  if(saved.evidenceType&&saved.evidenceType!=='null'){
   const compact=saved.evidenceFormat==='avenuez-evidence-registry-v1',frozen=storedFilters(compact?saved.contextFilters:saved.legacyFilters),count=compact?saved.contextClientCount:saved.legacyClientCount,id=compact?saved.contextClientId:saved.legacyClientId,name=compact?saved.contextClientName:saved.legacyClientName;
   if(!frozen||count!==1||id!==clientId||frozen.to!==saved.storeDate)throw Error('Saved review evidence scope is invalid');
   // Keep the exact saved object (including property order and historical
   // aliases), matching aiContext's restored evidence and history fingerprint.
   filters=frozen;clientIds=[clientId];if(typeof name==='string'&&name)names=[name];
  }
 }
 const scopeKey=await fingerprint({clientIds,filters,reviewId:reviewId??null});
 return {scope,s,scopeKey,filters,clients:names,reviewId:reviewId??null};
}

export async function sessionHistory(session:Session){
 const {s,scope,scopeKey}=session;
 return (await s.all('SELECT * FROM ai_turns WHERE organizationId=? AND actorId=? AND scopeKey=? ORDER BY createdAt DESC LIMIT 20',scope.organizationId,scope.actorId,scopeKey)).reverse().map(turn=>({...turn,payload:JSON.parse(turn.payload)}));
}
