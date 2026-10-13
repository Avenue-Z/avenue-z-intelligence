import {afterEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({page:null as string|null}));
vi.mock('react',async original=>{const actual=await original<typeof import('react')>();return {...actual,useState:(initial:unknown)=>state.page&&initial===null?[state.page,()=>{}]:actual.useState(initial)};});
vi.mock('../../components/ui/sheet',async()=>{const {createElement}=await import('react');type Children={children?:import('react').ReactNode};const wrap=({children}:Children)=>createElement('div',null,children);return {Sheet:({open,children}:Children&{open:boolean})=>open?children:null,SheetContent:({children}:Children)=>createElement('aside',{'aria-label':'Landing-page drawer'},children),SheetHeader:wrap,SheetTitle:wrap,SheetDescription:wrap};});
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
afterEach(()=>{state.page=null;});
it('renders traffic statistics, all-page search and local chart controls from compact aggregates alone',()=>{
 const a=workspacePresentation(queryClient(client,rows,[],filters,{preparedDatasets:['overview','traffic','funnels']}),filters),record={...a,views:{},details:[],findings:[],reviews:[],note:{body:'',version:0}},html=renderToStaticMarkup(createElement(TrafficWorkspace,{record,filters,update:()=>{}}));
 expect(html).toContain('100');expect(html).toContain('3.00%');expect(html).toContain('/pages/dream');expect(record.trafficExplorer?.current.breakdowns.traffic_channel.groups[0].label).toBe('Meta · UTM');expect(html).toContain('UTM medium');expect(html).toContain('Search landing pages');expect(html).toContain('Explore funnel');
});
it('states the full ranked population when only bounded chart segments are transferred',()=>{
 const group=compactTrafficExplorer(detailRows(rows),[],'traffic').current.pages[0],html=renderToStaticMarkup(createElement(ExplorerRanking,{groups:[group],metric:'sessions',currency:'USD',title:'Traffic mix',description:'Dated',top:10,groupCount:900,omitted:899}));
 expect(html).toContain('of 900');expect(html).toContain('899 lower-ranked segments omitted');expect(html).not.toContain('of 1 segments');
});
it('shows only the selected page current and comparison funnel while its deep detail is loading',()=>{
 state.page='/pages/dream';
 const pageRows=(date:string,page:string,counts:Record<string,number>)=>rows.map(row=>({...row,date,value:counts[row.metric],dimensions:{...row.dimensions,page}}));
 const current=pageRows(filters.to,state.page,{sessions:4065,converting_sessions:174,atc_sessions:600,checkouts:300,completed_checkouts:160}),previous=pageRows('2026-10-10',state.page,{sessions:2000,converting_sessions:60,atc_sessions:200,checkouts:100,completed_checkouts:50}),other=pageRows(filters.to,'/other',{sessions:99999,converting_sessions:9999,atc_sessions:20000,checkouts:15000,completed_checkouts:9000});
 const a=workspacePresentation(queryClient(client,[...current,...previous,...other],[],filters,{preparedDatasets:['traffic','funnels']}),filters),record={...a,views:{},details:[],findings:[],reviews:[],note:{body:'',version:0}},html=renderToStaticMarkup(createElement(TrafficWorkspace,{record,filters,update:()=>{}})),drawer=html.match(/<aside[^>]*>([\s\S]*?)<\/aside>/)?.[1]??'';
 expect(drawer).toContain('4,065');expect(drawer).toContain('174');expect(drawer).toContain('4.28%');expect(drawer).toContain('2,000');expect(drawer).toContain('60');expect(drawer).toContain('2026-10-10');
 for(const count of [600,300,160,200,100,50])expect(drawer).toContain(`<strong>${count}</strong>`);
 expect(drawer).toContain('Landing-page funnel');expect(drawer).toContain('Comparison landing-page funnel');expect(drawer).toContain('Loading this page');
 expect(drawer).not.toContain('99,999');expect(drawer).not.toContain('104,064');expect(drawer).not.toContain('This page over time');expect(drawer).not.toContain('Segment funnel detail');
});
it('keeps a missing selected-page comparison and an unqualified current rate unavailable',()=>{
 state.page='/pages/dream';
 const a=workspacePresentation(queryClient(client,[...rows,...rows.map(row=>({...row,date:'2026-10-10',dimensions:{...row.dimensions,page:'/other'}}))],[],filters,{preparedDatasets:['traffic','funnels']}),filters);
 a.trafficExplorer!.current.pages[0].summary.cvr=null;
 const record={...a,views:{},details:[],findings:[],reviews:[],note:{body:'',version:0}},html=renderToStaticMarkup(createElement(TrafficWorkspace,{record,filters,update:()=>{}})),drawer=html.match(/<aside[^>]*>([\s\S]*?)<\/aside>/)?.[1]??'';
 expect(drawer).toContain('100');expect(drawer).toContain('Comparison landing-page funnel');expect(drawer).not.toContain('<strong>3.00%</strong>');expect(drawer).not.toContain('<strong>0.00%</strong>');expect(drawer).toContain('Comparison: —');
});
