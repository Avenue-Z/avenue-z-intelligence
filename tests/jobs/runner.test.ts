import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {Store} from '../../lib/server/store';
import clients from '../../data/initial-clients.json';
const state=vi.hoisted(()=>({store:null as any,fail:false,syncCompleted:[] as string[]}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:(key:string)=>key==='APP_ORGANIZATION_ID'?'o':null}));
vi.mock('../../lib/jobs/sync',()=>({enqueueDue:async()=>{},runSyncBatch:async()=>({completed:state.syncCompleted,failed:[]}),generateReview:async(scope:any,c:any,date:string)=>{if(state.fail)throw new Error('sensitive provider detail');return state.store.saveReview(scope.organizationId,c.id,date,'generated',{actorId:scope.actorId},new Date().toISOString());}}));
import {reviewTick,syncTick} from '../../lib/jobs/runner';
import {DailyScheduler} from '../../lib/jobs/scheduler';
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-12T13:05:00Z'));state.fail=false;state.syncCompleted=[];
 const db=new DatabaseSync(':memory:');for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')))db.exec(readFileSync(`drizzle/${f}`,'utf8'));
 const prepare=(sql:string)=>{let v:any[]=[];const api={bind(...values:any[]){v=values;return api;},async all(){return {results:db.prepare(sql).all(...v)};},async first(){return db.prepare(sql).get(...v)??null;},async run(){return {meta:{changes:Number(db.prepare(sql).run(...v).changes)}};}};return api;};state.store=new Store({prepare,batch:async(ss:any[])=>Promise.all(ss.map(s=>s.run()))});
 const c=clients[0];await state.store.run("INSERT INTO organizations VALUES('o','Avenue Z',1)");
 await state.store.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',c.id,'o',c.name,c.slug,c.timezone,c.currency,c.color,JSON.stringify(c.config),1);
 await state.store.run("INSERT INTO connections VALUES('s','o','kind-patches','Source','kind-triple-whale','registered','secret-ref',30,1,'2026-10-12T13:04:00Z','2026-10-12T13:00:00Z',NULL,1)");
 await state.store.saveQualification('o','kind-patches','s',1,1,{profiles:[{dataset:'overview',metric:'revenue'}]},'admin');
});
afterEach(()=>vi.useRealTimers());
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
 const result=await syncTick();expect(result.completed).toEqual(['o:s:warm']);expect(result).toHaveProperty('cacheWarm.completed',16);expect(await s.all("SELECT status FROM observation_cache_entries WHERE organizationId='o' AND clientId='kind-patches'")).toEqual(Array.from({length:16},()=>({status:'ready'})));
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
