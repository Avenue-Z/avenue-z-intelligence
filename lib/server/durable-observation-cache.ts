import {observationCodec} from './observation-codec';
import type {Store} from './store';
type Manifest={generation:string;chunkCount:number;characters:number;payloadHash:string};
const chunkCharacters=64*1024,maxCharacters=6*1024*1024,chunksPerPage=4;
async function digest(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');}
function chunks(payload:string){const output:string[]=[];for(let start=0;start<payload.length;){let end=Math.min(start+chunkCharacters,payload.length);if(end<payload.length&&payload.charCodeAt(end-1)>=0xd800&&payload.charCodeAt(end-1)<=0xdbff)end--;output.push(payload.slice(start,end));start=end;}return output;}

/** Optional derived cache in the application's shared SQLite database.
 * Every lookup is tenant-scoped and uses the caller's freshly captured source
 * version. A generation is readable only after all bounded chunks publish.
 */
export async function durableObservationPayload(db:Store['db'],org:string,client:string,key:string,load:()=>Promise<string>,deadline?:number):Promise<string>{
 const cacheKey=await digest(`observation-codec-v1:${key}`),scope=[org,client,cacheKey];
 const checkBudget=()=>{if(deadline!==undefined&&Date.now()>=deadline)throw Error('Observation cache warm budget elapsed');};
 const first=async<T>(sql:string,...values:unknown[]):Promise<T|null>=>{checkBudget();const row=await db.prepare(sql).bind(...values).first();checkBudget();return row;};
 const all=async<T>(sql:string,...values:unknown[]):Promise<T[]>=>{checkBudget();const rows=(await db.prepare(sql).bind(...values).all()).results;checkBudget();return rows;};
 const discard=async(generation:string)=>{try{await db.batch([
  db.prepare('DELETE FROM observation_cache_entries WHERE organizationId=? AND clientId=? AND cacheKey=? AND generation=?').bind(...scope,generation),
  db.prepare('DELETE FROM observation_cache_chunks WHERE organizationId=? AND clientId=? AND cacheKey=? AND generation=?').bind(...scope,generation)
 ]);}catch{/* A failed cache repair must not interrupt the source read. */}};
 let manifest:Manifest|null=null;
 try{
  manifest=await first<Manifest>("SELECT generation,chunkCount,characters,payloadHash FROM observation_cache_entries WHERE organizationId=? AND clientId=? AND cacheKey=? AND status='ready'",...scope);
  if(manifest){
   if(!Number.isInteger(manifest.chunkCount)||manifest.chunkCount<1||manifest.chunkCount>Math.ceil(maxCharacters/chunkCharacters)+1||!Number.isInteger(manifest.characters)||manifest.characters<1||manifest.characters>maxCharacters)throw Error('Invalid cache manifest');
   const parts:string[]=Array(manifest.chunkCount);
   for(let start=0;start<manifest.chunkCount;start+=chunksPerPage*4){
    const pages=await Promise.all(Array.from({length:Math.min(4,Math.ceil((manifest.chunkCount-start)/chunksPerPage))},(_,index)=>{
     const offset=start+index*chunksPerPage;
     return all<{chunkIndex:number;payload:string}>('SELECT chunkIndex,payload FROM observation_cache_chunks WHERE organizationId=? AND clientId=? AND cacheKey=? AND generation=? AND chunkIndex>=? ORDER BY chunkIndex LIMIT 4',...scope,manifest!.generation,offset).then(rows=>({offset,rows}));
    }));
    for(const {offset,rows} of pages){if(rows.length!==Math.min(chunksPerPage,manifest.chunkCount-offset))throw Error('Incomplete cache');for(let index=0;index<rows.length;index++){const row=rows[index];if(row.chunkIndex!==offset+index||typeof row.payload!=='string'||row.payload.length>chunkCharacters)throw Error('Invalid cache chunk');parts[row.chunkIndex]=row.payload;}}
   }
   const payload=parts.join('');if(payload.length!==manifest.characters||await digest(payload)!==manifest.payloadHash)throw Error('Cache integrity mismatch');
   // Treat malformed codec data as a miss even when its manifest was altered.
   if(!observationCodec.valid(payload))throw Error('Invalid cache codec');return payload;
  }
 }catch(error){if(deadline!==undefined&&Date.now()>=deadline)throw error;if(manifest)await discard(manifest.generation);}
 const payload=await load();
 if(payload.length>maxCharacters||deadline!==undefined&&Date.now()>=deadline)return payload;
 const generation=crypto.randomUUID(),createdAt=new Date().toISOString(),expired=new Date(Date.now()-300000).toISOString(),pieces=chunks(payload);
 try{
  const claim=await db.batch([
   db.prepare("INSERT INTO observation_cache_entries(organizationId,clientId,cacheKey,generation,status,chunkCount,characters,payloadHash,createdAt) VALUES(?,?,?,?,'writing',?,?,?,?) ON CONFLICT(organizationId,clientId,cacheKey) DO UPDATE SET generation=excluded.generation,status='writing',chunkCount=excluded.chunkCount,characters=excluded.characters,payloadHash=excluded.payloadHash,createdAt=excluded.createdAt WHERE observation_cache_entries.status='writing' AND observation_cache_entries.createdAt<?").bind(...scope,generation,pieces.length,payload.length,await digest(payload),createdAt,expired),
   db.prepare('DELETE FROM observation_cache_entries WHERE organizationId=? AND clientId=? AND cacheKey NOT IN (SELECT cacheKey FROM observation_cache_entries WHERE organizationId=? AND clientId=? ORDER BY createdAt DESC,cacheKey LIMIT 8)').bind(org,client,org,client),
   db.prepare('DELETE FROM observation_cache_chunks WHERE organizationId=? AND clientId=? AND NOT EXISTS (SELECT 1 FROM observation_cache_entries e WHERE e.organizationId=observation_cache_chunks.organizationId AND e.clientId=observation_cache_chunks.clientId AND e.cacheKey=observation_cache_chunks.cacheKey AND e.generation=observation_cache_chunks.generation)').bind(org,client)
  ]);
  if(!claim[0].meta.changes)return payload;
  for(let start=0;start<pieces.length;start+=chunksPerPage){
   if(deadline!==undefined&&Date.now()>=deadline){await discard(generation);return payload;}
   const writes=pieces.slice(start,start+chunksPerPage).map((piece,index)=>db.prepare("INSERT INTO observation_cache_chunks(organizationId,clientId,cacheKey,generation,chunkIndex,payload) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM observation_cache_entries WHERE organizationId=? AND clientId=? AND cacheKey=? AND generation=? AND status='writing') ON CONFLICT DO NOTHING").bind(...scope,generation,start+index,piece,...scope,generation));
   const results=await db.batch(writes);if(results.some(result=>!result.meta.changes))return payload;
  }
  if(deadline!==undefined&&Date.now()>=deadline){await discard(generation);return payload;}
  await db.prepare("UPDATE observation_cache_entries SET status='ready' WHERE organizationId=? AND clientId=? AND cacheKey=? AND generation=? AND status='writing' AND chunkCount=(SELECT COUNT(*) FROM observation_cache_chunks WHERE organizationId=? AND clientId=? AND cacheKey=? AND generation=?)").bind(...scope,generation,...scope,generation).run();
 }catch{await discard(generation);}
 return payload;
}
