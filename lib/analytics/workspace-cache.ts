import type {AccessScope,QueryFilters} from './contracts';
import type {Workspace} from '../server/workspace';
import {workspaceDatasets} from './workspace-datasets';
import {confirmedIntradayCutoff} from './intraday-coverage';
import {unsupportedClientFilterReset} from './client-filter-policy';
import {summarize} from './query';
import {clientSubscriptionsEnabled} from './client-feature-policy';

const dataset=(view:string)=>view==='overview'?'funnels':view;
const required=(view:string,focused:boolean,clientId:string)=>view==='overview'&&!focused?['overview']:workspaceDatasets(view,clientId);

/** Reuse only aggregates prepared for this response's exact data selection. */
export function selectWorkspaceView(workspace:Workspace,view:string,focusedClientId=workspace.focusedClientId):Workspace|null{
 if(focusedClientId&&!workspace.clients.some(record=>record.client.id===focusedClientId))return null;
 const previousDataset=dataset(workspace.filters.view),nextDataset=dataset(view);
 const clients:Workspace['clients']=[];
 for(const record of workspace.clients){
  if(focusedClientId&&record.client.id!==focusedClientId){clients.push(record);continue;}
  if(view==='reviews'&&record.reviewsIndexOnly)return null;
  if(workspace.filters.mode==='partial'&&view!==workspace.filters.view){const nextCutoff=confirmedIntradayCutoff(record.connections,view,record.client.timezone,workspace.filters.to);if(!nextCutoff||nextCutoff!==record.cutoff)return null;}
  const prepared=record.preparedDatasets??[previousDataset,...Object.keys(record.views??{})];
  if(!required(view,!!focusedClientId,record.client.id).every(name=>prepared.includes(name)))return null;
  if(view===workspace.filters.view){clients.push(record);continue;}
  const viewPriorMetrics=view==='overview'?record.prior:record.comparisonViews?.[nextDataset]?.viewMetrics??summarize([]);
  if(view==='overview'&&!prepared.includes('funnels')){const views={...record.views,...prepared.includes(previousDataset)?{[previousDataset]:{details:record.details,actions:record.actions,viewMetrics:record.datasetMetrics}}:{}};clients.push({...record,details:[],actions:[],views,datasetMetrics:record.metrics,viewMetrics:record.metrics,viewPriorMetrics});continue;}
  if(previousDataset===nextDataset){if(view!=='overview'&&!record.datasetMetrics)return null;clients.push({...record,viewMetrics:view==='overview'?record.metrics:record.datasetMetrics,viewPriorMetrics});continue;}
  const next=record.views?.[nextDataset];if(!next)return null;
  const views={...record.views,...prepared.includes(previousDataset)?{[previousDataset]:{details:record.details,actions:record.actions,viewMetrics:record.datasetMetrics}}:{}};
  delete views[nextDataset];
  clients.push({...record,...next,views,datasetMetrics:next.viewMetrics,viewMetrics:view==='overview'?record.metrics:next.viewMetrics,viewPriorMetrics});
 }
 return {...workspace,filters:{...workspace.filters,view},clients};
}

const scopeKey=(scope:AccessScope)=>JSON.stringify([scope.organizationId,scope.actorId,scope.role,[...scope.permittedClientIds].sort()]);
const filterKey=(filters:QueryFilters)=>JSON.stringify(['hourly-workspace-v1',filters.from,filters.to,filters.period??null,filters.compare,filters.compareFrom??null,filters.compareTo??null,filters.mode,filters.market,filters.stream,filters.source,filters.device,filters.page]);
/** Section is part of request identity: the review archive returns full bodies. */
export const workspaceRequestKey=(params:URLSearchParams)=>JSON.stringify([...params].sort());
export function cancelWorkspaceRequest(request:{current:AbortController|null},key:{current:string}){
 request.current?.abort();request.current=null;key.current='';
}

/** Page-memory cache. Never survives a logout, navigation or browser session. */
export class WorkspaceCache{
 private scope:string;
 private focusedClientId:string|undefined;
 private entries=new Map<string,Map<string,Workspace>>();
 constructor(initial:Workspace){this.scope=scopeKey(initial.scope);this.focusedClientId=initial.focusedClientId;this.remember(initial);}
 remember(workspace:Workspace){
  const scope=scopeKey(workspace.scope);if(scope!==this.scope){this.entries.clear();this.scope=scope;}
  const key=this.scope+filterKey(workspace.filters)+JSON.stringify(workspace.focusedClientId??null),views=this.entries.get(key)??new Map<string,Workspace>();
  views.delete(workspace.filters.view);views.set(workspace.filters.view,workspace);if(views.size>12)views.delete(views.keys().next().value!);
  this.entries.delete(key);this.entries.set(key,views);
  if(this.entries.size>8)this.entries.delete(this.entries.keys().next().value!);
 }
 read(filters:QueryFilters,now=Date.now(),focusedClientId=this.focusedClientId){
  const key=this.scope+filterKey(filters)+JSON.stringify(focusedClientId??null),views=this.entries.get(key);if(!views)return null;
  for(const cached of [...views.values()].reverse()){
   const workspace=selectWorkspaceView(cached,filters.view,focusedClientId);if(!workspace)continue;
   this.entries.delete(key);this.entries.set(key,views);
   const age=now-Date.parse(cached.loadedAt);
   return {workspace,stale:!Number.isFinite(age)||age>=60000};
  }
  return null;
 }
 invalidate(){this.entries.clear();}
}


const preloadViews=['overview','revenue','traffic','markets','products','subscriptions','media','reviews','settings'] as const;
const selectionKey=(params:URLSearchParams)=>workspaceRequestKey(new URLSearchParams([...params].filter(([key])=>key!=='view'&&key!=='section')));
function sourceFingerprint(workspace:Workspace,clientId:string){
 const record=workspace.clients.find(item=>item.client.id===clientId);
 return JSON.stringify([scopeKey(workspace.scope),record?.client,record?.connections.map(source=>[source.id,source.version,source.enabled,source.lastSuccess,source.coverageThrough]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
}
type WorkspaceLoad=(params:URLSearchParams,signal:AbortSignal)=>Promise<Workspace>;
type PendingWorkspace={controller:AbortController;promise:Promise<Workspace>;foreground:boolean;retryOnNewWave:boolean};
/** Prepare saved tab data after the screen renders. Foreground navigation joins
 * an identical request; obsolete filter/source waves never populate the cache.
 * Only two background reads run at once and no provider is queried here. */
export class WorkspacePreloader{
 private selection='';private wave='';private scope='';private generation=0;private hardGeneration=0;private active=0;
 private pending=new Map<string,PendingWorkspace>();private queue=new Map<string,URLSearchParams>();private attempted=new Set<string>();
 constructor(private cache:WorkspaceCache,private load:WorkspaceLoad){}
 select(params:URLSearchParams){const key=selectionKey(params);if(key!==this.selection){this.cancel();this.selection=key;}}
 cancel(retryForeground=false){
  this.generation++;if(!retryForeground)this.hardGeneration++;
  for(const pending of this.pending.values()){pending.retryOnNewWave=retryForeground&&pending.foreground;pending.controller.abort();}
  this.pending.clear();
  this.queue.clear();this.attempted.clear();this.active=0;this.wave='';
 }
 request(params:URLSearchParams,foreground=true):Promise<Workspace>{
  const key=workspaceRequestKey(params),existing=this.pending.get(key);if(existing){if(foreground)existing.foreground=true;return existing.promise;}
  this.queue.delete(key);const controller=new AbortController(),generation=this.generation,hardGeneration=this.hardGeneration,scope=this.scope;
  const requested=new URLSearchParams(params),pending:PendingWorkspace={controller,foreground,promise:undefined!,retryOnNewWave:false};
  // A queued server read can outlive the request's platform limit. Bound both
  // foreground navigation and optional preloads so a dropped response cannot
  // leave this request permanently pending in the browser.
  let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{reject(new Error('This view is taking longer than expected. Please retry.'));controller.abort();},45000);});
  const promise=Promise.race([Promise.resolve().then(()=>this.load(requested,controller.signal)),deadline]).then(workspace=>{
   if(controller.signal.aborted||generation!==this.generation)throw new DOMException('Obsolete workspace request','AbortError');
   this.cache.remember(workspace);return workspace;
  }).catch(error=>{
   // Detach an older-hour read immediately. A navigation that already joined
   // it can finish through the current wave, but must never receive old data.
   if(pending.retryOnNewWave&&hardGeneration===this.hardGeneration&&scope===this.scope&&selectionKey(requested)===this.selection)return this.request(requested,true);
   throw error;
  }).finally(()=>{if(timer)clearTimeout(timer);if(this.pending.get(key)?.controller===controller)this.pending.delete(key);});
  pending.promise=promise;this.pending.set(key,pending);return promise;
 }
 preload(workspace:Workspace,params:URLSearchParams,clientId:string,views:readonly string[]=preloadViews){
  const scope=scopeKey(workspace.scope);if(this.scope&&this.scope!==scope){this.cancel();this.cache.invalidate();}this.scope=scope;
  const record=workspace.clients.find(record=>record.client.id===clientId);
  if(!workspace.scope.permittedClientIds.includes(clientId)||!record)return;
  params=new URLSearchParams(params);params.set('clientId',clientId);this.select(params);
  const sources=sourceFingerprint(workspace,clientId),wave=this.selection+sources;
  if(this.wave&&this.wave!==wave){this.cancel(true);this.cache.invalidate();this.cache.remember(workspace);}this.wave=wave;
  for(const view of views){
   if(view==='subscriptions'&&!clientSubscriptionsEnabled(clientId,record.client.config.subscriptionsEnabled))continue;
   const filters={...workspace.filters,view,...unsupportedClientFilterReset(workspace.filters,view)},next=new URLSearchParams(params);next.set('view',view);
   for(const [key,value]of Object.entries(unsupportedClientFilterReset(workspace.filters,view)))next.set(key,value);
   const key=workspaceRequestKey(next);if(this.attempted.has(key)||this.pending.has(key))continue;
   const cached=this.cache.read(filters,Date.now(),clientId);
   if(cached&&!cached.stale&&sourceFingerprint(cached.workspace,clientId)===sources)continue;
   this.attempted.add(key);this.queue.set(key,next);
  }
  this.pump();
 }
 private pump(){
  while(this.active<2&&this.queue.size){
   const [key,params]=this.queue.entries().next().value!;this.queue.delete(key);this.active++;const generation=this.generation;
   void this.request(params,false).catch(()=>{/* A failed optional preload leaves normal navigation/retry available. */}).finally(()=>{if(generation===this.generation){this.active--;this.pump();}});
  }
 }
}
