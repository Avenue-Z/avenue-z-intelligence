import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import type {AccessScope} from '../../lib/analytics/contracts';
const state=vi.hoisted(()=>({store:null as Store|null}));
vi.mock('@avenue/runtime',()=>({env:{},runtimePlatform:'sites'}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:()=>null}));
vi.mock('../../lib/ai/server',()=>({generateAIReview:vi.fn()}));
import {runSyncBatch} from '../../lib/jobs/sync';
const scope:AccessScope={organizationId:'o',actorId:'scheduler',role:'service',permittedClientIds:['kind-patches']};
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-12T13:00:00Z');
 const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:unknown[]=[];const statement={bind(...input:unknown[]){values=input;return statement;},async all(){return {results:sqlite.prepare(sql).all(...values as any[])};},async first(){return sqlite.prepare(sql).get(...values as any[])??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values as any[]).changes)}};}};return statement;};
 const store=state.store=new Store({prepare,batch:statements=>Promise.all(statements.map(statement=>statement.run()))});
 await store.run("INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,version) VALUES('source','o','kind-patches','Source','gateway','https://source.example','secret',60,1,1)");
 await store.enqueue('o','kind-patches','source','first',new Date().toISOString());
 vi.spyOn(store,'connections').mockRejectedValue(new Error('Provider read timed out'));
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
it('leaves due jobs and source health untouched when less than thirty seconds remain',async()=>{
 const store=state.store!,claim=vi.spyOn(store,'claim');expect(await runSyncBatch(scope,{maxJobs:7,deadline:Date.now()+29999})).toEqual({completed:[],failed:[]});
 expect(claim).not.toHaveBeenCalled();expect(await store.first('SELECT status,attempts,error,leaseUntil FROM jobs')).toEqual({status:'pending',attempts:0,error:null,leaseUntil:null});expect(await store.first('SELECT error,lastSuccess FROM connections')).toEqual({error:null,lastSuccess:null});
});
it('permits an exact thirty-second budget and retains the claimed job retry policy',async()=>{
 const store=state.store!;expect((await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+30000})).failed).toHaveLength(1);
 expect(await store.first('SELECT status,attempts,error,dueAt FROM jobs')).toEqual({status:'pending',attempts:1,error:'Provider read timed out',dueAt:'2026-10-12T13:02:00.000Z'});
});
it('stops before claiming another job when the first job consumes the remaining headroom',async()=>{
 const store=state.store!,started=Date.now();await store.enqueue('o','kind-patches','source','second',new Date().toISOString());
 const retry=store.retry.bind(store);vi.spyOn(store,'retry').mockImplementation(async(...args)=>{await retry(...args);vi.setSystemTime(started+1001);});
 expect((await runSyncBatch(scope,{maxJobs:7,deadline:started+31000})).failed).toHaveLength(1);
 expect(await store.first("SELECT status,attempts,error,leaseUntil FROM jobs WHERE id='o:source:second'")).toEqual({status:'pending',attempts:0,error:null,leaseUntil:null});
});
it('does not claim a large hourly Meta report with a short remaining runtime budget',async()=>{
 const store=state.store!;await store.run("UPDATE connections SET provider='kind-meta-performance'");const claim=vi.spyOn(store,'claim');
 expect(await runSyncBatch(scope,{maxJobs:7,deadline:Date.now()+119999})).toEqual({completed:[],failed:[]});expect(claim).not.toHaveBeenCalled();expect(await store.first('SELECT status,attempts,error FROM jobs')).toEqual({status:'pending',attempts:0,error:null});
});
it('reserves enough runtime for a full paginated hourly Traffic capture',async()=>{
 const store=state.store!;await store.run("UPDATE connections SET provider='kind-shopify-traffic'");const claim=vi.spyOn(store,'claim');
 expect(await runSyncBatch(scope,{maxJobs:7,deadline:Date.now()+89999})).toEqual({completed:[],failed:[]});expect(claim).not.toHaveBeenCalled();
});
it('keeps Recharge cohort work pending when less than three minutes remain without changing source health or polling cadence',async()=>{
 const store=state.store!;await store.run("UPDATE connections SET provider='kind-recharge-cancellations'");
 expect(await runSyncBatch(scope,{maxJobs:7,deadline:Date.now()+179999})).toEqual({completed:[],failed:[]});
 expect(await store.first('SELECT status,attempts,error,leaseUntil FROM jobs')).toEqual({status:'pending',attempts:0,error:null,leaseUntil:null});
 expect(await store.first('SELECT error,lastSuccess,pollMinutes FROM connections')).toEqual({error:null,lastSuccess:null,pollMinutes:60});
});
it('allows a Recharge cohort source to start with exactly three minutes remaining and retains its normal retry policy',async()=>{
 const store=state.store!;await store.run("UPDATE connections SET provider='kind-recharge-cancellations'");
 expect((await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+180000})).failed).toHaveLength(1);
 expect(await store.first('SELECT status,attempts,error,dueAt FROM jobs')).toEqual({status:'pending',attempts:1,error:'Provider read timed out',dueAt:'2026-10-12T13:02:00.000Z'});
});
