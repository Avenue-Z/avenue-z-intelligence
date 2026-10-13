import {DatabaseSync} from 'node:sqlite';
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
it('restores exactly the original values and retrieval provenance from the verified archive without moving the current pointer',async()=>{
 const facts=await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY date,rowKey',oldId),metadata=await store.first('SELECT * FROM snapshots WHERE id=?',oldId),pointer=await store.all('SELECT * FROM current_snapshots');
 await pruneArchivedMaterializations(store,scope,options());await restoreArchivedMaterialization(store,scope,oldId,{readArchive:reader,deadline:Date.now()+60000});
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY date,rowKey',oldId)).toEqual(facts);expect(await store.first('SELECT * FROM snapshots WHERE id=?',oldId)).toEqual(metadata);expect(await store.all('SELECT * FROM current_snapshots')).toEqual(pointer);
});
it('bounds each maintenance call and retains projections until all corresponding raw rows are pruned',async()=>{
 const result=await pruneArchivedMaterializations(store,scope,{...options(),maxRows:1});expect(result.rowsDeleted).toBe(1);expect(await store.first('SELECT COUNT(*) AS n FROM observations WHERE snapshotId=?',oldId)).toEqual({n:2});expect(await store.first('SELECT COUNT(*) AS n FROM snapshot_day_projection_entries WHERE snapshotId=?',oldId)).toEqual({n:1});
});
it('fills a partially pruned capture on verified archive replay without dropping its original provenance',async()=>{
 const before=await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY date,rowKey',oldId);
 await pruneArchivedMaterializations(store,scope,{...options(),maxRows:1});await restoreArchivedMaterialization(store,scope,oldId,{readArchive:reader,deadline:Date.now()+60000});
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY date,rowKey',oldId)).toEqual(before);
});
it('fills a partially pruned capture before an ordinary provider replay makes it current again',async()=>{
 await pruneArchivedMaterializations(store,scope,{...options(),maxRows:1});await store.persistBatch('o','source',oldBatch,await fingerprint(oldBatch),'2026-10-13T18:00:00Z');
 expect(await store.first('SELECT COUNT(*) AS n FROM observations WHERE snapshotId=?',oldId)).toEqual({n:3});expect(await store.first('SELECT snapshotId FROM current_snapshots')).toEqual({snapshotId:oldId});
});
it('protects a frozen review matching the original source and retrieval timestamp',async()=>{
 await store.saveReview('o',client.id,'2026-10-13','frozen',{evidence:{sourceId:'source',retrievedAt:'2026-10-13T10:00:00Z'}},'2026-10-13T13:00:00Z');const before=await store.all('SELECT * FROM reviews');
 expect((await pruneArchivedMaterializations(store,scope,options())).rowsDeleted).toBe(0);expect(await store.all('SELECT * FROM reviews')).toEqual(before);expect(await store.first('SELECT COUNT(*) AS n FROM observations WHERE snapshotId=?',oldId)).toEqual({n:3});
});
it('protects active source jobs and writing captures',async()=>{
 await store.enqueue('o',client.id,'source','current','2026-10-13T17:00:00Z');await store.run("UPDATE jobs SET status='running',leaseUntil='2026-10-13T18:15:00Z'");expect((await pruneArchivedMaterializations(store,scope,options())).rowsDeleted).toBe(0);
 await store.run('DELETE FROM jobs');await store.run("UPDATE snapshots SET status='writing' WHERE id=?",oldId);expect((await pruneArchivedMaterializations(store,scope,options())).rowsDeleted).toBe(0);
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
