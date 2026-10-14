import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import initial from '../../data/initial-clients.json';
import type {AccessScope,Client,SourceBatch} from '../../lib/analytics/contracts';
import {kindQualification,observation,sourceBatch} from '../../lib/sources/kind-patches';

const state=vi.hoisted(()=>({store:null as Store|null,sqlite:null as DatabaseSync|null,batch:null as SourceBatch|null,mode:'tail' as 'tail'|'before'|'success'|'settling',platform:'sites',healthAtTail:null as {lastSuccess:string|null;coverageThrough:string|null;error:string|null}|null,puts:0,skips:null as string[]|null,requests:[] as {kind:'current'|'history';provider:string;window:{from:string;to:string}}[]}));
vi.mock('@avenue/runtime',()=>({env:{BUCKET:{put:async()=>{state.puts++;}}},get runtimePlatform(){return state.platform;}}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:()=> 'server-only-test-secret'}));
vi.mock('../../lib/ai/server',()=>({generateAIReview:vi.fn()}));
vi.mock('../../lib/sources/kind-fetch',async importOriginal=>({
 kindSourceDates:(await importOriginal<typeof import('../../lib/sources/kind-fetch')>()).kindSourceDates,
 effectiveKindWindow:(await importOriginal<typeof import('../../lib/sources/kind-fetch')>()).effectiveKindWindow,
 fetchKindSource:async(source:{provider:string},_client:unknown,window:{from:string;to:string})=>{state.requests.push({kind:'history',provider:source.provider,window});return state.batch!;},
 fetchKindBatches:async function*(source:{provider:string},_client:unknown,window:{from:string;to:string},_secret:string,_fetch:unknown,_deadline:number,skips?:ReadonlySet<string>){
  state.skips=skips?[...skips]:null;
  state.requests.push({kind:'current',provider:source.provider,window});
  if(state.mode==='before')throw Error('Current provider request failed');
  if(state.mode==='settling'){const {AppLovinSettlingHourError}=await import('../../lib/sources/hourly-paid-media');throw new AppLovinSettlingHourError();}
  const date=state.batch!.rows[0].date;yield {batch:state.batch!,window:{from:date,to:date}};
  state.healthAtTail=await state.store!.first('SELECT lastSuccess,coverageThrough,error FROM connections WHERE id=?','source');
  if(state.mode==='tail')throw Error('Historical provider request failed');
 }
}));
import {enqueueDue,runSyncBatch} from '../../lib/jobs/sync';

const scope:AccessScope={organizationId:'o',actorId:'scheduler',role:'service',permittedClientIds:['kind-patches']};
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-13T13:00:00Z');state.mode='tail';state.platform='sites';state.healthAtTail=null;state.puts=0;state.skips=null;state.requests=[];
 const sqlite=state.sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:unknown[]=[];const statement={sql,bind(...input:unknown[]){values=input;return statement;},async all(){return {results:sqlite.prepare(sql).all(...values as SQLInputValue[])};},async first(){return sqlite.prepare(sql).get(...values as SQLInputValue[])??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values as SQLInputValue[]).changes)}};}};return statement;};
 const store=state.store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))}),client={...initial[0],version:1};
 await store.run('INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config,version) VALUES(?,?,?,?,?,?,?,?,?)',client.id,'o',client.name,client.id,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);
 await store.run("INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,version,lastSuccess,coverageThrough,error) VALUES('source','o','kind-patches','Source','kind-shopify-sales','https://bright-patches.myshopify.com/admin/api/2026-07/graphql.json','PRIVATE',60,1,1,'2026-10-13T11:00:00Z','2026-10-13T10:00:00Z','OLD_SOURCE_ERROR')");
 state.batch=sourceBatch(client as Client,[observation('2026-10-13','revenue','revenue',42.25,'shopify_net_sales_all_channels','shopify_sales','USD',{stream:'Online Store'},{start:'2026-10-13T11:00:00Z',end:'2026-10-13T12:00:00Z'})],'2026-10-13T12:00:00Z',[],'hourly');
 await store.saveQualification('o',client.id,'source',1,1,kindQualification(state.batch,'kind-shopify-sales'),'scheduler');
 await store.enqueue('o',client.id,'source','hourly-test',new Date().toISOString());
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();state.sqlite?.close();});
async function settlePublication<T>(pending:Promise<T>){let settled=false;void pending.finally(()=>{settled=true;}).catch(()=>{});await vi.waitFor(()=>expect(settled).toBe(true));return pending;}

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
it('defers a settling AppLovin first hour without consuming terminal attempts or changing valid stored data and health',async()=>{
 const store=state.store!;vi.setSystemTime('2026-10-13T23:15:00Z');await store.run("UPDATE connections SET provider='kind-applovin'");
 await store.persistBatch('o','source',state.batch!,'previous-valid','2026-10-13T11:00:00Z');await store.run('UPDATE jobs SET attempts=2');
 const priorFacts=await store.all('SELECT * FROM observations'),priorPointers=await store.all('SELECT * FROM current_snapshots'),priorHealth=await store.first('SELECT lastSuccess,coverageThrough,error FROM connections');state.mode='settling';
 await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+200000});
 expect(await store.first('SELECT status,attempts,dueAt,leaseUntil,error FROM jobs')).toEqual({status:'pending',attempts:2,dueAt:'2026-10-13T23:20:00.000Z',leaseUntil:null,error:'AppLovin latest completed hour is still settling'});
 vi.setSystemTime('2026-10-13T23:20:00Z');await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+200000});
 expect(await store.first('SELECT status,attempts,dueAt FROM jobs')).toEqual({status:'pending',attempts:2,dueAt:'2026-10-13T23:25:00.000Z'});
 expect(await store.first('SELECT lastSuccess,coverageThrough,error FROM connections')).toEqual(priorHealth);expect(await store.all('SELECT * FROM observations')).toEqual(priorFacts);expect(await store.all('SELECT * FROM current_snapshots')).toEqual(priorPointers);expect(state.puts).toBe(0);
 vi.setSystemTime('2026-10-13T23:25:00Z');state.mode='success';state.batch={...state.batch!,coverageThrough:'2026-10-13T23:00:00Z',rows:state.batch!.rows.map(row=>({...row,date:'2026-10-14',start:'2026-10-13T22:00:00Z',end:'2026-10-13T23:00:00Z'}))};
 expect((await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+200000})).completed).toEqual(['o:source:hourly-test']);expect(await store.first('SELECT status,attempts,error FROM jobs')).toEqual({status:'complete',attempts:3,error:null});
 expect(await store.first('SELECT lastSuccess,coverageThrough,error FROM connections')).toEqual({lastSuccess:'2026-10-13T23:25:00.000Z',coverageThrough:'2026-10-13T23:00:00Z',error:null});expect(await store.first("SELECT date FROM current_snapshots WHERE date='2026-10-14'")).toEqual({date:'2026-10-14'});
});
it('leaves current health unchanged when archive or persistence fails before durable publication',async()=>{
 vi.spyOn(state.store!,'persistBatch').mockRejectedValue(Error('Durable storage unavailable'));
 const result=await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+200000});expect(result.failed).toHaveLength(1);
 expect(await state.store!.first('SELECT lastSuccess,coverageThrough,error FROM connections')).toEqual({lastSuccess:'2026-10-13T11:00:00Z',coverageThrough:'2026-10-13T10:00:00Z',error:'Durable storage unavailable'});expect(state.healthAtTail).toBeNull();
});
it('marks a fully successful current capture complete and clears the former health error',async()=>{
 state.mode='success';const result=await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+200000});expect(result.failed).toEqual([]);expect(result.completed).toEqual(['o:source:hourly-test']);expect(await state.store!.first('SELECT status,error FROM jobs')).toEqual({status:'complete',error:null});expect(state.healthAtTail?.error).toBeNull();
});
it.each(['kind-shopify-traffic','kind-meta-performance','kind-shopify-sales'])('selects the dense transaction bound only for a current %s publication',async provider=>{
 const store=state.store!,persist=vi.spyOn(store,'persistBatch');await store.run('UPDATE connections SET provider=?',provider);state.mode='success';
 const result=await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+700000});expect(result.failed).toEqual([]);expect(persist).toHaveBeenCalledOnce();
 const options=persist.mock.calls[0][6];if(provider==='kind-shopify-sales')expect(options).not.toHaveProperty('factPageSize');else expect(options).toHaveProperty('factPageSize',500);
});
it('publishes native current data without reading or planning historical facts before its source claim',async()=>{
 state.platform='vercel';state.mode='success';const store=state.store!,read=store.all.bind(store);
 vi.spyOn(store,'all').mockImplementation(async(sql,...args)=>{if(sql.startsWith('SELECT c.date'))throw Error('Historical fact reads unavailable');return read(sql,...args);});
 await enqueueDue(scope);expect(await store.first("SELECT count(*) n FROM jobs WHERE id LIKE '%:hourly-history:____-__-__'")).toEqual({n:0});
 const result=await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+200000});expect(result.failed).toEqual([]);expect(result.completed).toEqual(['o:source:hourly-test']);
 expect(await store.first('SELECT status FROM snapshots')).toEqual({status:'ready'});expect(await store.first('SELECT coverageThrough,error FROM connections')).toEqual({coverageThrough:'2026-10-13T12:00:00Z',error:null});
});
it('retains thirty closed store dates of historical planning in the Sites scheduler fallback',async()=>{
 const store=state.store!,original=await store.first('SELECT * FROM jobs WHERE id=?','o:source:hourly-test');await enqueueDue(scope);expect(await store.first("SELECT count(*) n,MIN(substr(id,-10)) firstDate,MAX(substr(id,-10)) lastDate FROM jobs WHERE id LIKE '%:hourly-history:____-__-__'")).toEqual({n:30,firstDate:'2026-09-13',lastDate:'2026-10-12'});expect(await store.first('SELECT * FROM jobs WHERE id=?','o:source:hourly-test')).toEqual(original);expect(await store.first("SELECT count(*) n FROM jobs WHERE id NOT LIKE '%:hourly-history:____-__-__' AND status='pending'")).toEqual({n:2});
});

it.each(['kind-shopify-sales','kind-shopify-products','kind-shopify-traffic','kind-meta-performance','kind-applovin'])('keeps routine %s captures on today while independent history repairs remain separate',async provider=>{
 await state.store!.run('UPDATE connections SET provider=?',provider);state.mode='before';
 await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+700000});
 expect(state.requests).toEqual([{kind:'current',provider,window:{from:'2026-10-13',to:'2026-10-13'}}]);
});
it.each(['kind-shopify-hourly','kind-shopify-funnels','kind-triple-whale','kind-triple-whale-summary','kind-triple-whale-diagnostics'])('preserves existing comparison recency for %s without independent history jobs',async provider=>{
 await state.store!.run('UPDATE connections SET provider=?',provider);state.mode='before';
 await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000});
 expect(state.requests).toEqual([{kind:'current',provider,window:{from:provider==='kind-shopify-hourly'?'2026-10-12':'2026-10-07',to:'2026-10-13'}}]);
});
it.each(['kind-shopify-sales','kind-shopify-products','kind-shopify-traffic','kind-meta-performance','kind-applovin'])('leaves a %s closed-day repair unclaimed for the dedicated history worker',async provider=>{
 const store=state.store!,before=await store.first('SELECT lastSuccess,coverageThrough,error FROM connections');
 await store.run('UPDATE connections SET provider=?',provider);await store.run('DELETE FROM jobs');await store.enqueue('o','kind-patches','source','hourly-history:2026-10-12',new Date().toISOString());
 const result=await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000});
 expect(result.failed).toEqual([]);expect(result.completed).toEqual([]);
 expect(state.requests).toEqual([]);expect(await store.first('SELECT lastSuccess,coverageThrough,error FROM connections')).toEqual(before);expect(await store.first('SELECT status,attempts,leaseUntil FROM jobs')).toEqual({status:'pending',attempts:0,leaseUntil:null});expect(await store.all('SELECT date FROM current_snapshots')).toEqual([]);
});

it('retries the identical fact page after a committed database timeout without refetching or duplicating facts',async()=>{
 state.mode='success';const store=state.store!,write=store.db.batch.bind(store.db);let calls=0;
 store.db.batch=async statements=>{const facts=statements[0]?.sql.startsWith('INSERT INTO observations'),result=await write(statements);if(facts&&++calls===1)throw new DOMException('Database request timed out','TimeoutError');return result;};
 const result=await settlePublication(runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+200000}));
 expect(result).toEqual({completed:['o:source:hourly-test'],failed:[]});expect(calls).toBe(2);expect(state.requests).toHaveLength(1);expect(state.puts).toBe(1);
 expect(await store.first('SELECT count(*) n FROM observations')).toEqual({n:1});expect(await store.first('SELECT count(*) n FROM snapshots')).toEqual({n:1});expect(await store.first('SELECT status,error FROM jobs')).toEqual({status:'complete',error:null});
 expect((await store.first('SELECT coverageThrough,error FROM connections'))).toEqual({coverageThrough:'2026-10-13T12:00:00Z',error:null});
});
it('retries only idempotent source freshness and completion acknowledgments after committed response timeouts',async()=>{
 state.mode='success';const store=state.store!,run=store.run.bind(store),lost=new Set<string>();
 vi.spyOn(store,'run').mockImplementation(async(sql,...values)=>{const result=await run(sql,...values);if((sql.startsWith('UPDATE connections SET lastSuccess=')||sql.startsWith("UPDATE jobs SET status='complete'"))&&!lost.has(sql)){lost.add(sql);throw new DOMException('Database request timed out','TimeoutError');}return result;});
 const result=await settlePublication(runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+200000}));
 expect(result).toEqual({completed:['o:source:hourly-test'],failed:[]});expect(state.requests).toHaveLength(1);expect(lost.size).toBe(2);expect(await store.first('SELECT status,error,attempts FROM jobs')).toEqual({status:'complete',error:null,attempts:1});expect((await store.first('SELECT error FROM connections'))?.error).toBeNull();
});
it('keeps failed durable storage visible after three database timeout attempts',async()=>{
 state.mode='success';const store=state.store!,write=store.db.batch.bind(store.db);let attempts=0;
 store.db.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO observations')){attempts++;throw new DOMException('Database request timed out','TimeoutError');}return write(statements);};
 const result=await settlePublication(runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+200000}));
 expect(attempts).toBe(3);expect(result.failed).toEqual([{id:'o:source:hourly-test',error:'Database request timed out'}]);expect(state.requests).toHaveLength(1);expect(await store.first('SELECT status FROM snapshots')).toEqual({status:'writing'});expect(await store.all('SELECT * FROM current_snapshots')).toEqual([]);expect(await store.first('SELECT lastSuccess,error FROM connections')).toEqual({lastSuccess:'2026-10-13T11:00:00Z',error:'Database request timed out'});
});
it('does not start a publication retry when the native source-run budget is nearly exhausted',async()=>{
 state.mode='success';const started=Date.now(),store=state.store!,write=store.db.batch.bind(store.db);let attempts=0;
 store.db.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO observations')){attempts++;vi.setSystemTime(started+180000);throw new DOMException('Database request timed out','TimeoutError');}return write(statements);};
 const result=await runSyncBatch(scope,{maxJobs:1,deadline:started+200000});expect(attempts).toBe(1);expect(result.failed).toHaveLength(1);expect(state.requests).toHaveLength(1);
});

async function sessionComparisonFixture(provider:'kind-shopify-hourly'|'kind-shopify-funnels'){
 const store=state.store!,client={...initial[0],version:1} as Client,date='2026-10-12',prior=sourceBatch(client,[observation(date,'overview','sessions',7,'shopify_human_sessions','human_online_store_sessions',null,{},{start:'2026-10-11T22:00:00Z',end:'2026-10-11T23:00:00Z'})],'2026-10-12T22:00:00Z',[],'hourly');
 await store.run('UPDATE connections SET provider=?',provider);await store.persistBatch('o','source',prior,'comparison','2026-10-13T00:00:00Z',{from:date,to:date});
 state.batch=sourceBatch(client,[observation('2026-10-13','overview','sessions',9,'shopify_human_sessions','human_online_store_sessions',null,{},{start:'2026-10-13T11:00:00Z',end:'2026-10-13T12:00:00Z'})],'2026-10-13T12:00:00Z',[],'hourly');
 await store.saveQualification('o',client.id,'source',1,1,kindQualification(state.batch,provider),'scheduler');state.mode='success';
}
it.each(['kind-shopify-hourly','kind-shopify-funnels'] as const)('native automatic %s reuse is passed to the provider generator while today publishes normally',async provider=>{
 await sessionComparisonFixture(provider);state.platform='vercel';const result=await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+200000});
 expect(result.completed).toEqual(['o:source:hourly-test']);expect(state.skips).toEqual(['2026-10-12']);expect(state.requests).toHaveLength(1);
 expect(await state.store!.first("SELECT status,error FROM jobs")).toEqual({status:'complete',error:null});
});
it.each(['manual','initial','legacy'] as const)('preserves %s session priming without handing the generator a closed-date skip set',async reason=>{
 await sessionComparisonFixture('kind-shopify-hourly');state.platform=reason==='legacy'?'sites':'vercel';
 if(reason==='manual'){await state.store!.run('DELETE FROM jobs');await state.store!.enqueue('o','kind-patches','source','manual:abc',new Date().toISOString());}
 if(reason==='initial')await state.store!.run('UPDATE connections SET lastSuccess=NULL');
 expect((await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+200000})).completed).toHaveLength(1);expect(state.skips).toBeNull();
});
it('still publishes and completes today when optional session metadata reuse times out',async()=>{
 await sessionComparisonFixture('kind-shopify-hourly');state.platform='vercel';const store=state.store!,read=store.all.bind(store);
 vi.spyOn(store,'all').mockImplementation(async(sql,...args)=>{if(sql.includes('AS payload FROM current_snapshots c JOIN snapshots'))throw new DOMException('Database request timed out','TimeoutError');return read(sql,...args);});
 expect(await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+200000})).toEqual({completed:['o:source:hourly-test'],failed:[]});expect(state.skips).toEqual([]);expect(state.requests).toHaveLength(1);
 expect(await store.first('SELECT error,coverageThrough FROM connections')).toEqual({error:null,coverageThrough:'2026-10-13T12:00:00Z'});
});
