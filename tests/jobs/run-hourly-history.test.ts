import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import initial from '../../data/initial-clients.json';
import type {AccessScope,SourceBatch} from '../../lib/analytics/contracts';

const state=vi.hoisted(()=>({store:null as Store|null,sqlite:null as DatabaseSync|null,archives:[] as string[],active:new Set<string>(),peak:0,captures:[] as {provider:string;date:string}[],failure:'',partial:false,parallel:false,release:null as (()=>void)|null,waiting:null as Promise<void>|null,maintenance:[] as {maxSnapshots:number;maxRows:number;deadline:number}[],throttled:false}));
vi.mock('@avenue/runtime',()=>({env:{BUCKET:{put:async(key:string)=>{if(state.failure==='archive')throw Error('Archive unavailable');state.archives.push(key);}}},runtimePlatform:'sites'}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:(name:string)=>name==='APP_ORGANIZATION_ID'?'o':'private-test-value'}));
vi.mock('../../lib/jobs/archive-materialization-retention',()=>({pruneArchivedMaterializations:async(_store:unknown,_scope:unknown,options:{maxSnapshots:number;maxRows:number;deadline:number})=>{state.maintenance.push(options);return {verifiedSnapshots:1,prunedSnapshots:1,rowsDeleted:12,charactersDeleted:6000,projectionChunksDeleted:1,skipped:0};}}));
vi.mock('../../lib/sources/kind-fetch',()=>({fetchKindSource:async(source:{provider:string},client:{id:string;timezone:string;currency:string},window:{from:string;to:string})=>{
 if(state.throttled&&source.provider.startsWith('kind-shopify-')){state.captures.push({provider:source.provider,date:window.to});const {ShopifyRateLimitError}=await import('../../lib/sources/shopify-graphql');throw new ShopifyRateLimitError(60000);}
 if(state.active.has(source.provider))throw Error('Duplicate active provider');state.active.add(source.provider);state.peak=Math.max(state.peak,state.active.size);state.captures.push({provider:source.provider,date:window.to});
 if(state.parallel){if(state.active.size===2)state.release?.();else await state.waiting;}
 state.active.delete(source.provider);
 return {clientId:client.id,timezone:client.timezone,currency:client.currency,channels:[],dimensions:[],grain:'hourly',complete:!state.partial,coverageThrough:`${window.to}T22:00:00Z`,rows:[{date:window.to,dataset:'revenue',metric:'revenue',value:42.25,definition:'qualified',population:'population',currency:'USD',dimensions:{},start:`${window.to}T20:00:00Z`,end:`${window.to}T21:00:00Z`,sourceId:source.provider,retrievedAt:new Date().toISOString(),coverageThrough:`${window.to}T22:00:00Z`,quality:'complete'}]} satisfies SourceBatch;
}}));
import {runHourlyHistoryBatch,hourlyHistoryTick} from '../../lib/jobs/run-hourly-history';

const scope:AccessScope={organizationId:'o',actorId:'scheduler',role:'service',permittedClientIds:['kind-patches']},client={...initial[0],version:1};
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-13T18:00:00Z');state.archives=[];state.active=new Set();state.peak=0;state.captures=[];state.failure='';state.partial=false;state.parallel=false;state.maintenance=[];state.throttled=false;state.waiting=new Promise(resolve=>{state.release=resolve;});
 const sqlite=state.sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:unknown[]=[];const statement={bind(...input:unknown[]){values=input;return statement;},async all(){return {results:sqlite.prepare(sql).all(...values as any[])};},async first(){return sqlite.prepare(sql).get(...values as any[])??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values as any[]).changes)}};}};return statement;};
 const store=state.store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))});
 await store.run("INSERT INTO organizations VALUES('o','Avenue Z',1)");await store.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',client.id,'o',client.name,client.id,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();state.sqlite?.close();});
async function source(id:string,provider='kind-shopify-sales',date='2026-10-12'){
 const store=state.store!;await store.run("INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,1,?,?,NULL,1)",id,'o',client.id,'Source',provider,'https://example.com','PRIVATE',60,'2026-10-13T17:00:00Z','2026-10-13T17:00:00Z');
 const profile={dataset:'revenue',metric:'revenue',definition:'qualified',population:'population',currency:'USD',dimensions:[],hourly:true};await store.saveQualification('o',client.id,id,1,1,{clientId:client.id,queryId:`${provider}:hourly-v2`,timezone:client.timezone,currency:client.currency,hourlyGrain:true,requiresHourly:true,channels:[],requiredChannels:[],dimensions:[],requiredDimensions:[],paginationComplete:true,reconciled:true,reconciliationEvidence:'Independent same-window reconciliation',profiles:[profile]},'scheduler');
 await store.enqueue('o',client.id,id,`hourly-history:${date}`,new Date().toISOString());
}

it('captures two different historical providers concurrently and publishes archived facts without touching current jobs or source health',async()=>{
 await source('sales');await source('meta','kind-meta-performance');const store=state.store!,before=await store.all('SELECT * FROM connections');await store.enqueue('o',client.id,'sales','current','2026-10-13T17:00:00Z');
 state.parallel=true;const result=await runHourlyHistoryBatch(store,scope,{maxJobs:2,deadline:Date.now()+700000});
 expect(result.failed).toEqual([]);expect(result.completed).toHaveLength(2);expect(state.peak).toBe(2);expect(state.archives).toHaveLength(2);expect(await store.all('SELECT * FROM connections')).toEqual(before);
 expect(await store.first("SELECT status,attempts FROM jobs WHERE id='o:sales:current'")).toEqual({status:'pending',attempts:0});expect(await store.all('SELECT status FROM snapshots')).toEqual([{status:'ready'},{status:'ready'}]);expect(await store.all('SELECT date FROM current_snapshots')).toEqual([{date:'2026-10-12'},{date:'2026-10-12'}]);
});
it('stops before claiming a new historical job at the 22 GB safety threshold',async()=>{
 await source('sales');const store=state.store!,original=store.first.bind(store);vi.spyOn(store,'first').mockImplementation(async(sql,...args)=>sql==='PRAGMA page_count'?{page_count:Math.ceil(22000000000/4096)}:sql==='PRAGMA freelist_count'?{freelist_count:0}:original(sql,...args));
 const result=await runHourlyHistoryBatch(store,scope,{maxJobs:2,deadline:Date.now()+700000});expect(result).toMatchObject({completed:[],failed:[],skipped:'storage-capacity'});expect(state.captures).toEqual([]);expect(await store.first('SELECT status,attempts FROM jobs')).toEqual({status:'pending',attempts:0});
});
it('does not complete or publish an incomplete historical provider response',async()=>{
 await source('sales');state.partial=true;const store=state.store!,result=await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000});expect(result.completed).toEqual([]);expect(result.failed).toHaveLength(1);expect(await store.first('SELECT status,attempts FROM jobs')).toEqual({status:'pending',attempts:1});expect(await store.all('SELECT * FROM snapshots')).toEqual([]);expect(state.archives).toEqual([]);
});
it('retries an archive failure while keeping current source freshness healthy',async()=>{
 await source('sales');state.failure='archive';const store=state.store!,result=await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000});expect(result.failed).toHaveLength(1);expect(await store.first('SELECT status,error,attempts FROM jobs')).toEqual({status:'pending',error:'Archive unavailable',attempts:1});expect(await store.first('SELECT error,lastSuccess FROM connections')).toEqual({error:null,lastSuccess:'2026-10-13T17:00:00Z'});expect(await store.all('SELECT * FROM snapshots')).toEqual([]);
});
it('leaves active leases and short-budget jobs alone',async()=>{
 await source('sales');const store=state.store!;expect((await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+29999})).completed).toEqual([]);expect(await store.first('SELECT attempts FROM jobs')).toEqual({attempts:0});await store.run("UPDATE jobs SET status='running',leaseUntil='2026-10-13T18:10:00Z'");expect((await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000})).completed).toEqual([]);expect(state.captures).toEqual([]);
});
it('refuses unpermitted clients, roles and unqualified source versions',async()=>{
 await source('sales');const store=state.store!;expect((await runHourlyHistoryBatch(store,{...scope,permittedClientIds:['beam']},{maxJobs:1,deadline:Date.now()+700000})).completed).toEqual([]);expect((await runHourlyHistoryBatch(store,{...scope,role:'analyst'},{maxJobs:1,deadline:Date.now()+700000})).completed).toEqual([]);await store.run('UPDATE connections SET version=2');expect((await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000})).completed).toEqual([]);expect(state.captures).toEqual([]);
});
it('uses a separate runner lease and preserves the current sync lease',async()=>{
 const store=state.store!;await store.run("INSERT INTO runner_leases VALUES('o:sync','current-runner','2026-10-13T18:15:00Z')");await store.run("INSERT INTO runner_leases VALUES('o:hourly-history','other-history-runner','2026-10-13T18:15:00Z')");expect(await hourlyHistoryTick()).toMatchObject({skipped:'already-running',completed:[],failed:[]});expect(await store.all('SELECT id,token FROM runner_leases ORDER BY id')).toEqual([{id:'o:hourly-history',token:'other-history-runner'},{id:'o:sync',token:'current-runner'}]);
});
it('captures AppLovin dates nearest its retention boundary before newer comparison days',async()=>{
 await source('applovin','kind-applovin','2026-10-12');const store=state.store!;await store.run("UPDATE jobs SET dueAt='2026-10-13T17:00:00.000Z'");await store.enqueue('o',client.id,'applovin','hourly-history:2026-09-15',new Date().toISOString());
 await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000});expect(state.captures).toEqual([{provider:'kind-applovin',date:'2026-09-15'}]);
});
it('runs a bounded archive-maintenance phase at 18 GB before continuing historical captures',async()=>{
 const store=state.store!,original=store.first.bind(store);vi.spyOn(store,'first').mockImplementation(async(sql,...args)=>sql==='PRAGMA page_count'?{page_count:Math.ceil(18000000000/4096)}:sql==='PRAGMA freelist_count'?{freelist_count:0}:original(sql,...args));
 const result=await hourlyHistoryTick();expect(state.maintenance).toEqual([{maxSnapshots:8,maxRows:250000,deadline:Date.now()+180000}]);expect(result).toHaveProperty('maintenance.rowsDeleted',12);expect(await store.all('SELECT * FROM runner_leases')).toEqual([]);
});
it('defers the shared Shopify budget without burning attempts or claiming its other pending dates while unrelated feeds continue',async()=>{
 await source('sales');await source('products','kind-shopify-products');await source('meta','kind-meta-performance');state.throttled=true;
 const store=state.store!;for(const id of ['sales','products'])for(const date of ['2026-10-11','2026-10-10'])await store.enqueue('o',client.id,id,`hourly-history:${date}`,new Date().toISOString());
 const before=await store.all('SELECT * FROM connections'),result=await runHourlyHistoryBatch(store,scope,{maxJobs:7,deadline:Date.now()+700000});
 expect(result.completed).toEqual(['o:meta:hourly-history:2026-10-12']);expect(result.failed.length).toBeGreaterThanOrEqual(1);expect(result.failed.length).toBeLessThanOrEqual(2);
 const shopify=await store.all<{status:string;attempts:number}>('SELECT status,attempts FROM jobs WHERE sourceId IN (?,?) ORDER BY sourceId','sales','products');expect(shopify).toHaveLength(6);expect(shopify.every(job=>job.status==='pending'&&job.attempts===0)).toBe(true);expect(state.captures.filter(value=>value.provider.startsWith('kind-shopify-')).length).toBeLessThanOrEqual(2);expect(await store.all('SELECT * FROM connections')).toEqual(before);
});
it('replays a timed-out historical publication without refetching, duplicating facts or altering live health',async()=>{
 await source('sales');const store=state.store!,before=await store.all('SELECT * FROM connections'),persist=store.persistBatch.bind(store);let attempts=0;
 vi.spyOn(store,'persistBatch').mockImplementation(async(...args)=>{const id=await persist(...args);if(++attempts===1)throw new DOMException('Database request timed out','TimeoutError');return id;});
 const pending=runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000});let settled=false;void pending.finally(()=>{settled=true;}).catch(()=>{});await vi.waitFor(()=>expect(settled).toBe(true));const result=await pending;
 expect(result.completed).toEqual(['o:sales:hourly-history:2026-10-12']);expect(result.failed).toEqual([]);expect(attempts).toBe(2);expect(state.captures).toHaveLength(1);expect(state.archives).toHaveLength(1);expect(await store.first('SELECT count(*) n FROM observations')).toEqual({n:1});expect(await store.all('SELECT * FROM connections')).toEqual(before);expect(await store.first('SELECT status,attempts FROM jobs')).toEqual({status:'complete',attempts:1});
});
