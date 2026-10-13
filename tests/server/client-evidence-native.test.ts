import {createClient} from '@libsql/client';
import {readFileSync,readdirSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {sqliteBindings} from '../../lib/server/sqlite-bindings';
import type {Observation,SourceBatch} from '../../lib/analytics/contracts';
import clients from '../../data/initial-clients.json';
const state=vi.hoisted(()=>({env:{} as Record<string,unknown>,platform:'vercel',identity:vi.fn()}));
vi.mock('@avenue/runtime',()=>({env:state.env,get runtimePlatform(){return state.platform;}}));
vi.mock('../../app/chatgpt-auth',()=>({getChatGPTUser:state.identity}));
import {getStore} from '../../lib/server/access';
import {Store} from '../../lib/server/store';
const secret='native-evidence-test-secret-at-least-32-characters';
let db:ReturnType<typeof createClient>;
const parameters=(extra:Record<string,string>={})=>new URLSearchParams({clientId:'kind-patches',view:'traffic',from:'2026-10-11',to:'2026-10-11',compare:'previous',...extra});
function request(purpose:'evidence'|'export'|'chat'|undefined,params=parameters()){
 const now=Date.now(),body=JSON.stringify({...purpose?{purpose}:{},version:1,issuedAt:now,expiresAt:now+90000,actorId:'sites:analyst',organizationId:'avenue-z',query:params.toString()});
 return new Request('https://native.example/api/internal/'+(purpose||'workspace'),{method:'POST',body,headers:{'content-type':'application/json','x-workspace-signature':createHmac('sha256',secret).update(body).digest('hex')}});
}
function row(changes:Partial<Observation>={}):Observation{return {date:'2026-10-11',dataset:'traffic',metric:'sessions',value:120,dimensions:{source:'Meta',market:'US',page:'/lp'},population:'humans',currency:null,definition:'human_sessions',quality:'complete',sourceId:'source',retrievedAt:'2026-10-12T03:00:00Z',coverageThrough:'2026-10-12T03:00:00Z',...changes};}
async function seed(rows:Observation[]){const batch={clientId:'kind-patches',timezone:'Europe/Stockholm',currency:'USD',complete:true,coverageThrough:'2026-10-12T03:00:00Z',rows} as SourceBatch;await getStore().persistBatch('avenue-z','source',batch,crypto.randomUUID(),'2026-10-12T03:00:00Z');}
beforeEach(async()=>{
 state.platform='vercel';for(const key of Object.keys(state.env))delete state.env[key];db=createClient({url:'file::memory:'});
 for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))await db.executeMultiple(readFileSync(`drizzle/${file}`,'utf8'));
 Object.assign(state.env,{DB:sqliteBindings(db),APP_ORGANIZATION_ID:'avenue-z',COMPANY_WORKSPACE_SECRET:secret});const store=getStore();
 await store.run('INSERT INTO members VALUES(?,?,?,?,?)','avenue-z','analyst@example.com','sites:analyst','analyst','["kind-patches"]');
 for(const client of clients)await store.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,1)',client.id,'avenue-z',client.name,client.slug,client.timezone,client.currency,client.color,JSON.stringify(client.config));
 state.identity.mockResolvedValue({userId:'sites:analyst'});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();db.close();});
it('returns only the exact current dimensions from the current authorized client and dataset',async()=>{
 await seed([row(),row({date:'2026-10-10',value:90}),row({value:500,dimensions:{source:'Google',market:'US',page:'/lp'}}),row({value:900,dataset:'products'}),row({value:50,quality:'historical'})]);
 const observe=vi.spyOn(Store.prototype,'observations');const {POST}=await import('../../app/api/internal/evidence/route');
 const response=await POST(request('evidence',parameters({source:'Meta',page:'/lp',market:'United States',segment:JSON.stringify(Object.entries({source:'Meta',market:'US',page:'/lp'}).sort())})));
 expect(response.status).toBe(200);const result=await response.json() as {rows:Observation[]};expect(result.rows).toHaveLength(1);expect(result.rows[0]).toMatchObject({date:'2026-10-11',dataset:'traffic',value:120,quality:'complete'});expect(observe.mock.calls[0]?.[5]).toEqual({datasets:['traffic'],dimensions:true,includePriorWeek:false});expect(response.headers.get('cache-control')).toBe('no-store');
});
it('preserves CSV fields and escapes a provider formula while narrowing to visible current data',async()=>{
 await seed([row({dimensions:{source:'=HYPERLINK("unsafe")',market:'US'}}),row({date:'2026-10-10',value:90}),row({dataset:'products',value:900})]);
 const {POST}=await import('../../app/api/internal/export/route');const response=await POST(request('export'));expect(response.status).toBe(200);
 const {csv}=await response.json() as {csv:string};expect(csv.split('\r\n')).toHaveLength(2);expect(csv).toContain('date,dataset,metric,value,definition,population,currency,dimension_source,dimension_market,source,retrievedAt,coverageThrough,quality');expect(csv).toContain('2026-10-11,traffic,sessions,120');expect(csv).toContain('"\'=HYPERLINK(""unsafe"")"');expect(csv).not.toContain('2026-10-10');expect(csv).not.toContain('products');
});
it.each(['workspace','chat','other-operation'])('rejects %s signatures replayed into export and evidence',async(kind)=>{
 const exportRoute=await import('../../app/api/internal/export/route'),evidenceRoute=await import('../../app/api/internal/evidence/route');
 const purpose=kind==='workspace'?undefined:kind==='chat'?'chat':'evidence';expect((await exportRoute.POST(request(purpose))).status).toBe(403);
 expect((await evidenceRoute.POST(request(kind==='other-operation'?'export':purpose))).status).toBe(403);
});
it('resolves revocations on each request and denies another client despite a valid signature',async()=>{
 const {POST}=await import('../../app/api/internal/export/route');expect((await POST(request('export'))).status).toBe(200);
 expect((await POST(request('export',parameters({clientId:'beam'})))).status).toBe(403);
 await getStore().run('UPDATE members SET clients=?','[]');expect((await POST(request('export'))).status).toBe(403);
});
it('returns a safe 413 rather than a partial file when the selected observations exceed the response bound',async()=>{
 await seed([row({dimensions:{source:'x'.repeat(4*1024*1024)}})]);
 const {POST}=await import('../../app/api/internal/export/route');const response=await POST(request('export'));expect(response.status).toBe(413);expect(await response.json()).toEqual({error:'This selection has too much detail. Choose a shorter period or a specific landing page.'});
});
it('uses the canonical matched Stockholm cutoff for the current and comparison selections',async()=>{
 await getStore().run('INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,coverageThrough) VALUES(?,?,?,?,?,?,?,?,?,?)','source','avenue-z','kind-patches','Source','kind-triple-whale','https://source.example','SOURCE',30,1,'2026-10-11T11:00:00Z');
 await seed([row({value:10,start:'2026-10-11T09:00:00Z',end:'2026-10-11T10:00:00Z'}),row({value:90,start:'2026-10-11T11:00:00Z',end:'2026-10-11T12:00:00Z'})]);
 const {POST}=await import('../../app/api/internal/export/route');const response=await POST(request('export',parameters({mode:'partial'})));expect(response.status).toBe(200);const {csv}=await response.json() as {csv:string};expect(csv).toContain('traffic,sessions,10,');expect(csv).not.toContain('traffic,sessions,90,');
});
it('fails closed rather than loading dense observations inside an unconfigured Sites runtime',async()=>{
 state.platform='sites';const observe=vi.spyOn(Store.prototype,'observations');const {clientEvidenceJSON}=await import('../../lib/server/client-evidence');
 await expect(clientEvidenceJSON({organizationId:'avenue-z',actorId:'sites:analyst',role:'analyst',permittedClientIds:['kind-patches']},'kind-patches',parameters(),'export')).rejects.toThrow('Company data service unavailable');expect(observe).not.toHaveBeenCalled();
});
it('bridges a Sites download end to end and binds the route client instead of an injected query client',async()=>{
 await seed([row()]);state.platform='sites';state.env.COMPANY_WORKSPACE_URL='https://native.example';
 let destination='',signedPurpose='',signedClient='';
 vi.stubGlobal('fetch',async(url:RequestInfo|URL,init?:RequestInit)=>{destination=String(url);expect(init?.redirect).toBe('manual');const signed=JSON.parse(String(init?.body));signedPurpose=signed.purpose;signedClient=new URLSearchParams(signed.query).get('clientId')||'';state.platform='vercel';try{const {POST}=await import('../../app/api/internal/export/route');return await POST(new Request(url,init));}finally{state.platform='sites';}});
 const {GET}=await import('../../app/api/clients/[clientId]/export/route');const response=await GET(new Request('https://preview.example/api/clients/kind-patches/export?'+parameters({clientId:'beam'})),{params:Promise.resolve({clientId:'kind-patches'})});
 expect(response.status).toBe(200);expect(destination).toBe('https://native.example/api/internal/export');expect(signedPurpose).toBe('export');expect(signedClient).toBe('kind-patches');expect(await response.text()).toContain('2026-10-11,traffic,sessions,120');
});
it('rejects an altered signed filter before exposing any selected evidence',async()=>{
 const signed=request('export'),body=await signed.text(),tampered=new Request(signed.url,{method:'POST',headers:signed.headers,body:body.replace('2026-10-11','2026-10-10')});
 const {POST}=await import('../../app/api/internal/export/route');expect((await POST(tampered)).status).toBe(403);
});
