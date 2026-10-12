import type {AccessScope,QueryFilters} from './contracts';
import type {Workspace} from '../server/workspace';

const dataset=(view:string)=>view==='overview'?'funnels':view;

/** Reuse only aggregates prepared for this response's exact data selection. */
export function selectWorkspaceView(workspace:Workspace,view:string):Workspace|null{
 if(view===workspace.filters.view)return workspace;
 const previousDataset=dataset(workspace.filters.view),nextDataset=dataset(view);
 const clients:Workspace['clients']=[];
 for(const record of workspace.clients){
  if(previousDataset===nextDataset){if(view!=='overview'&&!record.datasetMetrics)return null;clients.push({...record,viewMetrics:view==='overview'?record.metrics:record.datasetMetrics});continue;}
  const next=record.views?.[nextDataset];if(!next)return null;
  const views={...record.views,[previousDataset]:{details:record.details,actions:record.actions,viewMetrics:record.datasetMetrics}};
  delete views[nextDataset];
  clients.push({...record,...next,views,datasetMetrics:next.viewMetrics,viewMetrics:view==='overview'?record.metrics:next.viewMetrics});
 }
 return {...workspace,filters:{...workspace.filters,view},clients};
}

const scopeKey=(scope:AccessScope)=>JSON.stringify([scope.organizationId,scope.actorId,scope.role,[...scope.permittedClientIds].sort()]);
const filterKey=(filters:QueryFilters)=>JSON.stringify([filters.from,filters.to,filters.compare,filters.mode,filters.market,filters.stream,filters.source,filters.device,filters.page]);

/** Page-memory cache. Never survives a logout, navigation or browser session. */
export class WorkspaceCache{
 private scope:string;
 private entries=new Map<string,Workspace>();
 constructor(initial:Workspace){this.scope=scopeKey(initial.scope);this.remember(initial);}
 remember(workspace:Workspace){
  const scope=scopeKey(workspace.scope);if(scope!==this.scope){this.entries.clear();this.scope=scope;}
  const key=this.scope+filterKey(workspace.filters);this.entries.delete(key);this.entries.set(key,workspace);
  if(this.entries.size>8)this.entries.delete(this.entries.keys().next().value!);
 }
 read(filters:QueryFilters,now=Date.now()){
  const key=this.scope+filterKey(filters),cached=this.entries.get(key);if(!cached)return null;
  const workspace=selectWorkspaceView(cached,filters.view);if(!workspace)return null;
  this.entries.delete(key);this.entries.set(key,cached);
  const age=now-Date.parse(cached.loadedAt);
  return {workspace,stale:!Number.isFinite(age)||age>=60000};
 }
 invalidate(){this.entries.clear();}
}
