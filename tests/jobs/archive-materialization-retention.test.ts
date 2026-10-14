import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import initial from '../../data/initial-clients.json';
import type {AccessScope,SourceBatch} from '../../lib/analytics/contracts';
import {fingerprint} from '../../lib/reviews/build';
import {pruneArchivedMaterializations,restoreArchivedMaterialization,type ArchiveReader} from '../../lib/jobs/archive-materialization-retention';
vi.mock('../../lib/server/secrets',()=>({serverSecret:()=>null}));

const scope:AccessScope={organizationId:'o',actorId:'history-scheduler',role:'service',permittedClientIds:['kind-patches']},client={...initial[0],version:1};
let sqlite:DatabaseSync,store:Store,archives:Map<string,string>,oldId:string,currentId:string,oldBatch:SourceBatch;
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-13T18:00:00Z');sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:unknown[]=[];const statement={bind(...input:unknown[]){values=input;return statement;},async all(){return {results:sqlite.prepare(sql).all(...values as any[])};},async first(){return sqlite.prepare(sql).get(...values as any[])??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values as any[]).changes)}};}};return statement;};
 store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))});archives=new Map();
 await store.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',client.id,'o',client.name,client.id,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);
 await store.run("INSERT INTO connections VALUES('source','o','kind-patches','Source','kind-shopify-sales','https://example.com','PRIVATE',60,1,'2026-10-13T17:00:00Z','2026-10-13T17:00:00Z',NULL,1)");
 const batch=(value:number):SourceBatch=>({clientId:client.id,timezone:client.timezone,currency:client.currency,grain:'hourly',channels:[],dimensions:[],complete:true,coverageThrough:'2026-10-13T10:00:00Z',rows:[0,1,2].map(hour=>({date:'2026-10-13',dataset:'revenue',metric:'revenue',population:'sales',value:value+hour,definition:'qualified',currency:'USD',dimensions:{},sourceId:'',retrievedAt:'',coverageThrough:null,quality:'complete',start:`2026-10-13T${String(hour+7).padStart(2,'0')}:00:00Z`,end:`2026-10-13T${String(hour+8).padStart(2,'0')}:00:00Z`}))});
 oldBatch=batch(40);const oldHash=await fingerprint(oldBatch);oldId=await store.persistBatch('o','source',oldBatch,oldHash,'2026-10-13T10:00:00Z');archives.set(`snapshots/${oldId}.json`,JSON.stringify(oldBatch));
 const current=batch(90),hash=await fingerprint(current);currentId=await store.persistBatch('o','source',current,hash,'2026-10-13T11:00:00Z');archives.set(`snapshots/${currentId}.json`,JSON.stringify(current));
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();sqlite.close();});
const reader:ArchiveReader=async key=>{const text=archives.get(key);if(!text)throw Error('Missing archive');return {text,bytes:new TextEncoder().encode(text).byteLength,pathname:key,etag:'verified-etag'};};
const options=()=>({maxSnapshots:4,maxRows:2000,deadline:Date.now()+60000,readArchive:reader});

it('prunes only superseded materializations while preserving current facts, immutable metadata, original archives and audit evidence',async()=>{
 const metadata=await store.all('SELECT * FROM snapshots ORDER BY id'),current=await store.all('SELECT * FROM observations WHERE snapshotId=?',currentId),archiveBefore=[...archives.entries()];
 const result=await pruneArchivedMaterializations(store,scope,options());expect(result.rowsDeleted).toBe(3);expect(result.prunedSnapshots).toBe(1);
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=?',oldId)).toEqual([]);expect(await store.all('SELECT * FROM observations WHERE snapshotId=?',currentId)).toEqual(current);expect(await store.all('SELECT * FROM snapshots ORDER BY id')).toEqual(metadata);expect([...archives.entries()]).toEqual(archiveBefore);
 expect(await store.all('SELECT * FROM snapshot_day_projection_entries WHERE snapshotId=?',oldId)).toEqual([]);expect(await store.all('SELECT * FROM snapshot_day_projection_chunks WHERE snapshotId=?',oldId)).toEqual([]);expect(await store.first('SELECT COUNT(*) AS n FROM audit')).toEqual({n:2});
});
it('bounds payload protection scans before selecting a small maintenance batch',async()=>{
 const sample=await store.first<{date:string;rowKey:string;payload:string}>('SELECT date,rowKey,payload FROM observations WHERE snapshotId=? LIMIT 1',oldId);
 for(let index=0;index<100;index++){
  const id=`unreferenced-${index}`;
  await store.run("INSERT INTO snapshots SELECT ?,organizationId,clientId,sourceId,'2026-10-13T12:00:00Z',coverageThrough,complete,status,objectKey FROM snapshots WHERE id=?",id,oldId);
  await store.run('INSERT INTO observations VALUES(?,?,?,?)',id,sample!.date,sample!.rowKey,sample!.payload);
 }
 await store.saveReview('o',client.id,'2026-10-13','unrelated',{evidence:'unrelated capture'},'2026-10-13T13:00:00Z');
 let payloadChecks=0;sqlite.function('instr',(value,needle)=>{payloadChecks++;return String(value).indexOf(String(needle))+1;});
 const result=await pruneArchivedMaterializations(store,scope,{...options(),maxSnapshots:1});
 expect(result.rowsDeleted).toBe(3);expect(result.prunedSnapshots).toBe(1);expect(payloadChecks).toBeLessThan(80);
 expect(await store.first('SELECT COUNT(*) AS n FROM observations WHERE snapshotId=?',currentId)).toEqual({n:3});
});
it('continues through protected candidate pages without starving a later recoverable capture',async()=>{
 const sample=await store.first<{date:string;rowKey:string;payload:string}>('SELECT date,rowKey,payload FROM observations WHERE snapshotId=? LIMIT 1',oldId),protectedIds:string[]=[];
 for(let index=0;index<22;index++){
  const id=`review-protected-${index}`;protectedIds.push(id);
  await store.run("INSERT INTO snapshots SELECT ?,organizationId,clientId,sourceId,'2026-10-13T09:00:00Z',coverageThrough,complete,status,objectKey FROM snapshots WHERE id=?",id,oldId);
  await store.run('INSERT INTO observations VALUES(?,?,?,?)',id,sample!.date,sample!.rowKey,sample!.payload);
 }
 await store.saveReview('o',client.id,'2026-10-13','protected',{snapshotIds:protectedIds},'2026-10-13T13:00:00Z');
 const read=vi.fn(reader),result=await pruneArchivedMaterializations(store,scope,{...options(),maxSnapshots:1,readArchive:read});
 expect(result.rowsDeleted).toBe(3);expect(read).toHaveBeenCalledOnce();
 expect(await store.first("SELECT COUNT(*) AS n FROM observations WHERE snapshotId LIKE 'review-protected-%'")).toEqual({n:22});
});
it('bounds candidate paging when protected captures fill every page',async()=>{
 const sample=await store.first<{date:string;rowKey:string;payload:string}>('SELECT date,rowKey,payload FROM observations WHERE snapshotId=? LIMIT 1',oldId),protectedIds:string[]=[];
 for(let index=0;index<513;index++){
  const id=`protected-${index}`;protectedIds.push(id);
  await store.run("INSERT INTO snapshots SELECT ?,organizationId,clientId,sourceId,'2026-10-13T09:00:00Z',coverageThrough,complete,status,objectKey FROM snapshots WHERE id=?",id,oldId);
  await store.run('INSERT INTO observations VALUES(?,?,?,?)',id,sample!.date,sample!.rowKey,sample!.payload);
 }
 await store.saveReview('o',client.id,'2026-10-13','protected',{snapshotIds:protectedIds},'2026-10-13T13:00:00Z');
 expect(await pruneArchivedMaterializations(store,scope,{...options(),maxSnapshots:1})).toMatchObject({rowsDeleted:0,deferred:'candidate-page-limit'});
 expect(await store.first('SELECT COUNT(*) n FROM observations WHERE snapshotId=?',oldId)).toEqual({n:3});
});
it('continues after eight missing archives to prune a later verified capture',async()=>{
 const sample=await store.first<{date:string;rowKey:string;payload:string}>('SELECT date,rowKey,payload FROM observations WHERE snapshotId=? LIMIT 1',oldId);
 for(let index=0;index<8;index++){
  const id=`missing-archive-${index}`;
  await store.run("INSERT INTO snapshots SELECT ?,organizationId,clientId,sourceId,'2026-10-13T09:00:00Z',coverageThrough,complete,status,? FROM snapshots WHERE id=?",id,`snapshots/${id}.json`,oldId);
  await store.run('INSERT INTO observations VALUES(?,?,?,?)',id,sample!.date,sample!.rowKey,sample!.payload);
 }
 const current=await store.all('SELECT * FROM observations WHERE snapshotId=?',currentId),metadata=await store.all('SELECT * FROM snapshots ORDER BY id');
 const result=await pruneArchivedMaterializations(store,scope,{...options(),maxSnapshots:8});
 expect(result).toMatchObject({verifiedSnapshots:1,prunedSnapshots:1,rowsDeleted:3,skipped:8});
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=?',oldId)).toEqual([]);
 expect(await store.first("SELECT COUNT(*) AS n FROM observations WHERE snapshotId LIKE 'missing-archive-%'")).toEqual({n:8});
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=?',currentId)).toEqual(current);
 expect(await store.all('SELECT * FROM snapshots ORDER BY id')).toEqual(metadata);
});
it('continues across pages after pruning earlier candidates and stops at the verified snapshot limit',async()=>{
 const sample=await store.first<{date:string;rowKey:string;payload:string}>('SELECT date,rowKey,payload FROM observations WHERE snapshotId=? LIMIT 1',oldId);
 for(let index=0;index<15;index++){
  const id=`missing-archive-${index}`;
  await store.run("INSERT INTO snapshots SELECT ?,organizationId,clientId,sourceId,'2026-10-13T09:00:00Z',coverageThrough,complete,status,? FROM snapshots WHERE id=?",id,`snapshots/${id}.json`,oldId);
  await store.run('INSERT INTO observations VALUES(?,?,?,?)',id,sample!.date,sample!.rowKey,sample!.payload);
 }
 const pointer=await store.first<{snapshotId:string;publishedAt:string;dataHash:string|null}>('SELECT snapshotId,publishedAt,dataHash FROM current_snapshots'),laterIds:string[]=[];
 for(let index=0;index<2;index++){
  const batch={...oldBatch,rows:oldBatch.rows.map(row=>({...row,value:row.value!+100+index}))},hash=await fingerprint(batch);
  const id=await store.persistBatch('o','source',batch,hash,`2026-10-13T${12+index}:00:00Z`,undefined,{restoreMaterialization:true});
  laterIds.push(id);archives.set(`snapshots/${id}.json`,JSON.stringify(batch));
 }
 await store.run('UPDATE current_snapshots SET snapshotId=?,publishedAt=?,dataHash=?',pointer!.snapshotId,pointer!.publishedAt,pointer!.dataHash);
 const pointers=await store.all('SELECT * FROM current_snapshots'),current=await store.all('SELECT * FROM observations WHERE snapshotId=?',currentId);
 const result=await pruneArchivedMaterializations(store,scope,{...options(),maxSnapshots:2});
 expect(result).toMatchObject({verifiedSnapshots:2,prunedSnapshots:2,rowsDeleted:6,skipped:15});
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=?',oldId)).toEqual([]);
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=?',laterIds[0])).toEqual([]);
 expect(await store.first('SELECT COUNT(*) AS n FROM observations WHERE snapshotId=?',laterIds[1])).toEqual({n:3});
 expect(await store.first("SELECT COUNT(*) AS n FROM observations WHERE snapshotId LIKE 'missing-archive-%'")).toEqual({n:15});
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=?',currentId)).toEqual(current);
 expect(await store.all('SELECT * FROM current_snapshots')).toEqual(pointers);
});
it('stops verification failures at the original maintenance deadline',async()=>{
 const sample=await store.first<{date:string;rowKey:string;payload:string}>('SELECT date,rowKey,payload FROM observations WHERE snapshotId=? LIMIT 1',oldId);
 for(let index=0;index<8;index++){
  const id=`missing-archive-${index}`;
  await store.run("INSERT INTO snapshots SELECT ?,organizationId,clientId,sourceId,'2026-10-13T09:00:00Z',coverageThrough,complete,status,? FROM snapshots WHERE id=?",id,`snapshots/${id}.json`,oldId);
  await store.run('INSERT INTO observations VALUES(?,?,?,?)',id,sample!.date,sample!.rowKey,sample!.payload);
 }
 const result=await pruneArchivedMaterializations(store,scope,{...options(),maxSnapshots:8,readArchive:async(key,deadline)=>{vi.advanceTimersByTime(20000);return reader(key,deadline);}});
 expect(result).toMatchObject({verifiedSnapshots:0,prunedSnapshots:0,rowsDeleted:0,skipped:3});
 expect(await store.first('SELECT COUNT(*) AS n FROM observations WHERE snapshotId=?',oldId)).toEqual({n:3});
 expect(await store.first("SELECT COUNT(*) AS n FROM observations WHERE snapshotId LIKE 'missing-archive-%'")).toEqual({n:8});
 expect(await store.all('SELECT * FROM runner_leases')).toEqual([]);
});
it('restores exactly the original values and retrieval provenance from the verified archive without moving the current pointer',async()=>{
 const facts=await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY date,rowKey',oldId),metadata=await store.first('SELECT * FROM snapshots WHERE id=?',oldId),pointer=await store.all('SELECT * FROM current_snapshots');
 await pruneArchivedMaterializations(store,scope,options());await restoreArchivedMaterialization(store,scope,oldId,{readArchive:reader,deadline:Date.now()+60000});
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY date,rowKey',oldId)).toEqual(facts);expect(await store.first('SELECT * FROM snapshots WHERE id=?',oldId)).toEqual(metadata);expect(await store.all('SELECT * FROM current_snapshots')).toEqual(pointer);
});
it('bounds each maintenance call and retains projections until all corresponding raw rows are pruned',async()=>{
 const result=await pruneArchivedMaterializations(store,scope,{...options(),maxRows:1});expect(result.rowsDeleted).toBe(1);expect(await store.first('SELECT COUNT(*) AS n FROM observations WHERE snapshotId=?',oldId)).toEqual({n:2});expect(await store.first('SELECT COUNT(*) AS n FROM snapshot_day_projection_entries WHERE snapshotId=?',oldId)).toEqual({n:1});
});
it('uses direct rowid lookups for each guarded delete instead of rescanning the whole capture',async()=>{
 const run=store.run.bind(store),all=store.all.bind(store),deletions:any[]=[],selections:any[]=[];
 vi.spyOn(store,'run').mockImplementation(async(sql,...args)=>{if(sql.startsWith('DELETE FROM observations'))deletions.push(...sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args as any[]));return run(sql,...args);});
 vi.spyOn(store,'all').mockImplementation(async(sql,...args)=>{if(sql.startsWith('SELECT rowid,length(payload)'))selections.push(...sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args as any[]));return all(sql,...args);});
 expect((await pruneArchivedMaterializations(store,scope,options())).rowsDeleted).toBe(3);
 expect(deletions.some(row=>/SEARCH observations USING INTEGER PRIMARY KEY \(rowid=\?\)/.test(row.detail))).toBe(true);
 expect(deletions.some(row=>/SEARCH observations.*\(snapshotId=\?\)/.test(row.detail))).toBe(false);
 expect(selections.some(row=>/SEARCH observations.*\(snapshotId=\?\)/.test(row.detail))).toBe(true);
 expect(selections.some(row=>/TEMP B-TREE|SCAN observations/.test(row.detail))).toBe(false);
});
it('fills a partially pruned capture on verified archive replay without dropping its original provenance',async()=>{
 const before=await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY date,rowKey',oldId);
 await pruneArchivedMaterializations(store,scope,{...options(),maxRows:1});await restoreArchivedMaterialization(store,scope,oldId,{readArchive:reader,deadline:Date.now()+60000});
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY date,rowKey',oldId)).toEqual(before);
});
it('replays a partial writing capture with its original retrieval metadata instead of mixing retry timestamps',async()=>{
 const facts=await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY date,rowKey',oldId),metadata=await store.first('SELECT * FROM snapshots WHERE id=?',oldId);
 await store.run("UPDATE snapshots SET status='writing' WHERE id=?",oldId);
 await store.run("UPDATE current_snapshots SET publishedAt='2026-10-13T19:00:00Z'");
 const pointer=await store.all('SELECT * FROM current_snapshots');
 await store.run('DELETE FROM observations WHERE snapshotId=? AND rowid IN (SELECT rowid FROM observations WHERE snapshotId=? LIMIT 1)',oldId,oldId);
 await store.persistBatch('o','source',oldBatch,await fingerprint(oldBatch),'2026-10-13T18:00:00Z');
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY date,rowKey',oldId)).toEqual(facts);
 expect(await store.first('SELECT * FROM snapshots WHERE id=?',oldId)).toEqual(metadata);
 expect(await store.all('SELECT * FROM current_snapshots')).toEqual(pointer);
});
it('fills a partially pruned capture before an ordinary provider replay makes it current again',async()=>{
 await pruneArchivedMaterializations(store,scope,{...options(),maxRows:1});await store.persistBatch('o','source',oldBatch,await fingerprint(oldBatch),'2026-10-13T18:00:00Z');
 expect(await store.first('SELECT COUNT(*) AS n FROM observations WHERE snapshotId=?',oldId)).toEqual({n:3});expect(await store.first('SELECT snapshotId FROM current_snapshots')).toEqual({snapshotId:oldId});
});
it('protects a frozen review matching the original source and retrieval timestamp',async()=>{
 await store.saveReview('o',client.id,'2026-10-13','frozen',{evidence:{sourceId:'source',retrievedAt:'2026-10-13T10:00:00Z'}},'2026-10-13T13:00:00Z');const before=await store.all('SELECT * FROM reviews');
 expect((await pruneArchivedMaterializations(store,scope,options())).rowsDeleted).toBe(0);expect(await store.all('SELECT * FROM reviews')).toEqual(before);expect(await store.first('SELECT COUNT(*) AS n FROM observations WHERE snapshotId=?',oldId)).toEqual({n:3});
});
it('protects active source jobs and fresh writing captures',async()=>{
 await store.enqueue('o',client.id,'source','current','2026-10-13T17:00:00Z');await store.run("UPDATE jobs SET status='running',leaseUntil='2026-10-13T18:15:00Z'");expect((await pruneArchivedMaterializations(store,scope,options())).rowsDeleted).toBe(0);
 await store.run('DELETE FROM jobs');await store.run("UPDATE snapshots SET status='writing',retrievedAt='2026-10-13T17:00:00Z' WHERE id=?",oldId);expect((await pruneArchivedMaterializations(store,scope,options())).rowsDeleted).toBe(0);
});
it('prunes a verified stale partial writing copy without publishing it and replays exact original facts safely',async()=>{
 const original=await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY date,rowKey',oldId);
 await store.run("UPDATE snapshots SET status='writing' WHERE id=?",oldId);
 await store.run('DELETE FROM observations WHERE snapshotId=? AND rowid IN (SELECT rowid FROM observations WHERE snapshotId=? LIMIT 1)',oldId,oldId);
 const metadata=await store.all('SELECT * FROM snapshots ORDER BY id'),pointers=await store.all('SELECT * FROM current_snapshots'),raw=[...archives.entries()];
 const result=await pruneArchivedMaterializations(store,scope,options());
 expect(result).toMatchObject({verifiedSnapshots:1,prunedSnapshots:1,rowsDeleted:2});
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=?',oldId)).toEqual([]);
 expect(await store.all('SELECT * FROM snapshots ORDER BY id')).toEqual(metadata);
 expect(await store.all('SELECT * FROM current_snapshots')).toEqual(pointers);expect([...archives.entries()]).toEqual(raw);
 expect(await store.first("SELECT action FROM audit WHERE id=?",`archive-materialization:${oldId}`)).toEqual({action:'snapshot.materialization.archive_verified'});
 await store.persistBatch('o','source',oldBatch,await fingerprint(oldBatch),'2026-10-13T10:00:00Z');
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY date,rowKey',oldId)).toEqual(original);
 expect(await store.first('SELECT retrievedAt,coverageThrough,complete,objectKey FROM snapshots WHERE id=?',oldId)).toEqual({retrievedAt:'2026-10-13T10:00:00Z',coverageThrough:'2026-10-13T10:00:00Z',complete:1,objectKey:`snapshots/${oldId}.json`});
 expect(await store.all('SELECT * FROM current_snapshots')).toEqual(pointers);
});
it.each(['fresh','missing-archive','bad-hash','wrong-path','wrong-bytes','coverage-mismatch','complete-mismatch','client-timezone-mismatch','schema-invalid','wrong-client','current-pointer','running-source-job','running-review','writing-projection','review-evidence','ai-evidence','pointer-race','maintenance-token-race'])('retains a partial writing copy protected by %s',async protectedBy=>{
 await store.run("UPDATE snapshots SET status='writing' WHERE id=?",oldId);
 await store.run('DELETE FROM observations WHERE snapshotId=? AND rowid IN (SELECT rowid FROM observations WHERE snapshotId=? LIMIT 1)',oldId,oldId);
 if(protectedBy==='fresh')await store.run("UPDATE snapshots SET retrievedAt='2026-10-13T17:00:00Z' WHERE id=?",oldId);
 if(protectedBy==='missing-archive')archives.delete(`snapshots/${oldId}.json`);
 if(protectedBy==='bad-hash')archives.set(`snapshots/${oldId}.json`,JSON.stringify({...oldBatch,rows:[]}));
 if(protectedBy==='coverage-mismatch')await store.run("UPDATE snapshots SET coverageThrough='2026-10-13T11:00:00Z' WHERE id=?",oldId);
 if(protectedBy==='complete-mismatch')await store.run('UPDATE snapshots SET complete=0 WHERE id=?',oldId);
 if(protectedBy==='client-timezone-mismatch')await store.run("UPDATE clients SET timezone='America/Chicago' WHERE id=?",client.id);
 if(protectedBy==='schema-invalid'||protectedBy==='wrong-client'){
  const invalid=protectedBy==='wrong-client'?{...oldBatch,clientId:'another-client'}:{...oldBatch,rows:oldBatch.rows.map(row=>({...row,date:'invalid-date'}))};
  const invalidId=`o:kind-patches:source:${await fingerprint(invalid)}`;
  await store.run('INSERT INTO snapshots SELECT ?,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,? FROM snapshots WHERE id=?',invalidId,`snapshots/${invalidId}.json`,oldId);
  await store.run('UPDATE observations SET snapshotId=? WHERE snapshotId=?',invalidId,oldId);oldId=invalidId;archives.set(`snapshots/${oldId}.json`,JSON.stringify(invalid));
 }
 if(protectedBy==='current-pointer'){await store.run('UPDATE current_snapshots SET snapshotId=?',oldId);await store.run("UPDATE snapshots SET retrievedAt='2026-10-13T17:00:00Z' WHERE id=?",currentId);}
 if(protectedBy==='running-source-job'){await store.enqueue('o',client.id,'source','hourly-history:2026-10-12','2026-10-13T17:00:00Z');await store.run("UPDATE jobs SET status='running',leaseUntil='2026-10-13T18:15:00Z'");}
 if(protectedBy==='running-review')await store.run("INSERT INTO scheduled_reviews(id,organizationId,clientId,storeDate,mode,status,attempts,dueAt,leaseToken,leaseUntil) VALUES('review','o','kind-patches','2026-10-13','partial','running',1,'2026-10-13T17:00:00Z','review-token','2026-10-13T18:15:00Z')");
 if(protectedBy==='writing-projection')await store.run("UPDATE snapshot_day_projection_entries SET status='writing' WHERE snapshotId=?",oldId);
 if(protectedBy==='review-evidence')await store.saveReview('o',client.id,'2026-10-13','frozen',{snapshotId:oldId},'2026-10-13T13:00:00Z');
 if(protectedBy==='ai-evidence')await store.run('INSERT INTO ai_turns VALUES(?,?,?,?,?,?,?)','turn','o','actor','scope','question',JSON.stringify({sourceId:'source',retrievedAt:'2026-10-13T10:00:00Z'}),'2026-10-13T13:00:00Z');
 const facts=await store.all('SELECT * FROM observations ORDER BY snapshotId,date,rowKey'),metadata=await store.all('SELECT * FROM snapshots ORDER BY id');
 const guardedReader:ArchiveReader=async(key,deadline)=>{const archive=await reader(key,deadline);
  if(protectedBy==='wrong-path')return {...archive,pathname:'another-archive'};
  if(protectedBy==='wrong-bytes')return {...archive,bytes:archive.bytes+1};
  if(protectedBy==='pointer-race')await store.run('UPDATE current_snapshots SET snapshotId=?',oldId);
  if(protectedBy==='maintenance-token-race')await store.run('DELETE FROM runner_leases');
  return archive;
 };
 expect((await pruneArchivedMaterializations(store,scope,{...options(),readArchive:guardedReader})).rowsDeleted).toBe(0);
 expect(await store.all('SELECT * FROM observations ORDER BY snapshotId,date,rowKey')).toEqual(facts);
 expect(await store.all('SELECT * FROM snapshots ORDER BY id')).toEqual(metadata);
});
async function currentWork(){
 await store.run("INSERT INTO connections VALUES('other-source','o','kind-patches','Other','kind-meta','https://example.com','PRIVATE',60,1,NULL,NULL,NULL,1)");
 await store.enqueue('o',client.id,'other-source','current','2026-10-13T17:00:00Z');
}
it('yields before maintenance writes when another enabled current source is due',async()=>{
 await currentWork();const facts=await store.all('SELECT * FROM observations'),audit=await store.all('SELECT * FROM audit');
 expect(await pruneArchivedMaterializations(store,scope,options())).toMatchObject({rowsDeleted:0,deferred:'current-source-work'});
 expect(await store.all('SELECT * FROM observations')).toEqual(facts);expect(await store.all('SELECT * FROM audit')).toEqual(audit);expect(await store.all('SELECT * FROM runner_leases')).toEqual([]);
});
it.each(['disabled','historical','future'])('does not defer cleanup for %s current-work metadata',async ignored=>{
 await currentWork();
 if(ignored==='disabled')await store.run("UPDATE connections SET enabled=0 WHERE id='other-source'");
 if(ignored==='historical')await store.run("UPDATE jobs SET id='o:other-source:hourly-history:2026-10-12'");
 if(ignored==='future')await store.run("UPDATE jobs SET dueAt='2026-10-13T19:00:00Z'");
 expect((await pruneArchivedMaterializations(store,scope,options())).rowsDeleted).toBe(3);
});
it('rechecks current-source priority after remote archive verification',async()=>{
 const facts=await store.all('SELECT * FROM observations');
 const result=await pruneArchivedMaterializations(store,scope,{...options(),readArchive:async(key,deadline)=>{const archive=await reader(key,deadline);await currentWork();return archive;}});
 expect(result).toMatchObject({verifiedSnapshots:1,rowsDeleted:0,deferred:'current-source-work'});
 expect(await store.all('SELECT * FROM observations')).toEqual(facts);expect(await store.all('SELECT * FROM audit')).toEqual([]);
});
it('protects every fact when current work appears between the last priority check and the guarded delete',async()=>{
 const facts=await store.all('SELECT * FROM observations'),run=store.run.bind(store);let raced=false;
 vi.spyOn(store,'run').mockImplementation(async(sql,...args)=>{if(!raced&&sql.startsWith('DELETE FROM observations')){raced=true;await currentWork();}return run(sql,...args);});
 expect((await pruneArchivedMaterializations(store,scope,options())).rowsDeleted).toBe(0);
 expect(await store.all('SELECT * FROM observations')).toEqual(facts);
});
it('requires a durable recovery marker when protections lift after the verification audit was blocked',async()=>{
 const facts=await store.all('SELECT * FROM observations'),run=store.run.bind(store);let raced=false;
 vi.spyOn(store,'run').mockImplementation(async(sql,...args)=>{if(!raced&&sql.startsWith('INSERT INTO audit')){raced=true;await run('UPDATE current_snapshots SET snapshotId=?',oldId);const result=await run(sql,...args);await run('UPDATE current_snapshots SET snapshotId=?',currentId);return result;}return run(sql,...args);});
 expect((await pruneArchivedMaterializations(store,scope,options())).rowsDeleted).toBe(0);
 expect(await store.all('SELECT * FROM observations')).toEqual(facts);expect(await store.all('SELECT * FROM audit')).toEqual([]);
});
it('yields between fact pages when current work becomes due after confirmed progress',async()=>{
 await store.run('DELETE FROM observations WHERE snapshotId=?',oldId);
 const large={...oldBatch,dimensions:['page'],rows:Array.from({length:3001},(_,index)=>({...oldBatch.rows[0],dimensions:{page:String(index)}}))};
 const hash=await fingerprint(large);oldId=await store.persistBatch('o','source',large,hash,'2026-10-13T10:00:00Z',undefined,{restoreMaterialization:true});archives.set(`snapshots/${oldId}.json`,JSON.stringify(large));
 await store.run("UPDATE snapshots SET status='writing' WHERE id=?",oldId);
 const metadata=await store.first('SELECT * FROM snapshots WHERE id=?',oldId),pointer=await store.all('SELECT * FROM current_snapshots'),run=store.run.bind(store);let pages=0;
 vi.spyOn(store,'run').mockImplementation(async(sql,...args)=>{const result=await run(sql,...args);if(sql.startsWith('DELETE FROM observations')&&++pages===1)await currentWork();return result;});
 expect(await pruneArchivedMaterializations(store,scope,{...options(),maxRows:5000})).toMatchObject({verifiedSnapshots:1,prunedSnapshots:1,rowsDeleted:2000,deferred:'current-source-work'});
 expect(await store.first('SELECT COUNT(*) n FROM observations WHERE snapshotId=?',oldId)).toEqual({n:1001});
 expect(await store.first('SELECT * FROM snapshots WHERE id=?',oldId)).toEqual(metadata);expect(await store.all('SELECT * FROM current_snapshots')).toEqual(pointer);
});
it('does not claim unknown deletion counts after a committed write loses its response and restores exact facts',async()=>{
 const facts=await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY date,rowKey',oldId),run=store.run.bind(store);
 vi.spyOn(store,'run').mockImplementation(async(sql,...args)=>{const result=await run(sql,...args);if(sql.startsWith('DELETE FROM observations'))throw new DOMException('Database request timed out','TimeoutError');return result;});
 expect(await pruneArchivedMaterializations(store,scope,options())).toMatchObject({rowsDeleted:0,prunedSnapshots:0,deferred:'database',stage:'facts.delete',uncertainWrite:true});
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=?',oldId)).toEqual([]);
 await restoreArchivedMaterialization(store,scope,oldId,{readArchive:reader,deadline:Date.now()+60000});
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY date,rowKey',oldId)).toEqual(facts);
});
async function committedFactTimeout(){
 const run=store.run.bind(store);let lost=false;
 vi.spyOn(store,'run').mockImplementation(async(sql,...args)=>{const result=await run(sql,...args);if(!lost&&sql.startsWith('DELETE FROM observations')){lost=true;throw new DOMException('Database request timed out','TimeoutError');}return result;});
 const result=await pruneArchivedMaterializations(store,scope,options());
 expect(result).toMatchObject({rowsDeleted:0,prunedSnapshots:0,deferred:'database',stage:'facts.delete',uncertainWrite:true});
 expect(await store.first('SELECT COUNT(*) n FROM observations WHERE snapshotId=?',oldId)).toEqual({n:0});
}
it.each(['ready','writing'])('revisits verified orphan projections after the last %s fact delete loses its response',async status=>{
 await store.run('UPDATE snapshots SET status=? WHERE id=?',status,oldId);
 const metadata=await store.all('SELECT * FROM snapshots ORDER BY id'),pointers=await store.all('SELECT * FROM current_snapshots'),raw=[...archives.entries()];
 await committedFactTimeout();
 expect(await store.first('SELECT COUNT(*) n FROM snapshot_day_projection_chunks WHERE snapshotId=?',oldId)).toEqual({n:1});
 const result=await pruneArchivedMaterializations(store,scope,options());
 expect(result).toMatchObject({verifiedSnapshots:1,prunedSnapshots:1,rowsDeleted:0,charactersDeleted:0,projectionChunksDeleted:1,projectionEntriesDeleted:1});
 expect(await store.all('SELECT * FROM snapshot_day_projection_entries WHERE snapshotId=?',oldId)).toEqual([]);expect(await store.all('SELECT * FROM snapshot_day_projection_chunks WHERE snapshotId=?',oldId)).toEqual([]);
 expect(await store.all('SELECT * FROM snapshots ORDER BY id')).toEqual(metadata);expect(await store.all('SELECT * FROM current_snapshots')).toEqual(pointers);expect([...archives.entries()]).toEqual(raw);
 expect(await store.first("SELECT json_extract(payload,'$.rowsDeleted') rowsDeleted,json_extract(payload,'$.projectionChunksDeleted') chunks,json_extract(payload,'$.projectionEntriesDeleted') entries FROM audit WHERE action='snapshot.materialization.archived'")).toEqual({rowsDeleted:0,chunks:1,entries:1});
 expect((await pruneArchivedMaterializations(store,scope,options())).verifiedSnapshots).toBe(0);
});
it('revisits verified ready projection entries even when their chunks were already reclaimed',async()=>{
 await committedFactTimeout();await store.run('DELETE FROM snapshot_day_projection_chunks WHERE snapshotId=?',oldId);
 expect(await pruneArchivedMaterializations(store,scope,options())).toMatchObject({verifiedSnapshots:1,prunedSnapshots:1,rowsDeleted:0,projectionChunksDeleted:0,projectionEntriesDeleted:1});
 expect(await store.all('SELECT * FROM snapshot_day_projection_entries WHERE snapshotId=?',oldId)).toEqual([]);
});
it('requires a new full archive verification before reclaiming orphan derived copies',async()=>{
 await committedFactTimeout();archives.set(`snapshots/${oldId}.json`,JSON.stringify({...oldBatch,rows:[]}));
 const entries=await store.all('SELECT * FROM snapshot_day_projection_entries'),chunks=await store.all('SELECT * FROM snapshot_day_projection_chunks');
 expect(await pruneArchivedMaterializations(store,scope,options())).toMatchObject({verifiedSnapshots:0,rowsDeleted:0,projectionChunksDeleted:0,skipped:1});
 expect(await store.all('SELECT * FROM snapshot_day_projection_entries')).toEqual(entries);expect(await store.all('SELECT * FROM snapshot_day_projection_chunks')).toEqual(chunks);
});
it('does not select orphan derived copies without their original verified recovery marker',async()=>{
 await committedFactTimeout();await store.run('DELETE FROM audit WHERE id=?',`archive-materialization:${oldId}`);
 const entries=await store.all('SELECT * FROM snapshot_day_projection_entries'),chunks=await store.all('SELECT * FROM snapshot_day_projection_chunks');
 expect(await pruneArchivedMaterializations(store,scope,options())).toMatchObject({verifiedSnapshots:0,rowsDeleted:0,projectionChunksDeleted:0});
 expect(await store.all('SELECT * FROM snapshot_day_projection_entries')).toEqual(entries);expect(await store.all('SELECT * FROM snapshot_day_projection_chunks')).toEqual(chunks);
});
it.each(['current-pointer','running-job','review','writing-projection'])('protects orphan projections when %s appears after archive verification',async protectedBy=>{
 await committedFactTimeout();const entries=await store.all('SELECT * FROM snapshot_day_projection_entries WHERE snapshotId=?',oldId),chunks=await store.all('SELECT * FROM snapshot_day_projection_chunks WHERE snapshotId=?',oldId);
 const guardedReader:ArchiveReader=async(key,deadline)=>{const archive=await reader(key,deadline);
  if(protectedBy==='current-pointer')await store.run('UPDATE current_snapshots SET snapshotId=?',oldId);
  if(protectedBy==='running-job'){await store.enqueue('o',client.id,'source','hourly-history:2026-10-12','2026-10-13T17:00:00Z');await store.run("UPDATE jobs SET status='running',leaseUntil='2026-10-13T18:15:00Z'");}
  if(protectedBy==='review')await store.saveReview('o',client.id,'2026-10-13','frozen',{snapshotId:oldId},'2026-10-13T18:00:00Z');
  if(protectedBy==='writing-projection')await store.run("UPDATE snapshot_day_projection_entries SET status='writing' WHERE snapshotId=?",oldId);
  return archive;
 };
 expect(await pruneArchivedMaterializations(store,scope,{...options(),readArchive:guardedReader})).toMatchObject({rowsDeleted:0,projectionChunksDeleted:0,prunedSnapshots:0});
 expect(await store.all('SELECT * FROM snapshot_day_projection_chunks WHERE snapshotId=?',oldId)).toEqual(chunks);
 expect(await store.all('SELECT * FROM snapshot_day_projection_entries WHERE snapshotId=?',oldId)).toEqual(protectedBy==='writing-projection'?entries.map(entry=>({...entry,status:'writing'})):entries);
});
it('propagates unexpected database errors instead of reporting safe deferral',async()=>{
 const all=store.all.bind(store),failure=Error('SQLITE_CONSTRAINT: invalid statement');
 vi.spyOn(store,'all').mockImplementation(async(sql,...args)=>{if(sql.startsWith('SELECT rowid,length(payload)'))throw failure;return all(sql,...args);});
 await expect(pruneArchivedMaterializations(store,scope,options())).rejects.toBe(failure);
 expect(await store.first('SELECT COUNT(*) n FROM observations WHERE snapshotId=?',oldId)).toEqual({n:3});expect(await store.all('SELECT * FROM runner_leases')).toEqual([]);
});
it('reports confirmed progress when a later database page times out',async()=>{
 const run=store.run.bind(store);let deleted=false;
 vi.spyOn(store,'run').mockImplementation(async(sql,...args)=>{if(sql.startsWith('DELETE FROM snapshot_day_projection_chunks')&&deleted)throw new DOMException('Database request timed out','TimeoutError');const result=await run(sql,...args);if(sql.startsWith('DELETE FROM observations'))deleted=true;return result;});
 const result=await pruneArchivedMaterializations(store,scope,options());
 expect(result).toMatchObject({rowsDeleted:3,prunedSnapshots:1,deferred:'database',stage:'projections.chunks.delete',uncertainWrite:true});
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=?',oldId)).toEqual([]);
 expect(await store.first("SELECT action FROM audit WHERE id=?",`archive-materialization:${oldId}`)).toEqual({action:'snapshot.materialization.archive_verified'});
 expect(await store.all('SELECT * FROM runner_leases')).toEqual([]);
});
it('uses tenant-scoped projection indexes for bounded cleanup',async()=>{
 const run=store.run.bind(store),all=store.all.bind(store),plans:{detail:string}[]=[],deletions:{detail:string}[]=[];
 const explain=(sql:string,args:unknown[])=>sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args as SQLInputValue[]).map(row=>({detail:String(row.detail)}));
 vi.spyOn(store,'run').mockImplementation(async(sql,...args)=>{if(sql.startsWith('DELETE FROM snapshot_day_projection')){const explained=explain(sql,args);plans.push(...explained);deletions.push(...explained);}return run(sql,...args);});
 vi.spyOn(store,'all').mockImplementation(async(sql,...args)=>{if(sql.startsWith('SELECT s.*,c.provider'))plans.push(...explain(sql,args));return all(sql,...args);});
 expect((await pruneArchivedMaterializations(store,scope,options())).rowsDeleted).toBe(3);
 expect(plans.some(row=>/SCAN snapshot_day_projection|SCAN d\b/.test(row.detail))).toBe(false);
 expect(deletions.some(row=>/SCAN snapshot_day_projection|TEMP B-TREE/.test(row.detail))).toBe(false);
 const derived=plans.filter(row=>/SEARCH d USING.*snapshot_day_projection/.test(row.detail));expect(derived.length).toBeGreaterThanOrEqual(2);
 expect(derived.every(row=>/organizationId=\? AND clientId=\? AND snapshotId=\?/.test(row.detail))).toBe(true);
 expect(plans.filter(row=>/SEARCH snapshot_day_projection/.test(row.detail)).every(row=>/organizationId=\? AND clientId=\? AND snapshotId=\?/.test(row.detail))).toBe(true);
});
it('refuses a missing or corrupted raw archive',async()=>{
 archives.delete(`snapshots/${oldId}.json`);expect((await pruneArchivedMaterializations(store,scope,options())).rowsDeleted).toBe(0);
 archives.set(`snapshots/${oldId}.json`,JSON.stringify({...oldBatch,rows:[]}));expect((await pruneArchivedMaterializations(store,scope,options())).rowsDeleted).toBe(0);expect(await store.first('SELECT COUNT(*) AS n FROM observations WHERE snapshotId=?',oldId)).toEqual({n:3});
});
it('rechecks pointer protection after archive verification and before every deletion',async()=>{
 const movingReader:ArchiveReader=async(key,deadline)=>{const result=await reader(key,deadline);await store.run('UPDATE current_snapshots SET snapshotId=?',oldId);return result;};
 expect((await pruneArchivedMaterializations(store,scope,{...options(),readArchive:movingReader})).rowsDeleted).toBe(0);expect(await store.first('SELECT COUNT(*) AS n FROM observations WHERE snapshotId=?',oldId)).toEqual({n:3});
});
it('refuses analyst and cross-client retention access',async()=>{
 expect((await pruneArchivedMaterializations(store,{...scope,role:'analyst'},options())).rowsDeleted).toBe(0);expect((await pruneArchivedMaterializations(store,{...scope,permittedClientIds:['beam']},options())).rowsDeleted).toBe(0);expect(await store.first('SELECT COUNT(*) AS n FROM observations WHERE snapshotId=?',oldId)).toEqual({n:3});
});
it('protects source evidence while a daily review is still being generated',async()=>{
 await store.run("INSERT INTO scheduled_reviews(id,organizationId,clientId,storeDate,mode,status,attempts,dueAt,leaseToken,leaseUntil) VALUES('review','o','kind-patches','2026-10-13','partial','running',1,'2026-10-13T17:00:00Z','review-token','2026-10-13T18:15:00Z')");
 expect((await pruneArchivedMaterializations(store,scope,options())).rowsDeleted).toBe(0);expect(await store.first('SELECT COUNT(*) AS n FROM observations WHERE snapshotId=?',oldId)).toEqual({n:3});
});
it('rejects a capture whose metadata changed after archive verification',async()=>{
 const changingReader:ArchiveReader=async(key,deadline)=>{const result=await reader(key,deadline);await store.run("UPDATE snapshots SET coverageThrough='2026-10-13T11:00:00Z' WHERE id=?",oldId);return result;};
 expect((await pruneArchivedMaterializations(store,scope,{...options(),readArchive:changingReader})).rowsDeleted).toBe(0);expect(await store.first('SELECT COUNT(*) AS n FROM observations WHERE snapshotId=?',oldId)).toEqual({n:3});
});
it('serializes explicit recovery with pruning through the same maintenance lease',async()=>{
 await store.run("INSERT INTO runner_leases VALUES('o:archive-materializations','pruner','2026-10-13T18:10:00Z')");
 await expect(restoreArchivedMaterialization(store,scope,oldId,{readArchive:reader,deadline:Date.now()+60000})).rejects.toThrow('Archive maintenance is already running');
 await store.run('DELETE FROM runner_leases');await pruneArchivedMaterializations(store,scope,options());
 const restoringReader:ArchiveReader=async(key,deadline)=>{expect((await pruneArchivedMaterializations(store,scope,options())).rowsDeleted).toBe(0);return reader(key,deadline);};
 await restoreArchivedMaterialization(store,scope,oldId,{readArchive:restoringReader,deadline:Date.now()+60000});expect(await store.first('SELECT COUNT(*) AS n FROM observations WHERE snapshotId=?',oldId)).toEqual({n:3});expect(await store.all('SELECT * FROM runner_leases')).toEqual([]);
});
it('restores all original closed-day facts even when a newer current capture retains the same day hash',async()=>{
 const original={...oldBatch,coverageThrough:'2026-10-12T22:00:00Z',rows:oldBatch.rows.map(row=>({...row,date:'2026-10-12',start:row.start?.replace('2026-10-13','2026-10-12'),end:row.end?.replace('2026-10-13','2026-10-12')}))},hash=await fingerprint(original),id=await store.persistBatch('o','source',original,hash,'2026-10-13T10:00:00Z');archives.set(`snapshots/${id}.json`,JSON.stringify(original));
 const newer={...original,coverageThrough:'2026-10-13T11:00:00Z'},newHash=await fingerprint(newer),newId=await store.persistBatch('o','source',newer,newHash,'2026-10-13T11:00:00Z',undefined,{restoreMaterialization:true});
 await store.run("UPDATE current_snapshots SET snapshotId=?,publishedAt='2026-10-13T11:00:00Z' WHERE date='2026-10-12'",newId);const pointer=await store.first("SELECT * FROM current_snapshots WHERE date='2026-10-12'"),before=await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY date,rowKey',id);
 await pruneArchivedMaterializations(store,scope,options());expect(await store.all('SELECT * FROM observations WHERE snapshotId=?',id)).toEqual([]);
 await restoreArchivedMaterialization(store,scope,id,{readArchive:reader,deadline:Date.now()+60000});expect(await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY date,rowKey',id)).toEqual(before);expect(await store.first("SELECT * FROM current_snapshots WHERE date='2026-10-12'")).toEqual(pointer);
});
