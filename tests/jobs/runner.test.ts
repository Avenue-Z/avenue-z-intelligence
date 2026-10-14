import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {Store} from '../../lib/server/store';
import clients from '../../data/initial-clients.json';
import type {SourceBatch} from '../../lib/analytics/contracts';
import {fingerprint} from '../../lib/reviews/build';
import * as retention from '../../lib/jobs/archive-materialization-retention';
const state=vi.hoisted(()=>({store:null as any,fail:false,syncCompleted:[] as string[],runtimePlatform:'sites',syncElapsedMs:0,drainCurrent:false}));
vi.mock('@avenue/runtime',()=>({get runtimePlatform(){return state.runtimePlatform;}}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:(key:string)=>key==='APP_ORGANIZATION_ID'?'o':null}));
vi.mock('../../lib/jobs/sync',()=>({enqueueDue:async()=>{},runSyncBatch:async()=>{vi.setSystemTime(Date.now()+state.syncElapsedMs);if(state.drainCurrent)for(const id of state.syncCompleted)await state.store.finish(id);return {completed:state.syncCompleted,failed:[]};},generateReview:async(scope:any,c:any,date:string)=>{if(state.fail)throw new Error('sensitive provider detail');return state.store.saveReview(scope.organizationId,c.id,date,'generated',{actorId:scope.actorId},new Date().toISOString());}}));
import {reviewTick,syncTick} from '../../lib/jobs/runner';
import {DailyScheduler} from '../../lib/jobs/scheduler';
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-12T13:05:00Z'));state.fail=false;state.syncCompleted=[];state.runtimePlatform='sites';state.syncElapsedMs=0;state.drainCurrent=false;
 const db=new DatabaseSync(':memory:');for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')))db.exec(readFileSync(`drizzle/${f}`,'utf8'));
 const prepare=(sql:string)=>{let v:any[]=[];const api={bind(...values:any[]){v=values;return api;},async all(){return {results:db.prepare(sql).all(...v)};},async first(){return db.prepare(sql).get(...v)??null;},async run(){return {meta:{changes:Number(db.prepare(sql).run(...v).changes)}};}};return api;};state.store=new Store({prepare,batch:async(ss:any[])=>Promise.all(ss.map(s=>s.run()))});
 const c=clients[0];await state.store.run("INSERT INTO organizations VALUES('o','Avenue Z',1)");
 await state.store.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',c.id,'o',c.name,c.slug,c.timezone,c.currency,c.color,JSON.stringify(c.config),1);
 await state.store.run("INSERT INTO connections VALUES('s','o','kind-patches','Source','kind-triple-whale','registered','secret-ref',30,1,'2026-10-12T13:04:00Z','2026-10-12T13:00:00Z',NULL,1)");
 await state.store.saveQualification('o','kind-patches','s',1,1,{profiles:[{dataset:'overview',metric:'revenue'}]},'admin');
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
it('creates one persisted report with an application identity across repeated cron ticks',async()=>{
 expect((await reviewTick()).completed).toHaveLength(1);expect((await reviewTick()).completed).toEqual([]);
 const saved=await state.store.reviews('o','kind-patches');expect(saved).toHaveLength(1);expect(saved[0].payload.actorId).toBe('application-scheduler');
 expect((await state.store.first('SELECT * FROM scheduled_reviews')).reviewId).toBe(saved[0].id);
});
it('waits for current coverage even when a provider was recently retrieved',async()=>{
 await state.store.run("UPDATE connections SET coverageThrough='2026-10-11T13:00:00Z'");expect((await reviewTick()).completed).toEqual([]);expect(await state.store.all('SELECT * FROM scheduled_reviews')).toEqual([]);
});
it('waits for the connected hourly human feed before generating an intraday report',async()=>{
 const s=state.store;await s.run("INSERT INTO connections VALUES('sessions','o','kind-patches','Human sessions','kind-shopify-hourly','registered','secret-ref',60,1,'2026-10-12T13:04:00Z','2026-10-11T22:00:00Z',NULL,1)");await s.saveQualification('o','kind-patches','sessions',1,1,{profiles:[{dataset:'overview',metric:'sessions',hourly:true}]},'admin');
 expect((await reviewTick()).completed).toEqual([]);await s.run("UPDATE connections SET coverageThrough='2026-10-12T13:00:00Z' WHERE id='sessions'");expect((await reviewTick()).completed).toHaveLength(1);
});
it.each(['kind-shopify-sales','kind-triple-whale-diagnostics'])('waits for qualified current %s coverage before publishing the daily review',async provider=>{
 const s=state.store;await s.run("INSERT INTO connections SELECT 'financial','o','kind-patches',name,?,endpoint,secretRef,pollMinutes,enabled,lastSuccess,'2026-10-11T22:00:00Z',error,version FROM connections WHERE id='s'",provider);
 await s.saveQualification('o','kind-patches','financial',1,1,{profiles:[{dataset:provider==='kind-shopify-sales'?'revenue':'renewalDiagnostics',metric:'revenue',hourly:true}]},'admin');
 expect((await reviewTick()).completed).toEqual([]);expect(await s.all('SELECT * FROM reviews')).toEqual([]);
 await s.run("UPDATE connections SET coverageThrough='2026-10-12T13:00:00Z' WHERE id='financial'");
 expect((await reviewTick()).completed).toHaveLength(1);
});
it.each(['missing','connection-version','client-version'])('waits for visible financial qualification when it is %s',async kind=>{
 const s=state.store;await s.run("INSERT INTO connections SELECT 'financial','o','kind-patches',name,'kind-shopify-sales',endpoint,secretRef,pollMinutes,enabled,lastSuccess,coverageThrough,error,version FROM connections WHERE id='s'");
 if(kind!=='missing')await s.saveQualification('o','kind-patches','financial',kind==='connection-version'?2:1,kind==='client-version'?2:1,{profiles:[{dataset:'revenue',metric:'revenue',hourly:true}]},'admin');
 expect((await reviewTick()).completed).toEqual([]);expect(await s.all('SELECT * FROM reviews')).toEqual([]);
});
it('ignores unrelated stale Meta reporting while retaining the required overview revenue gate',async()=>{
 const s=state.store;await s.run("INSERT INTO connections SELECT 'meta','o','kind-patches',name,'kind-meta-performance',endpoint,secretRef,pollMinutes,enabled,'2026-10-11T13:00:00Z','2026-10-11T13:00:00Z','Old platform report',2 FROM connections WHERE id='s'");
 await s.saveQualification('o','kind-patches','meta',1,1,{profiles:[{dataset:'creatives',metric:'revenue',hourly:true}]},'admin');
 expect((await reviewTick()).completed).toHaveLength(1);
 await s.run('DELETE FROM scheduled_reviews');await s.run('DELETE FROM reviews');await s.run("DELETE FROM qualifications WHERE sourceId='s'");
 expect((await reviewTick()).completed).toEqual([]);
});
it('refuses stale qualifications after a connection or client changes',async()=>{
 await state.store.run('UPDATE connections SET version=2');expect((await reviewTick()).completed).toEqual([]);
});
it('persists report retry state without leaking provider errors',async()=>{
 state.fail=true;expect((await reviewTick()).failed).toHaveLength(1);const j=await state.store.first('SELECT * FROM scheduled_reviews');expect(j.status).toBe('pending');expect(j.error).not.toContain('sensitive');
 expect((await reviewTick()).failed).toEqual([]);
});
it('recovers a saved schedule-tagged report without generating another revision',async()=>{
 const s=state.store,scheduler=new DailyScheduler(s);await scheduler.enqueue('o','kind-patches',{storeDate:'2026-10-12',mode:'partial'},'2026-10-12T13:00:00Z');
 const job=await s.first('SELECT * FROM scheduled_reviews');await s.saveReview('o','kind-patches','2026-10-12','saved',{scheduleJobId:job.id},'2026-10-12T13:01:00Z');
 expect((await reviewTick()).completed).toHaveLength(1);expect(await s.reviews('o','kind-patches')).toHaveLength(1);
});
it('does not generate a partial report for an elapsed store day using the next day clock',async()=>{
 const scheduler=new DailyScheduler(state.store);await scheduler.enqueue('o','kind-patches',{storeDate:'2026-10-12',mode:'partial'},'2026-10-12T13:00:00Z');
 vi.setSystemTime(new Date('2026-10-13T04:05:00Z'));
 await state.store.run("UPDATE connections SET lastSuccess='2026-10-13T04:04:00Z',coverageThrough='2026-10-13T04:00:00Z'");
 expect((await reviewTick()).completed).toEqual([]);expect((await state.store.first('SELECT * FROM scheduled_reviews')).status).toBe('failed');
});
it('isolates an invalid persisted schedule while another brand receives its report',async()=>{
 const c=clients[1],s=state.store;await s.run('UPDATE clients SET config=? WHERE id=?',JSON.stringify({...clients[0].config,reviewTime:'99:99'}),'kind-patches');
 await s.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',c.id,'o',c.name,c.slug,c.timezone,c.currency,c.color,JSON.stringify(c.config),1);
 await s.run("INSERT INTO connections SELECT 'beam-source','o','beam',name,provider,endpoint,secretRef,pollMinutes,enabled,lastSuccess,coverageThrough,error,version FROM connections WHERE id='s'");
 await s.saveQualification('o','beam','beam-source',1,1,{profiles:[{dataset:'overview',metric:'revenue'}]},'admin');
 const result=await reviewTick();expect(result.completed).toHaveLength(1);expect(result.failed).toEqual([{id:'schedule:kind-patches'}]);expect(await s.reviews('o','beam')).toHaveLength(1);
});
it('warms durable closed and partial selections after a successful source job without a browser session',async()=>{
 const s=state.store;await s.enqueue('o','kind-patches','s','warm','2026-10-12T13:00:00Z');await s.finish('o:s:warm');state.syncCompleted=['o:s:warm'];
 await s.persistBatch('o','s',{clientId:'kind-patches',channels:[],complete:true,coverageThrough:'2026-10-12T13:00:00Z',rows:[{date:'2026-10-11',dataset:'overview',metric:'revenue',value:42,definition:'web',currency:'USD',dimensions:{}}]},'warm','2026-10-12T13:00:00Z');
 const result=await syncTick();expect(result.completed).toEqual(['o:s:warm']);expect(result).toHaveProperty('cacheWarm.completed',30);expect(await s.all("SELECT status FROM observation_cache_entries WHERE organizationId='o' AND clientId='kind-patches'")).toEqual(Array.from({length:24},()=>({status:'ready'})));
});
it('releases the native sync lease after completed source jobs without duplicating independent cache warming',async()=>{
 const s=state.store;state.runtimePlatform='vercel';await s.enqueue('o','kind-patches','s','warm','2026-10-12T13:00:00Z');await s.finish('o:s:warm');state.syncCompleted=['o:s:warm'];
 await s.persistBatch('o','s',{clientId:'kind-patches',channels:[],complete:true,coverageThrough:'2026-10-12T13:00:00Z',rows:[{date:'2026-10-11',dataset:'overview',metric:'revenue',value:42,definition:'web',currency:'USD',dimensions:{}}]},'warm','2026-10-12T13:00:00Z');
 const jobs=await s.all('SELECT id,status,attempts,dueAt FROM jobs ORDER BY id'),observations=vi.spyOn(s,'observations');
 const result=await syncTick();
 expect(result.completed).toEqual(['o:s:warm']);expect(result.failed).toEqual([]);expect(result).toHaveProperty('cacheWarm',{attempted:0,completed:0});
 expect(observations).not.toHaveBeenCalled();expect(await s.all('SELECT * FROM observation_cache_entries')).toEqual([]);
 expect(await s.all('SELECT * FROM runner_leases')).toEqual([]);expect(await s.all('SELECT id,status,attempts,dueAt FROM jobs ORDER BY id')).toEqual(jobs);
});
it.each(['pending','running'])('releases the sync lease without warming while enabled current jobs remain %s',async status=>{
 const s=state.store;await s.enqueue('o','kind-patches','s','warm','2026-10-12T13:00:00Z');await s.finish('o:s:warm');state.syncCompleted=['o:s:warm'];
 await s.persistBatch('o','s',{clientId:'kind-patches',channels:[],complete:true,coverageThrough:'2026-10-12T13:00:00Z',rows:[{date:'2026-10-11',dataset:'overview',metric:'revenue',value:42,definition:'web',currency:'USD',dimensions:{}}]},'warm','2026-10-12T13:00:00Z');
 await s.enqueue('o','kind-patches','s','queued','2026-10-12T13:00:00Z');await s.run('UPDATE jobs SET status=? WHERE id=?',status,'o:s:queued');const jobs=await s.all('SELECT id,status,attempts,dueAt FROM jobs ORDER BY id');
 const result=await syncTick();
 expect(result.completed).toEqual(['o:s:warm']);expect(result).toHaveProperty('cacheWarm',{attempted:0,completed:0});
 expect(await s.all('SELECT * FROM observation_cache_entries')).toEqual([]);
 expect(await s.all('SELECT * FROM runner_leases')).toEqual([]);expect(await s.all('SELECT id,status,attempts,dueAt FROM jobs ORDER BY id')).toEqual(jobs);
});
it.each(['history','future','disabled','other-organization'])('retains inline warming when only %s work remains',async kind=>{
 const s=state.store;await s.enqueue('o','kind-patches','s','warm','2026-10-12T13:00:00Z');await s.finish('o:s:warm');state.syncCompleted=['o:s:warm'];
 await s.persistBatch('o','s',{clientId:'kind-patches',channels:[],complete:true,coverageThrough:'2026-10-12T13:00:00Z',rows:[{date:'2026-10-11',dataset:'overview',metric:'revenue',value:42,definition:'web',currency:'USD',dimensions:{}}]},'warm','2026-10-12T13:00:00Z');
 if(kind==='disabled'){await s.run("INSERT INTO connections SELECT 'disabled','o','kind-patches',name,provider,endpoint,secretRef,pollMinutes,0,lastSuccess,coverageThrough,error,version FROM connections WHERE id='s'");await s.enqueue('o','kind-patches','disabled','queued','2026-10-12T13:00:00Z');}
 else await s.enqueue(kind==='other-organization'?'other':'o','kind-patches','s',kind==='history'?'hourly-history:2026-10-11':'queued',kind==='future'?'2026-10-12T14:00:00Z':'2026-10-12T13:00:00Z');
 expect(await syncTick()).toHaveProperty('cacheWarm.completed',30);expect(await s.all('SELECT * FROM runner_leases')).toEqual([]);
});
it('does not warm caches when no source job completed or the cache migration is absent',async()=>{
 const s=state.store,observations=vi.spyOn(s,'observations');expect((await syncTick()).completed).toEqual([]);expect(observations).not.toHaveBeenCalled();
 await s.enqueue('o','kind-patches','s','warm','2026-10-12T13:00:00Z');state.syncCompleted=['o:s:warm'];await s.run('DROP TABLE observation_cache_entries');expect((await syncTick()).completed).toEqual(['o:s:warm']);expect(observations).not.toHaveBeenCalled();
});
it('preserves completed source jobs when cache warming fails during a source read',async()=>{
 const s=state.store;await s.enqueue('o','kind-patches','s','warm','2026-10-12T13:00:00Z');await s.finish('o:s:warm');state.syncCompleted=['o:s:warm'];
 // Simulate legacy/corrupted storage. The dataset expression index now rejects
 // malformed JSON at write time, before this read-failure recovery path is reached.
 await s.run('DROP INDEX idx_observations_snapshot_date_dataset_rowkey');
 await s.persistBatch('o','s',{clientId:'kind-patches',channels:[],complete:true,coverageThrough:'2026-10-12T13:00:00Z',rows:[{date:'2026-10-11',dataset:'overview',metric:'revenue',value:42,definition:'web',currency:'USD',dimensions:{}}]},'warm','2026-10-12T13:00:00Z');
 // Remove derived day projections too so the injected raw failure is reached.
 await s.run('DELETE FROM snapshot_day_projection_chunks');await s.run('DELETE FROM snapshot_day_projection_entries');await s.run("UPDATE observations SET payload='unavailable'");
 const result=await syncTick();expect(result.completed).toEqual(['o:s:warm']);expect(result.failed).toEqual([]);expect(result).toHaveProperty('cacheWarm.completed',0);expect(await s.first("SELECT status FROM jobs WHERE id='o:s:warm'")).toMatchObject({status:'complete'});
});

function maintenanceCapacity(s:Store,overrides:Record<string,unknown>={}){
 const first=s.first.bind(s),values:Record<string,unknown>={page_count:Math.ceil(18000000000/4096),page_size:4096,freelist_count:0,...overrides};
 return vi.spyOn(s,'first').mockImplementation(async(sql,...args)=>{const name=sql.slice('PRAGMA '.length);return sql.startsWith('PRAGMA ')&&name in values?(values[name]===null?null:{[name]:values[name]}):first(sql,...args);});
}
async function oldRecoverableCopy(s:Store){
 const make=(value:number):SourceBatch=>({clientId:'kind-patches',timezone:clients[0].timezone,currency:clients[0].currency,grain:'hourly',channels:[],dimensions:[],complete:true,coverageThrough:'2026-10-11T10:00:00Z',rows:[0,1,2].map(hour=>({date:'2026-10-11',dataset:'overview',metric:'revenue',population:'sales',value:value+hour,definition:'qualified',currency:'USD',dimensions:{},sourceId:'',retrievedAt:'',coverageThrough:null,quality:'complete',start:`2026-10-11T0${hour+7}:00:00Z`,end:`2026-10-11T${hour+8<10?'0':''}${hour+8}:00:00Z`}))});
 const old=make(40),oldId=await s.persistBatch('o','s',old,await fingerprint(old),'2026-10-12T10:00:00Z'),latest=make(90),currentId=await s.persistBatch('o','s',latest,await fingerprint(latest),'2026-10-12T11:00:00Z');
 return {oldId,currentId,old,reader:async(key:string)=>({text:JSON.stringify(old),bytes:new TextEncoder().encode(JSON.stringify(old)).byteLength,pathname:key,etag:'private-verified'})};
}
it('reclaims a verified old copy immediately after natural current drain while retaining the native sync owner',async()=>{
 const s:Store=state.store;state.runtimePlatform='vercel';const old=await oldRecoverableCopy(s);await s.enqueue('o','kind-patches','s','current','2026-10-12T13:00:00Z');state.syncCompleted=['o:s:current'];state.drainCurrent=true;maintenanceCapacity(s);
 const metadata=await s.all('SELECT * FROM snapshots ORDER BY id'),current=await s.all('SELECT * FROM observations WHERE snapshotId=?',old.currentId),original=retention.pruneArchivedMaterializations;let leaseObserved=false;
 const prune=vi.spyOn(retention,'pruneArchivedMaterializations').mockImplementation(async(store,scope,options)=>{leaseObserved=!!await store.first('SELECT token FROM runner_leases WHERE id=?','o:sync');expect(await store.first('SELECT status FROM jobs WHERE id=?','o:s:current')).toEqual({status:'complete'});expect(options.deadline-Date.now()).toBe(60000);return original(store,scope,{...options,readArchive:old.reader});});
 const result=await syncTick();expect(prune).toHaveBeenCalledTimes(1);expect(leaseObserved).toBe(true);expect(result.completed).toEqual(['o:s:current']);expect(result.failed).toEqual([]);expect(result).toHaveProperty('maintenance.rowsDeleted',3);expect(result).toHaveProperty('cacheWarm',{attempted:0,completed:0});
 expect(await s.all('SELECT * FROM observations WHERE snapshotId=?',old.oldId)).toEqual([]);expect(await s.all('SELECT * FROM observations WHERE snapshotId=?',old.currentId)).toEqual(current);expect(await s.all('SELECT * FROM snapshots ORDER BY id')).toEqual(metadata);expect(await s.all('SELECT * FROM runner_leases')).toEqual([]);
});
it.each(['pending','running'])('does not start native post-drain maintenance while current work is %s',async status=>{
 const s:Store=state.store;state.runtimePlatform='vercel';maintenanceCapacity(s);await s.enqueue('o','kind-patches','s','current','2026-10-12T13:00:00Z');await s.run('UPDATE jobs SET status=? WHERE id=?',status,'o:s:current');const jobs=await s.all('SELECT * FROM jobs'),prune=vi.spyOn(retention,'pruneArchivedMaterializations');
 await syncTick();expect(prune).not.toHaveBeenCalled();expect(await s.all('SELECT * FROM jobs')).toEqual(jobs);expect(await s.all('SELECT * FROM runner_leases')).toEqual([]);
});
it.each(['legacy','no-kp'])('does not add the native cleanup lane for %s scope',async kind=>{
 const s:Store=state.store;maintenanceCapacity(s);if(kind==='no-kp'){state.runtimePlatform='vercel';await s.run('DELETE FROM clients');}const prune=vi.spyOn(retention,'pruneArchivedMaterializations');await syncTick();expect(prune).not.toHaveBeenCalled();expect(await s.all('SELECT * FROM runner_leases')).toEqual([]);
});
it.each(['replaced','expired','expiry-during-read'])('does not start cleanup after the sync owner is %s',async outcome=>{
 const s:Store=state.store;state.runtimePlatform='vercel';maintenanceCapacity(s);const first=s.first.bind(s),prune=vi.spyOn(retention,'pruneArchivedMaterializations');
 vi.spyOn(s,'first').mockImplementation(async(sql,...args)=>{if(sql.startsWith('SELECT token,leaseUntil FROM runner_leases')){if(outcome==='replaced')await s.run('UPDATE runner_leases SET token=? WHERE id=?','replacement-owner','o:sync');else if(outcome==='expired')await s.run('UPDATE runner_leases SET leaseUntil=? WHERE id=?',new Date(Date.now()-1).toISOString(),'o:sync');const owner=await first(sql,...args);if(outcome==='expiry-during-read')vi.setSystemTime(Date.now()+900001);return owner;}return first(sql,...args);});
 const result=await syncTick();expect(result.failed).toEqual([]);expect(prune).not.toHaveBeenCalled();if(outcome==='replaced')expect(await s.first('SELECT token FROM runner_leases WHERE id=?','o:sync')).toEqual({token:'replacement-owner'});else expect(await s.all('SELECT * FROM runner_leases')).toEqual([]);
});
it.each([{page_count:1},{page_count:null},{page_count:-1},{page_count:1.5},{page_size:0},{page_size:1023},{freelist_count:-1},{freelist_count:Math.ceil(18000000000/4096)+1},{page_count:Number.MAX_SAFE_INTEGER}])('skips cleanup on low or invalid physical capacity %j',async values=>{
 const s:Store=state.store;state.runtimePlatform='vercel';maintenanceCapacity(s,values);const prune=vi.spyOn(retention,'pruneArchivedMaterializations');const result=await syncTick();expect(prune).not.toHaveBeenCalled();expect(result.completed).toEqual([]);expect(result.failed).toEqual([]);expect(await s.all('SELECT * FROM runner_leases')).toEqual([]);
});
it.each([700000,724999,725000])('respects the remaining maintenance/release budget after %s ms of current work',async elapsed=>{
 const s:Store=state.store;state.runtimePlatform='vercel';state.syncElapsedMs=elapsed;const started=Date.now();maintenanceCapacity(s);const prune=vi.spyOn(retention,'pruneArchivedMaterializations').mockResolvedValue({verifiedSnapshots:0,prunedSnapshots:0,rowsDeleted:0,charactersDeleted:0,projectionChunksDeleted:0,skipped:0});await syncTick();
 if(elapsed>=725000)expect(prune).not.toHaveBeenCalled();else{expect(prune).toHaveBeenCalledTimes(1);const deadline=prune.mock.calls[0][2].deadline;expect(deadline).toBe(started+730000);expect(deadline-Date.now()).toBeLessThanOrEqual(60000);expect(started+770000-deadline).toBe(40000);}expect(await s.all('SELECT * FROM runner_leases')).toEqual([]);
});
it('bounds stalled optional capacity reads without failing completed source outcomes or starting late cleanup',async()=>{
 const s:Store=state.store;state.runtimePlatform='vercel';await s.enqueue('o','kind-patches','s','current','2026-10-12T13:00:00Z');await s.finish('o:s:current');state.syncCompleted=['o:s:current'];const first=s.first.bind(s);let finish!:(value:{page_count:number})=>void;
 vi.spyOn(s,'first').mockImplementation((sql,...args)=>sql==='PRAGMA page_count'?new Promise(resolve=>{finish=resolve;}):first(sql,...args));const prune=vi.spyOn(retention,'pruneArchivedMaterializations');let finished=false;const request=syncTick().then(result=>{finished=true;return result;});await vi.advanceTimersByTimeAsync(5001);const result=await request;
 expect(finished).toBe(true);expect(result.completed).toEqual(['o:s:current']);expect(result.failed).toEqual([]);expect(await s.first('SELECT status FROM jobs WHERE id=?','o:s:current')).toEqual({status:'complete'});expect(await s.all('SELECT * FROM runner_leases')).toEqual([]);finish({page_count:Math.ceil(18000000000/4096)});await vi.advanceTimersByTimeAsync(1000);expect(prune).not.toHaveBeenCalled();
});
it.each(['capacity-db','maintenance-db','archive'])('isolates optional %s failure from completed current jobs',async failure=>{
 const s:Store=state.store;state.runtimePlatform='vercel';await s.enqueue('o','kind-patches','s','current','2026-10-12T13:00:00Z');await s.finish('o:s:current');state.syncCompleted=['o:s:current'];maintenanceCapacity(s);
 if(failure==='capacity-db'){const first=s.first.bind(s);vi.spyOn(s,'first').mockImplementation((sql,...args)=>sql.startsWith('PRAGMA ')?Promise.reject(Error('Private capacity failure')):first(sql,...args));}
 const prune=vi.spyOn(retention,'pruneArchivedMaterializations').mockRejectedValue(Error('Private maintenance '+failure));const result=await syncTick();expect(result.completed).toEqual(['o:s:current']);expect(result.failed).toEqual([]);expect(await s.first('SELECT status FROM jobs WHERE id=?','o:s:current')).toEqual({status:'complete'});expect(await s.all('SELECT * FROM runner_leases')).toEqual([]);if(failure!=='capacity-db')expect(prune).toHaveBeenCalledTimes(1);
});
