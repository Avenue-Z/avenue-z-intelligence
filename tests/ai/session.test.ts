import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import {authorize} from '../../lib/server/policy';
import type {AccessScope,QueryFilters} from '../../lib/analytics/contracts';
import clients from '../../data/initial-clients.json';
const state=vi.hoisted(()=>({store:null as Store|null,scope:{organizationId:'org',actorId:'analyst',role:'analyst',permittedClientIds:['beam']} as AccessScope,queries:[] as string[]}));
vi.mock('@avenue/runtime',()=>({runtimePlatform:'sites'}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store,requireClientAccess:async(id?:string)=>authorize(state.scope,id)}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:()=>null}));
import {loadAISession,sessionHistory} from '../../lib/ai/session';
import {aiContext} from '../../lib/ai/server';
import {compactAIContextForModel} from '../../lib/ai/context';
import {fingerprint} from '../../lib/reviews/build';
import {GET} from '../../app/api/chat/route';
const filters:QueryFilters={from:'2026-10-07',to:'2026-10-07',mode:'closed',compare:'previous',view:'overview',market:'',stream:'',source:'',device:'',page:''};
function database(){const db=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))db.exec(readFileSync(`drizzle/${file}`,'utf8'));return {prepare(sql:string){state.queries.push(sql);let values:unknown[]=[];const statement={bind(...input:unknown[]){values=input;return statement;},async first(){return db.prepare(sql).get(...values as never[])??null;},async all(){return {results:db.prepare(sql).all(...values as never[])};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...values as never[]).changes)}};}};return statement;},async batch(statements:{run:()=>Promise<unknown>}[]){return Promise.all(statements.map(statement=>statement.run()));}};}
beforeEach(async()=>{state.scope={organizationId:'org',actorId:'analyst',role:'analyst',permittedClientIds:['beam']};state.store=new Store(database() as never);for(const client of clients)await state.store.run('INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config,version) VALUES(?,?,?,?,?,?,?,?,?)',client.id,'org',client.name,client.slug,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);state.queries=[];});
function forbidObservations(){vi.spyOn(state.store!,'observations').mockImplementation(async()=>{throw Error('Composer must not query source observations');});}

it('loads a client composer session and exact existing history without reading observations',async()=>{
 const full=await aiContext('beam',filters);await state.store!.run('INSERT INTO ai_turns VALUES(?,?,?,?,?,?,?)','turn','org','analyst',full.scopeKey,'Question',JSON.stringify({answer:'Answer'}),'2026-10-08T00:00:00Z');
 forbidObservations();state.queries=[];const session=await loadAISession('beam',filters);expect(session.scopeKey).toBe(full.scopeKey);expect(session.clients).toEqual(['Beam']);expect(await sessionHistory(session)).toMatchObject([{id:'turn',payload:{answer:'Answer'}}]);expect(state.queries.some(sql=>sql.includes('observations')||sql.includes('snapshots'))).toBe(false);
});
it('retains a frozen compact review filter object and matches the full answer scope key',async()=>{
 const full=await aiContext('beam',filters),frozen={...full.context,filters:{...filters,view:'funnels',market:'France'}};
 const id=await state.store!.saveReview('org','beam',filters.to,'saved',{type:'ai',filters:frozen.filters,evidence:compactAIContextForModel(frozen)},'2026-10-08T00:00:00Z');
 const restored=await aiContext('beam',{...filters,from:'2026-10-10',to:'2026-10-11'},id);forbidObservations();state.queries=[];
 const session=await loadAISession('beam',{...filters,from:'2026-10-10',to:'2026-10-11'},id);expect(session.filters).toEqual(frozen.filters);expect(session.scopeKey).toBe(restored.scopeKey);expect(session.filters.view).toBe('funnels');expect(session.filters.market).toBe('France');
 const reviewQuery=state.queries.find(sql=>sql.includes('FROM reviews'))!;expect(reviewQuery).toContain('json_extract');expect(reviewQuery).not.toMatch(/SELECT\s+\*|AS\s+evidence\b|json_remove/);expect(reviewQuery).toContain('organizationId=? AND clientId=? AND id=?');
});
it('supports a legacy uncompressed frozen review without loading its evidence archive',async()=>{
 const full=await aiContext('beam',filters),id=await state.store!.saveReview('org','beam',filters.to,'legacy',{type:'ai',evidence:full.context},'2026-10-08T00:00:00Z');forbidObservations();
 const session=await loadAISession('beam',{...filters,to:'2026-10-11'},id);expect(session.filters).toEqual(full.context.filters);expect(session.scopeKey).toBe(await fingerprint({clientIds:['beam'],filters:full.context.filters,reviewId:id}));
});
it('denies unrelated tenants, clients and review identities before exposing history',async()=>{
 const full=await aiContext('beam',filters),id=await state.store!.saveReview('outside','beam',filters.to,'outside',{type:'ai',evidence:full.context},'2026-10-08T00:00:00Z');forbidObservations();
 await expect(loadAISession('kind-patches',filters)).rejects.toThrow('Client access denied');await expect(loadAISession('beam',filters,id)).rejects.toThrow('Review access denied');await expect(loadAISession(undefined,filters,id)).rejects.toThrow('Client identity required');
 expect(state.queries.some(sql=>sql.includes('FROM ai_turns'))).toBe(false);
});
it('rejects a saved evidence client or date that does not match its authorized review',async()=>{
 const full=await aiContext('beam',filters);
 for(const [id,context] of [['bad-client',{...full.context,clients:[{...full.context.clients[0],client:{...full.context.clients[0].client,id:'kind-patches'}}]}],['bad-date',{...full.context,filters:{...filters,to:'2026-10-06'}}]] as const){await state.store!.run('INSERT INTO reviews(id,organizationId,clientId,storeDate,revision,fingerprint,createdAt,payload,current) VALUES(?,?,?,?,?,?,?,?,?)',id,'org','beam',filters.to,1,id,'2026-10-08T00:00:00Z',JSON.stringify({type:'ai',evidence:context}),1);}
 forbidObservations();await expect(loadAISession('beam',filters,'bad-client')).rejects.toThrow('Saved review evidence scope is invalid');await expect(loadAISession('beam',filters,'bad-date')).rejects.toThrow('Saved review evidence scope is invalid');
});
it('uses only permitted selected clients in the portfolio session and actor-specific history',async()=>{
 const session=await loadAISession(undefined,filters);expect(session.clients).toEqual(['Beam']);expect(session.scopeKey).toBe(await fingerprint({clientIds:['beam'],filters:session.filters,reviewId:null}));
 for(const actor of ['analyst','someone-else'])await state.store!.run('INSERT INTO ai_turns VALUES(?,?,?,?,?,?,?)',actor,'org',actor,session.scopeKey,'Question',JSON.stringify({answer:actor}),'2026-10-08T00:00:00Z');expect(await sessionHistory(session)).toMatchObject([{id:'analyst',payload:{answer:'analyst'}}]);
});
it('serves the actual chat composer route without rebuilding AI evidence',async()=>{
 forbidObservations();const query=new URLSearchParams({...filters,clientId:'beam'}),response=await GET(new Request(`https://app.example/api/chat?${query}`));
 expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(await response.json()).toMatchObject({turns:[],configured:false,scope:{clients:['Beam'],reviewId:null,filters:{from:filters.from,to:filters.to}}});
 const denied=await GET(new Request(`https://app.example/api/chat?${query}&reviewId=another-tenant-review`));expect(denied.status).toBe(403);expect(await denied.json()).toEqual({error:'Review access denied'});
});
