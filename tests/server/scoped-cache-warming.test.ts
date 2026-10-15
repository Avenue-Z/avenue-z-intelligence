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
async function enabledWarmSource(store:Store){await store.run("INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,version) VALUES('source','o','kind-patches','Current feed','kind-triple-whale','https://source.example','SERVER_SECRET',60,1,1)");}
async function fixtureWithLandingPages(){
 const d=await fixture(),{store}=d;
 await store.run("INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,version,coverageThrough) VALUES('traffic','o','kind-patches','Traffic','kind-shopify-traffic','https://unused.example','unused',60,1,1,'2026-10-12T12:00:00Z')");
 const cohorts=[{page:'/a',utm:'facebook',sessions:100,prior:80,converting:10,priorConverting:4},{page:'/a',utm:'tiktok',sessions:50,prior:20,converting:5,priorConverting:4},{page:'/b',utm:'facebook',sessions:120,prior:60,converting:12,priorConverting:6},{page:'/c',utm:'facebook',sessions:110,prior:55,converting:11,priorConverting:5},{page:'/d',utm:'facebook',sessions:90,prior:40,converting:9,priorConverting:4}];
 const rows=['2026-10-11','2026-10-12'].flatMap(date=>cohorts.flatMap(cohort=>[9,10,11,12].flatMap(hour=>Object.entries({sessions:hour===12?900:date==='2026-10-12'?cohort.sessions:cohort.prior,converting_sessions:hour===12?90:date==='2026-10-12'?cohort.converting:cohort.priorConverting}).map(([metric,value])=>({date,dataset:'traffic',metric,value,currency:null,definition:'shopify_human_public_landing_page_traffic',population:'human_public_landing_page_sessions',dimensions:{page:cohort.page,market:'US',device:'mobile',source:'social',utm_source:cohort.utm,utm_medium:'paid',utm_campaign:'c'},start:`${date}T${hour}:00:00Z`,end:`${date}T${hour+1}:00:00Z`,sourceId:'',retrievedAt:'',coverageThrough:null,quality:'complete' as const})))));
 await store.persistBatch('o','traffic',{clientId:client.id,timezone:'UTC',currency:'USD',channels:[],dimensions:['page','market','device','source','utm_source','utm_medium','utm_campaign'],grain:'hourly',complete:true,coverageThrough:'2026-10-12T13:00:00Z',rows},'pages','2026-10-12T13:00:00Z');
 return d;
}
it('warms three real distinct current landing-page drawers after every primary live tab and keeps the first live frames within the existing 32-entry cap',async()=>{
 state.platform='vercel';vi.stubGlobal('fetch',()=>{throw Error('Provider work is forbidden');});const {store}=await fixtureWithLandingPages(),observations=store.observations.bind(store),seen:{filters:QueryFilters;selection:unknown}[]=[];
 store.observations=async(org,id,filters,headlines,options,selection)=>{seen.push({filters:filters!,selection});return observations(org,id,filters,headlines,options,selection);};
 expect(await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],Date.now()+270000)).toEqual({attempted:32,completed:32});
 expect(seen.slice(0,10).map(row=>row.filters.view)).toEqual(['revenue','overview','media','markets','subscriptions','products','traffic','traffic','reviews','settings']);
 const drawers=seen.filter(row=>row.filters.page);expect(drawers.map(row=>row.filters.page)).toEqual(['/a','/b','/c']);expect(seen.slice(10,13)).toEqual(drawers);
 for(const drawer of drawers){expect(drawer.filters).toMatchObject({from:'2026-10-12',to:'2026-10-12',compare:'previous',mode:'partial',view:'traffic',market:'',source:'',device:''});expect(drawer.selection).toEqual({datasets:['traffic','funnels'],dimensions:true,includePriorWeek:false,includeOperations:false,trendDatasets:[]});}
 expect(await store.all('SELECT cacheKey FROM prepared_workspace_cache')).toHaveLength(32);
 const fresh=new Store({...store.db}),brand=(await fresh.clients('o'))[0],load=vi.fn(async()=>{throw Error('Warmed native frame missed');}),selection={datasets:['traffic','funnels'],dimensions:true,includePriorWeek:false,includeOperations:false,trendDatasets:[]};
 const frame=await preparedWorkspaceFrame({store:fresh,organizationId:'o',client:brand,filters:{...base,from:'2026-10-12',to:'2026-10-12',mode:'partial',period:'today',page:'/a'},preparedDatasets:['traffic','funnels'],selection},load);
 expect(frame.cutoff).toBe('2026-10-12T12:00:00Z');expect(frame.trafficExplorer?.current.totals?.metrics.sessions).toBe(450);expect(frame.trafficExplorer?.comparison.totals?.metrics.sessions).toBe(300);expect(frame.trafficExplorer?.current.totals?.summary.cvr).toBe(0.1);expect(frame.trafficExplorer?.comparison.totals?.summary.cvr).toBe(0.08);
 await preparedWorkspaceFrame({store:fresh,organizationId:'o',client:brand,filters:{...base,view:'revenue',from:'2026-10-12',to:'2026-10-12',mode:'partial'},preparedDatasets:workspaceDatasets('revenue'),selection:workspaceObservationSelection('revenue')},load);expect(load).not.toHaveBeenCalled();
});
it('reads freshly published source facts after day preparation before caching the native Traffic frame',async()=>{
 state.platform='vercel';const {store}=await fixtureWithLandingPages(),observations=store.observations.bind(store);let corrected=false;
 store.observations=async(org,id,filters,headlines,options,selection)=>{const rows=await observations(org,id,filters,headlines,options,selection);if(!corrected&&filters?.view==='traffic'&&filters.mode==='partial'&&filters.compare==='previous'&&!filters.page){
  corrected=true;const facts=await store.all<{payload:string}>('SELECT payload FROM observations WHERE snapshotId=?','o:kind-patches:traffic:pages'),batchRows=facts.map(value=>JSON.parse(value.payload) as SourceBatch['rows'][number]).map(row=>({...row,...row.date==='2026-10-12'&&row.metric==='sessions'?{value:row.value!*2}:{}}));
  await store.persistBatch('o','traffic',{clientId:client.id,timezone:'UTC',currency:'USD',channels:[],dimensions:['page','market','device','source','utm_source','utm_medium','utm_campaign'],grain:'hourly',complete:true,coverageThrough:'2026-10-12T13:00:00Z',rows:batchRows},'published-after-preflight','2026-10-12T13:05:01Z');
 }return rows;};
 expect(await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],Date.now()+270000)).toEqual({attempted:32,completed:32});expect(corrected).toBe(true);
 const fresh=new Store({...store.db}),brand=(await fresh.clients('o'))[0],load=vi.fn(async()=>{throw Error('Native frame missed');}),filters={...base,from:'2026-10-12',to:'2026-10-12',mode:'partial' as const,view:'traffic'};
 const frame=await preparedWorkspaceFrame({store:fresh,organizationId:'o',client:brand,filters,preparedDatasets:workspaceDatasets('traffic'),selection:workspaceObservationSelection('traffic')},load);
 expect(frame.trafficExplorer?.current.pages.find(page=>page.label==='/a')?.metrics.sessions).toBe(900);expect(frame.trafficExplorer?.comparison.pages.find(page=>page.label==='/a')?.metrics.sessions).toBe(300);expect(load).not.toHaveBeenCalled();
});
it('rechecks current-source priority before each optional landing-page drawer',async()=>{
 state.platform='vercel';const {store}=await fixtureWithLandingPages(),observations=store.observations.bind(store),pages:string[]=[];
 store.observations=async(org,id,filters,headlines,options,selection)=>{const rows=await observations(org,id,filters,headlines,options,selection);if(filters?.page){pages.push(filters.page);await store.enqueue('o','kind-patches','traffic','current-hour','2026-10-12T13:00:00Z');}return rows;};
 expect(await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],Date.now()+270000)).toEqual({attempted:10,completed:10});expect(pages).toEqual(['/a']);expect(await store.first("SELECT status,attempts FROM jobs WHERE id='o:traffic:current-hour'")).toEqual({status:'pending',attempts:0});
});
it('leaves the existing deadline reserve before another landing-page drawer starts',async()=>{
 state.platform='vercel';const {store}=await fixtureWithLandingPages(),observations=store.observations.bind(store),pages:string[]=[];
 store.observations=async(org,id,filters,headlines,options,selection)=>{const rows=await observations(org,id,filters,headlines,options,selection);if(filters?.page){pages.push(filters.page);vi.setSystemTime(Date.now()+240000);}return rows;};
 expect(await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],Date.now()+270000)).toEqual({attempted:10,completed:10});expect(pages).toEqual(['/a']);expect(await store.first("SELECT status FROM jobs WHERE id='o:source:warm'")).toEqual({status:'complete'});
});
it('leaves database capacity for due current ingestion instead of starting optional native warming',async()=>{
 state.platform='vercel';const {store}=await fixture();await enabledWarmSource(store);await store.enqueue('o','kind-patches','source','current-hour','2026-10-12T13:00:00Z');
 const observations=vi.spyOn(store,'observations'),jobs=await store.all('SELECT id,status,attempts FROM jobs ORDER BY id');
 expect(await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],Date.now()+270000)).toEqual({attempted:0,completed:0});expect(observations).not.toHaveBeenCalled();expect(await store.all('SELECT id,status,attempts FROM jobs ORDER BY id')).toEqual(jobs);
});
it('stops optional native warming between frames when a new current-hour job becomes due',async()=>{
 state.platform='vercel';const {store}=await fixture();await enabledWarmSource(store);const observations=store.observations.bind(store),seen:string[]=[];
 store.observations=async(org,id,filters,headlines,options,selection)=>{seen.push(filters!.view);const rows=await observations(org,id,filters,headlines,options,selection);await store.enqueue('o','kind-patches','source','current-hour','2026-10-12T13:00:00Z');return rows;};
 expect(await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],Date.now()+270000)).toEqual({attempted:1,completed:1});expect(seen).toEqual(['revenue']);expect(await store.first("SELECT status,attempts FROM jobs WHERE id='o:source:current-hour'")).toEqual({status:'pending',attempts:0});
});
it('warms the exact scoped Traffic and Overview keys used by foreground reads',async()=>{
 const {store,queries}=await fixture();const result=await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],Date.now()+270000);expect(result).toEqual({attempted:30,completed:30});const before=queries.filter(sql=>sql.startsWith('SELECT o.payload')).length;
 for(const view of ['traffic','overview'])for(const compare of ['previous','fourWeeks','weekday','thirtyDays'] as const)for(const mode of ['closed','partial'] as const){const date=mode==='closed'?base.to:'2026-10-12';await store.observations('o',client.id,{...base,view,compare,mode,from:date,to:date},false,undefined,workspaceObservationSelection(view));}
 // The bounded 24-entry cache also retains daily chart context. One warmed
 // scope may be evicted; retained keys and the browser's repeat pass must hit.
 const firstPass=queries.filter(sql=>sql.startsWith('SELECT o.payload')).length;expect(firstPass-before).toBeLessThanOrEqual(1);
 for(const view of ['traffic','overview'])for(const compare of ['previous','fourWeeks','weekday','thirtyDays'] as const)for(const mode of ['closed','partial'] as const){const date=mode==='closed'?base.to:'2026-10-12';await store.observations('o',client.id,{...base,view,compare,mode,from:date,to:date},false,undefined,workspaceObservationSelection(view));}
 expect(queries.filter(sql=>sql.startsWith('SELECT o.payload'))).toHaveLength(firstPass);expect((await store.all('SELECT status FROM observation_cache_entries')).length).toBeLessThanOrEqual(24);
});
it('independently warms every live tab before historical Traffic and secondary scopes',async()=>{
 state.platform='vercel';vi.stubGlobal('fetch',()=>{throw Error('Provider or browser work is forbidden');});const {store}=await fixture(),observations=store.observations.bind(store),seen:{view:string;from:string;to:string;compare:string}[]=[];
 store.observations=async(org,id,filters,headlines,options,selection)=>{seen.push({view:filters!.view,from:filters!.from,to:filters!.to,compare:filters!.compare});return observations(org,id,filters,headlines,options,selection);};
 const result=await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],Date.now()+270000);expect(result).toEqual({attempted:32,completed:32});const liveViews=['revenue','overview','media','markets','subscriptions','products','traffic','reviews','settings'],primaryViews=['revenue','overview','media','markets','subscriptions','products','traffic','traffic','reviews','settings'];expect(seen.slice(0,10)).toEqual(primaryViews.map(view=>({view,from:'2026-10-12',to:'2026-10-12',compare:'previous'})));expect(seen.slice(10,19)).toEqual(liveViews.map(view=>({view,from:'2026-10-12',to:'2026-10-12',compare:'weekday'})));expect(seen.slice(19,23)).toEqual([{view:'traffic',from:'2026-10-11',to:'2026-10-11',compare:'previous'},{view:'overview',from:'2026-10-11',to:'2026-10-11',compare:'previous'},{view:'traffic',from:'2026-10-05',to:'2026-10-11',compare:'previous'},{view:'traffic',from:'2026-09-12',to:'2026-10-11',compare:'previous'}]);expect(await store.all('SELECT cacheKey FROM prepared_workspace_cache')).toHaveLength(32);
 const fresh=new Store({...store.db}),brand=(await fresh.clients('o'))[0],filters={...base,from:'2026-09-12'},load=vi.fn(async()=>{throw Error('Warm shared frame missed');});await preparedWorkspaceFrame({store:fresh,organizationId:'o',client:brand,filters,preparedDatasets:workspaceDatasets('traffic'),selection:workspaceObservationSelection('traffic')},load);expect(load).not.toHaveBeenCalled();
 for(const view of liveViews){const selected:QueryFilters={...base,view,from:'2026-10-12',to:'2026-10-12',mode:'partial',compare:'weekday',period:'today'},frame=await preparedWorkspaceFrame({store:fresh,organizationId:'o',client:brand,filters:selected,preparedDatasets:workspaceDatasets(view),selection:workspaceObservationSelection(view)},load);expect(frame.comparison.from).toBe('2026-10-05');}
 expect(load).not.toHaveBeenCalled();
});
it('does no native prepared warming for empty jobs, missing table, unauthorized clients or insufficient deadline',async()=>{
 state.platform='vercel';const {store}=await fixture(),observations=vi.spyOn(store,'observations');
 const cases:[AccessScope,string[],number][]=[[scope,[],Date.now()+270000],[{...scope,permittedClientIds:[]},['o:source:warm'],Date.now()+270000],[scope,['o:source:warm'],Date.now()+39999]];
 for(const [scopeValue,jobs,deadline] of cases)expect(await warmSuccessfulSourceJobs(store,scopeValue,jobs,deadline)).toEqual({attempted:0,completed:0});
 await store.run('DROP TABLE prepared_workspace_cache');expect(await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],Date.now()+270000)).toEqual({attempted:0,completed:0});expect(observations).not.toHaveBeenCalled();
});
it.each([50000,270000])('bounds native Traffic day preparation to the smaller of sixty seconds and the remaining %s ms budget',async budget=>{
 state.platform='vercel';vi.stubGlobal('fetch',()=>{throw Error('Provider work is forbidden');});const {store}=await fixtureWithLandingPages(),observations=store.observations.bind(store),started=Date.now(),sourceHealth=await store.connections('o',client.id),jobs=await store.jobs('o'),deadlines:number[]=[];
 store.observations=async(org,id,filters,headlines,options,selection)=>{const rows=await observations(org,id,filters,headlines,options,selection);if(filters?.view==='traffic'&&filters.compare==='previous'&&filters.mode==='partial'&&!filters.page){deadlines.push(options!.deadline);vi.setSystemTime(options!.deadline);}return rows;};
 expect(await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],started+budget)).toEqual({attempted:7,completed:6});
 expect(deadlines).toEqual([started+Math.min(60000,budget)]);expect(await store.connections('o',client.id)).toEqual(sourceHealth);expect(await store.jobs('o')).toEqual(jobs);
 expect(await store.all('SELECT cacheKey FROM prepared_workspace_cache')).toHaveLength(6);
});
it('bounds native prepared warming to its deadline without changing already completed source jobs',async()=>{
 state.platform='vercel';const {store}=await fixture(),observations=store.observations.bind(store),seen:string[]=[];
 store.observations=async(org,id,filters,headlines,options,selection)=>{seen.push(filters!.view);const rows=await observations(org,id,filters,headlines,options,selection);vi.setSystemTime(Date.now()+300000);return rows;};
 expect(await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],Date.now()+270000)).toEqual({attempted:1,completed:0});expect(seen).toEqual(['revenue']);expect(await store.first("SELECT status FROM jobs WHERE id='o:source:warm'")).toMatchObject({status:'complete'});expect(await store.all('SELECT cacheKey FROM prepared_workspace_cache')).toEqual([]);
});
it('prioritizes live Revenue then Overview and stops within the existing budget',async()=>{
 const {store}=await fixture(),seen:{view:string;compare:string;datasets:string[]|undefined;includePriorWeek:boolean|undefined}[]=[],observations=store.observations.bind(store);store.observations=async(org,id,filters,headlines,options,selection)=>{seen.push({view:filters!.view,compare:filters!.compare,datasets:selection?.datasets,includePriorWeek:selection?.includePriorWeek});const rows=await observations(org,id,filters,headlines,options,selection);if(seen.length===2)vi.setSystemTime(Date.now()+240000);return rows;};
 const result=await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],Date.now()+270000);expect(result).toEqual({attempted:2,completed:2});expect(seen).toEqual([{view:'revenue',compare:'previous',datasets:workspaceDatasets('revenue'),includePriorWeek:false},{view:'overview',compare:'previous',datasets:workspaceDatasets('overview'),includePriorWeek:false}]);
});
it('warms each captured live store day after midnight and shares its exact foreground key',async()=>{
 state.platform='vercel';vi.setSystemTime('2026-10-12T23:15:00Z');
 const {store}=await fixture();await store.run('UPDATE clients SET timezone=? WHERE id=?','Europe/Stockholm',client.id);
 for(const [provider,coverage] of [['kind-shopify-sales','2026-10-12T23:00:00Z'],['kind-shopify-traffic','2026-10-12T21:00:00Z'],['kind-triple-whale','2026-10-12T21:00:00Z'],['kind-shopify-hourly','2026-10-12T21:00:00Z']])await store.run('INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,coverageThrough) VALUES(?,?,?,?,?,?,?,?,?,?)',provider,'o',client.id,provider,provider,'https://unused.example','unused',60,1,coverage);
 const observations=store.observations.bind(store),seen:{view:string;from:string;to:string;compare:string;mode:string}[]=[];
 store.observations=async(org,id,filters,headlines,options,selection)=>{seen.push({view:filters!.view,from:filters!.from,to:filters!.to,compare:filters!.compare,mode:filters!.mode});return observations(org,id,filters,headlines,options,selection);};
 await warmSuccessfulSourceJobs(store,scope,['o:source:warm'],Date.now()+270000);
 expect(seen[0]).toMatchObject({view:'revenue',from:'2026-10-13',to:'2026-10-13',mode:'partial'});
 expect(seen.find(row=>row.view==='traffic'&&row.mode==='partial')).toMatchObject({from:'2026-10-12',to:'2026-10-12'});
 expect(seen.find(row=>row.view==='overview'&&row.mode==='partial')).toMatchObject({from:'2026-10-12',to:'2026-10-12'});
 expect(seen.some(row=>row.view==='traffic'&&row.mode==='closed'&&row.from==='2026-09-13'&&row.to==='2026-10-12')).toBe(true);
 const fresh=new Store({...store.db}),brand=(await fresh.clients('o'))[0],load=vi.fn(async()=>{throw Error('Live rollover warmed frame missed');});
 for(const [view,date] of [['revenue','2026-10-13'],['traffic','2026-10-12']])await preparedWorkspaceFrame({store:fresh,organizationId:'o',client:brand,filters:{...base,view,from:date,to:date,mode:'partial',period:'today'},preparedDatasets:workspaceDatasets(view),selection:workspaceObservationSelection(view)},load);
 expect(load).not.toHaveBeenCalled();
});
