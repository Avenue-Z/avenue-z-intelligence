import {createClient} from '@libsql/client';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {sqliteBindings} from '../../lib/server/sqlite-bindings';
import type {SourceBatch} from '../../lib/analytics/contracts';
import clients from '../../data/initial-clients.json';
const state=vi.hoisted(()=>({env:{} as Record<string,unknown>,identity:vi.fn()}));
vi.mock('@avenue/runtime',()=>({env:state.env,runtimePlatform:'sites'}));
vi.mock('../../app/chatgpt-auth',()=>({getChatGPTUser:state.identity}));
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {getStore} from '../../lib/server/access';
import {Store} from '../../lib/server/store';
import {loadWorkspace} from '../../lib/server/workspace';
import {Dashboard,selectBeamGa4Workspace} from '../../components/analytics/dashboard';
import {workspaceRefreshParams} from '../../lib/analytics/live-period';
let db:ReturnType<typeof createClient>;
const org='avenue-z',focused='kind-patches',other='beam',third='autobrush',date='2026-10-13';
const query=(extra:Record<string,string>={})=>new URLSearchParams({clientId:focused,view:'revenue',from:date,to:date,mode:'closed',...extra});
const sidebar=(html:string)=>html.match(/<nav class="client-nav">([\s\S]*?)<\/nav>/)?.[1]??'';
beforeEach(async()=>{
 for(const key of Object.keys(state.env))delete state.env[key];
 db=createClient({url:'file::memory:'});for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))await db.executeMultiple(readFileSync(`drizzle/${file}`,'utf8'));
 state.env.DB=sqliteBindings(db);state.identity.mockResolvedValue({userId:'focused-reader'});const s=getStore();
 await s.run('INSERT INTO members VALUES(?,?,?,?,?)',org,'admin@example.com','focused-reader','admin','["*"]');
 for(const client of clients){
  await s.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,1)',client.id,org,client.name,client.slug,client.timezone,client.currency,client.color,JSON.stringify(client.config));
  const batch:SourceBatch={clientId:client.id,timezone:client.timezone,currency:'USD',channels:[],dimensions:[],grain:'daily',complete:true,coverageThrough:'2026-10-14T00:00:00Z',rows:[{date,dataset:'overview',metric:'revenue',value:client.id===focused?100:800,definition:'web',population:'web',currency:'USD',dimensions:{},sourceId:'',retrievedAt:'',coverageThrough:null,quality:'complete'}]};
  await s.persistBatch(org,`facts-${client.id}`,batch,`capture-${client.id}`,'2026-10-14T01:00:00Z');
  await s.enqueue(org,client.id,`facts-${client.id}`,'pending','2026-10-14T01:00:00Z');
 }
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();db.close();});
it('loads only the focused admin client even when every unrelated brand read would fail, while rendering all three authorized sidebar links',async()=>{
 const readAll=Store.prototype.all,readFirst=Store.prototype.first;
 vi.spyOn(Store.prototype,'all').mockImplementation(function<T=Record<string,unknown>>(this:Store,sql:string,...values:unknown[]):Promise<T[]>{if(values.includes(other)||values.includes(third))throw Error('Unrelated brand data is unavailable');return readAll.call(this,sql,...values) as Promise<T[]>;});
 vi.spyOn(Store.prototype,'first').mockImplementation(function<T=Record<string,unknown>>(this:Store,sql:string,...values:unknown[]):Promise<T|null>{if(values.includes(other)||values.includes(third))throw Error('Unrelated brand data is unavailable');return readFirst.call(this,sql,...values) as Promise<T|null>;});
 const reads={connections:vi.spyOn(Store.prototype,'connections'),observations:vi.spyOn(Store.prototype,'observations'),findings:vi.spyOn(Store.prototype,'findings'),reviews:vi.spyOn(Store.prototype,'reviews'),note:vi.spyOn(Store.prototype,'note')};
 const result=await loadWorkspace(query({market:'US',stream:'Online Store',compare:'weekday'}));
 expect(result.clients.map(record=>record.client.id)).toEqual([focused]);expect(result.navigationClients?.map(client=>client.name)).toEqual(['Autobrush','Beam','Kind Patches']);
 expect(result.filters).toMatchObject({market:'US',stream:'Online Store',compare:'weekday',mode:'closed',from:date,to:date});
 for(const read of Object.values(reads)){expect(read).toHaveBeenCalled();expect(read.mock.calls.map(call=>call[1])).toEqual([focused]);}
 expect(result.jobs.map(job=>job.clientId)).toEqual([focused]);
 const nav=sidebar(renderToStaticMarkup(createElement(Dashboard,{initial:result,clientId:focused,userName:'Avenue Z team'})));
 expect(nav).toContain('>Kind Patches</span>');expect(nav).toContain('>Beam</span>');expect(nav).toContain('>Autobrush</span>');expect(nav).toContain('/clients/beam?');expect(nav).toContain('/clients/autobrush?');expect(nav).toContain('market=&amp;stream=&amp;source=&amp;device=&amp;page=');
});
it.each(['portfolio','findings'])('continues to read all authorized client analytics and auxiliary data for the global %s workspace',async section=>{
 const reads={observations:vi.spyOn(Store.prototype,'observations'),findings:vi.spyOn(Store.prototype,'findings'),reviews:vi.spyOn(Store.prototype,'reviews'),note:vi.spyOn(Store.prototype,'note')};
 const params=query({view:'overview',section});params.delete('clientId');const result=await loadWorkspace(params);
 expect(result.clients.map(record=>[record.client.id,record.metrics.revenue])).toEqual([[third,800],[other,800],[focused,100]]);
 for(const read of [reads.findings,reads.reviews,reads.note])expect(read.mock.calls.map(call=>call[1]).sort()).toEqual([third,other,focused]);
 expect(reads.observations.mock.calls.map(call=>call[1]).sort()).toEqual(section==='portfolio'?[third,third,other,other,focused]:[third,other,focused]);
 const beamReads=reads.observations.mock.calls.filter(call=>call[1]===other);expect(beamReads).toHaveLength(section==='portfolio'?2:1);
 if(section==='portfolio'){
  expect(beamReads.map(call=>call[5]?.datasets)).toEqual(expect.arrayContaining([['overview','funnels','media'],['media']]));
  const projection=beamReads.find(call=>call[5]?.datasets.join(',')==='media');expect(projection?.[5]).toEqual({datasets:['media'],includeOperations:false,includePriorWeek:false,trendDatasets:['media']});
  const autobrushReads=reads.observations.mock.calls.filter(call=>call[1]===third);expect(autobrushReads).toHaveLength(2);expect(autobrushReads.map(call=>call[5]?.datasets)).toEqual(expect.arrayContaining([['overview','funnels','media'],['media']]));
 }
 expect(result.jobs.map(job=>job.clientId).sort()).toEqual([third,other,focused]);
});
it('never exposes unrelated brand navigation metadata to a KP-only analyst or reads those unauthorized brands',async()=>{
 await getStore().run('UPDATE members SET role=?,clients=?','analyst',JSON.stringify([focused]));const observations=vi.spyOn(Store.prototype,'observations');
 const result=await loadWorkspace(query());expect(result.scope.role).toBe('analyst');expect(result.navigationClients?.map(client=>client.id)).toEqual([focused]);expect(observations.mock.calls.map(call=>call[1])).toEqual([focused]);
 const nav=sidebar(renderToStaticMarkup(createElement(Dashboard,{initial:result,clientId:focused,userName:'KP analyst'})));expect(nav).toContain('Kind Patches');expect(nav).not.toContain('Beam');expect(nav).not.toContain('/clients/beam');expect(nav).not.toContain('Autobrush');expect(nav).not.toContain('/clients/autobrush');
 for(const clientId of [other,third])await expect(loadWorkspace(query({clientId}))).rejects.toThrow('Client access denied');
 expect(observations.mock.calls.map(call=>call[1])).toEqual([focused]);
});
it('keeps sidebar links working for existing cached responses that do not contain navigation metadata',async()=>{
 const params=query({view:'overview'});params.delete('clientId');const result=await loadWorkspace(params),legacy={...result};delete legacy.navigationClients;
 const nav=sidebar(renderToStaticMarkup(createElement(Dashboard,{initial:legacy,clientId:focused,userName:'Avenue Z team'})));expect(nav).toContain('Kind Patches');expect(nav).toContain('Beam');expect(nav).toContain('/clients/beam?');expect(nav).toContain('Autobrush');expect(nav).toContain('/clients/autobrush?');
});
it('keeps focused Traffic drills limited to that client without loading any auxiliary operations',async()=>{
 const observations=vi.spyOn(Store.prototype,'observations'),auxiliary={findings:vi.spyOn(Store.prototype,'findings'),reviews:vi.spyOn(Store.prototype,'reviews'),note:vi.spyOn(Store.prototype,'note'),jobs:vi.spyOn(Store.prototype,'jobs')};
 const result=await loadWorkspace(query({view:'traffic',page:'/selected',drill:'traffic-page'}));
 expect(result.clients.map(record=>record.client.id)).toEqual([focused]);expect(result.navigationClients?.map(client=>client.id)).toEqual([third,other,focused]);expect(observations.mock.calls.map(call=>call[1])).toEqual([focused]);
 expect(observations.mock.calls[0][5]).toEqual({datasets:['traffic','funnels'],dimensions:true,includePriorWeek:false,includeOperations:false,trendDatasets:[]});for(const operation of Object.values(auxiliary))expect(operation).not.toHaveBeenCalled();
});
it('rejects navigation metadata outside the current actor scope when reading a bridged workspace response',async()=>{
 await getStore().run('UPDATE members SET role=?,clients=?','analyst',JSON.stringify([focused]));const result=await loadWorkspace(query());
 Object.assign(state.env,{COMPANY_WORKSPACE_URL:'https://company.example',COMPANY_WORKSPACE_SECRET:'focused-test-secret-with-at-least-32-characters'});
 vi.stubGlobal('fetch',async()=>Response.json({...result,navigationClients:clients}));
 await expect(loadWorkspace(query())).rejects.toThrow('Company workspace access changed');
});

it('enters the Autobrush GA4 shell in Los Angeles time without reading commerce observations or a prepared frame',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-22T05:30:00Z'));
 try{const observations=vi.spyOn(Store.prototype,'observations').mockRejectedValue(Error('Commerce data must not supply GA4')),result=await loadWorkspace(new URLSearchParams({clientId:'autobrush',view:'ga4',period:'today'}));expect(result.filters).toMatchObject({from:'2026-10-21',to:'2026-10-21',mode:'partial',view:'ga4'});expect(result.clients.map(record=>record.client.id)).toEqual(['autobrush']);expect(observations).not.toHaveBeenCalled();expect(result.clients[0].metrics.revenue).toBeNull();}finally{vi.useRealTimers();}
});

it('keeps the bare Autobrush GA4 workspace live through an actual refresh across Los Angeles midnight',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-22T06:59:00Z'));
 try{
  const result=await loadWorkspace(new URLSearchParams({clientId:'autobrush',view:'ga4'}));expect(result.filters).toMatchObject({from:'2026-10-21',to:'2026-10-21',mode:'partial',period:'today'});
  vi.setSystemTime(new Date('2026-10-22T07:01:00Z'));const refresh=workspaceRefreshParams('?view=ga4',result.filters);refresh.set('clientId','autobrush');
  expect(selectBeamGa4Workspace(result,refresh,'autobrush')!.filters).toMatchObject({from:'2026-10-22',to:'2026-10-22',period:'today'});
  expect((await loadWorkspace(refresh)).filters).toMatchObject({from:'2026-10-22',to:'2026-10-22',mode:'partial',period:'today'});
 }finally{vi.useRealTimers();}
});
it.each([['beam','2026-10-21'],['autobrush','2026-10-20']])('opens the bare closed %s GA4 workspace on yesterday in its own reporting timezone',async(clientId,yesterday)=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-22T05:30:00Z'));
 try{const result=await loadWorkspace(new URLSearchParams({clientId,view:'ga4',mode:'closed'}));expect(result.filters).toMatchObject({from:yesterday,to:yesterday,mode:'closed'});expect(result.filters.period).toBeUndefined();}finally{vi.useRealTimers();}
});
it('keeps an explicit Autobrush GA4 date fixed rather than marking it live',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-22T05:30:00Z'));
 try{const result=await loadWorkspace(new URLSearchParams({clientId:'autobrush',view:'ga4',from:date,to:date,mode:'closed'}));expect(result.filters).toMatchObject({from:date,to:date,mode:'closed'});expect(result.filters.period).toBeUndefined();}finally{vi.useRealTimers();}
});

it('enters the Attribution workspace without native observations and refreshes live dates on Detroit midnight',async()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-22T03:59:00Z'));try{const observations=vi.spyOn(Store.prototype,'observations').mockRejectedValue(Error('Native data must not supply Northbeam')),result=await loadWorkspace(new URLSearchParams({clientId:'autobrush',view:'northbeam'}));expect(result.filters).toMatchObject({from:'2026-10-21',to:'2026-10-21',period:'today',mode:'partial',view:'northbeam'});expect(result.clients.map(record=>record.client.id)).toEqual(['autobrush']);expect(result.clients[0].metrics.revenue).toBeNull();expect(observations).not.toHaveBeenCalled();vi.setSystemTime(new Date('2026-10-22T04:01:00Z'));const refresh=workspaceRefreshParams('?view=northbeam',result.filters);refresh.set('clientId','autobrush');expect(selectBeamGa4Workspace(result,refresh,'autobrush')!.filters.to).toBe('2026-10-22');expect((await loadWorkspace(refresh)).filters.to).toBe('2026-10-22');const closed=await loadWorkspace(new URLSearchParams({clientId:'autobrush',view:'northbeam',mode:'closed'}));expect(closed.filters).toMatchObject({from:'2026-10-21',to:'2026-10-21',mode:'closed'});expect(observations).not.toHaveBeenCalled();}finally{vi.useRealTimers();}});
it('rejects a Northbeam shell outside Autobrush or with unsupported dimensions before native reads',async()=>{const observations=vi.spyOn(Store.prototype,'observations');for(const extra of [{clientId:'beam'},{clientId:'autobrush',market:'US'}] as Record<string,string>[])await expect(loadWorkspace(new URLSearchParams({view:'northbeam',...extra}))).rejects.toThrow();await expect(loadWorkspace(new URLSearchParams({view:'northbeam'}))).rejects.toThrow('Autobrush');expect(observations).not.toHaveBeenCalled();});
