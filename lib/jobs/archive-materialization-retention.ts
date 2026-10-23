import {get,head} from '@vercel/blob';
import type {AccessScope,Client,Connection,SourceBatch} from '../analytics/contracts';
import {fingerprint} from '../reviews/build';
import {serverSecret} from '../server/secrets';
import type {Store} from '../server/store';
import {validateBatch} from '../sources/qualification';
import {DailyScheduler} from './scheduler';
import {denseHourlyHistoryProviders,hourlyHistoryWindow} from './hourly-history';
import {dayWindow,shiftDate,todayIn} from '../analytics/windows';
import {assertSourceActivation,validateRegisteredBatch} from '../sources/registered-contract';
import {hourlySessionCutoff} from '../sources/kind-patches';

type ArchivedSnapshot={id:string;organizationId:string;clientId:string;sourceId:string;retrievedAt:string;coverageThrough:string|null;complete:number;status:string;objectKey:string;provider:string|null};
type ArchiveContent={text:string;bytes:number;pathname:string;etag:string};
export type ArchiveReader=(key:string,deadline:number)=>Promise<ArchiveContent>;
type Options={maxSnapshots:number;maxRows:number;deadline:number;readArchive?:ArchiveReader;monthlyRetention?:boolean;clientId?:'kind-patches'|'beam'|'autobrush'};
const MAX_ARCHIVE_BYTES=200*1024*1024;
const MAX_CANDIDATE_PAGES=32;
type MaintenanceResult={verifiedSnapshots:number;prunedSnapshots:number;rowsDeleted:number;charactersDeleted:number;projectionChunksDeleted:number;projectionEntriesDeleted?:number;pointersRetired?:number;skipped:number;deferred?:'current-source-work'|'deadline'|'database'|'candidate-page-limit';stage?:string;uncertainWrite?:boolean};

async function privateArchive(key:string,deadline:number):Promise<ArchiveContent>{
 const token=serverSecret('BLOB_READ_WRITE_TOKEN');if(!token)throw Error('Private archive is unavailable');
 const signal=AbortSignal.timeout(Math.max(1,Math.min(45000,deadline-Date.now()))),metadata=await head(key,{token,abortSignal:signal});
 if(metadata.pathname!==key||metadata.size<1||metadata.size>MAX_ARCHIVE_BYTES)throw Error('Archive metadata is invalid');
 const result=await get(key,{token,access:'private',useCache:false,abortSignal:signal});
 // GET size describes the HTTP transfer and can be zero for chunked responses.
 // Compression can use a weak ETag for the same decoded entity as HEAD.
 // Verify exact decoded bytes below and the immutable snapshot hash afterward.
 if(!result||result.statusCode!==200||result.blob.pathname!==key||!result.blob.etag||!metadata.etag||result.blob.etag.replace(/^W\//,'')!==metadata.etag.replace(/^W\//,''))throw Error('Archive changed during verification');
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
 validateBatch(parsed,snapshot.clientId,expanded&&snapshot.provider==='autobrush-shopify-traffic'?{autobrushTrafficHourly:true}:expanded&&snapshot.provider==='beam-shopify-traffic'?{beamTrafficHourly:true}:expanded&&snapshot.provider==='kind-shopify-traffic'?{kindTrafficHourly:true}:expanded&&snapshot.provider==='kind-meta-performance'?{kindMetaHourly:true}:undefined);
 const client=(await store.clients(snapshot.organizationId)).find(value=>value.id===snapshot.clientId);
 if(!client||parsed.timezone!==client.timezone||parsed.currency!==client.currency||Number(parsed.complete)!==snapshot.complete||parsed.coverageThrough!==snapshot.coverageThrough)throw Error('Archive identity or capture metadata changed');
 return {batch:parsed as SourceBatch,hash,archive};
}

/** Complete a recent frozen capture before asking a changing provider for a
 * replacement. Only immutable, currently qualified, same-day hourly evidence
 * can reuse staged keys; every failed eligibility check falls back to a fresh
 * capture. This helper does not publish, delete, or change source health. */
export async function readRecentWritingCapture(store:Store,scope:AccessScope,source:Connection,client:Client,window:{from:string;to:string},options:{deadline:number;readArchive?:ArchiveReader}):Promise<{batch:SourceBatch;hash:string;retrievedAt:string}|null>{
 const now=Date.now();
 const resumable=client.id==='kind-patches'&&['kind-shopify-traffic','kind-meta-performance'].includes(source.provider)||client.id==='beam'&&source.provider==='beam-shopify-traffic'||client.id==='autobrush'&&source.provider==='autobrush-shopify-traffic';
 if(now>=options.deadline||!['admin','service'].includes(scope.role)||!scope.permittedClientIds.includes(client.id)||!resumable||source.clientId!==client.id||!source.enabled||window.from!==window.to)return null;
 try{
  const today=todayIn(client.timezone,new Date(now)),day=dayWindow(window.to,client.timezone);
  if(window.to>today)return null;
  const through=window.to<today?day.end:hourlySessionCutoff(client.timezone,new Date(now)).through;
  if(Date.parse(through)<=Date.parse(day.start))return null;
  const record=await store.qualification(scope.organizationId,source.id),contract=assertSourceActivation(source,record,client);
  if(!contract.hourlyGrain||contract.profiles.some(profile=>!profile.hourly)||Date.now()>=options.deadline)return null;
  const activation="c.id=s.sourceId AND c.organizationId=s.organizationId AND c.clientId=s.clientId AND c.enabled=1 AND c.provider=? AND c.version=? AND cl.id=s.clientId AND cl.organizationId=s.organizationId AND cl.version=? AND cl.timezone=? AND cl.currency=? AND q.organizationId=s.organizationId AND q.sourceId=s.sourceId AND q.connectionVersion=c.version AND q.clientVersion=cl.version AND q.version=? AND q.payload=? AND NOT EXISTS(SELECT 1 FROM qualifications newer WHERE newer.organizationId=q.organizationId AND newer.sourceId=q.sourceId AND newer.version>q.version)",activationArgs=[source.provider,source.version,client.version,client.timezone,client.currency,record!.version,JSON.stringify(record!.payload)];
  const valid="s.organizationId=? AND s.clientId=? AND s.sourceId=? AND s.status='writing' AND s.complete=1 AND julianday(s.retrievedAt)>julianday(?) AND julianday(s.retrievedAt)<=julianday(?) AND julianday(s.coverageThrough)>julianday(?) AND julianday(s.coverageThrough)<=julianday(?) AND NOT EXISTS(SELECT 1 FROM audit a WHERE a.id='archive-materialization:'||s.id AND a.organizationId=s.organizationId AND a.clientId=s.clientId AND a.action='snapshot.materialization.archive_verified') AND NOT EXISTS(SELECT 1 FROM current_snapshots p WHERE p.organizationId=s.organizationId AND p.clientId=s.clientId AND p.sourceId=s.sourceId AND p.date=? AND julianday(p.publishedAt)>julianday(s.retrievedAt))",validArgs=[scope.organizationId,client.id,source.id,new Date(options.deadline-7200000).toISOString(),new Date(now).toISOString(),day.start,through,window.to];
  const joins='FROM snapshots s JOIN connections c ON c.id=s.sourceId JOIN clients cl ON cl.id=s.clientId JOIN qualifications q ON q.organizationId=s.organizationId AND q.sourceId=s.sourceId';
  const snapshot=await store.first<ArchivedSnapshot>(`SELECT s.*,c.provider ${joins} WHERE ${activation} AND ${valid} ORDER BY s.retrievedAt DESC,s.id DESC LIMIT 1`,...activationArgs,...validArgs);
  if(!snapshot||Date.now()>=options.deadline||Date.parse(snapshot.coverageThrough??'')>Date.parse(snapshot.retrievedAt)||!Number.isInteger((Date.parse(snapshot.coverageThrough??'')-Date.parse(day.start))/3600000)||window.to<today&&Date.parse(snapshot.coverageThrough??'')!==Date.parse(day.end))return null;
  const verified=await verifiedArchive(store,snapshot,options.readArchive??privateArchive,options.deadline),batch=verified.batch;
  validateRegisteredBatch(batch,contract);
  if(batch.grain!=='hourly'||!batch.complete||!batch.rows.length||batch.nextCursor||batch.rows.some(row=>row.date!==window.to||!row.start||!row.end||!Number.isFinite(Date.parse(row.start))||!Number.isFinite(Date.parse(row.end))||Date.parse(row.start)<Date.parse(day.start)||Date.parse(row.end)>Date.parse(snapshot.coverageThrough!)||Date.parse(row.end)-Date.parse(row.start)>7200000)||Date.now()>=options.deadline)return null;
  const unchanged=await store.first(`SELECT s.id ${joins} WHERE ${activation} AND ${valid} AND s.id=? AND s.objectKey=? AND s.retrievedAt=? AND s.coverageThrough=? LIMIT 1`,...activationArgs,...validArgs,snapshot.id,snapshot.objectKey,snapshot.retrievedAt,snapshot.coverageThrough);
  if(!unchanged||Date.now()>=options.deadline)return null;
  console.info('Resuming immutable source capture',{provider:source.provider,storeDate:window.to,coverageThrough:batch.coverageThrough,retrievedAt:snapshot.retrievedAt});
  return {batch,hash:verified.hash,retrievedAt:snapshot.retrievedAt};
 }catch{return null;}
}

// These predicates are repeated inside every DELETE, after remote archive
// verification, so a concurrent pointer/job/review publication protects it.
const protection=`s.organizationId=? AND s.clientId='kind-patches' AND s.status IN ('ready','writing') AND s.retrievedAt<?
 AND NOT EXISTS(SELECT 1 FROM current_snapshots p WHERE p.snapshotId=s.id)
 AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.organizationId=s.organizationId AND j.clientId=s.clientId AND j.sourceId=s.sourceId AND j.status='running' AND j.leaseUntil>=?)
 AND NOT EXISTS(SELECT 1 FROM scheduled_reviews r WHERE r.organizationId=s.organizationId AND r.clientId=s.clientId AND r.status='running' AND r.leaseUntil>=?)
 AND NOT EXISTS(SELECT 1 FROM snapshot_day_projection_entries e WHERE e.snapshotId=s.id AND e.status='writing')
 AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.organizationId=s.organizationId AND r.clientId=s.clientId AND (instr(r.payload,s.id)>0 OR (instr(r.payload,s.sourceId)>0 AND instr(r.payload,s.retrievedAt)>0)))
 AND NOT EXISTS(SELECT 1 FROM ai_turns a WHERE a.organizationId=s.organizationId AND (instr(a.payload,s.id)>0 OR (instr(a.payload,s.sourceId)>0 AND instr(a.payload,s.retrievedAt)>0)))`;
const currentWork=`SELECT 1 FROM jobs j JOIN connections c ON c.id=j.sourceId AND c.organizationId=j.organizationId AND c.clientId=j.clientId WHERE j.organizationId=? AND j.clientId='kind-patches' AND c.enabled=1 AND j.id NOT LIKE '%:hourly-history:____-__-__' AND j.status IN ('pending','running') AND j.dueAt<=?`;
// Expired detailed date pointers have their own retirement step. This repeats
// every capture protection except the pointer intentionally being retired;
// materialization DELETEs continue to require no pointer anywhere.
const retirementProtection=`s.organizationId=? AND s.clientId='kind-patches' AND s.status='ready' AND s.retrievedAt<?
 AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.organizationId=s.organizationId AND j.clientId=s.clientId AND j.sourceId=s.sourceId AND j.status='running' AND j.leaseUntil>=?)
 AND NOT EXISTS(SELECT 1 FROM scheduled_reviews r WHERE r.organizationId=s.organizationId AND r.clientId=s.clientId AND r.status='running' AND r.leaseUntil>=?)
 AND NOT EXISTS(SELECT 1 FROM snapshot_day_projection_entries e WHERE e.snapshotId=s.id AND e.status='writing')
 AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.organizationId=s.organizationId AND r.clientId=s.clientId AND (instr(r.payload,s.id)>0 OR (instr(r.payload,s.sourceId)>0 AND instr(r.payload,s.retrievedAt)>0)))
 AND NOT EXISTS(SELECT 1 FROM ai_turns a WHERE a.organizationId=s.organizationId AND (instr(a.payload,s.id)>0 OR (instr(a.payload,s.sourceId)>0 AND instr(a.payload,s.retrievedAt)>0)))`;
// A committed final fact page may lose its response before derived cleanup.
// Revisit only its original recovery marker plus remaining scoped copies.
const materialization=`(EXISTS(SELECT 1 FROM observations o WHERE o.snapshotId=s.id LIMIT 1) OR (EXISTS(SELECT 1 FROM audit a WHERE a.id='archive-materialization:'||s.id AND a.organizationId=s.organizationId AND a.clientId=s.clientId AND a.action='snapshot.materialization.archive_verified' AND json_extract(a.payload,'$.objectKey')=s.objectKey AND json_extract(a.payload,'$.originalRetrievedAt')=s.retrievedAt AND json_extract(a.payload,'$.originalCoverageThrough') IS s.coverageThrough) AND (EXISTS(SELECT 1 FROM snapshot_day_projection_chunks d WHERE d.organizationId=s.organizationId AND d.clientId=s.clientId AND d.snapshotId=s.id LIMIT 1) OR EXISTS(SELECT 1 FROM snapshot_day_projection_entries d WHERE d.organizationId=s.organizationId AND d.clientId=s.clientId AND d.snapshotId=s.id AND d.status='ready' LIMIT 1))))`;

/** Reclaim recoverable ready or stale partial database copies, never original captures or metadata.
 * A separate maintenance lease and <=500 indexed rows per write bound work. */
export async function pruneArchivedMaterializations(store:Store,scope:AccessScope,options:Options){
 const clientId=options.clientId??'kind-patches';
 if(clientId!=='kind-patches'&&clientId!=='beam'&&clientId!=='autobrush')throw Error('Unsupported retention client');
 const protectionSql=protection.replaceAll("'kind-patches'",`'${clientId}'`),currentWorkSql=currentWork.replaceAll("'kind-patches'",`'${clientId}'`),retirementProtectionSql=retirementProtection.replaceAll("'kind-patches'",`'${clientId}'`);
 const result:MaintenanceResult={verifiedSnapshots:0,prunedSnapshots:0,rowsDeleted:0,charactersDeleted:0,projectionChunksDeleted:0,skipped:0};
 if(!['admin','service'].includes(scope.role)||!scope.permittedClientIds.includes(clientId)||Date.now()>=options.deadline)return result;
 const scheduler=new DailyScheduler(store),leaseId=`${scope.organizationId}:archive-materializations${clientId==='kind-patches'?'':':'+clientId}`;let token:string|null=null,stage='priority.read',snapshotId:string|undefined;
 const step=async<T>(name:string,work:()=>Promise<T>):Promise<T>=>{stage=name;const started=Date.now();const value=await work();if(Date.now()-started>=5000)console.info('Archive maintenance stage',{stage:name,ms:Date.now()-started,snapshotId,rowsDeleted:result.rowsDeleted});return value;};
 const canWrite=async()=>{if(result.deferred)return false;if(Date.now()>=options.deadline){result.deferred='deadline';return false;}if(await step('priority.read',()=>store.first(currentWorkSql+' LIMIT 1',scope.organizationId,new Date().toISOString()))){result.deferred='current-source-work';return false;}return true;};
 const deferred=(error:unknown)=>{if(!(error instanceof Error&&(error.name==='TimeoutError'||error.message==='Database request timed out')))throw error;result.deferred='database';result.stage=stage;if(stage.endsWith('.delete'))result.uncertainWrite=true;console.warn('Archive maintenance database deferred',{stage,snapshotId,kind:error.name,...result});};
 try{
  if(!await canWrite())return result;
  token=await step('lease.acquire',()=>scheduler.acquire(leaseId,new Date().toISOString(),Math.max(120000,Math.min(900000,options.deadline-Date.now()+30000))));
  if(!token)return {...result,skipped:1};
  const cutoff=new Date(Date.now()-2*3600000).toISOString(),now=new Date().toISOString();
  const limit=Math.max(0,Math.min(8,options.maxSnapshots)),pageSize=Math.max(16,limit*4),priority="CASE WHEN c.provider='kind-shopify-traffic' THEN 0 WHEN c.provider='kind-meta-performance' THEN 1 WHEN c.provider IN ('kind-shopify-hourly','kind-shopify-funnels') THEN 2 ELSE 3 END",order=`${priority},s.retrievedAt,s.id`;
  const client=options.monthlyRetention?(await store.clients(scope.organizationId)).find(value=>value.id===clientId):undefined;
  if(options.monthlyRetention&&!client)return {...result,skipped:1};
  const history=client?hourlyHistoryWindow(client.timezone):undefined,retained=history&&(clientId==='beam'||clientId==='autobrush')?{...history,from:shiftDate(history.today,-29)}:history,operationalFrom=client&&retained?dayWindow(retained.from,client.timezone).start:undefined;
  // Small stock captures support same-hour comparisons after their date pointer
  // moves. Adding this predicate can only increase the original protections.
  const operationalProtection=operationalFrom?" AND NOT EXISTS(SELECT 1 FROM connections oc WHERE oc.id=s.sourceId AND oc.organizationId=s.organizationId AND oc.clientId=s.clientId AND oc.provider='kind-recharge' AND s.retrievedAt>=?) AND EXISTS(SELECT 1 FROM clients WHERE organizationId=s.organizationId AND id=s.clientId AND timezone=? AND version=?)":'',safeProtection=protectionSql+operationalProtection,operationalArgs=operationalFrom&&client?[operationalFrom,client.timezone,client.version]:[];
  if(client&&retained&&limit&&options.maxRows>0){
   type Pointer=ArchivedSnapshot&{pointerDate:string;pointerPublishedAt:string;pointerDataHash:string|null};
   const retirementLimit=Math.max(1,Math.floor(limit/2));let cursor:{sourceId:string;date:string;id:string}|undefined,verifiedPointers=0;
   for(let pages=0;pages<MAX_CANDIDATE_PAGES&&verifiedPointers<retirementLimit&&!result.deferred&&Date.now()<options.deadline;pages++){
    const after=cursor?' AND (p.sourceId,p.date,s.id)>(?,?,?)':'',values=cursor?[cursor.sourceId,cursor.date,cursor.id]:[];
    const pointers=await step('pointers.candidates',()=>store.all<Pointer>(`SELECT s.*,c.provider,p.date AS pointerDate,p.publishedAt AS pointerPublishedAt,p.dataHash AS pointerDataHash FROM current_snapshots p JOIN snapshots s ON s.id=p.snapshotId AND s.organizationId=p.organizationId AND s.clientId=p.clientId AND s.sourceId=p.sourceId JOIN connections c ON c.id=s.sourceId AND c.organizationId=s.organizationId AND c.clientId=s.clientId WHERE p.organizationId=? AND p.clientId='${clientId}' AND c.provider IN (SELECT value FROM json_each(?)) AND p.date<? AND s.status='ready' AND s.retrievedAt<? AND ${materialization}${after} ORDER BY p.sourceId,p.date,s.id LIMIT ?`,scope.organizationId,JSON.stringify(clientId==='beam'?['beam-shopify-sales','beam-shopify-products','beam-shopify-sessions','beam-shopify-markets','beam-shopify-traffic','beam-motion','beam-intelligems']:clientId==='autobrush'?['autobrush-shopify-sales','autobrush-shopify-products','autobrush-shopify-sessions','autobrush-shopify-markets','autobrush-shopify-traffic','autobrush-motion','autobrush-intelligems']:[...denseHourlyHistoryProviders]),retained.from,cutoff,...values,pageSize));
    if(!pointers.length)break;const last=pointers.at(-1)!;cursor={sourceId:last.sourceId,date:last.pointerDate,id:last.id};
    for(const snapshot of pointers){
     if(verifiedPointers>=retirementLimit||!await canWrite())break;snapshotId=snapshot.id;
     const safety=()=>({sql:`EXISTS(SELECT 1 FROM snapshots s WHERE s.id=? AND s.objectKey=? AND s.retrievedAt=? AND s.sourceId=? AND s.complete=? AND s.coverageThrough IS ? AND ${retirementProtectionSql}) AND EXISTS(SELECT 1 FROM clients WHERE organizationId=? AND id='${clientId}' AND timezone=? AND version=?) AND EXISTS(SELECT 1 FROM connections WHERE id=? AND organizationId=? AND clientId='${clientId}' AND provider=?) AND EXISTS(SELECT 1 FROM current_snapshots WHERE organizationId=? AND clientId='${clientId}' AND sourceId=? AND date=? AND date<? AND snapshotId=? AND publishedAt=? AND dataHash IS ?) AND EXISTS(SELECT 1 FROM runner_leases WHERE id=? AND token=? AND leaseUntil>=?) AND NOT EXISTS(${currentWorkSql})`,args:[snapshot.id,snapshot.objectKey,snapshot.retrievedAt,snapshot.sourceId,snapshot.complete,snapshot.coverageThrough,scope.organizationId,cutoff,new Date().toISOString(),new Date().toISOString(),scope.organizationId,client.timezone,client.version,snapshot.sourceId,scope.organizationId,snapshot.provider,scope.organizationId,snapshot.sourceId,snapshot.pointerDate,retained.from,snapshot.id,snapshot.pointerPublishedAt,snapshot.pointerDataHash,leaseId,token,new Date().toISOString(),scope.organizationId,new Date().toISOString()]});
     const before=safety();if(!await step('pointers.protection',()=>store.first(`SELECT 1 AS eligible WHERE ${before.sql}`,...before.args)))continue;
     let verified;try{verified=await step('pointers.archive.verify',()=>verifiedArchive(store,snapshot,options.readArchive??privateArchive,options.deadline));if(!verified.batch.rows.some(row=>row.date===snapshot.pointerDate))throw Error('Archive does not contain the exact pointed date');verifiedPointers++;result.verifiedSnapshots++;}catch{result.skipped++;continue;}
     if(!await canWrite())break;
     const auditId=`archive-current-date:${snapshot.id}:${snapshot.pointerDate}:${await fingerprint([snapshot.pointerPublishedAt,snapshot.pointerDataHash])}`,proof=JSON.stringify({snapshotId:snapshot.id,sourceId:snapshot.sourceId,date:snapshot.pointerDate,publishedAt:snapshot.pointerPublishedAt,dataHash:snapshot.pointerDataHash,retainedFrom:retained.from,objectKey:snapshot.objectKey,archiveHash:verified.hash,archiveBytes:verified.archive.bytes,archiveEtag:verified.archive.etag,originalRetrievedAt:snapshot.retrievedAt,originalCoverageThrough:snapshot.coverageThrough}),auditGuard=safety();
     await step('pointers.verification.audit',()=>store.run(`INSERT INTO audit(id,organizationId,clientId,actorId,action,payload,createdAt) SELECT ?,?,?,?,?,?,? WHERE ${auditGuard.sql} ON CONFLICT(id) DO NOTHING`,auditId,scope.organizationId,snapshot.clientId,scope.actorId,'snapshot.current_date.archive_verified',proof,new Date().toISOString(),...auditGuard.args));
     if(!await canWrite())break;const deletionGuard=safety(),deleted=await step('pointers.delete',()=>store.run(`DELETE FROM current_snapshots WHERE organizationId=? AND clientId='${clientId}' AND sourceId=? AND date=? AND snapshotId=? AND publishedAt=? AND dataHash IS ? AND ${deletionGuard.sql} AND EXISTS(SELECT 1 FROM audit WHERE id=? AND organizationId=? AND clientId=? AND action='snapshot.current_date.archive_verified' AND payload=?)`,scope.organizationId,snapshot.sourceId,snapshot.pointerDate,snapshot.id,snapshot.pointerPublishedAt,snapshot.pointerDataHash,...deletionGuard.args,auditId,scope.organizationId,snapshot.clientId,proof));
     if(deleted.meta.changes)result.pointersRetired=(result.pointersRetired??0)+deleted.meta.changes;
    }
    if(pointers.length<pageSize)break;
   }
  }
  // Bound expensive review/AI payload checks before evaluating protection.
  // A LIMIT after those correlated checks scans every old capture first.
  // Protected or unverifiable captures cannot starve a later valid archive.
  // A stable cursor also avoids skipping rows as earlier pages are pruned.
  async function* candidates(){
   let cursor:{priority:number;retrievedAt:string;id:string}|null=null,pages=0;
   while(limit&&pages<MAX_CANDIDATE_PAGES&&!result.deferred&&result.verifiedSnapshots<limit&&result.rowsDeleted<options.maxRows&&Date.now()<options.deadline){
    pages++;
    const after:string=cursor?` AND (${priority},s.retrievedAt,s.id)>(?,?,?)`:'',values:(number|string)[]=cursor?[cursor.priority,cursor.retrievedAt,cursor.id]:[];
    const page:ArchivedSnapshot[]=await step('candidates.read',()=>store.all<ArchivedSnapshot>(`SELECT s.*,c.provider FROM snapshots s LEFT JOIN connections c ON c.id=s.sourceId AND c.organizationId=s.organizationId WHERE s.organizationId=? AND s.clientId='${clientId}' AND s.status IN ('ready','writing') AND s.retrievedAt<?${operationalProtection} AND NOT EXISTS(SELECT 1 FROM current_snapshots p WHERE p.organizationId=s.organizationId AND p.clientId=s.clientId AND p.sourceId=s.sourceId AND p.snapshotId=s.id) AND ${materialization}${after} ORDER BY ${order} LIMIT ?`,scope.organizationId,cutoff,...operationalArgs,...values,pageSize));
    if(!page.length||Date.now()>=options.deadline)return;
    const last:ArchivedSnapshot=page.at(-1)!;cursor={priority:last.provider==='kind-shopify-traffic'?0:last.provider==='kind-meta-performance'?1:['kind-shopify-hourly','kind-shopify-funnels'].includes(last.provider??'')?2:3,retrievedAt:last.retrievedAt,id:last.id};
    const eligible=await step('candidates.protection',()=>store.all<ArchivedSnapshot>(`SELECT s.*,c.provider FROM snapshots s LEFT JOIN connections c ON c.id=s.sourceId AND c.organizationId=s.organizationId WHERE s.id IN (SELECT value FROM json_each(?)) AND ${safeProtection} AND ${materialization} ORDER BY ${order} LIMIT ?`,JSON.stringify(page.map(snapshot=>snapshot.id)),scope.organizationId,cutoff,now,now,...operationalArgs,pageSize));
    for(const snapshot of eligible)yield snapshot;
    if(page.length<pageSize)return;
   }
   if(pages>=MAX_CANDIDATE_PAGES&&!result.deferred&&result.verifiedSnapshots<limit&&result.rowsDeleted<options.maxRows)result.deferred='candidate-page-limit';
  }
  for await(const snapshot of candidates()){
   snapshotId=snapshot.id;
   if(result.deferred||Date.now()>=options.deadline||result.rowsDeleted>=options.maxRows||result.verifiedSnapshots>=limit)break;
   let verified;try{verified=await step('archive.verify',()=>verifiedArchive(store,snapshot,options.readArchive??privateArchive,options.deadline));result.verifiedSnapshots++;}catch{result.skipped++;continue;}
   let removed=0,characters=0,projectionChunks=0,projectionEntries=0,counted=false;
   const countPruned=()=>{if(!counted){result.prunedSnapshots++;counted=true;}};
   const guard=(recovery=true)=>({sql:`EXISTS(SELECT 1 FROM snapshots s WHERE s.id=? AND s.objectKey=? AND s.retrievedAt=? AND s.sourceId=? AND s.complete=? AND s.coverageThrough IS ? AND s.status=? AND ${safeProtection}) AND EXISTS(SELECT 1 FROM runner_leases WHERE id=? AND token=? AND leaseUntil>=?) AND NOT EXISTS(${currentWorkSql})${recovery?" AND EXISTS(SELECT 1 FROM audit WHERE id=? AND organizationId=? AND clientId=? AND action='snapshot.materialization.archive_verified')":''}`,args:[snapshot.id,snapshot.objectKey,snapshot.retrievedAt,snapshot.sourceId,snapshot.complete,snapshot.coverageThrough,snapshot.status,scope.organizationId,cutoff,new Date().toISOString(),new Date().toISOString(),...operationalArgs,leaseId,token,new Date().toISOString(),scope.organizationId,new Date().toISOString(),...recovery?[`archive-materialization:${snapshot.id}`,scope.organizationId,snapshot.clientId]:[]]});
   // Publish the recovery marker before the first bounded delete. Ready replay
   // must fill missing rows even if a timeout leaves part of this day present.
   if(!await canWrite())break;
   const verificationGuard=guard(false);await step('archive.verification.audit',()=>store.run(`INSERT INTO audit(id,organizationId,clientId,actorId,action,payload,createdAt) SELECT ?,?,?,?,?,?,? WHERE ${verificationGuard.sql} ON CONFLICT(id) DO NOTHING`,`archive-materialization:${snapshot.id}`,scope.organizationId,snapshot.clientId,scope.actorId,'snapshot.materialization.archive_verified',JSON.stringify({snapshotId:snapshot.id,sourceId:snapshot.sourceId,objectKey:snapshot.objectKey,archiveHash:verified.hash,archiveBytes:verified.archive.bytes,archiveEtag:verified.archive.etag,originalRetrievedAt:snapshot.retrievedAt,originalCoverageThrough:snapshot.coverageThrough}),new Date().toISOString(),...verificationGuard.args));
   for(;;){
    if(result.rowsDeleted>=options.maxRows||result.deferred||Date.now()>=options.deadline)break;
    const limit=Math.min(500,options.maxRows-result.rowsDeleted),rows=await step('facts.select',()=>store.all<{rowid:number;characters:number}>('SELECT rowid,length(payload) AS characters FROM observations WHERE snapshotId=? ORDER BY date,rowKey LIMIT ?',snapshot.id,limit));
    if(!rows.length||!await canWrite())break;const safety=guard();
    // Select by the snapshot index above, then delete only these rowids. The
    // snapshot index would otherwise rescan every remaining row on each page.
    const deletion=await step('facts.delete',()=>store.run(`DELETE FROM observations NOT INDEXED WHERE snapshotId=? AND rowid IN (SELECT value FROM json_each(?)) AND ${safety.sql}`,snapshot.id,JSON.stringify(rows.map(row=>row.rowid)),...safety.args));
    if(!deletion.meta.changes)break;countPruned();removed+=deletion.meta.changes;result.rowsDeleted+=deletion.meta.changes;
    // A single guarded write removes this exact indexed selection atomically.
    if(deletion.meta.changes===rows.length){const bytes=rows.reduce((sum,row)=>sum+row.characters,0);characters+=bytes;result.charactersDeleted+=bytes;}
   }
   if(!result.deferred&&!await step('facts.remaining',()=>store.first('SELECT 1 AS present FROM observations WHERE snapshotId=? LIMIT 1',snapshot.id))){
    for(;;){if(!await canWrite())break;const safety=guard(),deletion=await step('projections.chunks.delete',()=>store.run(`DELETE FROM snapshot_day_projection_chunks WHERE organizationId=? AND clientId=? AND snapshotId=? AND rowid IN (SELECT rowid FROM snapshot_day_projection_chunks WHERE organizationId=? AND clientId=? AND snapshotId=? ORDER BY date,codecVersion,generation,chunkIndex LIMIT 64) AND ${safety.sql} AND NOT EXISTS(SELECT 1 FROM observations WHERE snapshotId=?)`,scope.organizationId,snapshot.clientId,snapshot.id,scope.organizationId,snapshot.clientId,snapshot.id,...safety.args,snapshot.id));if(deletion.meta.changes)countPruned();projectionChunks+=deletion.meta.changes;result.projectionChunksDeleted+=deletion.meta.changes;if(deletion.meta.changes<64)break;}
    if(await canWrite()){const safety=guard(),deletion=await step('projections.entries.delete',()=>store.run(`DELETE FROM snapshot_day_projection_entries WHERE organizationId=? AND clientId=? AND snapshotId=? AND status='ready' AND rowid IN (SELECT rowid FROM snapshot_day_projection_entries WHERE organizationId=? AND clientId=? AND snapshotId=? ORDER BY date,codecVersion LIMIT 64) AND ${safety.sql} AND NOT EXISTS(SELECT 1 FROM snapshot_day_projection_chunks WHERE organizationId=? AND clientId=? AND snapshotId=?) AND NOT EXISTS(SELECT 1 FROM observations WHERE snapshotId=?)`,scope.organizationId,snapshot.clientId,snapshot.id,scope.organizationId,snapshot.clientId,snapshot.id,...safety.args,scope.organizationId,snapshot.clientId,snapshot.id,snapshot.id));projectionEntries=deletion.meta.changes;if(projectionEntries){countPruned();result.projectionEntriesDeleted=(result.projectionEntriesDeleted??0)+projectionEntries;}}
   }
   if((removed||projectionChunks||projectionEntries)&&await canWrite())await step('archive.completion.audit',()=>store.audit(scope.organizationId,snapshot.clientId,scope.actorId,'snapshot.materialization.archived',{snapshotId:snapshot.id,sourceId:snapshot.sourceId,objectKey:snapshot.objectKey,archiveHash:verified.hash,archiveBytes:verified.archive.bytes,archiveEtag:verified.archive.etag,originalRetrievedAt:snapshot.retrievedAt,originalCoverageThrough:snapshot.coverageThrough,rowsDeleted:removed,payloadCharactersDeleted:characters,projectionChunksDeleted:projectionChunks,projectionEntriesDeleted:projectionEntries}));
  }
  if(Date.now()>=options.deadline&&!result.deferred)result.deferred='deadline';
  return result;
 }catch(error){deferred(error);return result;}
 finally{if(token)try{await step('lease.release',()=>scheduler.release(leaseId,token!));}catch(error){deferred(error);}}
}

/** Recovery uses the original timestamp: reconstruct immutable facts without
 * replacing a newer current pointer or inventing new retrieval provenance. */
export async function restoreArchivedMaterialization(store:Store,scope:AccessScope,snapshotId:string,options:{deadline:number;readArchive?:ArchiveReader;clientId?:'kind-patches'|'beam'|'autobrush'}){
 const clientId=options.clientId??'kind-patches';
 if(!['kind-patches','beam','autobrush'].includes(clientId)||!['admin','service'].includes(scope.role)||!scope.permittedClientIds.includes(clientId))throw Error('Archive recovery access denied');
 const scheduler=new DailyScheduler(store),leaseId=`${scope.organizationId}:archive-materializations${clientId==='kind-patches'?'':':'+clientId}`,token=await scheduler.acquire(leaseId,new Date().toISOString(),900000);
 if(!token)throw Error('Archive maintenance is already running');
 try{
  const snapshot=await store.first<ArchivedSnapshot>("SELECT s.*,c.provider FROM snapshots s LEFT JOIN connections c ON c.id=s.sourceId AND c.organizationId=s.organizationId WHERE s.id=? AND s.organizationId=? AND s.clientId=? AND s.status='ready'",snapshotId,scope.organizationId,clientId);if(!snapshot)throw Error('Recoverable snapshot is unavailable');
  const verified=await verifiedArchive(store,snapshot,options.readArchive??privateArchive,options.deadline);
  return await store.persistBatch(scope.organizationId,snapshot.sourceId,verified.batch,verified.hash,snapshot.retrievedAt,undefined,{restoreMaterialization:true,...(['kind-shopify-traffic','kind-meta-performance','beam-shopify-traffic','autobrush-shopify-traffic'].includes(snapshot.provider??'')?{factPageSize:500 as const}:{})});
 }finally{await scheduler.release(leaseId,token);}
}
