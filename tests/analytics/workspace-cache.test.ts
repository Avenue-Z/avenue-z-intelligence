import {expect,it} from 'vitest';
import * as navigation from '../../lib/analytics/workspace-cache';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import type {Workspace} from '../../lib/server/workspace';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';

const client:Client={id:'kind-patches',name:'Kind Patches',slug:'kind-patches',timezone:'UTC',currency:'USD',color:'#2549c5',version:1,config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'web',spendChannels:[],recurringLabel:'Subscriptions',minSessions:100,minOpportunity:5,maxActions:6,reviewTime:'09:00',reviewTimezone:'UTC',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-07',to:'2026-10-07',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'overview'};
function workspace(changes:Partial<QueryFilters>={},organizationId='agency',actorId='analyst'):Workspace{
 const f={...filters,...changes},rows:Observation[]=[['overview','revenue',100],['revenue','revenue',50],['revenue','orders',5],['funnels','sessions',1000],['funnels','converting_sessions',20]].map(([dataset,metric,value])=>({date:f.to,dataset:dataset as string,metric:metric as string,value:value as number,dimensions:{},definition:metric as string,population:'web',currency:metric==='revenue'?'USD':null,sourceId:'source',retrievedAt:'2026-10-08T00:00:00Z',coverageThrough:'2026-10-08T00:00:00Z',quality:'complete'}));
 return {scope:{organizationId,actorId,role:'analyst',permittedClientIds:[client.id]},filters:f,clients:[{...workspacePresentation(queryClient(client,rows,[],f,{prepareAllViews:true}),f),findings:[],reviews:[],note:{body:'',version:0},scheduleState:{active:false,waitingForSources:true,lastJob:undefined}}],jobs:[],reportingDateNote:null,loadedAt:'2026-10-08T12:00:00Z'};
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
