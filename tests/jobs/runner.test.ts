import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {Store} from '../../lib/server/store';
import clients from '../../data/initial-clients.json';
const state=vi.hoisted(()=>({store:null as any,fail:false}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:(key:string)=>key==='APP_ORGANIZATION_ID'?'o':null}));
vi.mock('../../lib/jobs/sync',()=>({enqueueDue:async()=>{},runSyncBatch:async()=>({completed:[],failed:[]}),generateReview:async(scope:any,c:any,date:string)=>{if(state.fail)throw new Error('sensitive provider detail');return state.store.saveReview(scope.organizationId,c.id,date,'generated',{actorId:scope.actorId},new Date().toISOString());}}));
import {reviewTick} from '../../lib/jobs/runner';
import {DailyScheduler} from '../../lib/jobs/scheduler';
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-12T13:05:00Z'));state.fail=false;
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
