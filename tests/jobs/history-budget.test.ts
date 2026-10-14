import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import type {AccessScope,Client} from '../../lib/analytics/contracts';
import {dayWindow} from '../../lib/analytics/windows';
import {kindQualification,localHourInterval,observation,sourceBatch} from '../../lib/sources/kind-patches';
import {rechargeCancellationDefinition,rechargeCancellationPopulation} from '../../lib/sources/recharge-cancellations';
import {rechargeCreatedDefinition,rechargeNewSubscriptionPopulation,rechargeSameDayCancellationDefinition} from '../../lib/sources/recharge-subscription-cohort';
import initial from '../../data/initial-clients.json';

const state=vi.hoisted(()=>({sqlite:null as DatabaseSync|null,store:null as Store|null,captures:0,archives:0,error:null as Error|null,offset:0,beforeFailure:null as (()=>Promise<void>)|null}));
vi.mock('@avenue/runtime',()=>({env:{BUCKET:{put:async()=>{state.archives++;}}},runtimePlatform:'vercel'}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:()=> 'private-test-value'}));
vi.mock('../../lib/sources/kind-fetch',()=>({fetchKindSource:async(_source:unknown,client:Client,window:{from:string;to:string},_secret:string,_fetch:unknown,deadline:number)=>{
 state.captures++;
 if(state.error){await state.beforeFailure?.();vi.setSystemTime(deadline+state.offset);throw state.error;}
 return fixture(client,window.to);
}}));
import {runHourlyHistoryBatch} from '../../lib/jobs/run-hourly-history';

const scope:AccessScope={organizationId:'o',actorId:'scheduler',role:'service',permittedClientIds:['kind-patches']},client={...initial[0],version:1} as Client;
const jobId='o:source:hourly-history:2026-09-16',started=Date.parse('2026-10-14T14:00:00Z'),deadline=started+700000;
function fixture(client:Client,date:string){
 const rows=[];
 for(let hour=0;hour<24;hour++)for(const[metric,definition,population]of[
  ['subscription_cancellations',rechargeCancellationDefinition,rechargeCancellationPopulation],
  ['new_subscriptions',rechargeCreatedDefinition,rechargeNewSubscriptionPopulation],
  ['same_day_subscription_cancellations',rechargeSameDayCancellationDefinition,rechargeNewSubscriptionPopulation],
 ] as const)rows.push(observation(date,'subscriptionEvents',metric,metric==='new_subscriptions'?100:5,definition,population,null,{},localHourInterval(date,hour,client.timezone)!));
 return sourceBatch(client,rows,dayWindow(date,client.timezone).end,[],'hourly');
}
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime(started);state.captures=0;state.archives=0;state.error=null;state.offset=0;state.beforeFailure=null;
 const sqlite=state.sqlite=new DatabaseSync(':memory:');
 for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{
  let values:unknown[]=[];
  const statement={sql,bind(...input:unknown[]){values=input;return statement;},async all(){return {results:sqlite.prepare(sql).all(...values as SQLInputValue[])};},async first(){return sqlite.prepare(sql).get(...values as SQLInputValue[])??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values as SQLInputValue[]).changes)}};}};
  return statement;
 };
 const store=state.store=new Store({prepare,batch:statements=>Promise.all(statements.map(statement=>statement.run()))});
 await store.run("INSERT INTO organizations VALUES('o','Avenue Z',1)");
 await store.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',client.id,'o',client.name,client.id,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);
 await store.run("INSERT INTO connections VALUES('source','o','kind-patches','Recharge','kind-recharge-cancellations','https://example.com','PRIVATE',60,1,'2026-10-14T13:00:00Z','2026-10-14T13:00:00Z',NULL,1)");
 const contract=kindQualification(fixture(client,'2026-09-16'),'kind-recharge-cancellations');contract.profiles=contract.profiles.slice(0,3);
 await store.saveQualification('o',client.id,'source',1,1,contract,'scheduler');
 await store.enqueue('o',client.id,'source','hourly-history:2026-09-16',new Date().toISOString());
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();state.sqlite?.close();});
const run=()=>runHourlyHistoryBatch(state.store!,scope,{maxJobs:2,deadline});

it.each([
 ['source deadline',new Error('Source synchronization deadline reached'),0],
 ['provider timeout after the shared deadline',new Error('Provider request timed out or could not be reached'),463],
 ['database timeout',new DOMException('Database request timed out','TimeoutError'),0],
 ['wrapped database timeout',new Error('Database transport unavailable',{cause:new DOMException('Database request timed out','TimeoutError')}),0],
] as const)('defers a %s at shared budget exhaustion without spending the last attempt or publishing data',async(_name,error,offset)=>{
 const store=state.store!,before=await store.all('SELECT * FROM connections');await store.run('UPDATE jobs SET attempts=2');state.error=error;state.offset=offset;
 const result=await run();
 expect(result).toMatchObject({completed:[],failed:[],skipped:'budget'});
 expect(await store.first('SELECT status,attempts,leaseUntil,dueAt,error FROM jobs')).toEqual({status:'pending',attempts:2,leaseUntil:null,dueAt:new Date(deadline+offset+300000).toISOString(),error:error.message});
 expect(state.captures).toBe(1);expect(state.archives).toBe(0);
 for(const table of ['snapshots','current_snapshots','observations'])expect(await store.first(`SELECT COUNT(*) n FROM ${table}`)).toEqual({n:0});
 expect(await store.all('SELECT * FROM connections')).toEqual(before);
});

it('defers an actual publication database timeout after exhaustion without inventing ready snapshots or current facts',async()=>{
 const store=state.store!,before=await store.all('SELECT * FROM connections'),read=store.first.bind(store);
 vi.spyOn(store,'first').mockImplementation(async(sql,...args)=>{if(sql.startsWith('SELECT id,status,retrievedAt,coverageThrough,complete FROM snapshots')){vi.setSystemTime(deadline);throw new DOMException('Database request timed out','TimeoutError');}return read(sql,...args);});
 expect(await run()).toMatchObject({completed:[],failed:[],skipped:'budget'});
 expect(await store.first('SELECT status,attempts,leaseUntil FROM jobs')).toEqual({status:'pending',attempts:0,leaseUntil:null});
 expect(state.captures).toBe(1);expect(state.archives).toBe(1);
 for(const table of ['snapshots','current_snapshots','observations'])expect(await store.first(`SELECT COUNT(*) n FROM ${table}`)).toEqual({n:0});
 expect(await store.all('SELECT * FROM connections')).toEqual(before);
});

it('keeps a provider timeout one millisecond before the global deadline in the normal bounded failure policy',async()=>{
 const store=state.store!;await store.run('UPDATE jobs SET attempts=2');state.error=new Error('Provider request timed out or could not be reached');state.offset=-1;
 const result=await run();expect(result.skipped).toBeUndefined();expect(result.failed).toEqual([{id:jobId,error:state.error.message}]);
 expect(await store.first('SELECT status,attempts FROM jobs')).toEqual({status:'failed',attempts:3});
});

it.each(['Provider returned HTTP 401','Provider returned HTTP 403','Registered source qualification mismatch','Provider returned invalid JSON','Recharge creation timestamp missing or invalid','Unexpected programmer failure'])('retains a real %s error after the deadline',async message=>{
 const store=state.store!;await store.run('UPDATE jobs SET attempts=2');state.error=new Error(message);
 const result=await run();expect(result.skipped).toBeUndefined();expect(result.failed).toEqual([{id:jobId,error:message}]);expect(await store.first('SELECT status,attempts,error FROM jobs')).toEqual({status:'failed',attempts:3,error:message});
});

it.each(['attempts','leaseUntil'] as const)('does not refund or clear a running claim whose %s changed while the old request expired',async field=>{
 const store=state.store!;state.error=new Error('Provider request timed out or could not be reached');
 state.beforeFailure=async()=>{await store.run(field==='attempts'?"UPDATE jobs SET attempts=4":"UPDATE jobs SET leaseUntil='2026-10-14T15:00:00Z'");};
 expect(await run()).toMatchObject({completed:[],failed:[],skipped:'budget'});
 expect(await store.first('SELECT status,attempts,leaseUntil FROM jobs')).toEqual({status:'running',attempts:field==='attempts'?4:1,leaseUntil:field==='leaseUntil'?'2026-10-14T15:00:00Z':'2026-10-14T14:15:00.000Z'});
});

it('preserves a complete job when its successful acknowledgment response times out at the global deadline',async()=>{
 const store=state.store!,before=await store.all('SELECT * FROM connections'),finish=store.finish.bind(store);
 vi.spyOn(store,'finish').mockImplementation(async(id,error)=>{await finish(id,error);vi.setSystemTime(deadline+463);throw new DOMException('Database request timed out','TimeoutError');});
 const result=await run();expect(result.completed).toEqual([jobId]);expect(result.failed).toEqual([]);
 expect(await store.first('SELECT status,attempts,leaseUntil,error FROM jobs')).toEqual({status:'complete',attempts:1,leaseUntil:null,error:null});
 expect(await store.first('SELECT COUNT(*) n FROM observations')).toEqual({n:72});expect(await store.first('SELECT date FROM current_snapshots')).toEqual({date:'2026-09-16'});
 expect(state.captures).toBe(1);expect(state.archives).toBe(1);expect(await store.all('SELECT * FROM connections')).toEqual(before);
});

it('leaves published facts intact with a pending retry when completion acknowledgment did not commit before exhaustion',async()=>{
 const store=state.store!,before=await store.all('SELECT * FROM connections');
 vi.spyOn(store,'finish').mockImplementation(async()=>{vi.setSystemTime(deadline);throw new DOMException('Database request timed out','TimeoutError');});
 const result=await run();expect(result).toMatchObject({completed:[],failed:[],skipped:'budget'});
 expect(await store.first('SELECT status,attempts,leaseUntil FROM jobs')).toEqual({status:'pending',attempts:0,leaseUntil:null});
 expect(await store.first('SELECT COUNT(*) n FROM observations')).toEqual({n:72});expect(await store.first('SELECT date FROM current_snapshots')).toEqual({date:'2026-09-16'});
 expect(await store.all('SELECT * FROM connections')).toEqual(before);
});
