import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import type {AccessScope,QueryFilters} from '../../lib/analytics/contracts';
import clients from '../../data/initial-clients.json';
const state=vi.hoisted(()=>({store:null as any,scope:{organizationId:'org',actorId:'user',role:'analyst',permittedClientIds:['kind-patches','beam']} as AccessScope,model:vi.fn(),results:[] as any[]}));
vi.mock('@avenue/runtime',()=>({runtimePlatform:'sites'}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store,requireClientAccess:async(id?:string)=>{if(id&&!state.scope.permittedClientIds.includes(id))throw Error('Client access denied');return state.scope;}}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:(name:string)=>name==='OPENAI_API_KEY'?'test-only':null}));
vi.mock('../../lib/ai/platform-provider',()=>({askPlatformOpenAI:state.model}));
import {aiContext} from '../../lib/ai/server';
import {answerPlatformAI} from '../../lib/ai/platform-chat';
import {loadPlatformSession,platformSessionHistory} from '../../lib/ai/platform-session';
const filters:QueryFilters={from:'2026-10-19',to:'2026-10-19',mode:'closed',compare:'weekday',view:'subscriptions',market:'US',source:'facebook',device:'mobile',page:'/only-current-page',stream:''};
const query={clientId:'all',view:'traffic',period:'selected',from:null,to:null,mode:null,compare:'previous',compareFrom:null,compareTo:null,market:null,page:null,source:null,device:null,stream:null,breakdown:'all',metric:'cvr',sort:'decline',limit:5,offset:0};
function database(){const db=new DatabaseSync(':memory:');for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')))db.exec(readFileSync(`drizzle/${f}`,'utf8'));return {prepare(sql:string){let values:any[]=[];const p={bind(...v:any[]){values=v;return p;},async first(){return db.prepare(sql).get(...values)??null;},async all(){return {results:db.prepare(sql).all(...values)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...values).changes)}};}};return p;},async batch(statements:any[]){return Promise.all(statements.map(s=>s.run()));}};}
beforeEach(async()=>{state.scope={organizationId:'org',actorId:'user',role:'analyst',permittedClientIds:['kind-patches','beam']};state.results=[];state.store=new Store(database());state.model.mockReset();for(const c of clients)await state.store.run('INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config,version) VALUES(?,?,?,?,?,?,?,?,?)',c.id,'org',c.name,c.slug,c.timezone,c.currency,c.color,JSON.stringify(c.config),1);
 for(const c of clients){const rows=['2026-10-19','2026-10-18'].flatMap((date,index)=>['sessions','converting_sessions'].map(metric=>({date,dataset:'traffic',metric,value:metric==='sessions'?1000:index?40:20,definition:'human',population:'human',currency:null,dimensions:{page:'/pages/declining',market:'US'}})));await state.store.persistBatch('org','qualified',{clientId:c.id,complete:true,coverageThrough:'2026-10-20T04:00:00Z',rows} as any,'traffic','2026-10-20T12:00:00Z');}
 state.model.mockImplementation(async(_key,_model,_brief,_history,_question,tools)=>{const result=await tools.find((t:any)=>t.name==='query_analytics').execute(query);state.results.push(result);return {answer:'Source-backed analysis across brands',sourceIds:result.sources.map((s:any)=>s.id).slice(0,2),followUps:['What changed in the US?'],caveats:[]};});
});
it('answers the exact cross-brand markets/landing-pages question independently of the current screen',async()=>{
 const question='which markets / landing pages are performing the worst day over day?',a=await answerPlatformAI({clientId:'kind-patches',filters,question},state.scope,{store:state.store}),b=await answerPlatformAI({clientId:'beam',filters:{...filters,view:'media',market:'CA'},question},state.scope,{store:state.store});
 expect(a.payload.scope.clients.sort()).toEqual(['Beam','Kind Patches']);expect(b.payload.scope.clients.sort()).toEqual(['Beam','Kind Patches']);
 expect(state.results[0].clients.map((c:any)=>c.client.id).sort()).toEqual(['beam','kind-patches']);
 for(const result of state.results)for(const c of result.clients){expect(c.tables.page.rows[0].dimension).toBe('/pages/declining');expect(c.tables.page.rows[0].change.percentagePoints).toBeCloseTo(-2);}
 expect(a.payload.sources).toHaveLength(2);expect(a.payload.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
});
it('keeps follow-up conversation across screens while requiring fresh retrieved evidence',async()=>{
 await answerPlatformAI({clientId:'kind-patches',filters,question:'Which pages declined?'},state.scope,{store:state.store});
 const session=await loadPlatformSession('beam',{...filters,view:'revenue'},undefined,state.scope,state.store);expect(await platformSessionHistory(session)).toHaveLength(1);
 await answerPlatformAI({clientId:'beam',filters,question:'And in Beam?'},state.scope,{store:state.store});expect(state.model.mock.calls[1][3][0].answer).toBe('Source-backed analysis across brands');expect(state.results).toHaveLength(2);
});
it('does not expose other actors, tenants or brands after grants change',async()=>{
 await answerPlatformAI({clientId:'kind-patches',filters,question:'Which pages declined?'},state.scope,{store:state.store});
 const other=await loadPlatformSession('beam',filters,undefined,{...state.scope,actorId:'other'},state.store);expect(await platformSessionHistory(other)).toEqual([]);
 state.scope={...state.scope,permittedClientIds:['beam']};const narrowed=await loadPlatformSession('beam',filters,undefined,state.scope,state.store);expect(await platformSessionHistory(narrowed)).toEqual([]);
 await expect(answerPlatformAI({clientId:'kind-patches',filters,question:'Anything?'},state.scope,{store:state.store})).rejects.toThrow('access');
});
it('rejects unsupported citations before saving a turn',async()=>{
 state.model.mockResolvedValue({answer:'Wrong scope',sourceIds:['selection:secret-client'],followUps:[],caveats:[]});
 await expect(answerPlatformAI({clientId:'beam',filters,question:'Anything?'},state.scope,{store:state.store})).rejects.toThrow('unsupported citation');expect(await state.store.all('SELECT * FROM ai_turns')).toHaveLength(0);
});

it('makes selected non-traffic datasets available beyond the old80-row preview only for platform retrieval',async()=>{
 const rows=['2026-10-19','2026-10-18'].flatMap(date=>Array.from({length:120},(_,i)=>({date,dataset:'products',metric:'revenue',value:i+1,definition:'net_sales',population:'sales',currency:'USD',dimensions:{product:`Product ${i}`}})));
 await state.store.persistBatch('org','products',{clientId:'beam',complete:true,coverageThrough:'2026-10-20T04:00:00Z',rows} as any,'products','2026-10-20T12:00:00Z');
 const selected={...filters,view:'products',market:'',source:'',device:'',page:'',compare:'previous'} as QueryFilters;
 const legacy=(await aiContext('beam',selected,undefined,state.scope,false,true,'Products',state.store)).context.clients[0];
 const platform=(await aiContext('beam',selected,undefined,state.scope,false,true,'Products',state.store,true)).context.clients[0];
 expect(legacy.datasetDetails.products.rows).toHaveLength(80);expect(platform.datasetDetails.products.rows).toHaveLength(120);expect(platform.comparisonDatasetDetails.products.rows).toHaveLength(120);expect(platform.datasetDetails.products.omitted).toBe(0);
});

it('keeps analytical lookups independent of the review archive and action queue',async()=>{
 const reviews=vi.spyOn(state.store,'reviews'),findings=vi.spyOn(state.store,'findings');
 const context=(await aiContext('beam',{...filters,view:'traffic',market:'',source:'',device:'',page:'',compare:'previous'},undefined,state.scope,false,true,'Which markets and landing pages declined day over day?',state.store,true)).context;
 expect(reviews).not.toHaveBeenCalled();expect(findings).not.toHaveBeenCalled();expect(context.clients[0].visualBreakdowns.traffic.current?.cuts.page.rows).toHaveLength(1);
 expect(context.clients[0].warnings.join(' ')).not.toContain('Saved reviews are supplied');
});
