import {observationCacheKey,trendDayCacheLimits} from './durable-observation-cache';
import {observationCodec} from './observation-codec';
import type {Store} from './store';
type Day={date:string;sourceId:string};
type Request={key:string;day:Day};
type Manifest={cacheKey:string;generation:string;chunkCount:number;characters:number;payloadHash:string};
const chunkCharacters=64*1024;
const checkBudget=(deadline?:number)=>{if(deadline!==undefined&&Date.now()>=deadline)throw Error('Observation cache warm budget elapsed');};
async function digest(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');}

/** Read only the immutable trend-day partition in bounded batches. Source
 * metadata and authorization are captured by the caller before these keys.
 * Missing or invalid entries fall through to the ordinary canonical reader. */
export async function readTrendDayPayloads(store:Store,org:string,client:string,requests:Request[],deadline?:number):Promise<Map<string,string>>{
 const result=new Map<string,string>();if(!requests.length)return result;
 const keyed=await Promise.all(requests.map(async request=>({...request,cacheKey:await observationCacheKey(request.key,true)}))),byKey=new Map(keyed.map(value=>[value.cacheKey,value])),manifests:Manifest[]=[];
 try{
  for(let start=0;start<keyed.length;start+=64){checkBudget(deadline);const rows=await store.all<Manifest>("SELECT e.cacheKey,e.generation,e.chunkCount,e.characters,e.payloadHash FROM json_each(?) p JOIN observation_cache_entries e ON e.cacheKey=p.value WHERE e.organizationId=? AND e.clientId=? AND e.status='ready' AND e.cacheKey LIKE 'trend-day:%'",JSON.stringify(keyed.slice(start,start+64).map(value=>value.cacheKey)),org,client);checkBudget(deadline);manifests.push(...rows);}
  const accepted:Manifest[]=[];let maximumBytes=0;
  for(const manifest of manifests){if(!byKey.has(manifest.cacheKey)||!Number.isInteger(manifest.characters)||manifest.characters<1||manifest.characters>trendDayCacheLimits.maximumCharacters||!Number.isInteger(manifest.chunkCount)||manifest.chunkCount<Math.ceil(manifest.characters/chunkCharacters)||manifest.chunkCount>Math.ceil(manifest.characters/chunkCharacters)+1)continue;maximumBytes+=manifest.characters*3;if(maximumBytes>trendDayCacheLimits.maximumBytes)break;accepted.push(manifest);}
  const parts=new Map(accepted.map(manifest=>[manifest.cacheKey,Array<string>(manifest.chunkCount)])),chunks=accepted.flatMap(({cacheKey,generation,chunkCount})=>Array.from({length:chunkCount},(_,chunkIndex)=>({cacheKey,generation,chunkIndex})));let next=0;
  const worker=async()=>{for(;;){checkBudget(deadline);const start=next;next+=4;if(start>=chunks.length)return;const requested=chunks.slice(start,start+4),rows=await store.all<{cacheKey:string;generation:string;chunkIndex:number;payload:string}>("SELECT c.cacheKey,c.generation,c.chunkIndex,c.payload FROM json_each(?) p JOIN observation_cache_chunks c ON c.cacheKey=json_extract(p.value,'$.cacheKey') AND c.generation=json_extract(p.value,'$.generation') AND c.chunkIndex=json_extract(p.value,'$.chunkIndex') WHERE c.organizationId=? AND c.clientId=?",JSON.stringify(requested),org,client);checkBudget(deadline);for(const row of rows){const expected=requested.find(value=>value.cacheKey===row.cacheKey&&value.generation===row.generation&&value.chunkIndex===row.chunkIndex);if(expected&&typeof row.payload==='string'&&row.payload.length<=chunkCharacters)parts.get(row.cacheKey)![row.chunkIndex]=row.payload;}}};
  await Promise.all(Array.from({length:Math.min(4,Math.ceil(chunks.length/4))},worker));
  const verified:Pick<Manifest,'cacheKey'|'generation'>[]=[];
  for(const manifest of accepted){checkBudget(deadline);const pieces=parts.get(manifest.cacheKey)!;if(pieces.filter(value=>typeof value==='string').length!==manifest.chunkCount)continue;const payload=pieces.join('');if(payload.length!==manifest.characters||await digest(payload)!==manifest.payloadHash)continue;try{observationCodec.visit(payload,()=>{},byKey.get(manifest.cacheKey)!.day);}catch{continue;}result.set(byKey.get(manifest.cacheKey)!.key,payload);verified.push({cacheKey:manifest.cacheKey,generation:manifest.generation});}
  // One optional touch keeps reusable history through hourly pointer churn.
  if(verified.length&&deadline!==undefined){checkBudget(deadline);try{await store.run("UPDATE observation_cache_entries SET createdAt=? WHERE organizationId=? AND clientId=? AND status='ready' AND cacheKey LIKE 'trend-day:%' AND EXISTS (SELECT 1 FROM json_each(?) p WHERE observation_cache_entries.cacheKey=json_extract(p.value,'$.cacheKey') AND observation_cache_entries.generation=json_extract(p.value,'$.generation'))",new Date().toISOString(),org,client,JSON.stringify(verified));}catch{/* Correct immutable data does not depend on recency. */}checkBudget(deadline);}
 }catch{checkBudget(deadline);/* Optional cache I/O leaves the source path available. */}
 return result;
}
