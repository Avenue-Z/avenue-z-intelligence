import type {Observation} from '../analytics/contracts';
import {observationCodec} from './observation-codec';
import type {Store} from './store';
export type SnapshotDay={snapshotId:string;date:string;sourceId:string};
export type SnapshotDayManifest=SnapshotDay&{generation:string;chunkCount:number;characters:number;payloadHash:string};
const codecVersion=1,chunkCharacters=64*1024,maxCharacters=6*1024*1024,chunksPerPage=4;
const smallBatchCharacters=chunkCharacters*chunksPerPage,smallBatchManifests=32;
class ProjectionIntegrityError extends Error{}
const scope=(org:string,client:string,day:SnapshotDay)=>[org,client,day.snapshotId,day.date,codecVersion];
const dayKey=(day:Pick<SnapshotDay,'snapshotId'|'date'>)=>JSON.stringify([day.snapshotId,day.date]);
const checkBudget=(deadline?:number)=>{if(deadline!==undefined&&Date.now()>=deadline)throw Error('Observation cache warm budget elapsed');};
async function digest(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');}
function chunks(payload:string){const output:string[]=[];for(let start=0;start<payload.length;){let end=Math.min(start+chunkCharacters,payload.length);if(end<payload.length&&payload.charCodeAt(end-1)>=0xd800&&payload.charCodeAt(end-1)<=0xdbff)end--;output.push(payload.slice(start,end));start=end;}return output;}

/** Immutable, complete raw snapshot/day facts. Range and dataset selection are
 * applied after reading; these projections never depend on a browser request.
 * A missing migration or failed derived write leaves authoritative rows intact.
 */
export async function snapshotDayManifests(db:Store['db'],org:string,client:string,days:SnapshotDay[],deadline?:number):Promise<Map<string,SnapshotDayManifest>>{
 const result=new Map<string,SnapshotDayManifest>();
 try{for(let start=0;start<days.length;start+=128){checkBudget(deadline);const rows=(await db.prepare("SELECT e.snapshotId,e.date,e.generation,e.chunkCount,e.characters,e.payloadHash FROM json_each(?) p JOIN snapshot_day_projection_entries e ON e.snapshotId=json_extract(p.value,'$.snapshotId') AND e.date=json_extract(p.value,'$.date') WHERE e.organizationId=? AND e.clientId=? AND e.codecVersion=? AND e.status='ready'").bind(JSON.stringify(days.slice(start,start+128)),org,client,codecVersion).all()).results as Omit<SnapshotDayManifest,'sourceId'>[];checkBudget(deadline);for(const row of rows){const day=days.find(d=>d.snapshotId===row.snapshotId&&d.date===row.date);if(day)result.set(dayKey(day),{...row,sourceId:day.sourceId});}}}
 catch(error){checkBudget(deadline);result.clear();}
 return result;
}
export function snapshotDayManifest(manifests:Map<string,SnapshotDayManifest>,day:SnapshotDay){return manifests.get(dayKey(day));}
export async function discardSnapshotDayProjection(db:Store['db'],org:string,client:string,manifest:SnapshotDayManifest){try{const values=scope(org,client,manifest);await db.batch([
 db.prepare('DELETE FROM snapshot_day_projection_entries WHERE organizationId=? AND clientId=? AND snapshotId=? AND date=? AND codecVersion=? AND generation=?').bind(...values,manifest.generation),
 db.prepare('DELETE FROM snapshot_day_projection_chunks WHERE organizationId=? AND clientId=? AND snapshotId=? AND date=? AND codecVersion=? AND generation=?').bind(...values,manifest.generation)
 ]);}catch{/* Repair is optional. */}}
export async function readSnapshotDayProjection(db:Store['db'],org:string,client:string,manifest:SnapshotDayManifest,deadline?:number):Promise<string|null>{
 try{
  if(!Number.isInteger(manifest.chunkCount)||manifest.chunkCount<1||manifest.chunkCount>Math.ceil(maxCharacters/chunkCharacters)+1||!Number.isInteger(manifest.characters)||manifest.characters<1||manifest.characters>maxCharacters)throw new ProjectionIntegrityError('Invalid day manifest');
  const parts:string[]=Array(manifest.chunkCount),values=scope(org,client,manifest);
  for(let start=0;start<manifest.chunkCount;start+=chunksPerPage*4){checkBudget(deadline);const pages=await Promise.all(Array.from({length:Math.min(4,Math.ceil((manifest.chunkCount-start)/chunksPerPage))},async(_,index)=>{const offset=start+index*chunksPerPage;const rows=(await db.prepare('SELECT chunkIndex,payload FROM snapshot_day_projection_chunks WHERE organizationId=? AND clientId=? AND snapshotId=? AND date=? AND codecVersion=? AND generation=? AND chunkIndex>=? ORDER BY chunkIndex LIMIT 4').bind(...values,manifest.generation,offset).all()).results as {chunkIndex:number;payload:string}[];return {offset,rows};}));checkBudget(deadline);
   for(const {offset,rows} of pages){if(rows.length!==Math.min(chunksPerPage,manifest.chunkCount-offset))throw new ProjectionIntegrityError('Incomplete day projection');for(let index=0;index<rows.length;index++){const row=rows[index];if(row.chunkIndex!==offset+index||typeof row.payload!=='string'||row.payload.length>chunkCharacters)throw new ProjectionIntegrityError('Invalid day chunk');parts[row.chunkIndex]=row.payload;}}
  }
  const payload=parts.join('');if(payload.length!==manifest.characters||await digest(payload)!==manifest.payloadHash)throw new ProjectionIntegrityError('Day integrity mismatch');checkBudget(deadline);return payload;
 }catch(error){checkBudget(deadline);if(error instanceof ProjectionIntegrityError)await discardSnapshotDayProjection(db,org,client,manifest);return null;}
}
/** Pack tiny history days within the existing 256Ki-character valid-payload budget.
 * The count cap bounds metadata and integrity work even for very small days. */
export function smallSnapshotDayBatchWithinLimits(manifests:SnapshotDayManifest[]){
 return manifests.length>0&&manifests.length<=smallBatchManifests&&manifests.every(m=>m.chunkCount===1&&Number.isInteger(m.characters)&&m.characters>0&&m.characters<=chunkCharacters)&&manifests.reduce((total,m)=>total+m.characters,0)<=smallBatchCharacters;
}
export async function readSmallSnapshotDayProjections(db:Store['db'],org:string,client:string,manifests:SnapshotDayManifest[],deadline?:number):Promise<Map<string,string>>{
 const result=new Map<string,string>();if(!manifests.length)return result;
 if(!smallSnapshotDayBatchWithinLimits(manifests))return result;
 // Codec JSON escapes NUL, which otherwise truncates SQLite length(TEXT).
 // SQLite counts codepoints, so <= keeps valid astral text. Exact JS UTF16
 // length/hash checks remain below. Corrupt under-reporting can fetch at most
 // twice the declared character budget before rejection, never an unbounded row.
 try{checkBudget(deadline);const rows=(await db.prepare('SELECT c.snapshotId,c.date,c.generation,c.payload FROM json_each(?) p JOIN snapshot_day_projection_chunks c ON c.snapshotId=json_extract(p.value,\'$.snapshotId\') AND c.date=json_extract(p.value,\'$.date\') AND c.generation=json_extract(p.value,\'$.generation\') WHERE c.organizationId=? AND c.clientId=? AND c.codecVersion=? AND c.chunkIndex=0 AND instr(c.payload,char(0))=0 AND length(c.payload)<=json_extract(p.value,\'$.characters\')').bind(JSON.stringify(manifests.map(({snapshotId,date,generation,characters})=>({snapshotId,date,generation,characters}))),org,client,codecVersion).all()).results as {snapshotId:string;date:string;generation:string;payload:string}[];checkBudget(deadline);
  for(const manifest of manifests){const row=rows.find(r=>r.snapshotId===manifest.snapshotId&&r.date===manifest.date&&r.generation===manifest.generation);if(!row||typeof row.payload!=='string'||row.payload.length!==manifest.characters||await digest(row.payload)!==manifest.payloadHash){await discardSnapshotDayProjection(db,org,client,manifest);continue;}result.set(dayKey(manifest),row.payload);}
 }catch(error){checkBudget(deadline);}
 return result;
}
export async function writeSnapshotDayProjection(db:Store['db'],org:string,client:string,day:SnapshotDay,payload:string,deadline?:number):Promise<boolean>{
 if(payload.length>maxCharacters)return false;checkBudget(deadline);
 const values=scope(org,client,day),generation=crypto.randomUUID(),createdAt=new Date().toISOString(),expired=new Date(Date.now()-300000).toISOString(),pieces=chunks(payload);
 const manifest={...day,generation,chunkCount:pieces.length,characters:payload.length,payloadHash:await digest(payload)};
 try{
  checkBudget(deadline);const claim=await db.prepare("INSERT INTO snapshot_day_projection_entries(organizationId,clientId,snapshotId,date,codecVersion,generation,status,chunkCount,characters,payloadHash,createdAt) SELECT ?,?,?,?,?,?,'writing',?,?,?,? WHERE EXISTS (SELECT 1 FROM snapshots WHERE id=? AND organizationId=? AND clientId=? AND status='ready') ON CONFLICT(organizationId,clientId,snapshotId,date,codecVersion) DO UPDATE SET generation=excluded.generation,status='writing',chunkCount=excluded.chunkCount,characters=excluded.characters,payloadHash=excluded.payloadHash,createdAt=excluded.createdAt WHERE snapshot_day_projection_entries.status='writing' AND snapshot_day_projection_entries.createdAt<?").bind(...values,generation,pieces.length,payload.length,manifest.payloadHash,createdAt,day.snapshotId,org,client,expired).run();
  if(!claim.meta.changes)return false;
  await db.prepare("DELETE FROM snapshot_day_projection_chunks WHERE organizationId=? AND clientId=? AND snapshotId=? AND date=? AND codecVersion=? AND generation<>? AND EXISTS (SELECT 1 FROM snapshot_day_projection_entries WHERE organizationId=? AND clientId=? AND snapshotId=? AND date=? AND codecVersion=? AND generation=? AND status='writing')").bind(...values,generation,...values,generation).run();
  for(let start=0;start<pieces.length;start+=chunksPerPage){checkBudget(deadline);const writes=pieces.slice(start,start+chunksPerPage).map((piece,index)=>db.prepare("INSERT INTO snapshot_day_projection_chunks(organizationId,clientId,snapshotId,date,codecVersion,generation,chunkIndex,payload) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM snapshot_day_projection_entries WHERE organizationId=? AND clientId=? AND snapshotId=? AND date=? AND codecVersion=? AND generation=? AND status='writing') ON CONFLICT DO NOTHING").bind(...values,generation,start+index,piece,...values,generation));const results=await db.batch(writes);if(results.some(result=>!result.meta.changes))throw Error('Projection generation replaced');}
  checkBudget(deadline);const ready=await db.prepare("UPDATE snapshot_day_projection_entries SET status='ready' WHERE organizationId=? AND clientId=? AND snapshotId=? AND date=? AND codecVersion=? AND generation=? AND status='writing' AND chunkCount=(SELECT COUNT(*) FROM snapshot_day_projection_chunks WHERE organizationId=? AND clientId=? AND snapshotId=? AND date=? AND codecVersion=? AND generation=?)").bind(...values,generation,...values,generation).run();return !!ready.meta.changes;
 }catch(error){await discardSnapshotDayProjection(db,org,client,manifest);checkBudget(deadline);return false;}
}
/** Match the raw INSERT's first-wins row identity before creating a projection. */
export function snapshotDayPayload(rows:Observation[],day:SnapshotDay):string{
 const unique=new Map<string,Observation>();for(const row of rows){if(row.date!==day.date||row.sourceId!==day.sourceId)throw Error('Projection source/day mismatch');const key=JSON.stringify([row.dataset,row.metric,row.start,row.end,Object.entries(row.dimensions).sort()]);if(!unique.has(key))unique.set(key,row);}
 return observationCodec.encode([...unique].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,row])=>row));
}
/** One-time legacy backfill reads complete immutable days, never a query subset.
 * Native ingestion prepares future days automatically from its existing rows.
 */
export async function backfillSnapshotDayProjections(store:Store,org:string,client:string,options:{sourceIds?:string[];maxDays?:number;deadline?:number}={}){
 const stats={written:0,existing:0,failed:0};checkBudget(options.deadline);
 try{await store.first('SELECT codecVersion FROM snapshot_day_projection_entries LIMIT 1');}catch{return stats;}
 const days=await store.all<SnapshotDay>("SELECT c.snapshotId,c.sourceId,c.date FROM current_snapshots c JOIN snapshots s ON s.id=c.snapshotId AND s.organizationId=c.organizationId AND s.clientId=c.clientId WHERE c.organizationId=? AND c.clientId=? AND s.status='ready' ORDER BY c.date DESC,c.sourceId",org,client);
 const selected=days.filter(day=>!options.sourceIds||options.sourceIds.includes(day.sourceId)).slice(0,options.maxDays??128),manifests=await snapshotDayManifests(store.db,org,client,selected,options.deadline);
 for(const day of selected){checkBudget(options.deadline);const manifest=snapshotDayManifest(manifests,day);if(manifest){const payload=await readSnapshotDayProjection(store.db,org,client,manifest,options.deadline);if(payload){try{observationCodec.visit(payload,()=>{},day);stats.existing++;continue;}catch{await discardSnapshotDayProjection(store.db,org,client,manifest);}}}
  const rows:Observation[]=[];let cursor:string|null=null;for(;;){checkBudget(options.deadline);const page: {payload:string;rowKey:string}[]=await store.all(`SELECT o.payload,o.rowKey FROM observations o WHERE o.snapshotId=? AND o.date=?${cursor?' AND o.rowKey>?':''} ORDER BY o.rowKey LIMIT 2000`,day.snapshotId,day.date,...cursor?[cursor]:[]);checkBudget(options.deadline);for(const row of page)rows.push(JSON.parse(row.payload));if(page.length<2000)break;cursor=page[page.length-1].rowKey;}
  try{if(await writeSnapshotDayProjection(store.db,org,client,day,snapshotDayPayload(rows,day),options.deadline))stats.written++;else stats.failed++;}catch(error){checkBudget(options.deadline);stats.failed++;}
 }
 return stats;
}
