import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import type {AccessScope,SourceBatch} from '../../lib/analytics/contracts';
import initial from '../../data/initial-clients.json';

const state=vi.hoisted(()=>({store:null as Store|null,sqlite:null as DatabaseSync|null,batch:null as SourceBatch|null,captures:0,archives:0,archiveHook:null as (()=>Promise<void>)|null,captureError:null as Error|null,captureOffset:null as number|null}));
vi.mock('@avenue/runtime',()=>({env:{BUCKET:{put:async()=>{state.archives++;await state.archiveHook?.();}}},runtimePlatform:'vercel'}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:()=> 'private-test-secret'}));
vi.mock('../../lib/ai/server',()=>({generateAIReview:vi.fn()}));
vi.mock('../../lib/sources/kind-fetch',()=>({
 kindSourceDates:()=>[],
 fetchKindSource:async()=>state.batch!,
 fetchKindBatches:async function*(_source:unknown,_client:unknown,window:{from:string;to:string},_secret:string,_fetch:unknown,deadline:number){state.captures++;if(state.captureOffset!==null)vi.setSystemTime(deadline+state.captureOffset);if(state.captureError)throw state.captureError;yield {batch:state.batch!,window};},
}));
import {runSyncBatch} from '../../lib/jobs/sync';
const scope:AccessScope={organizationId:'o',actorId:'scheduler',role:'service',permittedClientIds:['kind-patches']},started=Date.parse('2026-10-14T16:00:00Z'),deadline=started+700000,jobId='o:source:current';
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime(started);state.captures=0;state.archives=0;state.archiveHook=null;state.captureError=null;state.captureOffset=null;
 const sqlite=state.sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:unknown[]=[];const statement={sql,bind(...input:unknown[]){values=input;return statement;},async all(){return {results:sqlite.prepare(sql).all(...values as SQLInputValue[])};},async first(){return sqlite.prepare(sql).get(...values as SQLInputValue[])??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values as SQLInputValue[]).changes)}};}};return statement;};
 const store=state.store=new Store({prepare,batch:statements=>Promise.all(statements.map(statement=>statement.run()))}),client={...initial[0],version:1};
 await store.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',client.id,'o',client.name,client.id,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);
 await store.run("INSERT INTO connections VALUES('source','o','kind-patches','Source','kind-shopify-sales','https://example.com','PRIVATE',60,1,'2026-10-14T15:00:00Z','2026-10-14T15:00:00Z','Prior provider warning',1)");
 state.batch={clientId:client.id,timezone:client.timezone,currency:client.currency,channels:[],dimensions:[],grain:'hourly',complete:true,coverageThrough:'2026-10-14T16:00:00Z',rows:[{date:'2026-10-14',dataset:'revenue',metric:'revenue',definition:'qualified',population:'population',value:42,currency:'USD',dimensions:{},start:'2026-10-14T15:00:00Z',end:'2026-10-14T16:00:00Z',sourceId:'',retrievedAt:'',coverageThrough:null,quality:'complete'}]};
 await store.saveQualification('o',client.id,'source',1,1,{clientId:client.id,queryId:'kind-shopify-sales:hourly-v2',timezone:client.timezone,currency:client.currency,hourlyGrain:true,requiresHourly:true,channels:[],requiredChannels:[],dimensions:[],requiredDimensions:[],paginationComplete:true,reconciled:true,reconciliationEvidence:'Independent fixture reconciliation',profiles:[{dataset:'revenue',metric:'revenue',definition:'qualified',population:'population',currency:'USD',dimensions:[],hourly:true}]},'scheduler');
 await store.enqueue('o',client.id,'source','current',new Date().toISOString());
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();state.sqlite?.close();});
const run=(end=deadline)=>runSyncBatch(scope,{maxJobs:1,deadline:end});

it.each([0,463])('defers an actual fresh capture when its publication budget expires %s ms late without inventing source freshness',async offset=>{
 const store=state.store!,health=await store.all('SELECT * FROM connections');await store.run('UPDATE jobs SET attempts=2');
 state.archiveHook=async()=>{vi.setSystemTime(deadline+offset);};
 expect(await run()).toEqual({completed:[],failed:[]});
 expect(await store.first('SELECT status,attempts,leaseUntil,dueAt,error FROM jobs')).toEqual({status:'pending',attempts:2,leaseUntil:null,dueAt:new Date(deadline+offset+300000).toISOString(),error:'Source publication budget elapsed'});
 expect(await store.all('SELECT * FROM connections')).toEqual(health);expect(state.captures).toBe(1);expect(state.archives).toBe(1);
 for(const table of ['snapshots','observations','current_snapshots'])expect(await store.first(`SELECT COUNT(*) n FROM ${table}`)).toEqual({n:0});
});

it('leaves staged validated facts unready and preserves the last confirmed source cutoff after publication budget exhaustion',async()=>{
 const store=state.store!,health=await store.all('SELECT * FROM connections'),write=store.db.batch.bind(store.db);
 store.db.batch=async statements=>{const result=await write(statements);if(statements.some(statement=>statement.sql.startsWith('INSERT INTO observations')))vi.setSystemTime(deadline);return result;};
 expect(await run()).toEqual({completed:[],failed:[]});
 expect(await store.first('SELECT status,attempts,leaseUntil FROM jobs')).toEqual({status:'pending',attempts:0,leaseUntil:null});expect(await store.all('SELECT * FROM connections')).toEqual(health);
 expect(await store.first('SELECT status FROM snapshots')).toEqual({status:'writing'});expect(await store.first('SELECT COUNT(*) n FROM observations')).toEqual({n:1});expect(await store.all('SELECT * FROM current_snapshots')).toEqual([]);
});

it.each(['attempts','leaseUntil','complete','pending','failed'] as const)('does not reset a claim whose %s changed before the old publication budget error',async changed=>{
 const store=state.store!,health=await store.all('SELECT * FROM connections');let expected:unknown;
 state.archiveHook=async()=>{if(changed==='attempts')await store.run('UPDATE jobs SET attempts=4');else if(changed==='leaseUntil')await store.run("UPDATE jobs SET leaseUntil='2026-10-14T17:00:00Z'");else await store.run('UPDATE jobs SET status=?,leaseUntil=NULL',changed);expected=await store.all('SELECT * FROM jobs');vi.setSystemTime(deadline);};
 expect(await run()).toEqual({completed:[],failed:[]});expect(await store.all('SELECT * FROM jobs')).toEqual(expected);expect(await store.all('SELECT * FROM connections')).toEqual(health);
});

it.each([
 ['Source publication budget elapsed',-1],['Provider returned HTTP 401',0],['Provider returned HTTP 403',0],['Registered source qualification mismatch',0],['Unknown publication failure',0],['Database request timed out',0],
] as const)('retains the actual failure policy for %s with deadline offset %s',async(message,offset)=>{
 const store=state.store!;await store.run('UPDATE jobs SET attempts=2');state.captureError=new Error(message);state.captureOffset=offset;
 expect((await run()).failed).toEqual([{id:jobId,error:message}]);expect(await store.first('SELECT status,attempts,error FROM jobs')).toEqual({status:'failed',attempts:3,error:message});
 expect(await store.first('SELECT lastSuccess,coverageThrough,error FROM connections')).toEqual({lastSuccess:'2026-10-14T15:00:00Z',coverageThrough:'2026-10-14T15:00:00Z',error:message});
});

it.each([
 ['kind-meta-performance',499999,false],['kind-meta-performance',500000,true],['kind-shopify-traffic',399999,false],['kind-shopify-traffic',400000,true],
] as const)('claims %s only when its measured %s ms remaining budget permits it',async(provider,budget,claimed)=>{
 const store=state.store!;await store.run('UPDATE connections SET provider=?',provider);const qualification=await store.qualification('o','source');await store.saveQualification('o','kind-patches','source',1,1,{...qualification!.payload,queryId:`${provider}:hourly-v2`},'scheduler');
 const health=await store.all('SELECT * FROM connections'),result=await run(started+budget);
 expect(state.captures).toBe(claimed?1:0);expect(result.failed).toEqual([]);expect(result.completed).toEqual(claimed?[jobId]:[]);
 expect(await store.first('SELECT status,attempts,leaseUntil FROM jobs')).toEqual({status:claimed?'complete':'pending',attempts:claimed?1:0,leaseUntil:null});
 if(!claimed)expect(await store.all('SELECT * FROM connections')).toEqual(health);
});

it('rechecks the measured claim floor after the provider lookup consumes time',async()=>{
 const store=state.store!,read=store.first.bind(store);await store.run("UPDATE connections SET provider='kind-meta-performance'");
 vi.spyOn(store,'first').mockImplementation(async(sql,...values)=>{const result=await read(sql,...values);if(sql.startsWith('SELECT c.provider FROM jobs'))vi.setSystemTime(started+1);return result;});
 expect(await run(started+500000)).toEqual({completed:[],failed:[]});expect(state.captures).toBe(0);expect(await store.first('SELECT status,attempts FROM jobs')).toEqual({status:'pending',attempts:0});
});

it('keeps completion committed when the acknowledgment response is lost and its replay no longer matches a running claim',async()=>{
 const store=state.store!,write=store.run.bind(store);let lost=false;
 vi.spyOn(store,'run').mockImplementation(async(sql,...values)=>{const result=await write(sql,...values);if((sql.startsWith("UPDATE jobs SET status='complete'")||sql.startsWith('UPDATE jobs SET status=?')&&values[0]==='complete')&&!lost){lost=true;throw new DOMException('Database request timed out','TimeoutError');}return result;});
 const pending=run();let settled=false;void pending.finally(()=>{settled=true;}).catch(()=>{});await vi.waitFor(()=>expect(settled).toBe(true));
 expect(await pending).toEqual({completed:[jobId],failed:[]});expect(await store.first('SELECT status,attempts,error,leaseUntil FROM jobs')).toEqual({status:'complete',attempts:1,error:null,leaseUntil:null});
});

it.each(['running','pending','failed'] as const)('does not finish or clear a newer %s claim before the previous capture acknowledges completion',async status=>{
 const store=state.store!,write=store.run.bind(store);let replaced=false;
 vi.spyOn(store,'run').mockImplementation(async(sql,...values)=>{const result=await write(sql,...values);if(sql.startsWith('UPDATE connections SET lastSuccess=')&&!replaced){replaced=true;await write("UPDATE jobs SET status=?,attempts=4,leaseUntil='2026-10-14T17:00:00Z'",status);}return result;});
 expect(await run()).toEqual({completed:[],failed:[]});expect(await store.first('SELECT status,attempts,leaseUntil FROM jobs')).toEqual({status,attempts:4,leaseUntil:'2026-10-14T17:00:00Z'});
});

it('recognizes a durably completed capture when its acknowledgment times out after the whole run budget expires',async()=>{
 const store=state.store!,write=store.run.bind(store);
 vi.spyOn(store,'run').mockImplementation(async(sql,...values)=>{const result=await write(sql,...values);if(sql.startsWith("UPDATE jobs SET status='complete'")){vi.setSystemTime(deadline+463);throw new DOMException('Database request timed out','TimeoutError');}return result;});
 expect(await run()).toEqual({completed:[jobId],failed:[]});
 expect(await store.first('SELECT status,attempts,leaseUntil,error FROM jobs')).toEqual({status:'complete',attempts:1,leaseUntil:null,error:null});
 expect(await store.first('SELECT lastSuccess,coverageThrough,error FROM connections')).toEqual({lastSuccess:'2026-10-14T16:00:00.000Z',coverageThrough:'2026-10-14T16:00:00Z',error:null});
 expect(await store.first('SELECT COUNT(*) n FROM current_snapshots')).toEqual({n:1});
});
