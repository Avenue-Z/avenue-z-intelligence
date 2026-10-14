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
import {Dashboard} from '../../components/analytics/dashboard';
let db:ReturnType<typeof createClient>;
const org='avenue-z',focused='kind-patches',other='beam',date='2026-10-13';
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
it('loads only the focused admin client even when every unrelated brand read would fail, while rendering both authorized sidebar links',async()=>{
 const readAll=Store.prototype.all,readFirst=Store.prototype.first;
 vi.spyOn(Store.prototype,'all').mockImplementation(function<T=Record<string,unknown>>(this:Store,sql:string,...values:unknown[]):Promise<T[]>{if(values.includes(other))throw Error('Beam data is unavailable');return readAll.call(this,sql,...values) as Promise<T[]>;});
 vi.spyOn(Store.prototype,'first').mockImplementation(function<T=Record<string,unknown>>(this:Store,sql:string,...values:unknown[]):Promise<T|null>{if(values.includes(other))throw Error('Beam data is unavailable');return readFirst.call(this,sql,...values) as Promise<T|null>;});
 const reads={connections:vi.spyOn(Store.prototype,'connections'),observations:vi.spyOn(Store.prototype,'observations'),findings:vi.spyOn(Store.prototype,'findings'),reviews:vi.spyOn(Store.prototype,'reviews'),note:vi.spyOn(Store.prototype,'note')};
 const result=await loadWorkspace(query({market:'US',stream:'Online Store',compare:'weekday'}));
 expect(result.clients.map(record=>record.client.id)).toEqual([focused]);expect(result.navigationClients?.map(client=>client.name)).toEqual(['Beam','Kind Patches']);
 expect(result.filters).toMatchObject({market:'US',stream:'Online Store',compare:'weekday',mode:'closed',from:date,to:date});
 for(const read of Object.values(reads)){expect(read).toHaveBeenCalled();expect(read.mock.calls.map(call=>call[1])).toEqual([focused]);}
 expect(result.jobs.map(job=>job.clientId)).toEqual([focused]);
 const nav=sidebar(renderToStaticMarkup(createElement(Dashboard,{initial:result,clientId:focused,userName:'Avenue Z team'})));
 expect(nav).toContain('>Kind Patches</span>');expect(nav).toContain('>Beam</span>');expect(nav).toContain('/clients/beam?');expect(nav).toContain('market=&amp;stream=&amp;source=&amp;device=&amp;page=');
});
it.each(['portfolio','findings'])('continues to read all authorized client analytics and auxiliary data for the global %s workspace',async section=>{
 const reads={observations:vi.spyOn(Store.prototype,'observations'),findings:vi.spyOn(Store.prototype,'findings'),reviews:vi.spyOn(Store.prototype,'reviews'),note:vi.spyOn(Store.prototype,'note')};
 const params=query({view:'overview',section});params.delete('clientId');const result=await loadWorkspace(params);
 expect(result.clients.map(record=>[record.client.id,record.metrics.revenue])).toEqual([[other,800],[focused,100]]);
 for(const read of Object.values(reads))expect(read.mock.calls.map(call=>call[1]).sort()).toEqual([other,focused]);
 expect(result.jobs.map(job=>job.clientId).sort()).toEqual([other,focused]);
});
it('never exposes Beam navigation metadata to a KP-only analyst or reads that unauthorized brand',async()=>{
 await getStore().run('UPDATE members SET role=?,clients=?','analyst',JSON.stringify([focused]));const observations=vi.spyOn(Store.prototype,'observations');
 const result=await loadWorkspace(query());expect(result.scope.role).toBe('analyst');expect(result.navigationClients?.map(client=>client.id)).toEqual([focused]);expect(observations.mock.calls.map(call=>call[1])).toEqual([focused]);
 const nav=sidebar(renderToStaticMarkup(createElement(Dashboard,{initial:result,clientId:focused,userName:'KP analyst'})));expect(nav).toContain('Kind Patches');expect(nav).not.toContain('Beam');expect(nav).not.toContain('/clients/beam');
 await expect(loadWorkspace(query({clientId:other}))).rejects.toThrow('Client access denied');
});
it('keeps sidebar links working for existing cached responses that do not contain navigation metadata',async()=>{
 const params=query({view:'overview'});params.delete('clientId');const result=await loadWorkspace(params),legacy={...result};delete legacy.navigationClients;
 const nav=sidebar(renderToStaticMarkup(createElement(Dashboard,{initial:legacy,clientId:focused,userName:'Avenue Z team'})));expect(nav).toContain('Kind Patches');expect(nav).toContain('Beam');expect(nav).toContain('/clients/beam?');
});
it('keeps focused Traffic drills limited to that client without loading any auxiliary operations',async()=>{
 const observations=vi.spyOn(Store.prototype,'observations'),auxiliary={findings:vi.spyOn(Store.prototype,'findings'),reviews:vi.spyOn(Store.prototype,'reviews'),note:vi.spyOn(Store.prototype,'note'),jobs:vi.spyOn(Store.prototype,'jobs')};
 const result=await loadWorkspace(query({view:'traffic',page:'/selected',drill:'traffic-page'}));
 expect(result.clients.map(record=>record.client.id)).toEqual([focused]);expect(result.navigationClients?.map(client=>client.id)).toEqual([other,focused]);expect(observations.mock.calls.map(call=>call[1])).toEqual([focused]);
 expect(observations.mock.calls[0][5]).toEqual({datasets:['traffic','funnels'],dimensions:true,includePriorWeek:false,includeOperations:false,trendDatasets:[]});for(const operation of Object.values(auxiliary))expect(operation).not.toHaveBeenCalled();
});
it('rejects navigation metadata outside the current actor scope when reading a bridged workspace response',async()=>{
 await getStore().run('UPDATE members SET role=?,clients=?','analyst',JSON.stringify([focused]));const result=await loadWorkspace(query());
 Object.assign(state.env,{COMPANY_WORKSPACE_URL:'https://company.example',COMPANY_WORKSPACE_SECRET:'focused-test-secret-with-at-least-32-characters'});
 vi.stubGlobal('fetch',async()=>Response.json({...result,navigationClients:clients}));
 await expect(loadWorkspace(query())).rejects.toThrow('Company workspace access changed');
});
