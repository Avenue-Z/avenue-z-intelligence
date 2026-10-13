import {expect,it} from 'vitest';
import * as navigation from '../../lib/analytics/workspace-cache';
import {queryClient} from '../../lib/analytics/query';
import {workspaceDatasets} from '../../lib/analytics/workspace-datasets';
import {workspacePresentation} from '../../lib/analytics/presentation';
import type {Workspace} from '../../lib/server/workspace';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';

const client:Client={id:'kind-patches',name:'Kind Patches',slug:'kind-patches',timezone:'UTC',currency:'USD',color:'#2549c5',version:1,config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'web',spendChannels:[],recurringLabel:'Subscriptions',minSessions:100,minOpportunity:5,maxActions:6,reviewTime:'09:00',reviewTimezone:'UTC',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-07',to:'2026-10-07',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'overview'};
function workspace(changes:Partial<QueryFilters>={},organizationId='agency',actorId='analyst'):Workspace{
 const f={...filters,...changes},rows:Observation[]=[['overview','revenue',100],['revenue','revenue',50],['revenue','orders',5],['funnels','sessions',1000],['funnels','converting_sessions',20]].map(([dataset,metric,value])=>({date:f.to,dataset:dataset as string,metric:metric as string,value:value as number,dimensions:{},definition:metric as string,population:'web',currency:metric==='revenue'?'USD':null,sourceId:'source',retrievedAt:'2026-10-08T00:00:00Z',coverageThrough:'2026-10-08T00:00:00Z',quality:'complete'}));
 return {scope:{organizationId,actorId,role:'analyst',permittedClientIds:[client.id]},filters:f,clients:[{...workspacePresentation(queryClient(client,rows,[],f,{preparedDatasets:[...new Set(['overview','traffic','revenue','markets','products','subscriptions','media','creatives','reviews','settings'].flatMap(workspaceDatasets))]}),f),findings:[],reviews:[],note:{body:'',version:0},scheduleState:{active:false,waitingForSources:true,lastJob:undefined}}],jobs:[],reportingDateNote:null,loadedAt:'2026-10-08T12:00:00Z'};
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

it('reuses the exact filter selection across views while refusing every changed data filter',()=>{
 const cache=new navigation.WorkspaceCache(workspace());
 expect(cache.read({...filters,view:'products'},Date.parse('2026-10-08T12:00:05Z'))!.workspace.filters.view).toBe('products');
 const different:Partial<QueryFilters>[]=[{from:'2026-10-06'},{to:'2026-10-08'},{compare:'weekday'},{mode:'partial'},{market:'US'},{stream:'subscriptions'},{source:'Meta'},{device:'mobile'},{page:'/landing'}];
 for(const changes of different)expect(cache.read({...filters,...changes})).toBeNull();
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
