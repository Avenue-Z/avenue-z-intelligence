import {get,head} from '@vercel/blob';
import type {AccessScope,SourceBatch} from '../analytics/contracts';
import {fingerprint} from '../reviews/build';
import {serverSecret} from '../server/secrets';
import type {Store} from '../server/store';
import {validateBatch} from '../sources/qualification';
import {DailyScheduler} from './scheduler';

type ArchivedSnapshot={id:string;organizationId:string;clientId:string;sourceId:string;retrievedAt:string;coverageThrough:string|null;complete:number;objectKey:string;provider:string|null};
type ArchiveContent={text:string;bytes:number;pathname:string;etag:string};
export type ArchiveReader=(key:string,deadline:number)=>Promise<ArchiveContent>;
type Options={maxSnapshots:number;maxRows:number;deadline:number;readArchive?:ArchiveReader};
const MAX_ARCHIVE_BYTES=200*1024*1024;

async function privateArchive(key:string,deadline:number):Promise<ArchiveContent>{
 const token=serverSecret('BLOB_READ_WRITE_TOKEN');if(!token)throw Error('Private archive is unavailable');
 const signal=AbortSignal.timeout(Math.max(1,Math.min(45000,deadline-Date.now()))),metadata=await head(key,{token,abortSignal:signal});
 if(metadata.pathname!==key||metadata.size<1||metadata.size>MAX_ARCHIVE_BYTES)throw Error('Archive metadata is invalid');
 const result=await get(key,{token,access:'private',useCache:false,abortSignal:signal});
 if(!result||result.statusCode!==200||result.blob.pathname!==key||result.blob.size!==metadata.size||result.blob.etag!==metadata.etag)throw Error('Archive changed during verification');
 const reader=result.stream.getReader(),decoder=new TextDecoder(),parts:string[]=[];let bytes=0;
 try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>metadata.size||Date.now()>=deadline)throw Error('Archive verification budget exceeded');parts.push(decoder.decode(next.value,{stream:true}));}parts.push(decoder.decode());}
 catch(error){await reader.cancel().catch(()=>{});throw error;}
 finally{reader.releaseLock();}
 if(bytes!==metadata.size)throw Error('Archive is incomplete');return {text:parts.join(''),bytes,pathname:key,etag:metadata.etag};
}

async function verifiedArchive(store:Store,snapshot:ArchivedSnapshot,reader:ArchiveReader,deadline:number){
 if(snapshot.objectKey!==`snapshots/${snapshot.id}.json`)throw Error('Snapshot archive path is not recoverable');
 const archive=await reader(snapshot.objectKey,deadline);
 if(archive.pathname!==snapshot.objectKey||archive.bytes<1||archive.bytes>MAX_ARCHIVE_BYTES||new TextEncoder().encode(archive.text).byteLength!==archive.bytes)throw Error('Archive bytes do not match metadata');
 const parsed=JSON.parse(archive.text),hash=await fingerprint(parsed);
 if(snapshot.id!==`${snapshot.organizationId}:${snapshot.clientId}:${snapshot.sourceId}:${hash}`)throw Error('Archive hash does not match its snapshot');
 const expanded=Array.isArray(parsed.rows)&&parsed.rows.length>50000;
 validateBatch(parsed,snapshot.clientId,expanded&&snapshot.provider==='kind-shopify-traffic'?{kindTrafficHourly:true}:expanded&&snapshot.provider==='kind-meta-performance'?{kindMetaHourly:true}:undefined);
 const client=(await store.clients(snapshot.organizationId)).find(value=>value.id===snapshot.clientId);
 if(!client||parsed.timezone!==client.timezone||parsed.currency!==client.currency||Number(parsed.complete)!==snapshot.complete||parsed.coverageThrough!==snapshot.coverageThrough)throw Error('Archive identity or capture metadata changed');
 return {batch:parsed as SourceBatch,hash,archive};
}

// These predicates are repeated inside every DELETE, after remote archive
// verification, so a concurrent pointer/job/review publication protects it.
const protection=`s.organizationId=? AND s.clientId='kind-patches' AND s.status='ready' AND s.retrievedAt<?
 AND NOT EXISTS(SELECT 1 FROM current_snapshots p WHERE p.snapshotId=s.id)
 AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.organizationId=s.organizationId AND j.clientId=s.clientId AND j.sourceId=s.sourceId AND j.status='running' AND j.leaseUntil>=?)
 AND NOT EXISTS(SELECT 1 FROM scheduled_reviews r WHERE r.organizationId=s.organizationId AND r.clientId=s.clientId AND r.status='running' AND r.leaseUntil>=?)
 AND NOT EXISTS(SELECT 1 FROM snapshot_day_projection_entries e WHERE e.snapshotId=s.id AND e.status='writing')
 AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.organizationId=s.organizationId AND r.clientId=s.clientId AND (instr(r.payload,s.id)>0 OR (instr(r.payload,s.sourceId)>0 AND instr(r.payload,s.retrievedAt)>0)))
 AND NOT EXISTS(SELECT 1 FROM ai_turns a WHERE a.organizationId=s.organizationId AND (instr(a.payload,s.id)>0 OR (instr(a.payload,s.sourceId)>0 AND instr(a.payload,s.retrievedAt)>0)))`;

/** Reclaim recoverable database copies, never original captures or metadata.
 * A separate maintenance lease and <=2,000 indexed rows per write bound work. */
export async function pruneArchivedMaterializations(store:Store,scope:AccessScope,options:Options){
 const result={verifiedSnapshots:0,prunedSnapshots:0,rowsDeleted:0,charactersDeleted:0,projectionChunksDeleted:0,skipped:0};
 if(!['admin','service'].includes(scope.role)||!scope.permittedClientIds.includes('kind-patches')||Date.now()>=options.deadline)return result;
 const scheduler=new DailyScheduler(store),leaseId=`${scope.organizationId}:archive-materializations`,token=await scheduler.acquire(leaseId,new Date().toISOString(),Math.max(120000,Math.min(900000,options.deadline-Date.now()+30000)));
 if(!token)return {...result,skipped:1};
 try{
  const cutoff=new Date(Date.now()-2*3600000).toISOString(),now=new Date().toISOString();
  const limit=Math.max(0,Math.min(8,options.maxSnapshots)),pageSize=Math.max(16,limit*4),candidates:ArchivedSnapshot[]=[],order="CASE WHEN c.provider='kind-shopify-traffic' THEN 0 WHEN c.provider='kind-meta-performance' THEN 1 WHEN c.provider IN ('kind-shopify-hourly','kind-shopify-funnels') THEN 2 ELSE 3 END,s.retrievedAt,s.id";
  // Bound expensive review/AI payload checks before evaluating protection.
  // A LIMIT after those correlated checks scans every old capture first.
  // Page past protected captures so they cannot starve a later valid archive.
  for(let offset=0;candidates.length<limit&&Date.now()<options.deadline;){
   const page=await store.all<ArchivedSnapshot>(`SELECT s.*,c.provider FROM snapshots s LEFT JOIN connections c ON c.id=s.sourceId AND c.organizationId=s.organizationId WHERE s.organizationId=? AND s.clientId='kind-patches' AND s.status='ready' AND s.retrievedAt<? AND NOT EXISTS(SELECT 1 FROM current_snapshots p WHERE p.snapshotId=s.id) AND EXISTS(SELECT 1 FROM observations o WHERE o.snapshotId=s.id LIMIT 1) ORDER BY ${order} LIMIT ? OFFSET ?`,scope.organizationId,cutoff,pageSize,offset);
   if(!page.length||Date.now()>=options.deadline)break;offset+=page.length;
   candidates.push(...await store.all<ArchivedSnapshot>(`SELECT s.*,c.provider FROM snapshots s LEFT JOIN connections c ON c.id=s.sourceId AND c.organizationId=s.organizationId WHERE s.id IN (SELECT value FROM json_each(?)) AND ${protection} AND EXISTS(SELECT 1 FROM observations o WHERE o.snapshotId=s.id LIMIT 1) ORDER BY ${order} LIMIT ?`,JSON.stringify(page.map(snapshot=>snapshot.id)),scope.organizationId,cutoff,now,now,limit-candidates.length));
   if(page.length<pageSize)break;
  }
  for(const snapshot of candidates){
   if(Date.now()>=options.deadline||result.rowsDeleted>=options.maxRows)break;
   let verified;try{verified=await verifiedArchive(store,snapshot,options.readArchive??privateArchive,options.deadline);result.verifiedSnapshots++;}catch{result.skipped++;continue;}
   let removed=0,characters=0,projectionChunks=0;
   const guard=()=>({sql:`EXISTS(SELECT 1 FROM snapshots s WHERE s.id=? AND s.objectKey=? AND s.retrievedAt=? AND s.sourceId=? AND s.complete=? AND s.coverageThrough IS ? AND ${protection}) AND EXISTS(SELECT 1 FROM runner_leases WHERE id=? AND token=? AND leaseUntil>=?)`,args:[snapshot.id,snapshot.objectKey,snapshot.retrievedAt,snapshot.sourceId,snapshot.complete,snapshot.coverageThrough,scope.organizationId,cutoff,new Date().toISOString(),new Date().toISOString(),leaseId,token,new Date().toISOString()]});
   // Publish the recovery marker before the first bounded delete. Ready replay
   // must fill missing rows even if a timeout leaves part of this day present.
   const verificationGuard=guard();await store.run(`INSERT INTO audit(id,organizationId,clientId,actorId,action,payload,createdAt) SELECT ?,?,?,?,?,?,? WHERE ${verificationGuard.sql} ON CONFLICT(id) DO NOTHING`,`archive-materialization:${snapshot.id}`,scope.organizationId,snapshot.clientId,scope.actorId,'snapshot.materialization.archive_verified',JSON.stringify({snapshotId:snapshot.id,sourceId:snapshot.sourceId,objectKey:snapshot.objectKey,archiveHash:verified.hash,archiveBytes:verified.archive.bytes,archiveEtag:verified.archive.etag,originalRetrievedAt:snapshot.retrievedAt,originalCoverageThrough:snapshot.coverageThrough}),new Date().toISOString(),...verificationGuard.args);
   for(;;){
    if(Date.now()>=options.deadline||result.rowsDeleted>=options.maxRows)break;
    const limit=Math.min(2000,options.maxRows-result.rowsDeleted),rows=await store.all<{rowid:number;characters:number}>('SELECT rowid,length(payload) AS characters FROM observations WHERE snapshotId=? ORDER BY date,rowKey LIMIT ?',snapshot.id,limit);
    if(!rows.length)break;const safety=guard();
    const deletion=await store.run(`DELETE FROM observations WHERE snapshotId=? AND rowid IN (SELECT value FROM json_each(?)) AND ${safety.sql}`,snapshot.id,JSON.stringify(rows.map(row=>row.rowid)),...safety.args);
    if(!deletion.meta.changes)break;removed+=deletion.meta.changes;result.rowsDeleted+=deletion.meta.changes;
    // A single guarded write removes this exact indexed selection atomically.
    if(deletion.meta.changes===rows.length){const bytes=rows.reduce((sum,row)=>sum+row.characters,0);characters+=bytes;result.charactersDeleted+=bytes;}
   }
   if(removed){
    result.prunedSnapshots++;
    if(!await store.first('SELECT 1 AS present FROM observations WHERE snapshotId=? LIMIT 1',snapshot.id)){
     for(;;){if(Date.now()>=options.deadline)break;const safety=guard(),deletion=await store.run(`DELETE FROM snapshot_day_projection_chunks WHERE organizationId=? AND clientId=? AND snapshotId=? AND rowid IN (SELECT rowid FROM snapshot_day_projection_chunks WHERE snapshotId=? ORDER BY date,codecVersion,generation,chunkIndex LIMIT 64) AND ${safety.sql} AND NOT EXISTS(SELECT 1 FROM observations WHERE snapshotId=?)`,scope.organizationId,snapshot.clientId,snapshot.id,snapshot.id,...safety.args,snapshot.id);projectionChunks+=deletion.meta.changes;result.projectionChunksDeleted+=deletion.meta.changes;if(deletion.meta.changes<64)break;}
     const safety=guard();await store.run(`DELETE FROM snapshot_day_projection_entries WHERE organizationId=? AND clientId=? AND snapshotId=? AND status='ready' AND rowid IN (SELECT rowid FROM snapshot_day_projection_entries WHERE snapshotId=? ORDER BY date,codecVersion LIMIT 64) AND ${safety.sql} AND NOT EXISTS(SELECT 1 FROM snapshot_day_projection_chunks WHERE snapshotId=?) AND NOT EXISTS(SELECT 1 FROM observations WHERE snapshotId=?)`,scope.organizationId,snapshot.clientId,snapshot.id,snapshot.id,...safety.args,snapshot.id,snapshot.id);
    }
    await store.audit(scope.organizationId,snapshot.clientId,scope.actorId,'snapshot.materialization.archived',{snapshotId:snapshot.id,sourceId:snapshot.sourceId,objectKey:snapshot.objectKey,archiveHash:verified.hash,archiveBytes:verified.archive.bytes,archiveEtag:verified.archive.etag,originalRetrievedAt:snapshot.retrievedAt,originalCoverageThrough:snapshot.coverageThrough,rowsDeleted:removed,payloadCharactersDeleted:characters,projectionChunksDeleted:projectionChunks});
   }
  }
  return result;
 }finally{await scheduler.release(leaseId,token);}
}

/** Recovery uses the original timestamp: reconstruct immutable facts without
 * replacing a newer current pointer or inventing new retrieval provenance. */
export async function restoreArchivedMaterialization(store:Store,scope:AccessScope,snapshotId:string,options:{deadline:number;readArchive?:ArchiveReader}){
 if(!['admin','service'].includes(scope.role)||!scope.permittedClientIds.includes('kind-patches'))throw Error('Archive recovery access denied');
 const scheduler=new DailyScheduler(store),leaseId=`${scope.organizationId}:archive-materializations`,token=await scheduler.acquire(leaseId,new Date().toISOString(),900000);
 if(!token)throw Error('Archive maintenance is already running');
 try{
  const snapshot=await store.first<ArchivedSnapshot>("SELECT s.*,c.provider FROM snapshots s LEFT JOIN connections c ON c.id=s.sourceId AND c.organizationId=s.organizationId WHERE s.id=? AND s.organizationId=? AND s.clientId='kind-patches' AND s.status='ready'",snapshotId,scope.organizationId);if(!snapshot)throw Error('Recoverable snapshot is unavailable');
  const verified=await verifiedArchive(store,snapshot,options.readArchive??privateArchive,options.deadline);
  return await store.persistBatch(scope.organizationId,snapshot.sourceId,verified.batch,verified.hash,snapshot.retrievedAt,undefined,{restoreMaterialization:true});
 }finally{await scheduler.release(leaseId,token);}
}
