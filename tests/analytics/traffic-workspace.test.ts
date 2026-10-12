import {expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TrafficWorkspace,ExplorerRanking} from '../../components/analytics/traffic-workspace';
import {compactTrafficExplorer} from '../../lib/analytics/traffic-presentation';
import {detailRows,queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import type {Observation,QueryFilters} from '../../lib/analytics/contracts';
const filters:QueryFilters={from:'2026-10-11',to:'2026-10-11',mode:'closed',compare:'previous',view:'traffic',market:'',stream:'',source:'',device:'',page:''};
const client={id:'a',name:'Client A',version:1,timezone:'UTC',currency:'USD',config:{spendChannels:[],revenueDefinition:'web',incidents:[],benchmarkMarket:'US',minSessions:100,minOpportunity:5,maxActions:6}} as any;
const rows=Object.entries({sessions:100,converting_sessions:3,atc_sessions:10,checkouts:5,completed_checkouts:2}).map(([metric,value])=>({date:filters.to,metric,value,dataset:'traffic',definition:'human_sessions',population:'human_sessions',dimensions:{page:'/pages/dream',utm_source:'meta',source:'social',device:'mobile'},sourceId:'s',retrievedAt:'2026-10-12T00:00:00Z',coverageThrough:'2026-10-12T00:00:00Z',currency:null,quality:'complete'} as Observation));
it('renders traffic statistics, all-page search and local chart controls from compact aggregates alone',()=>{
 const a=workspacePresentation(queryClient(client,rows,[],filters,{preparedDatasets:['overview','traffic','funnels']}),filters),record={...a,views:{},details:[],findings:[],reviews:[],note:{body:'',version:0}},html=renderToStaticMarkup(createElement(TrafficWorkspace,{record,filters,update:()=>{}}));
 expect(html).toContain('100');expect(html).toContain('3.00%');expect(html).toContain('/pages/dream');expect(record.trafficExplorer?.current.breakdowns.traffic_channel.groups[0].label).toBe('Meta · UTM');expect(html).toContain('UTM medium');expect(html).toContain('Search landing pages');expect(html).toContain('Explore funnel');
});
it('states the full ranked population when only bounded chart segments are transferred',()=>{
 const group=compactTrafficExplorer(detailRows(rows),[],'traffic').current.pages[0],html=renderToStaticMarkup(createElement(ExplorerRanking,{groups:[group],metric:'sessions',currency:'USD',title:'Traffic mix',description:'Dated',top:10,groupCount:900,omitted:899}));
 expect(html).toContain('of 900');expect(html).toContain('899 lower-ranked segments omitted');expect(html).not.toContain('of 1 segments');
});
