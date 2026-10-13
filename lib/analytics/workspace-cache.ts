import type {AccessScope,QueryFilters} from './contracts';
import type {Workspace} from '../server/workspace';
import {workspaceDatasets} from './workspace-datasets';
import {confirmedIntradayCutoff} from './intraday-coverage';

const dataset=(view:string)=>view==='overview'?'funnels':view;
const required=(view:string,focused:boolean)=>view==='overview'&&!focused?['overview']:workspaceDatasets(view);

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
  if(!required(view,!!focusedClientId).every(name=>prepared.includes(name)))return null;
  if(view===workspace.filters.view){clients.push(record);continue;}
  if(view==='overview'&&!prepared.includes('funnels')){const views={...record.views,...prepared.includes(previousDataset)?{[previousDataset]:{details:record.details,actions:record.actions,viewMetrics:record.datasetMetrics}}:{}};clients.push({...record,details:[],actions:[],views,datasetMetrics:record.metrics,viewMetrics:record.metrics});continue;}
  if(previousDataset===nextDataset){if(view!=='overview'&&!record.datasetMetrics)return null;clients.push({...record,viewMetrics:view==='overview'?record.metrics:record.datasetMetrics});continue;}
  const next=record.views?.[nextDataset];if(!next)return null;
  const views={...record.views,...prepared.includes(previousDataset)?{[previousDataset]:{details:record.details,actions:record.actions,viewMetrics:record.datasetMetrics}}:{}};
  delete views[nextDataset];
  clients.push({...record,...next,views,datasetMetrics:next.viewMetrics,viewMetrics:view==='overview'?record.metrics:next.viewMetrics});
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
