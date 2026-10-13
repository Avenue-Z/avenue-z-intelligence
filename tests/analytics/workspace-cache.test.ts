import {expect,it,vi} from 'vitest';
import * as navigation from '../../lib/analytics/workspace-cache';
import {queryClient} from '../../lib/analytics/query';
import {workspaceDatasets} from '../../lib/analytics/workspace-datasets';
import {workspacePresentation} from '../../lib/analytics/presentation';
import type {Workspace} from '../../lib/server/workspace';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';

const client:Client={id:'kind-patches',name:'Kind Patches',slug:'kind-patches',timezone:'UTC',currency:'USD',color:'#2549c5',version:1,config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'web',spendChannels:[],recurringLabel:'Subscriptions',minSessions:100,minOpportunity:5,maxActions:6,reviewTime:'09:00',reviewTimezone:'UTC',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-07',to:'2026-10-07',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'overview'};
function workspace(changes:Partial<QueryFilters>={},organizationId='agency',actorId='analyst',priorRows:Observation[]=[]):Workspace{
 const f={...filters,...changes},rows:Observation[]=[['overview','revenue',100],['revenue','revenue',50],['revenue','orders',5],['funnels','sessions',1000],['funnels','converting_sessions',20]].map(([dataset,metric,value])=>({date:f.to,dataset:dataset as string,metric:metric as string,value:value as number,dimensions:{},definition:metric as string,population:'web',currency:metric==='revenue'?'USD':null,sourceId:'source',retrievedAt:'2026-10-08T00:00:00Z',coverageThrough:'2026-10-08T00:00:00Z',quality:'complete'}));
 return {scope:{organizationId,actorId,role:'analyst',permittedClientIds:[client.id]},filters:f,clients:[{...workspacePresentation(queryClient(client,[...rows,...priorRows],[],f,{preparedDatasets:[...new Set(['overview','traffic','revenue','markets','products','subscriptions','media','creatives','reviews','settings'].flatMap(workspaceDatasets))]}),f),findings:[],reviews:[],note:{body:'',version:0},scheduleState:{active:false,waitingForSources:true,lastJob:undefined}}],jobs:[],reportingDateNote:null,loadedAt:'2026-10-08T12:00:00Z'};
}

it('switches to an unvisited tab immediately with its metrics and immutable original selection',()=>{
 const initial=workspace(),next=navigation.selectWorkspaceView(initial,'revenue')!;
 expect(next.filters).toMatchObject({view:'revenue',from:'2026-10-07',to:'2026-10-07'});
 expect(next.clients[0].viewMetrics).toMatchObject({revenue:50,orders:5,aov:10});
 expect(next.clients[0].details[0].metrics.revenue).toBe(50);
 expect(initial.filters.view).toBe('overview');
 expect(initial.clients[0].viewMetrics.revenue).toBe(100);
 expect(navigation.selectWorkspaceView(next,'overview')!.clients[0].viewMetrics.revenue).toBe(100);
 expect(navigation.selectWorkspaceView(next,'funnels')!.clients[0].viewMetrics.cvr).toBe(.02);
});
it('projects the comparison baseline for the selected dataset instead of retaining the previous tab baseline',()=>{
 const initial=workspace({},'agency','analyst',[
  {date:'2026-10-06',dataset:'revenue',metric:'revenue',value:40,dimensions:{},definition:'revenue',population:'web',currency:'USD',sourceId:'source',retrievedAt:'2026-10-08T00:00:00Z',coverageThrough:'2026-10-08T00:00:00Z',quality:'complete'},
  {date:'2026-10-06',dataset:'revenue',metric:'orders',value:4,dimensions:{},definition:'orders',population:'web',currency:null,sourceId:'source',retrievedAt:'2026-10-08T00:00:00Z',coverageThrough:'2026-10-08T00:00:00Z',quality:'complete'}
 ]);
 expect(initial.clients[0].comparisonEvidence).toEqual([]);
 const revenue=navigation.selectWorkspaceView(initial,'revenue')!;expect(revenue.clients[0].viewPriorMetrics).toMatchObject({revenue:40,orders:4,aov:10});
 expect(navigation.selectWorkspaceView(revenue,'overview')!.clients[0].viewPriorMetrics).toEqual(initial.clients[0].prior);
});
it('requires full review documents before projecting an analytics index into the Reviews view',()=>{
 const initial=workspace();initial.clients[0].reviewsIndexOnly=true;
 expect(navigation.selectWorkspaceView(initial,'reviews')).toBeNull();
 initial.clients[0].reviewsIndexOnly=false;expect(navigation.selectWorkspaceView(initial,'reviews')).not.toBeNull();
});
it('does not deduplicate a full archive request against an analytics index refresh',()=>{
 const analytics=new URLSearchParams({from:filters.from,to:filters.to,view:'overview',section:'portfolio'}),archive=new URLSearchParams(analytics);archive.set('section','reviews');
 expect(navigation.workspaceRequestKey(analytics)).not.toBe(navigation.workspaceRequestKey(archive));
 expect(navigation.workspaceRequestKey(analytics)).toBe(navigation.workspaceRequestKey(new URLSearchParams([...analytics].reverse())));
});
it('aborts an older pending response when immediate cached navigation becomes authoritative',async()=>{
 const old=new AbortController(),request={current:old as AbortController|null},key={current:'old-traffic-request'};let release!:(view:string)=>void,currentView='revenue';
 const pending=new Promise<string>(resolve=>{release=resolve;}).then(view=>{if(!old.signal.aborted)currentView=view;});
 navigation.cancelWorkspaceRequest(request,key);release('traffic');await pending;
 expect(currentView).toBe('revenue');expect(old.signal.aborted).toBe(true);expect(request.current).toBeNull();expect(key.current).toBe('');
});

it('reuses the exact filter selection across views while refusing every changed data filter',()=>{
 const cache=new navigation.WorkspaceCache(workspace());
 expect(cache.read({...filters,view:'products'},Date.parse('2026-10-08T12:00:05Z'))!.workspace.filters.view).toBe('products');
 const different:Partial<QueryFilters>[]=[{from:'2026-10-06'},{to:'2026-10-08'},{compare:'weekday'},{mode:'partial'},{market:'US'},{stream:'subscriptions'},{source:'Meta'},{device:'mobile'},{page:'/landing'}];
 for(const changes of different)expect(cache.read({...filters,...changes})).toBeNull();
});
it('keeps a pending comparison authoritative when the user switches to another prepared tab',()=>{
 const initial=workspace({view:'overview',compare:'previous'}),cache=new navigation.WorkspaceCache(initial),requested={...initial.filters,view:'revenue',compare:'weekday' as const};
 expect(cache.read(requested)).toBeNull();
 const confirmed=workspace({compare:'weekday'});cache.remember(confirmed);
 const revenue=cache.read(requested,Date.parse('2026-10-08T12:00:05Z'))!.workspace;
 expect(revenue.filters).toMatchObject({view:'revenue',compare:'weekday'});expect(revenue.clients[0].comparison.from).toBe('2026-09-30');expect(initial.filters.compare).toBe('previous');
});
it('does not reuse intraday aggregates across views with different source cutoffs',()=>{
 const initial=workspace({mode:'partial',view:'revenue'});initial.focusedClientId=client.id;
 initial.clients[0].connections=[{id:'sales',provider:'kind-shopify-sales',enabled:true,coverageThrough:'2026-10-07T16:00:00Z'},{id:'tw',provider:'kind-triple-whale',enabled:true,coverageThrough:'2026-10-07T14:00:00Z'}] as any;
 initial.clients[0].cutoff='2026-10-07T16:00:00Z';
 expect(navigation.selectWorkspaceView(initial,'markets')).toBeNull();
 initial.clients[0].connections[1].coverageThrough='2026-10-07T16:00:00Z';
 expect(navigation.selectWorkspaceView(initial,'markets')).not.toBeNull();
});

it('returns cached content immediately but marks a minute-old response for background refresh',()=>{
 const cache=new navigation.WorkspaceCache(workspace());
 expect(cache.read(filters,Date.parse('2026-10-08T12:00:59Z'))!.stale).toBe(false);
 expect(cache.read(filters,Date.parse('2026-10-08T12:01:00Z'))!.stale).toBe(true);
});

it('discards prior dates when the authenticated actor, organization or access changes',()=>{
 const cache=new navigation.WorkspaceCache(workspace());
 cache.remember(workspace({from:'2026-10-06'},'other-agency'));
 expect(cache.read(filters)).toBeNull();
 cache.remember(workspace({},'other-agency','new-analyst'));
 expect(cache.read({...filters,from:'2026-10-06'})).toBeNull();
 const narrowed=workspace({from:'2026-10-06',to:'2026-10-06'},'other-agency','new-analyst');narrowed.scope.permittedClientIds=[];narrowed.clients=[];cache.remember(narrowed);
 expect(cache.read(filters)).toBeNull();
});

it('invalidates cached responses after a workspace mutation',()=>{
 const cache=new navigation.WorkspaceCache(workspace());
 cache.invalidate();
 expect(cache.read(filters)).toBeNull();
});
it('checks prepared data only for the focused client and rejects missing compound datasets',()=>{
 const full=workspace({view:'revenue'}),primary=full.clients[0],headline={...primary,client:{...primary.client,id:'beam'},preparedDatasets:['overview'],views:{},details:[],actions:[]};full.clients.push(headline);full.scope.permittedClientIds.push('beam');(full as any).focusedClientId='kind-patches';
 expect(navigation.selectWorkspaceView(full,'products','kind-patches')).not.toBeNull();
 const incomplete={...full,clients:[{...primary,preparedDatasets:['overview','traffic','subscriptions'],views:{traffic:primary.views.traffic,subscriptions:primary.views.subscriptions}},headline]};
 expect(navigation.selectWorkspaceView(incomplete,'traffic','kind-patches')).toBeNull();expect(navigation.selectWorkspaceView(incomplete,'subscriptions','kind-patches')).toBeNull();expect(navigation.selectWorkspaceView({...incomplete,filters:{...incomplete.filters,view:'traffic'}},'traffic','kind-patches')).toBeNull();
});
it('retains independently prepared tabs for one selection without refreshing their original age',()=>{
 const initial=workspace({view:'revenue'});(initial as any).focusedClientId='kind-patches';initial.clients[0].preparedDatasets=workspaceDatasets('revenue');initial.clients[0].views={};
 const cache=new navigation.WorkspaceCache(initial),next=workspace({view:'traffic'});(next as any).focusedClientId='kind-patches';next.loadedAt='2026-10-08T12:00:30Z';next.clients[0].preparedDatasets=workspaceDatasets('traffic');next.clients[0].views={funnels:next.clients[0].views.funnels};cache.remember(next);
 expect(cache.read({...filters,view:'revenue'},Date.parse('2026-10-08T12:01:05Z'),'kind-patches')?.stale).toBe(true);expect(cache.read({...filters,view:'traffic'},Date.parse('2026-10-08T12:01:05Z'),'kind-patches')?.stale).toBe(false);expect(cache.read({...filters,view:'products'},undefined,'kind-patches')).toBeNull();
});
it('refuses a focused overview when its landing-page and spend datasets were not prepared',()=>{
 const initial=workspace({view:'revenue'});initial.focusedClientId='kind-patches';initial.clients[0].preparedDatasets=workspaceDatasets('revenue');initial.clients[0].views={overview:initial.clients[0].views.overview};
 expect(navigation.selectWorkspaceView(initial,'overview')).toBeNull();initial.focusedClientId=undefined;const overview=navigation.selectWorkspaceView(initial,'overview')!;expect(overview.clients[0].viewMetrics.revenue).toBe(100);expect(overview.clients[0].details).toEqual([]);expect(navigation.selectWorkspaceView(overview,'revenue')?.clients[0].viewMetrics.revenue).toBe(50);
});
it('does not project subscriptions or revenue from a frame missing their diagnostic datasets',()=>{
 const initial=workspace({view:'traffic'});initial.focusedClientId=client.id;
 initial.clients[0].preparedDatasets=['overview','funnels','traffic','subscriptions','subscriptionEvents','revenue'];
 expect(navigation.selectWorkspaceView(initial,'subscriptions',client.id)).toBeNull();
 expect(navigation.selectWorkspaceView(initial,'revenue',client.id)).toBeNull();
 initial.clients[0].preparedDatasets.push('orderStreams','renewalDiagnostics');
 expect(navigation.selectWorkspaceView(initial,'subscriptions',client.id)).not.toBeNull();
 expect(navigation.selectWorkspaceView(initial,'revenue',client.id)).toBeNull();
 initial.clients[0].preparedDatasets.push('orderHygiene');
 expect(navigation.selectWorkspaceView(initial,'revenue',client.id)).not.toBeNull();
});
it('reuses a diagnostically complete frame only for its exact custom comparison and focus',()=>{
 const initial=workspace({view:'revenue',compare:'custom',compareFrom:'2026-09-01',compareTo:'2026-09-01'});initial.focusedClientId=client.id;
 initial.clients[0].preparedDatasets=['overview','revenue','subscriptions','subscriptionEvents','orderStreams','orderHygiene'];
 const cache=new navigation.WorkspaceCache(initial);
 expect(cache.read(initial.filters,Date.parse('2026-10-08T12:00:05Z'),client.id)?.workspace.clients[0].viewMetrics.revenue).toBe(50);
 expect(cache.read({...initial.filters,compareFrom:'2026-09-02',compareTo:'2026-09-02'},undefined,client.id)).toBeNull();
 expect(cache.read(initial.filters,undefined,'beam')).toBeNull();
});


function focusedFrame(view='revenue',changes:Partial<QueryFilters>={}):Workspace{
 const frame=workspace({...changes,view});frame.focusedClientId=client.id;frame.loadedAt=new Date().toISOString();
 frame.clients[0].preparedDatasets=workspaceDatasets(view);frame.clients[0].views=Object.fromEntries(Object.entries(frame.clients[0].views).filter(([dataset])=>frame.clients[0].preparedDatasets!.includes(dataset)));
 return frame;
}
const parameters=(frame:Workspace)=>new URLSearchParams({...frame.filters,clientId:client.id});
async function flushPreloads(){for(let i=0;i<8;i++)await Promise.resolve();}

it('preloads unvisited client views with two background requests and joins foreground reads',async()=>{
 const initial=focusedFrame(),cache=new navigation.WorkspaceCache(initial),pending=new Map<string,(frame:Workspace)=>void>();
 const load=vi.fn((params:URLSearchParams,_signal:AbortSignal)=>new Promise<Workspace>(resolve=>pending.set(params.get('view')!,resolve)));
 const preloader=new navigation.WorkspacePreloader(cache,load),params=parameters(initial);
 preloader.preload(initial,params,client.id,['traffic','products','media']);await flushPreloads();
 expect(load.mock.calls.map(([params])=>params.get('view'))).toEqual(['traffic','products']);
 const trafficParams=new URLSearchParams(params);trafficParams.set('view','traffic');const foreground=preloader.request(trafficParams);
 expect(load).toHaveBeenCalledTimes(2);
 pending.get('traffic')!(focusedFrame('traffic'));await foreground;await flushPreloads();
 expect(load.mock.calls.map(([params])=>params.get('view'))).toEqual(['traffic','products','media']);
 expect(cache.read({...initial.filters,view:'traffic'},Date.now(),client.id)?.workspace.filters.view).toBe('traffic');
 preloader.cancel();
});

it('deduplicates repeated preload waves and cancels old filters without caching late responses',async()=>{
 const initial=focusedFrame(),cache=new navigation.WorkspaceCache(initial),signals:AbortSignal[]=[],pending:((frame:Workspace)=>void)[]=[];
 const load=vi.fn((_params:URLSearchParams,signal:AbortSignal)=>new Promise<Workspace>(resolve=>{signals.push(signal);pending.push(resolve);}));
 const preloader=new navigation.WorkspacePreloader(cache,load),params=parameters(initial);
 preloader.preload(initial,params,client.id,['traffic','products','media']);preloader.preload(initial,params,client.id,['traffic','products','media']);await flushPreloads();
 expect(load).toHaveBeenCalledTimes(2);
 const changed=new URLSearchParams(params);changed.set('from','2026-10-06');preloader.select(changed);
 expect(signals.every(signal=>signal.aborted)).toBe(true);
 pending[0](focusedFrame('traffic'));pending[1](focusedFrame('products'));await flushPreloads();
 expect(cache.read({...initial.filters,view:'traffic'},Date.now(),client.id)).toBeNull();expect(load).toHaveBeenCalledTimes(2);
});

it('preloads the exact comparison, date and supported dimension selection for each tab',async()=>{
 const initial=focusedFrame('traffic',{compare:'custom',compareFrom:'2026-09-01',compareTo:'2026-09-01',market:'US',source:'Meta',device:'mobile',page:'/offer'}),cache=new navigation.WorkspaceCache(initial);
 const load=vi.fn(async(params:URLSearchParams)=>focusedFrame(params.get('view')!,Object.fromEntries([...params].filter(([key])=>key!=='clientId')) as Partial<QueryFilters>));
 const preloader=new navigation.WorkspacePreloader(cache,load);preloader.preload(initial,parameters(initial),client.id,['revenue']);await flushPreloads();
 expect(load).toHaveBeenCalledTimes(1);const requested=load.mock.calls[0][0];
 expect(Object.fromEntries(requested)).toMatchObject({clientId:client.id,view:'revenue',from:initial.filters.from,to:initial.filters.to,compare:'custom',compareFrom:'2026-09-01',compareTo:'2026-09-01',market:'',source:'',device:'',page:''});
 expect(cache.read({...initial.filters,view:'revenue',market:'',source:'',device:'',page:''},Date.now(),client.id)).not.toBeNull();
 expect(cache.read({...initial.filters,view:'revenue'},Date.now(),client.id)).toBeNull();preloader.cancel();
});

it('refreshes preloaded tabs when an hourly source capture changes, even when browser entries are young',async()=>{
 const initial=focusedFrame();initial.clients[0].connections=[{id:'source',version:1,enabled:true,lastSuccess:'2026-10-08T12:00:00Z',coverageThrough:'2026-10-08T11:00:00Z'}] as any;
 const cache=new navigation.WorkspaceCache(initial),load=vi.fn(async(params:URLSearchParams)=>{const next=focusedFrame(params.get('view')!);next.clients[0].connections=initial.clients[0].connections;return next;});
 const preloader=new navigation.WorkspacePreloader(cache,load),params=parameters(initial);preloader.preload(initial,params,client.id,['products']);await flushPreloads();
 expect(load).toHaveBeenCalledTimes(1);preloader.preload(initial,params,client.id,['products']);await flushPreloads();expect(load).toHaveBeenCalledTimes(1);
 const updated=focusedFrame();updated.clients[0].connections=[{...initial.clients[0].connections[0],lastSuccess:'2026-10-08T13:00:00Z',coverageThrough:'2026-10-08T12:00:00Z'}];preloader.preload(updated,params,client.id,['products']);await flushPreloads();
 expect(load).toHaveBeenCalledTimes(2);preloader.cancel();
});

it('does not restore an older-hour tab while its replacement is still warming',async()=>{
 const initial=focusedFrame();initial.clients[0].connections=[{id:'source',version:1,enabled:true,lastSuccess:'2026-10-08T12:00:00Z',coverageThrough:'2026-10-08T11:00:00Z'}] as Workspace['clients'][number]['connections'];
 const cache=new navigation.WorkspaceCache(initial);let release!:(frame:Workspace)=>void;
 const load=vi.fn().mockImplementationOnce(async()=>{const traffic=focusedFrame('traffic');traffic.clients[0].connections=initial.clients[0].connections;return traffic;}).mockImplementationOnce(()=>new Promise<Workspace>(resolve=>{release=resolve;}));
 const preloader=new navigation.WorkspacePreloader(cache,load),params=parameters(initial);preloader.preload(initial,params,client.id,['traffic']);await flushPreloads();
 expect(cache.read({...initial.filters,view:'traffic'},Date.now(),client.id)).not.toBeNull();
 const updated=focusedFrame();updated.clients[0].connections=[{...initial.clients[0].connections[0],lastSuccess:'2026-10-08T13:00:00Z',coverageThrough:'2026-10-08T12:00:00Z'}];cache.remember(updated);preloader.preload(updated,params,client.id,['traffic']);await flushPreloads();
 expect(cache.read({...initial.filters,view:'traffic'},Date.now(),client.id)).toBeNull();expect(cache.read(updated.filters,Date.now(),client.id)?.workspace.clients[0].connections[0].coverageThrough).toBe('2026-10-08T12:00:00Z');
 const current=focusedFrame('traffic');current.clients[0].connections=updated.clients[0].connections;release(current);await flushPreloads();expect(cache.read({...initial.filters,view:'traffic'},Date.now(),client.id)?.workspace.clients[0].connections[0].coverageThrough).toBe('2026-10-08T12:00:00Z');preloader.cancel();
});


it('replaces an obsolete joined request before a new navigation can restore the previous source hour',async()=>{
 const initial=focusedFrame();initial.clients[0].connections=[{id:'source',enabled:true,lastSuccess:'2026-10-08T12:00:00Z'}] as Workspace['clients'][number]['connections'];
 const cache=new navigation.WorkspaceCache(initial),reads:{view:string;signal:AbortSignal;resolve:(frame:Workspace)=>void}[]=[];
 const load=vi.fn((params:URLSearchParams,signal:AbortSignal)=>new Promise<Workspace>(resolve=>{reads.push({view:params.get('view')!,signal,resolve});}));
 const preloader=new navigation.WorkspacePreloader(cache,load),params=parameters(initial);preloader.preload(initial,params,client.id,['traffic','products']);await flushPreloads();
 const trafficParams=new URLSearchParams(params);trafficParams.set('view','traffic');const first=preloader.request(trafficParams);
 const oldOuter={current:new AbortController() as AbortController|null},oldKey={current:'traffic'};navigation.cancelWorkspaceRequest(oldOuter,oldKey);
 const updated=focusedFrame();updated.clients[0].connections=[{...initial.clients[0].connections[0],lastSuccess:'2026-10-08T13:00:00Z'}];preloader.preload(updated,params,client.id,['traffic']);await flushPreloads();
 const next=preloader.request(trafficParams);expect(next).not.toBe(first);expect(reads[0].signal.aborted).toBe(true);expect(reads[1].signal.aborted).toBe(true);expect(reads).toHaveLength(3);
 const oldTraffic=focusedFrame('traffic');oldTraffic.clients[0].connections=initial.clients[0].connections;reads[0].resolve(oldTraffic);await flushPreloads();
 const currentTraffic=focusedFrame('traffic');currentTraffic.clients[0].connections=updated.clients[0].connections;reads[2].resolve(currentTraffic);
 for(const result of await Promise.all([first,next]))expect(result.clients[0].connections[0].lastSuccess).toBe('2026-10-08T13:00:00Z');
 expect(cache.read({...initial.filters,view:'traffic'},Date.now(),client.id)?.workspace.clients[0].connections[0].lastSuccess).toBe('2026-10-08T13:00:00Z');reads[1].resolve(focusedFrame('products'));preloader.cancel();
});

it('aborts a joined foreground request when its selected client or filters change',async()=>{
 const initial=focusedFrame(),cache=new navigation.WorkspaceCache(initial),signals:AbortSignal[]=[],releases:((frame:Workspace)=>void)[]=[];
 const load=vi.fn((_params:URLSearchParams,signal:AbortSignal)=>new Promise<Workspace>(resolve=>{signals.push(signal);releases.push(resolve);}));
 const preloader=new navigation.WorkspacePreloader(cache,load),params=parameters(initial);preloader.preload(initial,params,client.id,['traffic']);await flushPreloads();
 const traffic=new URLSearchParams(params);traffic.set('view','traffic');const foreground=preloader.request(traffic),rejected=expect(foreground).rejects.toMatchObject({name:'AbortError'});
 const next=new URLSearchParams(params);next.set('compare','weekday');preloader.select(next);expect(signals[0].aborted).toBe(true);
 releases[0](focusedFrame('traffic'));await rejected;expect(cache.read({...initial.filters,view:'traffic'},Date.now(),client.id)).toBeNull();
});

it('does not revive a detached old-hour foreground read after forced cancellation',async()=>{
 const initial=focusedFrame();initial.clients[0].connections=[{id:'source',enabled:true,lastSuccess:'2026-10-08T12:00:00Z'}] as Workspace['clients'][number]['connections'];
 const cache=new navigation.WorkspaceCache(initial),releases:((frame:Workspace)=>void)[]=[],load=vi.fn((_params:URLSearchParams,_signal:AbortSignal)=>new Promise<Workspace>(resolve=>releases.push(resolve)));
 const preloader=new navigation.WorkspacePreloader(cache,load),params=parameters(initial);preloader.preload(initial,params,client.id,['traffic']);await flushPreloads();
 const traffic=new URLSearchParams(params);traffic.set('view','traffic');const foreground=preloader.request(traffic),rejected=expect(foreground).rejects.toMatchObject({name:'AbortError'});
 const updated=focusedFrame();updated.clients[0].connections=[{...initial.clients[0].connections[0],lastSuccess:'2026-10-08T13:00:00Z'}];preloader.preload(updated,params,client.id,['traffic']);await flushPreloads();preloader.cancel();
 releases[0](focusedFrame('traffic'));releases[1](focusedFrame('traffic'));await rejected;await flushPreloads();expect(load).toHaveBeenCalledTimes(2);
});

it('retries a joined foreground read through the current wave when fetch rejects its obsolete signal',async()=>{
 const initial=focusedFrame();initial.clients[0].connections=[{id:'source',enabled:true,lastSuccess:'2026-10-08T12:00:00Z'}] as Workspace['clients'][number]['connections'];
 const cache=new navigation.WorkspaceCache(initial);let release!:(frame:Workspace)=>void;
 const load=vi.fn().mockImplementationOnce((_params:URLSearchParams,signal:AbortSignal)=>new Promise<Workspace>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))))).mockImplementationOnce(()=>new Promise<Workspace>(resolve=>{release=resolve;}));
 const preloader=new navigation.WorkspacePreloader(cache,load),params=parameters(initial);preloader.preload(initial,params,client.id,['traffic']);await flushPreloads();
 const traffic=new URLSearchParams(params);traffic.set('view','traffic');const foreground=preloader.request(traffic);
 const updated=focusedFrame();updated.clients[0].connections=[{...initial.clients[0].connections[0],lastSuccess:'2026-10-08T13:00:00Z'}];preloader.preload(updated,params,client.id,['traffic']);await flushPreloads();
 const current=focusedFrame('traffic');current.clients[0].connections=updated.clients[0].connections;release(current);expect((await foreground).clients[0].connections[0].lastSuccess).toBe('2026-10-08T13:00:00Z');expect(load).toHaveBeenCalledTimes(2);preloader.cancel();
});

it('cancels old-actor requests and refuses preloading clients outside the current access scope',async()=>{
 const initial=focusedFrame(),cache=new navigation.WorkspaceCache(initial);let signal!:AbortSignal,release!:(frame:Workspace)=>void;
 const load=vi.fn((_params:URLSearchParams,pendingSignal:AbortSignal)=>new Promise<Workspace>(resolve=>{signal=pendingSignal;release=resolve;}));
 const preloader=new navigation.WorkspacePreloader(cache,load),params=parameters(initial);preloader.preload(initial,params,client.id,['traffic']);await flushPreloads();
 const traffic=new URLSearchParams(params);traffic.set('view','traffic');const foreground=preloader.request(traffic),rejected=expect(foreground).rejects.toMatchObject({name:'AbortError'});
 const narrowed=focusedFrame();narrowed.scope={...narrowed.scope,actorId:'other-user',permittedClientIds:[]};narrowed.clients=[];preloader.preload(narrowed,params,client.id,['traffic']);
 expect(signal.aborted).toBe(true);expect(load).toHaveBeenCalledTimes(1);release(focusedFrame('traffic'));await rejected;
 expect(cache.read({...initial.filters,view:'traffic'},Date.now(),client.id)).toBeNull();
});

it('captures request parameters before the caller changes a URL selection',async()=>{
 const initial=focusedFrame(),cache=new navigation.WorkspaceCache(initial),load=vi.fn(async(params:URLSearchParams)=>focusedFrame(params.get('view')!));
 const preloader=new navigation.WorkspacePreloader(cache,load),params=parameters(initial);params.set('view','traffic');const request=preloader.request(params);params.set('view','products');await request;
 expect(load.mock.calls[0][0].get('view')).toBe('traffic');expect(cache.read({...initial.filters,view:'traffic'},Date.now(),client.id)).not.toBeNull();preloader.cancel();
});

it('leaves normal navigation available after an optional preload fails',async()=>{
 const initial=focusedFrame(),cache=new navigation.WorkspaceCache(initial),load=vi.fn().mockRejectedValueOnce(new Error('Temporary read timeout')).mockResolvedValueOnce(focusedFrame('traffic'));
 const preloader=new navigation.WorkspacePreloader(cache,load),params=parameters(initial);preloader.preload(initial,params,client.id,['traffic']);await flushPreloads();
 const traffic=new URLSearchParams(params);traffic.set('view','traffic');await expect(preloader.request(traffic)).resolves.toMatchObject({filters:{view:'traffic'}});
 expect(load).toHaveBeenCalledTimes(2);preloader.cancel();
});
