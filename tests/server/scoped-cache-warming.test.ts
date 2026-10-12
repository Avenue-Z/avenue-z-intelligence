import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import {warmSuccessfulSourceJobs} from '../../lib/server/cache-warming';
import {workspaceDatasets,workspaceObservationSelection} from '../../lib/analytics/workspace-datasets';
import type {AccessScope,Client,QueryFilters,SourceBatch} from '../../lib/analytics/contracts';
const state=vi.hoisted(()=>({platform:'sites'}));
vi.mock('@avenue/runtime',()=>({get runtimePlatform(){return state.platform;}}));
vi.mock('../../lib/server/analytics-memory',()=>({withAnalyticsMemory:async(work:()=>Promise<unknown>)=>work()}));
import {preparedWorkspaceFrame} from '../../lib/server/prepared-workspace-cache';
const scope:AccessScope={organizationId:'o',actorId:'application-scheduler',role:'admin',permittedClientIds:['kind-patches']};
const client:Client={id:'kind-patches',name:'Kind Patches',slug:'kind-patches',timezone:'UTC',currency:'USD',color:'blue',version:1,config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'web',spendChannels:['meta'],recurringLabel:'Recurring',minSessions:100,minOpportunity:10,maxActions:6,reviewTime:'09:00',reviewTimezone:'UTC',reviewMode:'closed',incidents:[]}};
const base:QueryFilters={from:'2026-10-11',to:'2026-10-11',compare:'previous',mode:'closed',view:'traffic',market:'',stream:'',source:'',device:'',page:''};
function database(){const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));const queries:string[]=[];const prepare=(sql:string)=>{let values:unknown[]=[];const statement={bind(...input:unknown[]){values=input;return statement;},async first(){queries.push(sql);return sqlite.prepare(sql).get(...values as any[])??null;},async all(){queries.push(sql);return {results:sqlite.prepare(sql).all(...values as any[])};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values as any[]).changes)}};}};return statement;};return {sqlite,queries,store:new Store({prepare,batch:async(statements:ReturnType<typeof prepare>[])=>Promise.all(statements.map(statement=>statement.run()))})};}
async function fixture(){const d=database(),s=d.store;await s.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',client.id,'o',client.name,client.slug,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);await s.enqueue('o',client.id,'source','warm','2026-10-12T13:00:00Z');await s.finish('o:source:warm');const batch:SourceBatch={clientId:client.id,timezone:'UTC',currency:'USD',channels:[],dimensions:[],grain:'daily',complete:true,coverageThrough:'2026-10-12T00:00:00Z',rows:['overview','traffic','funnels','revenue','media','subscriptions','subscriptionEvents','products'].map(dataset=>({date:base.to,dataset,metric:'revenue',value:100,definition:'web',population:dataset,currency:'USD',dimensions:{},sourceId:'',retrievedAt:'',coverageThrough:null,quality:'complete'}))};await s.persistBatch('o','source',batch,'facts','2026-10-12T13:00:00Z');return d;}
beforeEach(()=>{state.platform='sites';vi.useFakeTimers();vi.setSystemTime('2026-10-12T13:05:00Z');});afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('warms the exact scoped Traffic and Overview keys used by foreground reads',async()=>{
 const {store,queries}=await fixture();const result=await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],Date.now()+270000);expect(result).toEqual({attempted:16,completed:16});const before=queries.filter(sql=>sql.startsWith('SELECT o.payload')).length;
 for(const view of ['traffic','overview'])for(const compare of ['previous','fourWeeks','weekday','thirtyDays'] as const)for(const mode of ['closed','partial'] as const){const date=mode==='closed'?base.to:'2026-10-12';await store.observations('o',client.id,{...base,view,compare,mode,from:date,to:date},false,undefined,workspaceObservationSelection(view));}
 expect(queries.filter(sql=>sql.startsWith('SELECT o.payload'))).toHaveLength(before);expect(await store.all('SELECT status FROM observation_cache_entries')).toHaveLength(16);
});
it('independently warms native prepared one-day Traffic/Overview then seven/thirty-day Traffic before secondary scopes',async()=>{
 state.platform='vercel';vi.stubGlobal('fetch',()=>{throw Error('Provider or browser work is forbidden');});const {store}=await fixture(),observations=store.observations.bind(store),seen:{view:string;from:string;to:string}[]=[];
 store.observations=async(org,id,filters,headlines,options,selection)=>{seen.push({view:filters!.view,from:filters!.from,to:filters!.to});return observations(org,id,filters,headlines,options,selection);};
 const result=await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],Date.now()+270000);expect(result).toEqual({attempted:18,completed:18});expect(seen.slice(0,4)).toEqual([{view:'traffic',from:'2026-10-11',to:'2026-10-11'},{view:'overview',from:'2026-10-11',to:'2026-10-11'},{view:'traffic',from:'2026-10-05',to:'2026-10-11'},{view:'traffic',from:'2026-09-12',to:'2026-10-11'}]);expect(await store.all('SELECT cacheKey FROM prepared_workspace_cache')).toHaveLength(18);
 const fresh=new Store({...store.db}),brand=(await fresh.clients('o'))[0],filters={...base,from:'2026-09-12'},load=vi.fn(async()=>{throw Error('Warm shared frame missed');});await preparedWorkspaceFrame({store:fresh,organizationId:'o',client:brand,filters,preparedDatasets:workspaceDatasets('traffic'),selection:workspaceObservationSelection('traffic')},load);expect(load).not.toHaveBeenCalled();
});
it('does no native prepared warming for empty jobs, missing table, unauthorized clients or insufficient deadline',async()=>{
 state.platform='vercel';const {store}=await fixture(),observations=vi.spyOn(store,'observations');
 const cases:[AccessScope,string[],number][]=[[scope,[],Date.now()+270000],[{...scope,permittedClientIds:[]},['o:source:warm'],Date.now()+270000],[scope,['o:source:warm'],Date.now()+39999]];
 for(const [scopeValue,jobs,deadline] of cases)expect(await warmSuccessfulSourceJobs(store,scopeValue,jobs,deadline)).toEqual({attempted:0,completed:0});
 await store.run('DROP TABLE prepared_workspace_cache');expect(await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],Date.now()+270000)).toEqual({attempted:0,completed:0});expect(observations).not.toHaveBeenCalled();
});
it('bounds native prepared warming to its deadline without changing already completed source jobs',async()=>{
 state.platform='vercel';const {store}=await fixture(),observations=store.observations.bind(store),seen:string[]=[];
 store.observations=async(org,id,filters,headlines,options,selection)=>{seen.push(filters!.view);const rows=await observations(org,id,filters,headlines,options,selection);vi.setSystemTime(Date.now()+300000);return rows;};
 expect(await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],Date.now()+270000)).toEqual({attempted:1,completed:0});expect(seen).toEqual(['traffic']);expect(await store.first("SELECT status FROM jobs WHERE id='o:source:warm'")).toMatchObject({status:'complete'});expect(await store.all('SELECT cacheKey FROM prepared_workspace_cache')).toEqual([]);
});
it('prioritizes closed previous Traffic then four-week Traffic and stops within the existing budget',async()=>{
 const {store}=await fixture(),seen:{view:string;compare:string;datasets:string[]|undefined;includePriorWeek:boolean|undefined}[]=[],observations=store.observations.bind(store);store.observations=async(org,id,filters,headlines,options,selection)=>{seen.push({view:filters!.view,compare:filters!.compare,datasets:selection?.datasets,includePriorWeek:selection?.includePriorWeek});const rows=await observations(org,id,filters,headlines,options,selection);if(seen.length===2)vi.setSystemTime(Date.now()+240000);return rows;};
 const result=await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],Date.now()+270000);expect(result).toEqual({attempted:2,completed:2});expect(seen).toEqual([{view:'traffic',compare:'previous',datasets:workspaceDatasets('traffic'),includePriorWeek:false},{view:'traffic',compare:'fourWeeks',datasets:workspaceDatasets('traffic'),includePriorWeek:false}]);
});
