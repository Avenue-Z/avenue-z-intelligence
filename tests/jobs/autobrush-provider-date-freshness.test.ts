import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {AccessScope,Client,SourceBatch} from '../../lib/analytics/contracts';
import type {RegisteredContract} from '../../lib/sources/registered-contract';
import {Store} from '../../lib/server/store';
import initial from '../../data/initial-clients.json';

const state=vi.hoisted(()=>({store:null as Store|null,batch:null as SourceBatch|null,mode:'tail' as 'tail'|'before'|'closed-only'|'empty'|'success',healthAtTail:null as unknown,puts:0}));
vi.mock('@avenue/runtime',()=>({runtimePlatform:'vercel',env:{BUCKET:{put:async()=>{state.puts++;}}}}));
vi.mock('../../lib/server/access',()=>({getStore:()=>{throw Error('Owned Store is required');}}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:()=> 'test-private-configuration'}));
vi.mock('../../lib/ai/server',()=>({generateAIReview:vi.fn()}));
vi.mock('../../lib/jobs/autobrush-captures',()=>({fetchAutobrushCaptures:async function*(){
 if(state.mode==='before')throw Error('Current provider request failed');
 if(state.mode==='empty')return;
 const date=state.mode==='closed-only'?'2026-10-21':'2026-10-22';
 const batch={...state.batch!,rows:state.batch!.rows.map(row=>({...row,date}))};
 vi.setSystemTime('2026-10-22T13:30:02Z');
 yield {batch,window:{from:date,to:date}};
 state.healthAtTail=await state.store!.first('SELECT lastSuccess,coverageThrough,error FROM connections WHERE id=?','source');
 if(state.mode==='tail')throw Error('Optional closed provider request failed');
}}));
vi.mock('../../lib/jobs/beam-captures',()=>({fetchBeamCaptures:async function*(){
 yield {batch:state.batch!,window:{from:'2026-10-22',to:'2026-10-22'}};
 throw Error('Optional closed provider request failed');
}}));
import {runSyncBatch} from '../../lib/jobs/sync';

let sqlite:DatabaseSync;
const today='2026-10-22',started='2026-10-22T13:30:00.000Z',published='2026-10-22T13:30:04.000Z';
const providers=['autobrush-motion','autobrush-intelligems'] as const;
function fixture(client:Client,provider:string):SourceBatch{
 const motion=provider.endsWith('motion');
 const dimensions:Record<string,string>=motion?{channel:'meta',reporting_timezone:'provider_account_timezone_unverified',provider_as_of:'2026-10-22T08:30:00.000Z'}:{report_date:today,experiment_id:'experiment',experiment:'Price test',variant_id:'control',variant:'Control',status:'started',is_control:'true',market:'all',analysis_scope:'all_countries_all_products_all_currencies_zscore3'};
 return {clientId:client.id,timezone:client.timezone,currency:client.currency,channels:motion?['meta']:[],dimensions:Object.keys(dimensions),grain:'daily',complete:true,coverageThrough:null,nextCursor:null,rows:[{date:today,dataset:motion?'media':'experiments',metric:motion?'platform_spend':'visitors',value:motion?125.5:30,population:motion?'motion_meta_account_report':'intelligems_exposed_experiment_visitors',definition:motion?'motion_meta_account_spend_provider_date_cached':'intelligems_all_countries_experiment_all_products_all_currencies_daily_visitors_zscore3',currency:motion?'USD':null,dimensions,sourceId:'source',retrievedAt:'2026-10-22T13:00:00.000Z',coverageThrough:null,quality:'partial'}]};
}
function qualification(batch:SourceBatch):RegisteredContract{
 const row=batch.rows[0];
 return {clientId:batch.clientId,queryId:'fixture-provider-date',timezone:batch.timezone,currency:batch.currency,hourlyGrain:false,channels:batch.channels,requiredChannels:batch.channels,dimensions:batch.dimensions,requiredDimensions:batch.dimensions,paginationComplete:true,reconciled:true,reconciliationEvidence:'Fixture provider totals and complete population independently reconcile.',profiles:[{dataset:row.dataset,metric:row.metric,population:row.population!,definition:row.definition,currency:row.currency,dimensions:Object.keys(row.dimensions),hourly:false}]};
}
async function setup(provider:string){
 const client={...initial.find(value=>value.id===(provider.startsWith('beam-')?'beam':'autobrush'))!,version:1} as Client,store=state.store!;
 await store.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',client.id,'o',client.name,client.slug,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);
 await store.run("INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,version,error) VALUES('source','o',?,'Daily reporting',?,'https://example.com','PRIVATE',60,1,1,'OLD_SOURCE_ERROR')",client.id,provider);
 state.batch=fixture(client,provider);
 await store.saveQualification('o',client.id,'source',1,1,qualification(state.batch),'fixture');
 await store.enqueue('o',client.id,'source','current',started);
 const scope:AccessScope={organizationId:'o',actorId:'native',role:'service',permittedClientIds:[client.id]};
 return {store,scope};
}
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(started);state.mode='tail';state.batch=null;state.healthAtTail=null;state.puts=0;
 sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:SQLInputValue[]=[];const statement={sql,bind(...input:SQLInputValue[]){values=input;return statement;},async first(){return sqlite.prepare(sql).get(...values)??null;},async all(){return {results:sqlite.prepare(sql).all(...values)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}};}};return statement;};
 state.store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))});
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();sqlite.close();});

describe.each(providers)('%s current provider-date publication',provider=>{
 it('retains actual publication freshness and its ready current pointer when the optional closed fetch fails',async()=>{
  const {store,scope}=await setup(provider),persist=store.persistBatch.bind(store);
  vi.spyOn(store,'persistBatch').mockImplementation(async(...args)=>{const id=await persist(...args);vi.setSystemTime(published);return id;});
  const result=await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000},store);
  expect(result).toEqual({completed:[],failed:[{id:'o:source:current',error:'Optional closed provider request failed'}]});
  const health={lastSuccess:published,coverageThrough:null,error:null};
  expect(state.healthAtTail).toEqual(health);
  expect(await store.first('SELECT lastSuccess,coverageThrough,error FROM connections')).toEqual(health);
  expect(await store.first('SELECT status,attempts,error,dueAt FROM jobs')).toEqual({status:'pending',attempts:1,error:'Optional closed provider request failed',dueAt:'2026-10-22T13:32:04.000Z'});
  expect(await store.first("SELECT c.date,s.status,s.complete,s.coverageThrough,s.retrievedAt FROM current_snapshots c JOIN snapshots s ON s.id=c.snapshotId WHERE c.date='2026-10-22'")).toEqual({date:today,status:'ready',complete:1,coverageThrough:null,retrievedAt:'2026-10-22T13:30:02.000Z'});
  expect(await store.first("SELECT COUNT(*) n FROM observations o JOIN current_snapshots c ON c.snapshotId=o.snapshotId WHERE c.date='2026-10-22'")).toEqual({n:1});
  expect(state.puts).toBe(1);
 });
 it('records a missing current fetch without inventing publication freshness',async()=>{
  const {store,scope}=await setup(provider);state.mode='before';
  expect((await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000},store)).failed).toEqual([{id:'o:source:current',error:'Current provider request failed'}]);
  expect(await store.first('SELECT lastSuccess,coverageThrough,error FROM connections')).toEqual({lastSuccess:null,coverageThrough:null,error:'Current provider request failed'});
  expect(await store.all('SELECT * FROM current_snapshots')).toEqual([]);expect(state.puts).toBe(0);
 });
 it('rejects an unregistered current metric before archive or publication',async()=>{
  const {store,scope}=await setup(provider);state.batch!.rows[0].metric='unregistered';
  expect((await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000},store)).failed[0].error).toContain('Unregistered');
  expect(await store.first('SELECT lastSuccess,coverageThrough FROM connections')).toEqual({lastSuccess:null,coverageThrough:null});
  expect(await store.all('SELECT * FROM current_snapshots')).toEqual([]);expect(state.puts).toBe(0);
 });
 it('leaves freshness unavailable when current persistence fails',async()=>{
  const {store,scope}=await setup(provider);vi.spyOn(store,'persistBatch').mockRejectedValue(Error('Current publication failed'));
  expect((await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000},store)).failed).toEqual([{id:'o:source:current',error:'Current publication failed'}]);
  expect(await store.first('SELECT lastSuccess,coverageThrough,error FROM connections')).toEqual({lastSuccess:null,coverageThrough:null,error:'Current publication failed'});
  expect(await store.all('SELECT * FROM current_snapshots')).toEqual([]);
 });
 it.each(['closed-only','empty'] as const)('does not acknowledge a %s generator as a valid current publication',async mode=>{
  const {store,scope}=await setup(provider);state.mode=mode;
  expect((await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000},store)).completed).toEqual([]);
  expect(await store.first('SELECT lastSuccess,coverageThrough FROM connections')).toEqual({lastSuccess:null,coverageThrough:null});
  expect(await store.all("SELECT * FROM current_snapshots WHERE date='2026-10-22'")).toEqual([]);
 });
 it.each(['incomplete','hourly','cursor','foreign-client'] as const)('does not acknowledge a %s current batch',async invalid=>{
  const {store,scope}=await setup(provider);state.mode='success';
  if(invalid==='incomplete')state.batch!.complete=false;
  if(invalid==='hourly')state.batch!.grain='hourly';
  if(invalid==='cursor')state.batch!.nextCursor='unread-page';
  if(invalid==='foreign-client')state.batch!.clientId='beam';
  const result=await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000},store);
  expect(result.completed).toEqual([]);
  expect(await store.first('SELECT lastSuccess,coverageThrough FROM connections')).toEqual({lastSuccess:null,coverageThrough:null});
 });
});

it.each(['beam-motion','beam-intelligems'])('preserves existing %s health behavior for a daily report with unknown coverage',async provider=>{
 const {store,scope}=await setup(provider);
 expect((await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000},store)).failed).toEqual([{id:'o:source:current',error:'Optional closed provider request failed'}]);
 expect(await store.first('SELECT lastSuccess,coverageThrough,error FROM connections')).toEqual({lastSuccess:null,coverageThrough:null,error:'Optional closed provider request failed'});
});
