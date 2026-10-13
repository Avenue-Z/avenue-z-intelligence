import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import initial from '../../data/initial-clients.json';
import type {AccessScope,SourceBatch} from '../../lib/analytics/contracts';
import {kindQualification,observation,sourceBatch} from '../../lib/sources/kind-patches';

const state=vi.hoisted(()=>({store:null as Store|null,sqlite:null as DatabaseSync|null,batch:null as SourceBatch|null,mode:'tail' as 'tail'|'before'|'success',healthAtTail:null as any,puts:0,requests:[] as {kind:'current'|'history';provider:string;window:{from:string;to:string}}[]}));
vi.mock('@avenue/runtime',()=>({env:{BUCKET:{put:async()=>{state.puts++;}}},runtimePlatform:'sites'}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:()=> 'server-only-test-secret'}));
vi.mock('../../lib/ai/server',()=>({generateAIReview:vi.fn()}));
vi.mock('../../lib/sources/kind-fetch',()=>({
 fetchKindSource:async(source:{provider:string},_client:unknown,window:{from:string;to:string})=>{state.requests.push({kind:'history',provider:source.provider,window});return state.batch!;},
 fetchKindBatches:async function*(source:{provider:string},_client:unknown,window:{from:string;to:string}){
  state.requests.push({kind:'current',provider:source.provider,window});
  if(state.mode==='before')throw Error('Current provider request failed');
  yield {batch:state.batch!,window:{from:'2026-10-13',to:'2026-10-13'}};
  state.healthAtTail=await state.store!.first('SELECT lastSuccess,coverageThrough,error FROM connections WHERE id=?','source');
  if(state.mode==='tail')throw Error('Historical provider request failed');
 }
}));
import {runSyncBatch} from '../../lib/jobs/sync';

const scope:AccessScope={organizationId:'o',actorId:'scheduler',role:'service',permittedClientIds:['kind-patches']};
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-13T13:00:00Z');state.mode='tail';state.healthAtTail=null;state.puts=0;state.requests=[];
 const sqlite=state.sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:unknown[]=[];const statement={bind(...input:unknown[]){values=input;return statement;},async all(){return {results:sqlite.prepare(sql).all(...values as any[])};},async first(){return sqlite.prepare(sql).get(...values as any[])??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values as any[]).changes)}};}};return statement;};
 const store=state.store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))}),client={...initial[0],version:1};
 await store.run('INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config,version) VALUES(?,?,?,?,?,?,?,?,?)',client.id,'o',client.name,client.id,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);
 await store.run("INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,version,lastSuccess,coverageThrough,error) VALUES('source','o','kind-patches','Source','kind-shopify-sales','https://bright-patches.myshopify.com/admin/api/2026-07/graphql.json','PRIVATE',60,1,1,'2026-10-13T11:00:00Z','2026-10-13T10:00:00Z','OLD_SOURCE_ERROR')");
 state.batch=sourceBatch(client as any,[observation('2026-10-13','revenue','revenue',42.25,'shopify_net_sales_all_channels','shopify_sales','USD',{stream:'Online Store'},{start:'2026-10-13T11:00:00Z',end:'2026-10-13T12:00:00Z'})],'2026-10-13T12:00:00Z',[],'hourly');
 await store.saveQualification('o',client.id,'source',1,1,kindQualification(state.batch,'kind-shopify-sales'),'scheduler');
 await store.enqueue('o',client.id,'source','hourly-test',new Date().toISOString());
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();state.sqlite?.close();});

it('publishes durable current freshness before the historical tail and retains its separate job failure',async()=>{
 const result=await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+200000});
 expect(result.completed).toEqual([]);expect(result.failed).toEqual([{id:'o:source:hourly-test',error:'Historical provider request failed'}]);
 const expected={lastSuccess:'2026-10-13T13:00:00.000Z',coverageThrough:'2026-10-13T12:00:00Z',error:null};
 expect(state.healthAtTail).toEqual(expected);expect(await state.store!.first('SELECT lastSuccess,coverageThrough,error FROM connections')).toEqual(expected);
 expect(await state.store!.first('SELECT status,attempts,error FROM jobs')).toEqual({status:'pending',attempts:1,error:'Historical provider request failed'});
 expect(await state.store!.first('SELECT date FROM current_snapshots')).toEqual({date:'2026-10-13'});expect(await state.store!.first('SELECT status FROM snapshots')).toEqual({status:'ready'});expect(state.puts).toBe(1);
});
it('records a current-capture failure without fabricating freshness or a ready snapshot',async()=>{
 state.mode='before';const result=await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+200000});expect(result.failed).toHaveLength(1);
 expect(await state.store!.first('SELECT lastSuccess,coverageThrough,error FROM connections')).toEqual({lastSuccess:'2026-10-13T11:00:00Z',coverageThrough:'2026-10-13T10:00:00Z',error:'Current provider request failed'});
 expect(await state.store!.first('SELECT status,attempts,error FROM jobs')).toEqual({status:'pending',attempts:1,error:'Current provider request failed'});expect(await state.store!.all('SELECT * FROM snapshots')).toEqual([]);expect(state.puts).toBe(0);
});
it('leaves current health unchanged when archive or persistence fails before durable publication',async()=>{
 vi.spyOn(state.store!,'persistBatch').mockRejectedValue(Error('Durable storage unavailable'));
 const result=await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+200000});expect(result.failed).toHaveLength(1);
 expect(await state.store!.first('SELECT lastSuccess,coverageThrough,error FROM connections')).toEqual({lastSuccess:'2026-10-13T11:00:00Z',coverageThrough:'2026-10-13T10:00:00Z',error:'Durable storage unavailable'});expect(state.healthAtTail).toBeNull();
});
it('marks a fully successful current capture complete and clears the former health error',async()=>{
 state.mode='success';const result=await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+200000});expect(result.failed).toEqual([]);expect(result.completed).toEqual(['o:source:hourly-test']);expect(await state.store!.first('SELECT status,error FROM jobs')).toEqual({status:'complete',error:null});expect(state.healthAtTail?.error).toBeNull();
});

it.each(['kind-shopify-sales','kind-shopify-products','kind-shopify-traffic','kind-meta-performance','kind-applovin'])('keeps routine %s captures on today while independent history repairs remain separate',async provider=>{
 await state.store!.run('UPDATE connections SET provider=?',provider);state.mode='before';
 await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000});
 expect(state.requests).toEqual([{kind:'current',provider,window:{from:'2026-10-13',to:'2026-10-13'}}]);
});
it.each(['kind-shopify-hourly','kind-shopify-funnels','kind-triple-whale','kind-triple-whale-summary','kind-triple-whale-diagnostics'])('preserves existing comparison recency for %s without independent history jobs',async provider=>{
 await state.store!.run('UPDATE connections SET provider=?',provider);state.mode='before';
 await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000});
 expect(state.requests).toEqual([{kind:'current',provider,window:{from:provider==='kind-shopify-hourly'?'2026-10-12':'2026-10-07',to:'2026-10-13'}}]);
});
it.each(['kind-shopify-sales','kind-shopify-products','kind-shopify-traffic','kind-meta-performance','kind-applovin'])('retains the requested closed day and source freshness for a %s history job',async provider=>{
 const store=state.store!,before=await store.first('SELECT lastSuccess,coverageThrough,error FROM connections');
 await store.run('UPDATE connections SET provider=?',provider);await store.run('DELETE FROM jobs');await store.enqueue('o','kind-patches','source','hourly-history:2026-10-12',new Date().toISOString());
 state.batch={...state.batch!,coverageThrough:'2026-10-12T22:00:00Z',rows:state.batch!.rows.map(row=>({...row,date:'2026-10-12',start:'2026-10-12T20:00:00Z',end:'2026-10-12T21:00:00Z'}))};
 const result=await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000});
 expect(result.failed).toEqual([]);expect(result.completed).toEqual(['o:source:hourly-history:2026-10-12']);
 expect(state.requests).toEqual([{kind:'history',provider,window:{from:'2026-10-12',to:'2026-10-12'}}]);expect(await store.first('SELECT lastSuccess,coverageThrough,error FROM connections')).toEqual(before);expect(await store.first('SELECT date FROM current_snapshots')).toEqual({date:'2026-10-12'});
});
