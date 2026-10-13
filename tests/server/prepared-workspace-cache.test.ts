import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import type {Client,Connection,Observation,QueryFilters,SourceBatch} from '../../lib/analytics/contracts';
import clients from '../../data/initial-clients.json';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import {Store} from '../../lib/server/store';
const state=vi.hoisted(()=>({platform:'vercel',gate:vi.fn(async(work:()=>Promise<unknown>)=>work())}));
vi.mock('@avenue/runtime',()=>({get runtimePlatform(){return state.platform;}}));
vi.mock('../../lib/server/analytics-memory',()=>({withAnalyticsMemory:state.gate}));
import {preparedWorkspaceFrame,type PreparedWorkspaceInput} from '../../lib/server/prepared-workspace-cache';
const databases:DatabaseSync[]=[];
afterEach(()=>{for(const db of databases)db.close();databases.length=0;vi.useRealTimers();vi.unstubAllGlobals();state.platform='vercel';state.gate.mockClear();});
const filters:QueryFilters={from:'2026-10-10',to:'2026-10-11',compare:'previous',mode:'closed',view:'traffic',market:'',stream:'',source:'',device:'',page:''};
function fixture(){
 const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:unknown[]=[];const statement={bind(...input:unknown[]){values=input;return statement;},async all(){return {results:sqlite.prepare(sql).all(...values as any[])};},async first(){return sqlite.prepare(sql).get(...values as any[])??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values as any[]).changes)}};}};return statement;};
 const store=new Store({prepare,batch:async(statements:ReturnType<typeof prepare>[])=>{sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}}),client={...(clients[0] as Client),id:'a'},input:PreparedWorkspaceInput={store,organizationId:'o',client,filters:{...filters},preparedDatasets:['overview','traffic'],selection:{datasets:['overview','traffic'],includePriorWeek:false}};
 sqlite.prepare('INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES(?,?,?,?,?,?,?,?,?)').run('snapshot','o','a','source','2026-10-12T00:00:00Z','2026-10-12T00:00:00Z',1,'ready','derived');
 sqlite.prepare('INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId) VALUES(?,?,?,?,?)').run('o','a','source','2026-10-11','snapshot');
 sqlite.prepare('INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,lastSuccess,coverageThrough,error,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('source','o','a','Fresh source','gateway','https://private.example','PRIVATE_SECRET_REF',60,1,'old','2026-10-12T00:00:00Z',null,1);
 const load=vi.fn(async(connections:Connection[])=>workspacePresentation(queryClient(input.client,[],connections,input.filters,{preparedDatasets:input.preparedDatasets}),input.filters));
 return {sqlite,store,input,load};
}
function addPointer(sqlite:DatabaseSync,sourceId:string,date:string,key:string){
 sqlite.prepare('INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES(?,?,?,?,?,?,?,?,?)').run(key,'o','a',sourceId,'2026-10-13T00:00:00Z','2026-10-13T00:00:00Z',1,'ready','private-archive');
 sqlite.prepare('INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId) VALUES(?,?,?,?,?) ON CONFLICT(organizationId,clientId,sourceId,date) DO UPDATE SET snapshotId=excluded.snapshotId').run('o','a',sourceId,date,key);
}
function canonicalLoad(input:PreparedWorkspaceInput){return vi.fn(async(connections:Connection[])=>workspacePresentation(queryClient(input.client,await input.store.observations(input.organizationId,input.client.id,input.filters,false,undefined,input.selection),connections,input.filters,{preparedDatasets:input.preparedDatasets}),input.filters));}
it('uses the hosted warmer frame for a resolved Today shortcut and still isolates another date',async()=>{
 const {input,load}=fixture();input.filters={...input.filters,from:'2026-10-13',to:'2026-10-13',mode:'partial'};
 await preparedWorkspaceFrame(input,load);
 await preparedWorkspaceFrame({...input,filters:{...input.filters,period:'today'}},load);
 expect(load).toHaveBeenCalledTimes(1);
 await preparedWorkspaceFrame({...input,filters:{...input.filters,from:'2026-10-12',to:'2026-10-12'}},load);
 expect(load).toHaveBeenCalledTimes(2);
});
it('serves financial scopes while the dimensional traffic memory lease is occupied',async()=>{
 const {input,load}=fixture();let release!:()=>void;
 state.gate.mockImplementationOnce(async work=>{await new Promise<void>(resolve=>{release=resolve;});return work();});
 const traffic=preparedWorkspaceFrame(input,load);await vi.waitFor(()=>expect(state.gate).toHaveBeenCalledTimes(1));
 const financial={...input,filters:{...input.filters,view:'revenue'},preparedDatasets:['overview','revenue'],selection:{datasets:['overview','revenue'],includePriorWeek:false,includeOperations:false}},financialLoad=canonicalLoad(financial);
 try{const frame=await preparedWorkspaceFrame(financial,financialLoad);expect(frame.preparedDatasets).toEqual(['overview','revenue']);expect(frame.metrics.revenue).toBeNull();expect(financialLoad).toHaveBeenCalledTimes(1);expect(load).not.toHaveBeenCalled();expect(state.gate).toHaveBeenCalledTimes(1);}finally{release();await traffic;}
});
it('retains a closed historical frame across unrelated provider and out-of-window date refreshes',async()=>{
 const {sqlite,input,load}=fixture();await input.store.saveQualification('o','a','source',1,1,{profiles:[{dataset:'overview',metric:'revenue'},{dataset:'traffic',metric:'sessions'}]},'admin');
 await input.store.saveQualification('o','a','products',1,1,{profiles:[{dataset:'products',metric:'net_sales'}]},'admin');addPointer(sqlite,'products','2026-10-11','products-first');addPointer(sqlite,'source','2026-10-13','today-first');addPointer(sqlite,'source','2026-01-01','old-first');
 await preparedWorkspaceFrame(input,load);addPointer(sqlite,'products','2026-10-11','products-next');await input.store.saveQualification('o','a','products',2,1,{profiles:[{dataset:'products',metric:'gross_sales'}]},'admin');addPointer(sqlite,'source','2026-10-13','today-next');addPointer(sqlite,'source','2026-01-01','old-next');
 await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(1);
});
it('still invalidates the overview history and exact custom comparison windows',async()=>{
 const {sqlite,input,load}=fixture();await input.store.saveQualification('o','a','source',1,1,{profiles:[{dataset:'overview',metric:'revenue'},{dataset:'traffic',metric:'sessions'}]},'admin');addPointer(sqlite,'source','2026-09-12','history-first');
 await preparedWorkspaceFrame(input,load);addPointer(sqlite,'source','2026-09-12','history-corrected');await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(2);
 const custom={...input,filters:{...input.filters,compare:'custom' as const,compareFrom:'2026-08-15',compareTo:'2026-08-16'}};addPointer(sqlite,'source','2026-08-15','comparison-first');await preparedWorkspaceFrame(custom,load);addPointer(sqlite,'source','2026-08-15','comparison-corrected');await preparedWorkspaceFrame(custom,load);expect(load).toHaveBeenCalledTimes(4);
});
it('invalidates only contributing Revenue trend days and keeps context and non-context cache keys distinct',async()=>{
 const {sqlite,input,load}=fixture();input.filters={...input.filters,from:'2026-10-12',to:'2026-10-12',view:'revenue'};input.preparedDatasets=['revenue'];input.selection={datasets:['revenue'],includePriorWeek:false,trendDatasets:['revenue']};await input.store.saveQualification('o','a','source',1,1,{profiles:[{dataset:'revenue',metric:'revenue'},{dataset:'revenue',metric:'orders'}]},'admin');await input.store.saveQualification('o','a','traffic',1,1,{profiles:[{dataset:'traffic',metric:'sessions'}]},'admin');
 addPointer(sqlite,'source','2026-09-13','context-start');addPointer(sqlite,'source','2026-09-12','before-context');addPointer(sqlite,'traffic','2026-09-13','excluded-detail');await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(1);
 addPointer(sqlite,'source','2026-09-12','before-context-corrected');addPointer(sqlite,'traffic','2026-09-13','excluded-detail-corrected');await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(1);
 addPointer(sqlite,'source','2026-09-13','context-start-corrected');await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(2);
 const withoutContext={...input,selection:{datasets:['revenue'],includePriorWeek:false}};await preparedWorkspaceFrame(withoutContext,load);expect(load).toHaveBeenCalledTimes(3);addPointer(sqlite,'source','2026-09-13','context-start-corrected-again');await preparedWorkspaceFrame(withoutContext,load);expect(load).toHaveBeenCalledTimes(3);await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(4);
 sqlite.exec("UPDATE snapshots SET status='writing' WHERE id='context-start-corrected-again'");await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(5);
});
it('keeps renewal history and market prior-day pointers in their contributing scope',async()=>{
 const {sqlite,input,load}=fixture();input.selection.datasets=['overview','subscriptions','markets'];input.preparedDatasets=['overview','subscriptions','markets'];await input.store.saveQualification('o','a','source',1,1,{profiles:[{dataset:'subscriptions',metric:'recurring_revenue'},{dataset:'markets',metric:'sessions'}]},'admin');addPointer(sqlite,'source','2026-08-17','renewal-first');addPointer(sqlite,'source','2026-10-09','market-prior');
 await preparedWorkspaceFrame(input,load);addPointer(sqlite,'source','2026-08-17','renewal-corrected');await preparedWorkspaceFrame(input,load);addPointer(sqlite,'source','2026-10-09','market-corrected');await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(3);
});
it('remains conservative when any historical qualification lacks a complete profile contract',async()=>{
 const {sqlite,input,load}=fixture();await input.store.saveQualification('o','a','source',1,1,{profiles:[]},'admin');await input.store.saveQualification('o','a','source',2,1,{profiles:[{dataset:'products',metric:'net_sales'}]},'admin');addPointer(sqlite,'source','2026-01-01','unknown-first');
 await preparedWorkspaceFrame(input,load);addPointer(sqlite,'source','2026-01-01','unknown-corrected');await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(2);
});
it('returns corrected numeric facts and drops contributing data after deletion or loss of READY status',async()=>{
 const {sqlite,input}=fixture();await input.store.saveQualification('o','a','source',1,1,{profiles:[{dataset:'overview',metric:'revenue'}]},'admin');
 const fact=(value:number):SourceBatch=>({clientId:'a',timezone:'Europe/Stockholm',currency:'USD',channels:[],dimensions:[],grain:'daily',complete:true,coverageThrough:'2026-10-11T22:00:00Z',rows:[{date:'2026-10-11',dataset:'overview',metric:'revenue',value,definition:input.client.config.revenueDefinition,population:'web',currency:'USD',dimensions:{},sourceId:'',retrievedAt:'',coverageThrough:null,quality:'complete'}]});
 await input.store.persistBatch('o','source',fact(10),'ten','2026-10-12T00:00:00Z');const load=canonicalLoad(input);expect((await preparedWorkspaceFrame(input,load)).metrics.revenue).toBe(10);
 await input.store.persistBatch('o','source',fact(25),'twenty-five','2026-10-12T01:00:00Z');expect((await preparedWorkspaceFrame(input,load)).metrics.revenue).toBe(25);
 sqlite.exec("DELETE FROM current_snapshots WHERE sourceId='source'");expect((await preparedWorkspaceFrame(input,load)).metrics.revenue).toBeNull();
 await input.store.persistBatch('o','source',fact(30),'restored-thirty','2026-10-12T02:00:00Z');expect((await preparedWorkspaceFrame(input,load)).metrics.revenue).toBe(30);sqlite.exec("UPDATE snapshots SET status='writing' WHERE id='o:a:source:restored-thirty'");expect((await preparedWorkspaceFrame(input,load)).metrics.revenue).toBeNull();expect(load).toHaveBeenCalledTimes(4);
});
it('keeps latest operational values fresh while ignoring superseded operational dates',async()=>{
 const {sqlite,input}=fixture();await input.store.saveQualification('o','a','ops',1,1,{profiles:[{dataset:'media',metric:'active_ads'}]},'admin');
 const inventory=(date:string,value:number):SourceBatch=>({clientId:'a',timezone:'Europe/Stockholm',currency:'USD',channels:[],dimensions:[],grain:'daily',complete:true,coverageThrough:'2026-10-13T10:00:00Z',rows:[{date,dataset:'media',metric:'active_ads',value,definition:'current active inventory',population:'active_ads',currency:null,dimensions:{},sourceId:'',retrievedAt:'',coverageThrough:null,quality:'complete'}]});
 await input.store.persistBatch('o','ops',inventory('2026-10-12',3),'old','2026-10-13T10:00:00Z');await input.store.persistBatch('o','ops',inventory('2026-10-13',5),'latest','2026-10-13T10:00:00Z');const load=canonicalLoad(input);
 expect((await preparedWorkspaceFrame(input,load)).liveOperations.find(row=>row.metric==='active_ads')?.value).toBe(5);
 await input.store.persistBatch('o','ops',inventory('2026-10-12',99),'superseded-correction','2026-10-13T11:00:00Z');expect((await preparedWorkspaceFrame(input,load)).liveOperations.find(row=>row.metric==='active_ads')?.value).toBe(5);expect(load).toHaveBeenCalledTimes(1);
 await input.store.persistBatch('o','ops',inventory('2026-10-13',7),'latest-correction','2026-10-13T11:00:00Z');expect((await preparedWorkspaceFrame(input,load)).liveOperations.find(row=>row.metric==='active_ads')?.value).toBe(7);expect(load).toHaveBeenCalledTimes(2);
});
it('retains a non-operational frame across active-inventory refreshes while keeping operational cache keys distinct',async()=>{
 const {sqlite,input,load}=fixture();input.selection={...input.selection,includeOperations:false};await input.store.saveQualification('o','a','source',1,1,{profiles:[{dataset:'traffic',metric:'sessions'}]},'admin');await input.store.saveQualification('o','a','ops',1,1,{profiles:[{dataset:'media',metric:'active_ads'}]},'admin');addPointer(sqlite,'ops','2026-10-13','ops-first');
 await preparedWorkspaceFrame(input,load);addPointer(sqlite,'ops','2026-10-13','ops-second');await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(1);
 const withOperations={...input,selection:{...input.selection,includeOperations:true}};await preparedWorkspaceFrame(withOperations,load);expect(load).toHaveBeenCalledTimes(2);addPointer(sqlite,'ops','2026-10-13','ops-third');await preparedWorkspaceFrame(withOperations,load);expect(load).toHaveBeenCalledTimes(3);await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(3);
});
it('reuses only a prepared analytics frame, independently decodes it, and reattaches fresh closed-day source headers',async()=>{
 const {sqlite,input,load}=fixture();const first=await preparedWorkspaceFrame(input,load);first.warnings.push('caller change');first.client.name='changed';
 sqlite.exec("UPDATE connections SET lastSuccess='new',error='fresh error',coverageThrough='2026-10-12T01:00:00Z'");
 const second=await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(1);expect(state.gate).toHaveBeenCalledTimes(1);expect(second.warnings).not.toContain('caller change');expect(second.client.name).toBe(input.client.name);expect(second.connections[0]).toMatchObject({lastSuccess:'new',error:'fresh error'});expect(second.metrics.revenue).toBeNull();expect(second.warnings).toContain('No source observations are available for this selection.');
});
it('preserves the full compact Traffic geometry, dataset charts, qualified markers and comparison presentation exactly',async()=>{
 const {input}=fixture(),rows:Observation[]=['2026-10-08','2026-10-10'].flatMap(date=>['sessions','atc_sessions','checkouts','completed_checkouts','converting_sessions'].map((metric,index)=>({date,dataset:'traffic',metric,value:[10,4,0,1,2][index],population:'human_public_sessions',definition:'human_public_sessions',currency:null,dimensions:{page:'/',market:'US',source:'direct',device:'mobile'},sourceId:'source',retrievedAt:'2026-10-12T00:00:00Z',coverageThrough:'2026-10-12T00:00:00Z',quality:'complete'})));
 const load=vi.fn(async(connections:Connection[])=>workspacePresentation(queryClient(input.client,rows,connections,input.filters,{preparedDatasets:input.preparedDatasets}),input.filters));
 const expected=await load(await input.store.connections('o','a'));load.mockClear();
 expect(await preparedWorkspaceFrame(input,load)).toEqual(expected);expect(await preparedWorkspaceFrame(input,load)).toEqual(expected);expect(load).toHaveBeenCalledTimes(1);expect(expected.trafficExplorer).toBeDefined();expect(expected.datasetSeries.traffic).toHaveLength(2);
});
it('preserves actual hourly sales and unknown intervals through independently decoded cached frames',async()=>{
 const {input}=fixture();input.filters={...input.filters,from:'2026-10-11',to:'2026-10-11',view:'revenue',mode:'partial'};input.preparedDatasets=['revenue'];input.selection={datasets:['revenue'],includePriorWeek:false};
 const rows:Observation[]=['2026-10-10','2026-10-11'].flatMap(date=>['revenue','orders'].map(metric=>({date,dataset:'revenue',metric,value:metric==='revenue'?80:4,population:'shopify_sales',definition:'net_sales',currency:metric==='revenue'?'USD':null,dimensions:{stream:'Online Store'},sourceId:'source',retrievedAt:'2026-10-12T00:00:00Z',coverageThrough:'2026-10-12T00:00:00Z',quality:'complete',start:new Date(Date.parse(`${date}T00:00:00Z`)-7200000).toISOString(),end:new Date(Date.parse(`${date}T00:00:00Z`)-3600000).toISOString()})));
 const load=vi.fn(async(connections:Connection[])=>workspacePresentation(queryClient(input.client,rows,connections,input.filters,{preparedDatasets:input.preparedDatasets}),input.filters));
 const first=await preparedWorkspaceFrame(input,load);expect(first.datasetHourlySeries.revenue).toHaveLength(2);expect(first.datasetHourlySeries.revenue[0].metrics.revenue).toBe(80);expect(first.datasetHourlySeries.revenue[1].summary.revenue).toBeNull();expect(first.comparisonDatasetHourlySeries.revenue[0].metrics.orders).toBe(4);
 first.datasetHourlySeries.revenue[0].metrics.revenue=999;const second=await preparedWorkspaceFrame(input,load);expect(second.datasetHourlySeries.revenue[0].metrics.revenue).toBe(80);expect(load).toHaveBeenCalledTimes(1);
});
it('keeps organization, client and database namespaces isolated and ignores foreign pointer metadata',async()=>{
 const a=fixture(),b=fixture();await preparedWorkspaceFrame(a.input,a.load);await preparedWorkspaceFrame(b.input,b.load);expect(b.load).toHaveBeenCalledTimes(1);
 await preparedWorkspaceFrame({...a.input,organizationId:'outside'},a.load);await preparedWorkspaceFrame({...a.input,client:{...a.input.client,id:'other'}},a.load);expect(a.load).toHaveBeenCalledTimes(3);
 a.sqlite.prepare('INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId) VALUES(?,?,?,?,?)').run('outside','a','source','2026-10-10','snapshot');
 await preparedWorkspaceFrame(a.input,a.load);expect(a.load).toHaveBeenCalledTimes(3);
});
it('invalidates corrections, empty-date deletion and loss of READY status',async()=>{
 const {sqlite,input,load}=fixture();await preparedWorkspaceFrame(input,load);sqlite.exec("UPDATE current_snapshots SET date='2026-10-10'");await preparedWorkspaceFrame(input,load);sqlite.exec("DELETE FROM current_snapshots");await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(3);
 const ready=fixture();await preparedWorkspaceFrame(ready.input,ready.load);ready.sqlite.exec("UPDATE snapshots SET status='writing'");await preparedWorkspaceFrame(ready.input,ready.load);expect(ready.load).toHaveBeenCalledTimes(2);
});
it('invalidates source configuration, client configuration and qualification identity while retaining unknown metrics',async()=>{
 const {sqlite,input,load}=fixture();await preparedWorkspaceFrame(input,load);
 for(const update of ["UPDATE connections SET version=2","UPDATE connections SET provider='kind-shopify-hourly'","UPDATE connections SET enabled=0"]){sqlite.exec(update);await preparedWorkspaceFrame(input,load);}
 input.client={...input.client,version:input.client.version+1};await preparedWorkspaceFrame(input,load);input.client={...input.client,config:{...input.client.config,minSessions:123}};await preparedWorkspaceFrame(input,load);
 await input.store.saveQualification('o','a','source',2,1,{profiles:[{dataset:'traffic',metric:'sessions',population:'human'}]},'private-actor');await preparedWorkspaceFrame(input,load);
 sqlite.exec("UPDATE qualifications SET payload=json_set(payload,'$.profiles[0].population','different')");const result=await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(8);expect(result.metrics.revenue).toBeNull();
});
it('invalidates partial coverage and the client local day boundary',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-11T21:59:00Z'));const {sqlite,input,load}=fixture();input.filters.mode='partial';await preparedWorkspaceFrame(input,load);sqlite.exec("UPDATE connections SET coverageThrough='2026-10-12T01:00:00Z'");await preparedWorkspaceFrame(input,load);vi.setSystemTime(new Date('2026-10-11T22:01:00Z'));await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(3);
});
it('uses every exact filter, prepared dataset and drill selection in its key',async()=>{
 const {input,load}=fixture();await preparedWorkspaceFrame(input,load);
 const variants:Partial<QueryFilters>[]=[{from:'2026-10-09'},{to:'2026-10-12'},{compare:'weekday'},{compare:'custom',compareFrom:'2026-09-10',compareTo:'2026-09-11'},{mode:'partial'},{view:'revenue'},{market:'US'},{stream:'renewal'},{source:'paid'},{device:'mobile'},{page:'/a'}];
 for(const variant of variants)await preparedWorkspaceFrame({...input,filters:{...input.filters,...variant}},load);
 await preparedWorkspaceFrame({...input,preparedDatasets:['overview']},load);await preparedWorkspaceFrame({...input,selection:{...input.selection,dimensions:true}},load);await preparedWorkspaceFrame({...input,selection:{...input.selection,includePriorWeek:true}},load);expect(load).toHaveBeenCalledTimes(15);
 await preparedWorkspaceFrame({...input,preparedDatasets:['traffic','overview'],selection:{...input.selection,datasets:['traffic','overview']}},load);expect(load).toHaveBeenCalledTimes(15);
});
it('shares one native miss and skips installation if source pointers change during computation',async()=>{
 const {sqlite,input,load}=fixture();let release!:()=>void;const delayed=vi.fn(async(connections:Connection[])=>{await new Promise<void>(resolve=>{release=resolve;});return load(connections);});
 const requests=[preparedWorkspaceFrame(input,delayed),preparedWorkspaceFrame(input,delayed)];await vi.waitFor(()=>expect(delayed).toHaveBeenCalledTimes(1));sqlite.exec("DELETE FROM current_snapshots");release();await Promise.all(requests);expect(state.gate).toHaveBeenCalledTimes(1);
 sqlite.prepare('INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId) VALUES(?,?,?,?,?)').run('o','a','source','2026-10-11','snapshot');await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(2);
});
it('fails open key metadata lookup errors exactly once and never retries a canonical failure',async()=>{
 const {store,input,load}=fixture(),all=store.all.bind(store);store.all=async(sql:string,...values:unknown[])=>{if(sql.includes('current_snapshots'))throw Error('metadata offline');return all(sql,...values);};
 await preparedWorkspaceFrame(input,load);await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(2);
 const failing=vi.fn(async()=>{throw Error('canonical failed');});await expect(preparedWorkspaceFrame(input,failing)).rejects.toThrow('canonical failed');expect(failing).toHaveBeenCalledTimes(1);
});
it('propagates one failed coalesced canonical computation to every waiter without retrying it',async()=>{
 const {input,load}=fixture();let release!:()=>void;const failure=Error('qualified facts unavailable'),failing=vi.fn(async()=>{await new Promise<void>(resolve=>{release=resolve;});throw failure;});
 const work=Promise.allSettled([preparedWorkspaceFrame(input,failing),preparedWorkspaceFrame(input,failing),preparedWorkspaceFrame(input,failing)]);await vi.waitFor(()=>expect(failing).toHaveBeenCalledTimes(1));release();const results=await work;expect(results).toEqual(Array.from({length:3},()=>({status:'rejected',reason:failure})));expect(failing).toHaveBeenCalledTimes(1);expect(state.gate).toHaveBeenCalledTimes(1);await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(1);
});
it('bypasses the cache on Sites and strips workspace-private fields from cached frames',async()=>{
 const {input,load}=fixture();state.platform='sites';await preparedWorkspaceFrame(input,load);await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(2);state.platform='vercel';
 const contaminated=async(connections:Connection[])=>({...await load(connections),scope:{actorId:'private'},findings:['private'],reviews:['private'],note:'private',browserScopeKey:'private'});
 const result=await preparedWorkspaceFrame(input,contaminated);for(const name of ['scope','findings','reviews','note','browserScopeKey'])expect(result).not.toHaveProperty(name);
});
it('expires after three minutes, bounds entry count and rejects oversized serialized frames',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));const {sqlite,input,load}=fixture();sqlite.exec('DROP TABLE prepared_workspace_cache');await preparedWorkspaceFrame(input,load);vi.advanceTimersByTime(180001);await preparedWorkspaceFrame(input,load);expect(load).toHaveBeenCalledTimes(2);
 for(let i=0;i<33;i++)await preparedWorkspaceFrame({...input,filters:{...input.filters,page:`/${i}`}},load);await preparedWorkspaceFrame({...input,filters:{...input.filters,page:'/0'}},load);expect(load).toHaveBeenCalledTimes(36);
 const noise=randomBytes(450000).toString('base64'),huge=vi.fn(async(connections:Connection[])=>({...await load(connections),warnings:[noise]}));await preparedWorkspaceFrame({...input,filters:{...input.filters,page:'/huge'}},huge);await preparedWorkspaceFrame({...input,filters:{...input.filters,page:'/huge'}},huge);expect(huge).toHaveBeenCalledTimes(2);
});
it('evicts before the total serialized sixteen MiB budget can retain twenty near-limit frames',async()=>{
 const {sqlite,input,load}=fixture(),noise=randomBytes(330000).toString('base64'),large=vi.fn(async(connections:Connection[])=>({...await load(connections),warnings:[noise]}));sqlite.exec('DROP TABLE prepared_workspace_cache');
 for(let i=0;i<20;i++)await preparedWorkspaceFrame({...input,filters:{...input.filters,page:`/large-${i}`}},large);await preparedWorkspaceFrame({...input,filters:{...input.filters,page:'/large-0'}},large);expect(large).toHaveBeenCalledTimes(21);
});
it('retains large compressible frames within the compressed budget with an exact independent round trip',async()=>{
 const {input,load}=fixture(),text='repeated factual label '.repeat(80000),large=vi.fn(async(connections:Connection[])=>({...await load(connections),warnings:[text]}));
 const first=await preparedWorkspaceFrame(input,large),second=await preparedWorkspaceFrame(input,large);expect(first.warnings[0]).toBe(text);expect(second).toEqual(first);expect(second.client).not.toBe(first.client);expect(large).toHaveBeenCalledTimes(1);
});
it('reuses a shared frame from a separate Store/adapter, survives local expiry, and keeps source headers fresh',async()=>{
 const {sqlite,input,load}=fixture();const first=await preparedWorkspaceFrame(input,load);sqlite.exec("UPDATE connections SET lastSuccess='recent'");
 const fresh={...input,store:new Store({...input.store.db})},second=await preparedWorkspaceFrame(fresh,load);expect(load).toHaveBeenCalledTimes(1);expect(second.connections[0].lastSuccess).toBe('recent');expect({...second,connections:first.connections}).toEqual(first);
 const entry=sqlite.prepare('SELECT cacheKey,codecVersion,payload,createdAt,expiresAt FROM prepared_workspace_cache').get()!;expect(entry.cacheKey).toMatch(/^[a-f0-9]{64}$/);expect(Number(entry.expiresAt)-Number(entry.createdAt)).toBe(86400000);expect(String(entry.payload).length*2).toBeLessThanOrEqual(1024*1024);
});
it('expires shared frames after twenty-four hours and retains at most thirty-two entries per client',async()=>{
 const {sqlite,input,load}=fixture();await preparedWorkspaceFrame(input,load);sqlite.exec('UPDATE prepared_workspace_cache SET expiresAt=0');await preparedWorkspaceFrame({...input,store:new Store({...input.store.db})},load);expect(load).toHaveBeenCalledTimes(2);
 for(let i=0;i<34;i++)await preparedWorkspaceFrame({...input,filters:{...input.filters,page:`/persistent-${i}`}},load);expect(sqlite.prepare('SELECT COUNT(*) AS count FROM prepared_workspace_cache').get()?.count).toBe(32);
});
it('repairs shared hash corruption and fails open when the migration is absent',async()=>{
 const {sqlite,input,load}=fixture();await preparedWorkspaceFrame(input,load);sqlite.exec("UPDATE prepared_workspace_cache SET payload='broken'");await preparedWorkspaceFrame({...input,store:new Store({...input.store.db})},load);expect(load).toHaveBeenCalledTimes(2);
 sqlite.exec('DROP TABLE prepared_workspace_cache');await preparedWorkspaceFrame({...input,store:new Store({...input.store.db})},load);expect(load).toHaveBeenCalledTimes(3);
});
it('rejects a correctly hashed cross-client frame and a compressed payload that expands beyond four MiB',async()=>{
 const {sqlite,input,load}=fixture();await preparedWorkspaceFrame(input,load);
 const replace=async(frame:unknown)=>{const bytes=Buffer.from(await new Response(new Response(JSON.stringify(frame)).body!.pipeThrough(new CompressionStream('gzip'))).arrayBuffer()),payload=bytes.toString('base64');sqlite.prepare('UPDATE prepared_workspace_cache SET payload=?,payloadHash=?').run(payload,createHash('sha256').update(payload).digest('hex'));};
 const valid=await load(await input.store.connections('o','a'));load.mockClear();await replace({...valid,connections:undefined,client:{...input.client,id:'outside'}});await preparedWorkspaceFrame({...input,store:new Store({...input.store.db})},load);expect(load).toHaveBeenCalledTimes(1);
 await replace({...valid,connections:undefined,warnings:['x'.repeat(5*1024*1024)]});await preparedWorkspaceFrame({...input,store:new Store({...input.store.db})},load);expect(load).toHaveBeenCalledTimes(2);
});
it('does not persist frames when pointers change during a canonical computation or a warm deadline has elapsed',async()=>{
 const {sqlite,input,load}=fixture();await preparedWorkspaceFrame(input,async(connections)=>{sqlite.exec('DELETE FROM current_snapshots');return load(connections);});expect(sqlite.prepare('SELECT COUNT(*) AS count FROM prepared_workspace_cache').get()?.count).toBe(0);
 await expect(preparedWorkspaceFrame({...input,deadline:Date.now()-1},load)).rejects.toThrow('budget elapsed');expect(load).toHaveBeenCalledTimes(1);
});
it('keeps an expiring warmer separate from the foreground canonical promise for the same source token',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));const {input,load}=fixture();let releaseWarm!:()=>void,releaseBrowser!:()=>void;
 const warm=vi.fn(async(connections:Connection[])=>{await new Promise<void>(resolve=>{releaseWarm=resolve;});return load(connections);}),browser=vi.fn(async(connections:Connection[])=>{await new Promise<void>(resolve=>{releaseBrowser=resolve;});return load(connections);});
 const warming=preparedWorkspaceFrame({...input,deadline:Date.now()+10000},warm).catch(error=>error),foreground=preparedWorkspaceFrame(input,browser);await vi.waitFor(()=>{expect(warm).toHaveBeenCalledTimes(1);expect(browser).toHaveBeenCalledTimes(1);});
 await vi.advanceTimersByTimeAsync(10001);expect(await warming).toMatchObject({message:'Prepared frame warm budget elapsed'});releaseWarm();releaseBrowser();expect((await foreground).client.id).toBe(input.client.id);expect(browser).toHaveBeenCalledTimes(1);
});
it('falls back from unavailable compression once for every coalesced caller',async()=>{
 const {input,load}=fixture();vi.stubGlobal('CompressionStream',class {constructor(){throw Error('encoding unavailable');}});let release!:()=>void;
 const delayed=vi.fn(async(connections:Connection[])=>{await new Promise<void>(resolve=>{release=resolve;});return load(connections);});
 const work=Promise.all([preparedWorkspaceFrame(input,delayed),preparedWorkspaceFrame(input,delayed)]);await vi.waitFor(()=>expect(delayed).toHaveBeenCalledTimes(1));release();const [first,second]=await work;expect(first).toEqual(second);expect(first.client).not.toBe(second.client);expect(delayed).toHaveBeenCalledTimes(1);expect(load).toHaveBeenCalledTimes(1);
});
