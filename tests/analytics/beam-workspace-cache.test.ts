import {expect,it,vi} from 'vitest';
import {WorkspaceCache,WorkspacePreloader,selectWorkspaceView} from '../../lib/analytics/workspace-cache';
import {workspaceDatasets} from '../../lib/analytics/workspace-datasets';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';
import type {Workspace} from '../../lib/server/workspace';
const client:Client={id:'beam',name:'Beam',slug:'beam',timezone:'America/New_York',currency:'USD',color:'#4368c4',version:1,config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'net_sales',spendChannels:['Meta'],subscriptionsEnabled:false,recurringLabel:'Loop',minSessions:100,minOpportunity:5,maxActions:6,reviewTime:'09:00',reviewTimezone:'America/New_York',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-07',to:'2026-10-07',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'overview'};
function workspace(view='overview'):Workspace{
 const selected={...filters,view},rows:Observation[]=[{date:selected.to,dataset:'overview',metric:'revenue',value:100,definition:'net_sales',population:'orders',dimensions:{},currency:'USD',sourceId:'beam-sales',retrievedAt:'2026-10-08T12:00:00Z',coverageThrough:null,quality:'complete'},{date:selected.to,dataset:'revenue',metric:'revenue',value:100,definition:'net_sales',population:'orders',dimensions:{stream:'Online Store'},currency:'USD',sourceId:'beam-sales',retrievedAt:'2026-10-08T12:00:00Z',coverageThrough:null,quality:'complete'}];
 return {scope:{organizationId:'agency',actorId:'analyst',role:'analyst',permittedClientIds:['beam']},filters:selected,focusedClientId:'beam',clients:[{...workspacePresentation(queryClient(client,rows,[],selected,{preparedDatasets:workspaceDatasets(view,'beam')}),selected),reviews:[],findings:[],note:{body:'',version:0},scheduleState:{active:false,waitingForSources:true,lastJob:undefined}}],jobs:[],reportingDateNote:null,loadedAt:new Date().toISOString()};
}
it('reuses the exact saved Beam frame without requiring subscription datasets',()=>{
 const initial=workspace(),cache=new WorkspaceCache(initial),cached=cache.read(initial.filters,Date.parse(initial.loadedAt)+1000,'beam');
 expect(cached).not.toBeNull();expect(cached?.workspace.clients[0]).toBe(initial.clients[0]);expect(cached?.stale).toBe(false);
 expect(selectWorkspaceView(initial,'revenue','beam')?.clients[0].viewMetrics.revenue).toBe(100);
 expect(initial.clients[0].preparedDatasets).not.toContain('subscriptions');
});
it('filters subscription warming for Beam even when a caller supplies that view explicitly',async()=>{
 const initial=workspace(),cache=new WorkspaceCache(initial),load=vi.fn(async(params:URLSearchParams)=>workspace(params.get('view')!)),preloader=new WorkspacePreloader(cache,load);
 preloader.preload(initial,new URLSearchParams({...initial.filters,clientId:'beam'}),'beam',['subscriptions','products']);
 for(let index=0;index<12;index++)await Promise.resolve();
 expect(load.mock.calls.map(([params])=>params.get('view'))).toEqual(['products']);preloader.cancel();
});
