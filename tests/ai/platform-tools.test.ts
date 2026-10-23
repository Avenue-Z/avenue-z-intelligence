import {expect,it,vi} from 'vitest';
vi.mock('@avenue/runtime',()=>({runtimePlatform:'sites',env:{}}));
vi.mock('../../lib/server/access',()=>({getStore:vi.fn(),requireClientAccess:vi.fn()}));
import {createPlatformTools,resolvePlatformFilters} from '../../lib/ai/platform-tools';
import clients from '../../data/initial-clients.json';
import {comparisonPeriod} from '../../lib/analytics/windows';
import type {AccessScope,QueryFilters,Client} from '../../lib/analytics/contracts';
const filters:QueryFilters={from:'2026-10-20',to:'2026-10-20',mode:'partial',compare:'weekday',view:'subscriptions',market:'US',page:'/pages/current',source:'facebook',device:'mobile',stream:''};
const scope:AccessScope={organizationId:'org',actorId:'user',role:'analyst',permittedClientIds:['kind-patches','beam']};
const query={clientId:'all',view:'traffic',period:'selected',from:null,to:null,mode:null,compare:'previous',compareFrom:null,compareTo:null,market:null,page:null,source:null,device:null,stream:null,breakdown:'all',metric:'cvr',sort:'decline',limit:20,offset:0};
const known=clients as Client[];
function dependencies(){return {scope,clients:known,filters,currentClientId:'kind-patches',question:'which markets / landing pages are performing the worst day over day?',store:{all:vi.fn(async()=>[]),findings:vi.fn(async()=>[]),note:vi.fn(async()=>({body:''}))} as any,loadContext:vi.fn(async(clientId:string,f:QueryFilters)=>({filters:f,clients:[],sources:[{id:`selection:${clientId}`,label:clientId,url:`/clients/${clientId}`}]}))};}
it('loads all permitted brands from any current screen and clears screen-only dimensions',async()=>{
 const d=dependencies(),tools=createPlatformTools(d),result:any=await tools[0].execute(query);
 expect(d.loadContext.mock.calls.map(([id])=>id).sort()).toEqual(['beam','kind-patches']);
 for(const [,f] of d.loadContext.mock.calls)expect(f).toMatchObject({view:'traffic',compare:'previous',market:'',source:'',page:'',device:'',from:'2026-10-20',to:'2026-10-20'});
 expect(result.sources).toHaveLength(2);expect(new Set(result.sources.map((s:any)=>s.id)).size).toBe(2);
});
it('denies forbidden clients, unknown fields and malformed filters before data reads',async()=>{
 const d=dependencies();d.scope={...scope,permittedClientIds:['beam']};const t=createPlatformTools(d)[0];
 for(const bad of [{...query,clientId:'kind-patches'},{...query,organizationId:'outside'},{...query,period:'custom',from:'2026-02-30',to:'2026-03-02'},{...query,period:'custom',from:'2026-01-01',to:'2026-10-01'},{...query,limit:5000}])await expect(t.execute(bad)).rejects.toThrow();
 expect(d.loadContext).not.toHaveBeenCalled();
});
it('resolves today and yesterday in each brand timezone at a date boundary',()=>{
 const now=new Date('2026-10-21T01:00:00Z'),kp=known.find(c=>c.id==='kind-patches')!,beam=known.find(c=>c.id==='beam')!;
 expect(resolvePlatformFilters({...query,period:'today'},kp,filters,now)).toMatchObject({from:'2026-10-21',to:'2026-10-21',mode:'partial',compare:'previous'});
 expect(resolvePlatformFilters({...query,period:'today'},beam,filters,now)).toMatchObject({from:'2026-10-20',to:'2026-10-20',mode:'partial'});
 expect(resolvePlatformFilters({...query,period:'yesterday'},beam,filters,now)).toMatchObject({from:'2026-10-19',to:'2026-10-19',mode:'closed'});
});
it('namespaces separate queries of the same brand so their evidence links cannot collide',async()=>{
 const d=dependencies(),t=createPlatformTools(d)[0],a:any=await t.execute({...query,clientId:'beam'}),b:any=await t.execute({...query,clientId:'beam',period:'yesterday'});
 expect(a.sources[0].id).not.toBe(b.sources[0].id);
});
it('reads reports without loading their large evidence archives and keeps the tenant/client in SQL',async()=>{
 const d=dependencies();d.store.all.mockResolvedValue([{id:'report',storeDate:'2026-10-19',revision:2,createdAt:'2026-10-20T12:00:00Z',payload:JSON.stringify({headlines:['Saved report'],filters:{from:'2026-10-19',to:'2026-10-19'}})}]);
 const t=createPlatformTools(d).find(t=>t.name==='read_reviews')!,result:any=await t.execute({clientId:'beam',reviewId:null,date:'2026-10-19',limit:5,offset:0});
 expect(d.store.all.mock.calls[0][0]).toContain("json_remove(payload,'$.evidence')");expect(d.store.all.mock.calls[0].slice(1,3)).toEqual(['org','beam']);expect(result.sources[0].id).toContain('report');expect(result.clients[0].reviews[0].payload.headlines).toEqual(['Saved report']);
 await expect(t.execute({clientId:'outside',reviewId:'report',date:null,limit:5,offset:0})).rejects.toThrow();
});

it('honors explicit tool dates even if the planner leaves period selected',()=>{
 const beam=known.find(c=>c.id==='beam')!;
 expect(resolvePlatformFilters({...query,clientId:'beam',period:'selected',from:'2026-10-19',to:'2026-10-19',mode:'closed'},beam,filters,new Date('2026-10-20T15:00:00Z'))).toMatchObject({from:'2026-10-19',to:'2026-10-19',mode:'closed',compare:'previous'});
});
it('treats a requested media channel separately from web referrer source filters',async()=>{
 const d=dependencies(),result:any=await createPlatformTools(d)[0].execute({...query,clientId:'beam',view:'media',metric:'spend',source:'Meta'});
 expect(d.loadContext.mock.calls[0][1].source).toBe('');expect(result.requestedMediaChannel).toBe('meta');expect(result.instruction).toContain('all channels');
});
it('treats a media channel in stream as an advertising channel rather than a sales stream',async()=>{
 const d=dependencies(),result:any=await createPlatformTools(d)[0].execute({...query,clientId:'beam',view:'media',metric:'spend',stream:'Meta'});
 expect(d.loadContext.mock.calls[0][1].stream).toBe('');expect(result.requestedMediaChannel).toBe('meta');
});

it.each([['2026-10-22T05:30:00Z','2026-10-21','2026-10-22'],['2026-11-02T07:30:00Z','2026-11-01','2026-11-02']])('resolves GA4 live and comparison dates on each profile clock at %s',(_instant,autoDate,beamDate)=>{
 const now=new Date(_instant),auto=known.find(c=>c.id==='autobrush')!,beam=known.find(c=>c.id==='beam')!;
 for(const [brand,date] of [[auto,autoDate],[beam,beamDate]] as const){const live=resolvePlatformFilters({...query,view:'ga4',period:'today',metric:'sessions'},brand,filters,now);expect(live).toMatchObject({from:date,to:date,view:'ga4',mode:'partial'});expect(comparisonPeriod(live).to).toBe(new Date(Date.parse(date)-86400000).toISOString().slice(0,10));expect(resolvePlatformFilters({...query,view:'ga4',period:'yesterday'},brand,filters,now).to).toBe(comparisonPeriod(live).to);expect(resolvePlatformFilters({...query,view:'ga4',period:'last7days'},brand,filters,now).to).toBe(comparisonPeriod(live).to);}
 expect(resolvePlatformFilters({...query,view:'traffic',period:'today'},auto,filters,now).to).toBe(beamDate);
});
it('resolves both authorized GA4 brands independently in the actual cross-brand query tool',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-22T05:30:00Z'));
 try{const d=dependencies();d.scope={...scope,permittedClientIds:['autobrush','beam']};const result=await createPlatformTools(d)[0].execute({...query,view:'ga4',period:'today',metric:'sessions'});expect(result).toMatchObject({filtersByBrand:expect.arrayContaining([{clientId:'autobrush',filters:expect.objectContaining({from:'2026-10-21',to:'2026-10-21'})},{clientId:'beam',filters:expect.objectContaining({from:'2026-10-22',to:'2026-10-22'})}])});expect(d.loadContext.mock.calls.map(([id])=>id).sort()).toEqual(['autobrush','beam']);}finally{vi.useRealTimers();}
});
it('queries Northbeam attribution independently of the current screen and uses provider-day dates',async()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-22T05:30:00Z'));try{const d=dependencies();d.scope={...scope,permittedClientIds:['autobrush','beam']};await createPlatformTools(d)[0].execute({...query,clientId:'autobrush',view:'northbeam',period:'yesterday',metric:'attributedRevenue'});expect(d.loadContext.mock.calls[0].slice(0,2)).toMatchObject(['autobrush',expect.objectContaining({view:'northbeam',from:'2026-10-21',to:'2026-10-21',mode:'closed'})]);}finally{vi.useRealTimers();}});

it.each(['market','source','page','device','stream'])('rejects unsupported Northbeam %s filters before reading any data',async dimension=>{const d=dependencies();d.scope={...scope,permittedClientIds:['autobrush']};await expect(createPlatformTools(d)[0].execute({...query,clientId:'autobrush',view:'northbeam',metric:'attributedRevenue',[dimension]:'US'})).rejects.toThrow('without market');expect(d.loadContext).not.toHaveBeenCalled();});
it('keeps all-brand Northbeam requests authorized and explicit about unsupported profiles',async()=>{const d=dependencies();d.scope={...scope,permittedClientIds:['autobrush','beam']};const result=await createPlatformTools(d)[0].execute({...query,view:'northbeam',metric:'spend'});expect(result).toMatchObject({unsupportedClientIds:['beam']});expect(d.loadContext.mock.calls.map(([id])=>id)).toEqual(['autobrush']);});
it('uses the Northbeam provider clock even if a native client clock differs',()=>{const auto={...known.find(c=>c.id==='autobrush')!,timezone:'UTC'},instant=new Date('2026-10-22T02:30:00Z');expect(resolvePlatformFilters({...query,clientId:'autobrush',view:'northbeam',period:'today',metric:'spend'},auto,filters,instant).to).toBe('2026-10-21');expect(resolvePlatformFilters({...query,view:'revenue',period:'today'},auto,filters,instant).to).toBe('2026-10-22');});
