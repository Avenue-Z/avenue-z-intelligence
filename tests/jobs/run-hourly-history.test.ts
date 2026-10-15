import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import initial from '../../data/initial-clients.json';
import type {AccessScope,SourceBatch} from '../../lib/analytics/contracts';

const state=vi.hoisted(()=>({store:null as Store|null,sqlite:null as DatabaseSync|null,archives:[] as string[],active:new Set<string>(),peak:0,captures:[] as {provider:string;date:string}[],failure:'',partial:false,parallel:false,release:null as (()=>void)|null,waiting:null as Promise<void>|null,maintenance:[] as {maxSnapshots:number;maxRows:number;deadline:number}[],throttled:false,enqueueCurrentDuringCapture:false}));
vi.mock('@avenue/runtime',()=>({env:{BUCKET:{put:async(key:string)=>{if(state.failure==='archive')throw Error('Archive unavailable');state.archives.push(key);}}},runtimePlatform:'sites'}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:(name:string)=>name==='APP_ORGANIZATION_ID'?'o':'private-test-value'}));
vi.mock('../../lib/jobs/archive-materialization-retention',async importOriginal=>({...await importOriginal<typeof import('../../lib/jobs/archive-materialization-retention')>(),pruneArchivedMaterializations:async(_store:unknown,_scope:unknown,options:{maxSnapshots:number;maxRows:number;deadline:number})=>{state.maintenance.push(options);return {verifiedSnapshots:1,prunedSnapshots:1,rowsDeleted:12,charactersDeleted:6000,projectionChunksDeleted:1,skipped:0};}}));
vi.mock('../../lib/sources/kind-fetch',()=>({fetchKindSource:async(source:{id:string;provider:string},client:{id:string;timezone:string;currency:string},window:{from:string;to:string})=>{
 if(state.throttled&&source.provider.startsWith('kind-shopify-')){state.captures.push({provider:source.provider,date:window.to});const {ShopifyRateLimitError}=await import('../../lib/sources/shopify-graphql');throw new ShopifyRateLimitError(60000);}
 if(state.active.has(source.provider))throw Error('Duplicate active provider');state.active.add(source.provider);state.peak=Math.max(state.peak,state.active.size);state.captures.push({provider:source.provider,date:window.to});
 if(state.enqueueCurrentDuringCapture&&state.captures.length===1)await state.store!.enqueue('o','kind-patches',source.id,'current-during-history',new Date().toISOString());
 if(state.parallel){if(state.active.size===2)state.release?.();else await state.waiting;}
 state.active.delete(source.provider);
 const base={date:window.to,value:42.25,definition:'qualified',population:'population',start:`${window.to}T20:00:00Z`,end:`${window.to}T21:00:00Z`,sourceId:source.provider,retrievedAt:new Date().toISOString(),coverageThrough:`${window.to}T22:00:00Z`,quality:'complete' as const};
 return {clientId:client.id,timezone:client.timezone,currency:client.currency,channels:[],dimensions:source.provider==='kind-triple-whale'?['market']:[],grain:'hourly',complete:!state.partial,coverageThrough:`${window.to}T22:00:00Z`,rows:source.provider==='kind-recharge-cancellations'?['subscription_cancellations','new_subscriptions','same_day_subscription_cancellations'].map(metric=>({...base,dataset:'subscriptionEvents',metric,value:metric==='new_subscriptions'?100:5,currency:null,dimensions:{}})):source.provider==='kind-triple-whale'?['revenue','orders','new_orders'].map(metric=>({...base,dataset:'markets',metric,value:metric==='revenue'?42.25:2,currency:metric==='revenue'?'USD':null,dimensions:{market:'US'}})):[{...base,dataset:'revenue',metric:'revenue',currency:'USD',dimensions:{}}]} satisfies SourceBatch;
}}));
import {runHourlyHistoryBatch,hourlyHistoryTick} from '../../lib/jobs/run-hourly-history';

const scope:AccessScope={organizationId:'o',actorId:'scheduler',role:'service',permittedClientIds:['kind-patches']},client={...initial[0],version:1};
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-13T18:00:00Z');state.archives=[];state.active=new Set();state.peak=0;state.captures=[];state.failure='';state.partial=false;state.parallel=false;state.maintenance=[];state.throttled=false;state.enqueueCurrentDuringCapture=false;state.waiting=new Promise(resolve=>{state.release=resolve;});
 const sqlite=state.sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:unknown[]=[];const statement={sql,bind(...input:unknown[]){values=input;return statement;},async all(){return {results:sqlite.prepare(sql).all(...values as any[])};},async first(){return sqlite.prepare(sql).get(...values as any[])??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values as any[]).changes)}};}};return statement;};
 const store=state.store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))});
 await store.run("INSERT INTO organizations VALUES('o','Avenue Z',1)");await store.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',client.id,'o',client.name,client.id,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();state.sqlite?.close();});
async function source(id:string,provider='kind-shopify-sales',date='2026-10-12'){
 const store=state.store!;await store.run("INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,1,?,?,NULL,1)",id,'o',client.id,'Source',provider,'https://example.com','PRIVATE',60,'2026-10-13T17:00:00Z','2026-10-13T17:00:00Z');
 const profile={dataset:'revenue',metric:'revenue',definition:'qualified',population:'population',currency:'USD',dimensions:[],hourly:true};await store.saveQualification('o',client.id,id,1,1,{clientId:client.id,queryId:`${provider}:hourly-v2`,timezone:client.timezone,currency:client.currency,hourlyGrain:true,requiresHourly:true,channels:[],requiredChannels:[],dimensions:[],requiredDimensions:[],paginationComplete:true,reconciled:true,reconciliationEvidence:'Independent same-window reconciliation',profiles:provider==='kind-recharge-cancellations'?['subscription_cancellations','new_subscriptions','same_day_subscription_cancellations'].map(metric=>({...profile,dataset:'subscriptionEvents',metric,currency:null})):provider==='kind-triple-whale'?['revenue','orders','new_orders'].map(metric=>({...profile,dataset:'markets',metric,currency:metric==='revenue'?'USD':null,dimensions:['market']})):[profile]},'scheduler');
 await store.enqueue('o',client.id,id,`hourly-history:${date}`,new Date().toISOString());
}

it('captures two different historical providers concurrently and publishes archived facts without changing current source health',async()=>{
 await source('sales');await source('meta','kind-meta-performance');const store=state.store!,before=await store.all('SELECT * FROM connections');
 state.parallel=true;const result=await runHourlyHistoryBatch(store,scope,{maxJobs:2,deadline:Date.now()+700000});
 expect(result.failed).toEqual([]);expect(result.completed).toHaveLength(2);expect(state.peak).toBe(2);expect(state.archives).toHaveLength(2);expect(await store.all('SELECT * FROM connections')).toEqual(before);
 expect(await store.all('SELECT status FROM snapshots')).toEqual([{status:'ready'},{status:'ready'}]);expect(await store.all('SELECT date FROM current_snapshots')).toEqual([{date:'2026-10-12'},{date:'2026-10-12'}]);
});
it.each(['kind-shopify-traffic','kind-meta-performance','kind-shopify-sales'])('selects the dense transaction bound only for a historical %s publication',async provider=>{
 await source('history',provider);const store=state.store!,persist=vi.spyOn(store,'persistBatch'),result=await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000});
 expect(result.failed).toEqual([]);expect(result.completed).toHaveLength(1);expect(persist).toHaveBeenCalledOnce();const options=persist.mock.calls[0][6];if(provider==='kind-shopify-sales')expect(options).not.toHaveProperty('factPageSize');else expect(options).toHaveProperty('factPageSize',500);
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
it('captures AppLovin dates nearest its retention boundary first within the last thirty-day band',async()=>{
 await source('applovin','kind-applovin','2026-10-03');const store=state.store!;await store.run("UPDATE jobs SET dueAt='2026-10-13T17:00:00.000Z'");await store.enqueue('o',client.id,'applovin','hourly-history:2026-09-15',new Date().toISOString());
 await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000});expect(state.captures).toEqual([{provider:'kind-applovin',date:'2026-09-15'}]);
});

it('captures recent Recharge cohorts before older provider queues without changing their immutable due times',async()=>{
 await source('meta','kind-meta-performance','2026-08-15');const store=state.store!;
 for(let day=16;day<=31;day++)await store.enqueue('o',client.id,'meta',`hourly-history:2026-08-${day}`,'2026-10-13T16:00:00.000Z');
 await store.run("UPDATE jobs SET dueAt='2026-10-13T16:00:00.000Z' WHERE sourceId='meta'");
 await source('recharge','kind-recharge-cancellations','2026-09-15');await store.run("UPDATE jobs SET dueAt='2026-10-13T17:00:00.000Z' WHERE sourceId='recharge'");
 await store.enqueue('o',client.id,'recharge','hourly-history:2026-10-11','2026-10-13T18:00:00.000Z');
 const before=await store.all('SELECT id,dueAt FROM jobs ORDER BY id');
 for(let count=0;count<3;count++)await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000});
 expect(state.captures).toEqual([{provider:'kind-recharge-cancellations',date:'2026-10-11'},{provider:'kind-recharge-cancellations',date:'2026-09-15'}]);
 expect(await store.all('SELECT id,dueAt FROM jobs ORDER BY id')).toEqual(before);
});

it('does not bypass the normal retry due time when a more recent history date is deferred',async()=>{
 await source('meta','kind-meta-performance','2026-09-13');await source('recharge','kind-recharge-cancellations','2026-10-12');const store=state.store!;
 await store.run("UPDATE jobs SET dueAt='2026-10-13T19:00:00Z' WHERE sourceId='recharge'");
 await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000});
 expect(state.captures).toEqual([{provider:'kind-meta-performance',date:'2026-09-13'}]);
 expect(await store.first("SELECT status,attempts,dueAt FROM jobs WHERE sourceId='recharge'")).toEqual({status:'pending',attempts:0,dueAt:'2026-10-13T19:00:00Z'});
});
it('runs a bounded archive-maintenance phase at 18 GB before continuing historical captures',async()=>{
 const store=state.store!,original=store.first.bind(store);vi.spyOn(store,'first').mockImplementation(async(sql,...args)=>sql==='PRAGMA page_count'?{page_count:Math.ceil(18000000000/4096)}:sql==='PRAGMA freelist_count'?{freelist_count:0}:original(sql,...args));
 const result=await hourlyHistoryTick();expect(state.maintenance).toEqual([{maxSnapshots:8,maxRows:250000,deadline:Date.now()+180000,monthlyRetention:true}]);expect(result).toHaveProperty('maintenance.rowsDeleted',12);expect(await store.all('SELECT * FROM runner_leases')).toEqual([]);
});
it('defers the shared Shopify budget without burning attempts or claiming its other pending dates while unrelated feeds continue',async()=>{
 await source('sales');await source('products','kind-shopify-products');await source('meta','kind-meta-performance');state.throttled=true;
 const store=state.store!;for(const id of ['sales','products'])for(const date of ['2026-10-11','2026-10-10'])await store.enqueue('o',client.id,id,`hourly-history:${date}`,new Date().toISOString());
 const before=await store.all('SELECT * FROM connections'),result=await runHourlyHistoryBatch(store,scope,{maxJobs:7,deadline:Date.now()+700000});
 expect(result.completed).toEqual(['o:meta:hourly-history:2026-10-12']);expect(result.failed.length).toBeGreaterThanOrEqual(1);expect(result.failed.length).toBeLessThanOrEqual(2);
 const shopify=await store.all<{status:string;attempts:number}>('SELECT status,attempts FROM jobs WHERE sourceId IN (?,?) ORDER BY sourceId','sales','products');expect(shopify).toHaveLength(6);expect(shopify.every(job=>job.status==='pending'&&job.attempts===0)).toBe(true);expect(state.captures.filter(value=>value.provider.startsWith('kind-shopify-')).length).toBeLessThanOrEqual(2);expect(await store.all('SELECT * FROM connections')).toEqual(before);
});
it('retries a committed historical fact page without refetching, duplicating facts or altering live health',async()=>{
 await source('sales');const store=state.store!,before=await store.all('SELECT * FROM connections'),batch=store.db.batch.bind(store.db);let attempts=0;
 vi.spyOn(store.db,'batch').mockImplementation(async(statements)=>{const result=await batch(statements);if(statements.some(statement=>typeof statement.sql==='string'&&statement.sql.startsWith('INSERT INTO observations'))&&++attempts===1)throw new DOMException('Database request timed out','TimeoutError');return result;});
 const pending=runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000});let settled=false;void pending.finally(()=>{settled=true;}).catch(()=>{});await vi.waitFor(()=>expect(settled).toBe(true));const result=await pending;
 expect(result.completed).toEqual(['o:sales:hourly-history:2026-10-12']);expect(result.failed).toEqual([]);expect(attempts).toBe(2);expect(state.captures).toHaveLength(1);expect(state.archives).toHaveLength(1);expect(await store.first('SELECT count(*) n FROM observations')).toEqual({n:1});expect(await store.all('SELECT * FROM connections')).toEqual(before);expect(await store.first('SELECT status,attempts FROM jobs')).toEqual({status:'complete',attempts:1});
});

it('captures a qualified Recharge closed day through the existing history worker and preserves current source freshness',async()=>{
 await source('recharge','kind-recharge-cancellations');const store=state.store!,before=await store.all('SELECT * FROM connections'),result=await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+180000});expect(result).toMatchObject({completed:['o:recharge:hourly-history:2026-10-12'],failed:[]});expect(await store.all('SELECT * FROM connections')).toEqual(before);expect(await store.first('SELECT COUNT(*) n FROM observations')).toEqual({n:3});
});
it('leaves Recharge historical cohorts pending below their three-minute start budget',async()=>{
 await source('recharge','kind-recharge-cancellations');const store=state.store!,result=await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+179999});expect(result).toMatchObject({completed:[],failed:[]});expect(state.captures).toEqual([]);expect(await store.first('SELECT status,attempts FROM jobs')).toEqual({status:'pending',attempts:0});
});
it('captures qualified closed Triple Whale country history without altering live source freshness',async()=>{
 await source('whale','kind-triple-whale');const store=state.store!,before=await store.all('SELECT * FROM connections');
 const result=await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+200000});
 expect(result).toMatchObject({completed:['o:whale:hourly-history:2026-10-12'],failed:[]});
 expect(state.captures).toEqual([{provider:'kind-triple-whale',date:'2026-10-12'}]);
 expect(await store.all('SELECT * FROM connections')).toEqual(before);expect(await store.first('SELECT COUNT(*) n FROM observations')).toEqual({n:3});
 expect(await store.first('SELECT date FROM current_snapshots')).toEqual({date:'2026-10-12'});
});
it('leaves the seven-query Triple Whale history capture pending when its required start budget is unavailable',async()=>{
 await source('whale','kind-triple-whale');const store=state.store!;
 const result=await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+199999});
 expect(result).toMatchObject({completed:[],failed:[]});expect(state.captures).toEqual([]);expect(await store.first('SELECT status,attempts FROM jobs')).toEqual({status:'pending',attempts:0});
});
it('refuses legacy Recharge history jobs until both new cohort profiles are qualified',async()=>{
 await source('recharge','kind-recharge-cancellations');const store=state.store!,q=await store.qualification('o','recharge');await store.saveQualification('o',client.id,'recharge',1,1,{...q!.payload,profiles:q!.payload.profiles.slice(0,1)},'scheduler');expect((await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000})).completed).toEqual([]);expect(state.captures).toEqual([]);expect(await store.first('SELECT status,attempts FROM jobs')).toEqual({status:'pending',attempts:0});
});

it('defers new history claims while an enabled current source job is due and preserves all jobs, leases and current health',async()=>{
 await source('sales');const store=state.store!;await store.enqueue('o',client.id,'sales','current','2026-10-13T17:00:00Z');const jobs=await store.all('SELECT * FROM jobs'),connections=await store.all('SELECT * FROM connections');expect(await runHourlyHistoryBatch(store,scope,{maxJobs:2,deadline:Date.now()+700000})).toMatchObject({completed:[],failed:[],skipped:'current-source-work'});expect(state.captures).toEqual([]);expect(state.archives).toEqual([]);expect(await store.all('SELECT * FROM jobs')).toEqual(jobs);expect(await store.all('SELECT * FROM connections')).toEqual(connections);
});
it('allows already claimed history to publish but stops additional claims when a current source job becomes due',async()=>{
 await source('sales');const store=state.store!;await store.enqueue('o',client.id,'sales','hourly-history:2026-10-11',new Date().toISOString());state.enqueueCurrentDuringCapture=true;const result=await runHourlyHistoryBatch(store,scope,{maxJobs:3,deadline:Date.now()+700000});expect(result).toMatchObject({completed:['o:sales:hourly-history:2026-10-11'],failed:[],skipped:'current-source-work'});expect(state.captures).toHaveLength(1);expect(await store.first("SELECT status,attempts FROM jobs WHERE id='o:sales:hourly-history:2026-10-12'")).toEqual({status:'pending',attempts:0});expect(await store.first("SELECT status,attempts FROM jobs WHERE id='o:sales:current-during-history'")).toEqual({status:'pending',attempts:0});expect(await store.first('SELECT COUNT(*) n FROM snapshots')).toEqual({n:1});
});
it('ignores future current jobs and disabled connections when reserving write capacity for current ingestion',async()=>{
 await source('sales');await source('disabled','kind-meta-performance');const store=state.store!;await store.run("UPDATE connections SET enabled=0 WHERE id='disabled'");await store.enqueue('o',client.id,'disabled','current','2026-10-13T17:00:00Z');await store.enqueue('o',client.id,'sales','future-current','2026-10-13T19:00:00Z');expect((await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000})).completed).toEqual(['o:sales:hourly-history:2026-10-12']);
});

it('skips archive maintenance and history planning before heavy writes when an enabled current source is due',async()=>{
 await source('sales');const store=state.store!;await store.enqueue('o',client.id,'sales','current','2026-10-13T17:00:00Z');const original=store.first.bind(store);vi.spyOn(store,'first').mockImplementation(async(sql,...args)=>sql==='PRAGMA page_count'?{page_count:Math.ceil(18000000000/4096)}:sql==='PRAGMA freelist_count'?{freelist_count:0}:original(sql,...args));const jobs=await store.all('SELECT * FROM jobs'),writes=vi.spyOn(store,'run');expect(await hourlyHistoryTick()).toMatchObject({skipped:'current-source-work',completed:[],failed:[]});expect(state.maintenance).toEqual([]);expect(state.captures).toEqual([]);expect(writes).not.toHaveBeenCalled();expect(await store.all('SELECT * FROM jobs')).toEqual(jobs);expect(await store.all('SELECT * FROM runner_leases')).toEqual([]);
});
it('plans and captures closed-day history through the independent cron when current ingestion is clear',async()=>{
 await source('sales');const store=state.store!;await store.run('DELETE FROM jobs');const before=await store.all('SELECT * FROM connections');
 const result=await hourlyHistoryTick();
 expect(result.completed).toHaveLength(30);expect(result.failed).toEqual([]);expect(await store.first("SELECT count(*) n FROM jobs WHERE id LIKE '%:hourly-history:____-__-__'")).toEqual({n:30});
 expect(state.captures).toHaveLength(30);expect(await store.all('SELECT * FROM connections')).toEqual(before);expect(await store.all('SELECT * FROM runner_leases')).toEqual([]);
});

it('never claims historical work older than thirty closed store dates or today',async()=>{
 await source('meta','kind-meta-performance','2026-09-12');const store=state.store!;await store.enqueue('o',client.id,'meta','hourly-history:2026-10-13',new Date().toISOString());const jobs=await store.all('SELECT * FROM jobs');expect((await runHourlyHistoryBatch(store,scope,{maxJobs:2,deadline:Date.now()+700000})).completed).toEqual([]);expect(state.captures).toEqual([]);expect(await store.all('SELECT * FROM jobs')).toEqual(jobs);
});
it('rechecks the thirty-day claim window atomically when the clock crosses local midnight',async()=>{
 vi.setSystemTime('2026-10-13T21:59:59Z');await source('sales','kind-shopify-sales','2026-09-13');const store=state.store!,first=store.first.bind(store);let raced=false;vi.spyOn(store,'first').mockImplementation(async(sql,...args)=>{const result=await first(sql,...args);if(!raced&&sql.startsWith('SELECT j.id,j.sourceId')){raced=true;vi.setSystemTime('2026-10-13T22:00:01Z');}return result;});
 const result=await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000});expect(result.completed).toEqual([]);expect(state.captures).toEqual([]);expect(await store.first('SELECT status,attempts FROM jobs')).toEqual({status:'pending',attempts:0});
});
it('does not republish a claimed day that expires during its provider capture',async()=>{
 vi.setSystemTime('2026-10-13T21:59:59Z');await source('sales','kind-shopify-sales','2026-09-13');const store=state.store!,all=store.first.bind(store);let reads=0;vi.spyOn(store,'first').mockImplementation(async(sql,...args)=>{if(sql==='PRAGMA page_count'&&++reads===2)vi.setSystemTime('2026-10-13T22:00:01Z');return all(sql,...args);});
 const result=await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000});expect(result.completed).toEqual([]);expect(await store.all('SELECT * FROM snapshots')).toEqual([]);expect(await store.first('SELECT status FROM jobs')).toEqual({status:'cancelled'});expect(state.archives).toHaveLength(1);
});

it('retains the narrower AppLovin provider window even when an older pending date lies inside the monthly policy',async()=>{
 await source('applovin','kind-applovin','2026-09-13');const store=state.store!,before=await store.all('SELECT * FROM jobs');await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000});expect(state.captures).toEqual([]);expect(await store.all('SELECT * FROM jobs')).toEqual(before);
});
it('does not cancel a replacement historical owner when a captured date expires before publication',async()=>{
 vi.setSystemTime('2026-10-13T21:59:59Z');await source('sales','kind-shopify-sales','2026-09-13');const store=state.store!,first=store.first.bind(store),run=store.run.bind(store);let reads=0,replaced=false;
 vi.spyOn(store,'first').mockImplementation(async(sql,...args)=>{if(sql==='PRAGMA page_count'&&++reads===2)vi.setSystemTime('2026-10-13T22:00:01Z');return first(sql,...args);});vi.spyOn(store,'run').mockImplementation(async(sql,...args)=>{if(!replaced&&sql.startsWith("UPDATE jobs SET status='cancelled'")){replaced=true;await run("UPDATE jobs SET attempts=attempts+1,leaseUntil='2026-10-13T22:15:00Z' WHERE sourceId='sales'");}return run(sql,...args);});
 await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000});expect(await store.first('SELECT status,attempts,leaseUntil FROM jobs')).toEqual({status:'running',attempts:2,leaseUntil:'2026-10-13T22:15:00Z'});expect(await store.all('SELECT * FROM snapshots')).toEqual([]);
});

it('does not publish an AppLovin oldest eligible capture after it crosses the twenty-eight-day provider boundary at local midnight',async()=>{
 vi.setSystemTime('2026-10-13T21:59:59Z');await source('applovin','kind-applovin','2026-09-15');const store=state.store!,first=store.first.bind(store);let reads=0;vi.spyOn(store,'first').mockImplementation(async(sql,...args)=>{if(sql==='PRAGMA page_count'&&++reads===2)vi.setSystemTime('2026-10-13T22:00:01Z');return first(sql,...args);});
 const result=await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline:Date.now()+700000});expect(result).toMatchObject({completed:[],failed:[],skipped:'retention-window'});expect(state.captures).toEqual([{provider:'kind-applovin',date:'2026-09-15'}]);expect(state.archives).toHaveLength(1);expect(await store.all('SELECT * FROM snapshots')).toEqual([]);expect(await store.all('SELECT * FROM current_snapshots')).toEqual([]);expect(await store.first('SELECT status FROM jobs')).toEqual({status:'cancelled'});expect(await store.first("SELECT json_extract(payload,'$.retainedFrom') retainedFrom FROM audit WHERE action='history.window.cancel_verified'")).toEqual({retainedFrom:'2026-09-16'});
});
