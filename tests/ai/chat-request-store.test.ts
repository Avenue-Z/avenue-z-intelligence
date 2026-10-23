import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import clients from '../../data/initial-clients.json';
import type {QueryFilters} from '../../lib/analytics/contracts';
const state=vi.hoisted(()=>({platform:'vercel',db:null as Store['db']|null,identity:vi.fn(),model:vi.fn(),clients:[] as {id:number;close:ReturnType<typeof vi.fn>}[],queries:[] as {owner:number;sql:string}[],globalReads:0,rejectSql:''}));
vi.mock('@avenue/runtime',()=>({get runtimePlatform(){return state.platform;},env:new Proxy({APP_ORGANIZATION_ID:'avenue-z'},{get(target,key){if(key==='DB'){state.globalReads++;if(state.platform==='vercel')throw Error('Global database forbidden in request');return state.db;}return target[key as keyof typeof target];}})}));
vi.mock('../../app/chatgpt-auth',()=>({getChatGPTUser:state.identity}));
vi.mock('../../lib/ai/provider',()=>({askOpenAI:state.model}));
vi.mock('../../lib/ai/platform-provider',()=>({askPlatformOpenAI:async(key:string,model:string,brief:any,history:any,question:string,tools:any[])=>{
 const result=await tools.find(t=>t.name==='query_analytics').execute({clientId:brief.startingContext.clientId??'all',view:brief.startingContext.filters.view==='reviews'?'overview':brief.startingContext.filters.view,period:'selected',from:null,to:null,mode:null,compare:'previous',compareFrom:null,compareTo:null,market:null,page:null,source:null,device:null,stream:null,breakdown:'all',metric:'cvr',sort:'decline',limit:5,offset:0});
 const answer=await state.model(key,model,JSON.stringify(result),history,question);
 return {...answer,sourceIds:answer.sourceIds.map((id:string)=>result.sources.find((source:any)=>source.id.endsWith(':'+id))?.id??id)};
}}));

vi.mock('../../lib/server/secrets',()=>({serverSecret:(name:string)=>({TURSO_DATABASE_URL:'libsql://test.invalid',TURSO_AUTH_TOKEN:'test-credential',OPENAI_API_KEY:'test-model-key',AUTH_URL:'https://app.example'} as Record<string,string>)[name]??null}));
vi.mock('@libsql/client',()=>({createClient:vi.fn(()=>{const client={id:state.clients.length+1,close:vi.fn()};state.clients.push(client);return client;})}));
vi.mock('../../lib/server/sqlite-bindings',()=>({sqliteBindings:(client:{id:number})=>({...state.db,prepare(sql:string){state.queries.push({owner:client.id,sql});if(state.rejectSql&&sql.startsWith(state.rejectSql))throw Error('Private failure includes person@example.com and question text');return state.db!.prepare(sql);}})}));
import {GET,POST} from '../../app/api/chat/route';
import {scopeForUser,requireClientAccess} from '../../lib/server/access';
import {loadAISession} from '../../lib/ai/session';
import {aiContext} from '../../lib/ai/server';
const filters:QueryFilters={from:'2026-10-16',to:'2026-10-16',mode:'partial',compare:'previous',view:'overview',market:'',source:'',stream:'',page:'',device:''};
let sqlite:DatabaseSync,seed:Store,logs:ReturnType<typeof vi.spyOn>,warnings:ReturnType<typeof vi.spyOn>;
function database(){sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));return {prepare(sql:string){let values:unknown[]=[];const statement={bind(...input:unknown[]){values=input;return statement;},async first(){return sqlite.prepare(sql).get(...values as never[])??null;},async all(){return {results:sqlite.prepare(sql).all(...values as never[])};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values as never[]).changes)}};}};return statement;},async batch(statements:{run:()=>Promise<unknown>}[]){return Promise.all(statements.map(statement=>statement.run()));}};}
beforeEach(async()=>{state.platform='vercel';state.clients=[];state.queries=[];state.globalReads=0;state.rejectSql='';state.db=database();seed=new Store(state.db);for(const client of clients)await seed.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',client.id,'avenue-z',client.name,client.slug,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);await seed.run('INSERT INTO members VALUES(?,?,?,?,?)','avenue-z','person@example.com','google:person','admin','["beam"]');state.identity.mockReset().mockResolvedValue({userId:'google:person',email:'person@example.com'});state.model.mockReset().mockResolvedValue({answer:'No measured change is available.',sourceIds:['selection:beam'],followUps:[],caveats:[]});logs=vi.spyOn(console,'info').mockImplementation(()=>{});warnings=vi.spyOn(console,'warn').mockImplementation(()=>{});});
afterEach(()=>{logs.mockRestore();warnings.mockRestore();sqlite.close();});
const get=()=>GET(new Request(`https://app.example/api/chat?${new URLSearchParams({...filters,clientId:'beam'})}`));
const post=()=>POST(new Request('https://app.example/api/chat',{method:'POST',headers:{origin:'https://app.example','content-type':'application/json'},body:JSON.stringify({clientId:'beam',filters,question:'What needs our attention, and why?'})}));

it('uses a fresh owned SDK per native GET/POST and one Store for authorization, context, history and writes',async()=>{
 const first=await get();expect(first.status).toBe(200);expect(first.headers.get('cache-control')).toBe('no-store');expect(state.clients).toHaveLength(1);expect(state.clients[0].close).toHaveBeenCalledTimes(1);expect(state.queries.every(query=>query.owner===1)).toBe(true);expect(state.queries.some(query=>/FROM members/.test(query.sql))).toBe(true);expect(state.queries.some(query=>/FROM ai_turns/.test(query.sql))).toBe(true);expect(state.queries.some(query=>/observations|snapshots/.test(query.sql))).toBe(false);
 state.queries=[];const response=await post();expect(response.status).toBe(200);expect(state.clients).toHaveLength(2);expect(state.clients[1].close).toHaveBeenCalledTimes(1);expect(state.queries.every(query=>query.owner===2)).toBe(true);for(const sql of ['FROM members','FROM current_snapshots','FROM ai_requests','INSERT INTO ai_requests','FROM ai_turns','INSERT INTO ai_turns'])expect(state.queries.some(query=>query.sql.includes(sql))).toBe(true);expect(state.globalReads).toBe(0);expect(state.model).toHaveBeenCalledTimes(1);
 const turns=await seed.all('SELECT * FROM ai_turns');expect(turns).toHaveLength(1);expect(turns[0]).toMatchObject({organizationId:'avenue-z',actorId:'google:person'});
});
it('closes the owned client when GET authorization fails before history is exposed',async()=>{
 state.identity.mockResolvedValue(null);const response=await get();expect(response.status).toBe(403);expect(state.clients).toHaveLength(1);expect(state.clients[0].close).toHaveBeenCalledTimes(1);expect(state.queries.some(query=>query.sql.includes('FROM ai_turns'))).toBe(false);
});
it('keeps concurrent native requests independent while one answer waits on its model',async()=>{
 const waiting=Promise.withResolvers<{answer:string;sourceIds:string[];followUps:string[];caveats:string[]}>();state.model.mockImplementationOnce(()=>waiting.promise);
 const answer=post();await vi.waitFor(()=>expect(state.model).toHaveBeenCalledTimes(1));expect(state.clients).toHaveLength(1);expect(state.clients[0].close).not.toHaveBeenCalled();
 const composer=await get();expect(composer.status).toBe(200);expect(state.clients).toHaveLength(2);expect(state.clients[1].close).toHaveBeenCalledTimes(1);expect(state.clients[0].close).not.toHaveBeenCalled();
 waiting.resolve({answer:'No measured change is available.',sourceIds:['selection:beam'],followUps:[],caveats:[]});expect((await answer).status).toBe(200);expect(state.clients[0].close).toHaveBeenCalledTimes(1);
});
it.each([['SELECT c.snapshotId','model'],['SELECT COUNT(*) AS n FROM ai_requests','reserve'],['SELECT * FROM ai_turns','history']])('identifies a %s read failure and closes its client without reaching the model',async(prefix,phase)=>{
 state.rejectSql=prefix;const response=await post();expect(response.status).toBe(400);expect(state.clients[0].close).toHaveBeenCalledTimes(1);expect(state.model).not.toHaveBeenCalled();expect(warnings.mock.calls).toEqual(expect.arrayContaining([['Chat request phase',expect.objectContaining({phase,status:'failed',kind:'Error'})]]));
});
it('closes after model failure and logs only fixed phases, timings and safe error kinds',async()=>{
 state.model.mockRejectedValue(Object.assign(new Error('Private prompt person@example.com test-model-key'),{name:'PII-in-error-name'}));const response=await post();expect(response.status).toBe(400);expect(state.clients[0].close).toHaveBeenCalledTimes(1);
 const entries=[...logs.mock.calls,...warnings.mock.calls].filter(call=>call[0]==='Chat request phase').map(call=>call[1] as {phase:string;status:string;requestId:string;ms:number;kind?:string});expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({phase:'authorize',status:'complete'}),expect.objectContaining({phase:'context',status:'complete'}),expect.objectContaining({phase:'reserve',status:'complete'}),expect.objectContaining({phase:'history',status:'complete'}),expect.objectContaining({phase:'model',status:'failed',kind:'Unknown'})]));const serialized=JSON.stringify(entries);expect(serialized).not.toMatch(/person@|test-model-key|Private prompt|PII-in-error-name|SELECT|What needs/);
 for(const entry of entries){expect(entry).toMatchObject({requestId:expect.any(String),ms:expect.any(Number)});expect(entry.ms).toBeGreaterThanOrEqual(0);}
 expect(new Set(entries.map(entry=>entry.requestId)).size).toBe(1);
 expect((await seed.all('SELECT * FROM ai_turns'))).toHaveLength(0);
});
it('closes on persistence failure without retrying an ambiguous write or repeating the model call',async()=>{
 state.rejectSql='INSERT INTO ai_turns';const response=await post();expect(response.status).toBe(400);expect(state.clients[0].close).toHaveBeenCalledTimes(1);expect(state.model).toHaveBeenCalledTimes(1);expect(state.queries.filter(query=>query.sql.startsWith('INSERT INTO ai_turns'))).toHaveLength(1);expect(warnings.mock.calls).toEqual(expect.arrayContaining([['Chat request phase',expect.objectContaining({phase:'persist',status:'failed'})]]));
});
it('retains the Sites database and bridge fallback without allocating or closing a native SDK',async()=>{
 state.platform='sites';expect((await get()).status).toBe(200);expect((await post()).status).toBe(200);expect(state.clients).toHaveLength(0);expect(state.globalReads).toBeGreaterThan(0);expect(state.model).toHaveBeenCalledTimes(1);expect(logs.mock.calls).toEqual([]);expect(warnings.mock.calls).toEqual([]);
});
it('uses an injected Store when access, composer metadata and AI context resolve their own authorization',async()=>{
 await expect(scopeForUser(seed)).resolves.toMatchObject({organizationId:'avenue-z',permittedClientIds:['beam']});await expect(requireClientAccess('beam',false,seed)).resolves.toMatchObject({actorId:'google:person'});
 const session=await loadAISession('beam',filters,undefined,undefined,seed);expect(session.s).toBe(seed);expect(session.clients).toEqual(['Beam']);
 const full=await aiContext('beam',filters,undefined,undefined,false,true,'What needs our attention, and why?',seed);expect(full.s).toBe(seed);expect(full.scopeKey).toBe(session.scopeKey);expect(state.globalReads).toBe(0);expect(state.model).not.toHaveBeenCalled();
});
