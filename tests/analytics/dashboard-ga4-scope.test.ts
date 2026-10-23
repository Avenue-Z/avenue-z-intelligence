import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {Dashboard,dashboardClientTabs,selectBeamGa4Workspace} from '../../components/analytics/dashboard';
import {WorkspaceCache} from '../../lib/analytics/workspace-cache';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import {workspaceDatasets} from '../../lib/analytics/workspace-datasets';
import type {Workspace} from '../../lib/server/workspace';
import type {Client,QueryFilters} from '../../lib/analytics/contracts';

const client:Client={id:'beam',name:'Beam',slug:'beam',timezone:'America/New_York',currency:'USD',color:'#4368c4',version:1,config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'net_sales',spendChannels:[],recurringLabel:'Loop',minSessions:100,minOpportunity:5,maxActions:6,reviewTime:'09:00',reviewTimezone:'America/New_York',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-16',to:'2026-10-16',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'overview'};
function workspace():Workspace{
 return {scope:{organizationId:'agency',actorId:'analyst',role:'analyst',permittedClientIds:['beam']},filters,focusedClientId:'beam',clients:[{...workspacePresentation(queryClient(client,[],[],filters,{preparedDatasets:workspaceDatasets('overview','beam')}),filters),findings:[],reviews:[],note:{body:'',version:0},scheduleState:{active:false,waitingForSources:true,lastJob:undefined}}],jobs:[],reportingDateNote:null,loadedAt:'2026-10-16T20:00:00Z'};
}
const params=(changes:Record<string,string>={})=>new URLSearchParams({...filters,view:'ga4',...changes});

it('applies every GA4 scope filter immediately while reusing only the authorized Beam shell',()=>{
 const initial=workspace(),next=selectBeamGa4Workspace(initial,params({from:'2026-10-10',to:'2026-10-15',compare:'weekday',mode:'partial',market:'US',source:'google',device:'mobile',page:'/sleep'}),'beam')!;
 expect(next.filters).toMatchObject({view:'ga4',from:'2026-10-10',to:'2026-10-15',compare:'weekday',mode:'partial',market:'US',source:'google',device:'mobile',page:'/sleep'});
 expect(next.clients).toBe(initial.clients);expect(next.scope).toBe(initial.scope);expect(next.loadedAt).toBe(initial.loadedAt);
 expect(initial.filters).toEqual(filters);
});

it('preserves explicit custom comparison dates even when the original shell had none',()=>{
 const next=selectBeamGa4Workspace(workspace(),params({compare:'custom',compareFrom:'2026-09-01',compareTo:'2026-09-01'}),'beam')!;
 expect(next.filters).toMatchObject({compare:'custom',compareFrom:'2026-09-01',compareTo:'2026-09-01'});
});

it('never reuses stale legacy records as cached evidence for changed GA4 dates or cohorts on exit',()=>{
 const initial=workspace(),cache=new WorkspaceCache(initial),next=selectBeamGa4Workspace(initial,params({from:'2026-10-10',to:'2026-10-10',market:'CA'}),'beam')!;
 expect(cache.read({...next.filters,view:'markets'})).toBeNull();
 const original=cache.read(initial.filters,Date.parse('2026-10-16T20:00:10Z'))!;
 expect(original.workspace.filters).toEqual(filters);expect(original.workspace.clients[0]).toBe(initial.clients[0]);expect(original.stale).toBe(false);
});

it('rolls a live GA4 shell at New York midnight without a legacy observation request or comparison reset',()=>{
 const initial=workspace(),live=params({period:'today',mode:'partial',compare:'weekday'});
 expect(selectBeamGa4Workspace(initial,live,'beam',new Date('2026-10-17T03:59:00Z'))!.filters).toMatchObject({from:'2026-10-16',to:'2026-10-16',period:'today',compare:'weekday'});
 expect(selectBeamGa4Workspace(initial,live,'beam',new Date('2026-10-17T04:01:00Z'))!.filters).toMatchObject({from:'2026-10-17',to:'2026-10-17',period:'today',mode:'partial',compare:'weekday'});
 expect(initial.filters).toEqual(filters);
});

it('refuses the immediate path for other clients, legacy views, missing records or withdrawn access',()=>{
 const initial=workspace();
 expect(selectBeamGa4Workspace(initial,params(),'kind-patches')).toBeNull();
 expect(selectBeamGa4Workspace(initial,params({view:'revenue'}),'beam')).toBeNull();
 expect(selectBeamGa4Workspace({...initial,clients:[]},params(),'beam')).toBeNull();
 expect(selectBeamGa4Workspace({...initial,scope:{...initial.scope,permittedClientIds:[]}},params(),'beam')).toBeNull();
 expect(selectBeamGa4Workspace({...initial,focusedClientId:'kind-patches'},params(),'beam')).toBeNull();
});

it('keeps Web analytics available in Beam pending navigation without changing Kind Patches tabs',()=>{
 expect(dashboardClientTabs('beam')).toContainEqual(['ga4','Web analytics']);
 expect(dashboardClientTabs('kind-patches')).not.toContainEqual(['ga4','Web analytics']);
});

it('hides disabled subscription tabs consistently while keeping KP subscriptions enabled by default',()=>{
 expect(dashboardClientTabs('beam',false)).not.toContainEqual(['subscriptions','Subscriptions']);
 expect(dashboardClientTabs('beam',false)).toContainEqual(['ga4','Web analytics']);
 expect(dashboardClientTabs('kind-patches')).toContainEqual(['subscriptions','Subscriptions']);
 expect(dashboardClientTabs('kind-patches',false)).not.toContainEqual(['subscriptions','Subscriptions']);
});

it('does not describe Beam source observations as awaiting live feeds in a reporting-date fallback',()=>{
 const initial={...workspace(),reportingDateNote:'Latest available closed reporting day · 2026-10-15'},html=renderToStaticMarkup(createElement(Dashboard,{initial,clientId:'beam',userName:'Analyst'}));
 expect(html).toContain('Latest available closed reporting day');expect(html).not.toContain('live feeds are pending');
});

it('reuses only an authorized Autobrush shell and rolls live dates on the GA4 LA clock across midnight and DST',()=>{
 const base=workspace(),auto={...client,id:'autobrush',name:'Autobrush'},initial={...base,scope:{...base.scope,permittedClientIds:['autobrush']},focusedClientId:'autobrush',clients:[{...base.clients[0],client:auto}]};
 for(const instant of ['2026-10-22T05:30:00Z','2026-11-02T07:30:00Z']){const expected=instant.startsWith('2026-10')?'2026-10-21':'2026-11-01';expect(selectBeamGa4Workspace(initial,params({period:'today'}),'autobrush',new Date(instant))!.filters).toMatchObject({from:expected,to:expected,mode:'partial'});}
 expect(selectBeamGa4Workspace(initial,params(),'beam')).toBeNull();expect(selectBeamGa4Workspace({...initial,scope:{...initial.scope,permittedClientIds:['beam']}},params(),'autobrush')).toBeNull();expect(selectBeamGa4Workspace({...initial,focusedClientId:'beam'},params(),'autobrush')).toBeNull();
 expect(dashboardClientTabs('autobrush',false)).toContainEqual(['ga4','Web analytics']);
 const html=renderToStaticMarkup(createElement(Dashboard,{initial:{...initial,filters:{...filters,view:'ga4'}},clientId:'autobrush',userName:'Analyst'}));expect(html).toContain('GA4 reporting time');expect(html).toContain('America/Los_Angeles');expect(html).not.toContain('Store-local time');
});

it.each(['beam','autobrush'])('omits the generic zero-connections count in the %s GA4 shell while retaining it for native views',clientId=>{
 const base=workspace(),initial={...base,focusedClientId:clientId,scope:{...base.scope,permittedClientIds:[clientId]},clients:[{...base.clients[0],client:{...base.clients[0].client,id:clientId,name:clientId==='beam'?'Beam':'Autobrush'}}]},ga4=renderToStaticMarkup(createElement(Dashboard,{initial:{...initial,filters:{...initial.filters,view:'ga4'}},clientId,userName:'Analyst'})),native=renderToStaticMarkup(createElement(Dashboard,{initial,clientId,userName:'Analyst'}));expect(ga4).not.toContain('class="feed-state"');expect(ga4).not.toContain('0/1 connected clients');expect(ga4).toContain('Data &amp; settings');expect(native).toContain('class="feed-state"');
});

it('uses the dedicated authorized Attribution shell and provider clock without native counts or hourly controls',()=>{const base=workspace(),auto={...client,id:'autobrush',name:'Autobrush'},initial={...base,scope:{...base.scope,permittedClientIds:['autobrush']},focusedClientId:'autobrush',clients:[{...base.clients[0],client:auto}]},next=selectBeamGa4Workspace(initial,new URLSearchParams({view:'northbeam',period:'today',compare:'weekday'}),'autobrush',new Date('2026-10-22T03:30:00Z'))!;expect(next.filters).toMatchObject({view:'northbeam',from:'2026-10-21',to:'2026-10-21',period:'today',compare:'weekday'});expect(next.clients).toBe(initial.clients);expect(selectBeamGa4Workspace({...initial,scope:{...initial.scope,permittedClientIds:['beam']}},new URLSearchParams({view:'northbeam'}),'autobrush')).toBeNull();const html=renderToStaticMarkup(createElement(Dashboard,{initial:next,clientId:'autobrush',userName:'Analyst'}));expect(html).toContain('Northbeam reporting time');expect(html).toContain('America/Detroit');expect(html).toContain('Loading attribution');expect(html).not.toContain('aria-label="Time mode"');expect(html).not.toContain('class="feed-state"');expect(html).toContain('Data &amp; settings');expect(html).not.toContain('Hourly feeds through');});
