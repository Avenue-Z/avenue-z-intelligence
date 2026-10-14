import {afterEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({page:null as string|null,table:false,drill:null as TrafficPageState|null}));
vi.mock('react',async original=>{const actual=await original<typeof import('react')>();return {...actual,useState:(initial:unknown)=>state.page&&initial===null?[state.page,()=>{}]:state.drill&&initial&&typeof initial==='object'&&'loading' in initial?[state.drill,()=>{}]:state.table&&initial===false?[true,()=>{}]:actual.useState(initial)};});
vi.mock('../../components/ui/sheet',async()=>{const {createElement}=await import('react');type Children={children?:import('react').ReactNode};const wrap=({children}:Children)=>createElement('div',null,children);return {Sheet:({open,children}:Children&{open:boolean})=>open?children:null,SheetContent:({children}:Children)=>createElement('aside',{'aria-label':'Landing-page drawer'},children),SheetHeader:wrap,SheetTitle:wrap,SheetDescription:wrap};});
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TrafficWorkspace,ExplorerRanking,LandingPageMarkets,explorerTrendData} from '../../components/analytics/traffic-workspace';
import {compactTrafficExplorer} from '../../lib/analytics/traffic-presentation';
import {detailRows,queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import type {Observation,QueryFilters} from '../../lib/analytics/contracts';
import {trafficPageKey,trafficRecordVersion,type TrafficPageDetail,type TrafficPageState} from '../../lib/analytics/traffic-page-loader';
const filters:QueryFilters={from:'2026-10-11',to:'2026-10-11',mode:'closed',compare:'previous',view:'traffic',market:'',stream:'',source:'',device:'',page:''};
const client={id:'a',name:'Client A',version:1,timezone:'UTC',currency:'USD',config:{spendChannels:[],revenueDefinition:'web',incidents:[],benchmarkMarket:'US',minSessions:100,minOpportunity:5,maxActions:6}} as any;
const rows=Object.entries({sessions:100,converting_sessions:3,atc_sessions:10,checkouts:5,completed_checkouts:2}).map(([metric,value])=>({date:filters.to,metric,value,dataset:'traffic',definition:'human_sessions',population:'human_sessions',dimensions:{page:'/pages/dream',utm_source:'meta',source:'social',device:'mobile'},sourceId:'s',retrievedAt:'2026-10-12T00:00:00Z',coverageThrough:'2026-10-12T00:00:00Z',currency:null,quality:'complete'} as Observation));
afterEach(()=>{state.page=null;state.table=false;state.drill=null;});
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
 for(const count of [600,300,160])expect(drawer).toContain(`<strong>${count}</strong>`);
 for(const count of [200,100,50])expect(drawer).toContain(`Yesterday: ${count}`);
 expect(drawer).toContain('Landing-page funnel');expect(drawer).not.toContain('Comparison landing-page funnel');expect(drawer).toContain('About these numbers');expect(drawer).toContain('Loading this page');
 expect(drawer).not.toContain('99,999');expect(drawer).not.toContain('104,064');expect(drawer).not.toContain('This page over time');expect(drawer).not.toContain('Segment funnel detail');
});
it('keeps a missing selected-page comparison and an unqualified current rate unavailable',()=>{
 state.page='/pages/dream';
 const a=workspacePresentation(queryClient(client,[...rows,...rows.map(row=>({...row,date:'2026-10-10',dimensions:{...row.dimensions,page:'/other'}}))],[],filters,{preparedDatasets:['traffic','funnels']}),filters);
 a.trafficExplorer!.current.pages[0].summary.cvr=null;
 const record={...a,views:{},details:[],findings:[],reviews:[],note:{body:'',version:0}},html=renderToStaticMarkup(createElement(TrafficWorkspace,{record,filters,update:()=>{}})),drawer=html.match(/<aside[^>]*>([\s\S]*?)<\/aside>/)?.[1]??'';
 expect(drawer).toContain('100');expect(drawer).not.toContain('Comparison landing-page funnel');expect(drawer).not.toContain('<strong>3.00%</strong>');expect(drawer).not.toContain('<strong>0.00%</strong>');expect(drawer).toContain('Yesterday: —');
});

it('defaults traffic mix to qualified conversion rate grouped by explicit UTM source',()=>{
 const a=workspacePresentation(queryClient(client,rows,[],filters,{preparedDatasets:['traffic','funnels']}),filters),record={...a,views:{},details:[],findings:[],reviews:[],note:{body:'',version:0}},html=renderToStaticMarkup(createElement(TrafficWorkspace,{record,filters,update:()=>{}}));
 expect(html).toContain('Conversion rate by UTM source');
 expect(html).toContain('<option value="utm_source" selected="">UTM source</option>');
 expect(html).toContain('<option value="cvr" selected="">Session conversion rate</option>');
});
it('compares landing-page metrics against yesterday at the same confirmed hour rather than a closed day',()=>{
 const partialFilters={...filters,mode:'partial' as const},counts=(date:string,startHour:string,endHour:string,values:Record<string,number>)=>rows.map(row=>({...row,date,start:`${date}T${startHour}:00:00Z`,end:`${date}T${endHour}:00:00Z`,value:values[row.metric],coverageThrough:`${date}T23:00:00Z`}));
 const current=counts(filters.to,'00','12',{sessions:100,converting_sessions:5,atc_sessions:20,checkouts:10,completed_checkouts:5}),currentLater=counts(filters.to,'12','23',{sessions:900,converting_sessions:90,atc_sessions:500,checkouts:400,completed_checkouts:300}),prior=counts('2026-10-10','00','12',{sessions:50,converting_sessions:1,atc_sessions:10,checkouts:5,completed_checkouts:2}),priorLater=counts('2026-10-10','12','23',{sessions:950,converting_sessions:400,atc_sessions:600,checkouts:500,completed_checkouts:400});
 const connection={id:'s',clientId:'a',name:'Traffic',provider:'kind-shopify-traffic' as const,endpoint:'',secretRef:'',pollMinutes:60,enabled:true,lastSuccess:'2026-10-11T12:30:00Z',coverageThrough:'2026-10-11T12:30:00Z',error:null,version:1};
 const a=workspacePresentation(queryClient(client,[...current,...currentLater,...prior,...priorLater],[connection],partialFilters,{preparedDatasets:['traffic','funnels']}),partialFilters),record={...a,views:{},details:[],findings:[],reviews:[],note:{body:'',version:0}},html=renderToStaticMarkup(createElement(TrafficWorkspace,{record,filters:partialFilters,update:()=>{}}));
 expect(a.cutoff).toBe('2026-10-11T12:00:00Z');expect(a.trafficExplorer!.current.pages[0].metrics.sessions).toBe(100);expect(a.trafficExplorer!.comparison.pages[0].metrics.sessions).toBe(50);
 expect(html).toContain('Yesterday: 50');expect(html).toContain('+100.0%');expect(html).toContain('Yesterday: 2.00%');expect(html).toContain('+3.00 pp');expect(html).not.toContain('Yesterday: 1,000');
});
it('keeps a manually selected weekday baseline correctly named in landing-page rows',()=>{
 const selected={...filters,compare:'weekday' as const},a=workspacePresentation(queryClient(client,[...rows,...rows.map(row=>({...row,date:'2026-10-04'}))],[],selected,{preparedDatasets:['traffic','funnels']}),selected),record={...a,views:{},details:[],findings:[],reviews:[],note:{body:'',version:0}},html=renderToStaticMarkup(createElement(TrafficWorkspace,{record,filters:selected,update:()=>{}}));
 expect(html).toContain('Comparison: 100');expect(html).not.toContain('Yesterday:');
});
it('renders independent landing-page market cohorts and weighted conversion changes',()=>{
 const marketRows=(date:string,market:string,source:string,sessions:number,converting_sessions:number)=>rows.map(row=>({...row,date,value:({sessions,converting_sessions,atc_sessions:0,checkouts:0,completed_checkouts:0} as Record<string,number>)[row.metric],dimensions:{...row.dimensions,market,source,utm_source:source}}));
 const current=compactTrafficExplorer(detailRows([...marketRows(filters.to,'US','meta',100,10),...marketRows(filters.to,'US','tiktok',900,18),...marketRows(filters.to,'CA','meta',600,30)]),detailRows(marketRows('2026-10-10','US','meta',1000,20)),'traffic');
 const html=renderToStaticMarkup(createElement(LandingPageMarkets,{current:current.current.breakdowns.market.groups,previous:current.comparison.breakdowns.market.groups,currency:'USD',comparisonLabel:'Yesterday'}));
 expect(html).toContain('Landing-page markets');expect(html).toContain('>US</td>');expect(html).toContain('>CA</td>');expect(html).toContain('2.80%');expect(html).toContain('+0.80 pp');expect(html).toContain('5.00%');expect(html).toContain('Yesterday: —');
});
it('shows weighted CVR ranking changes against the matching source without manufacturing missing baselines',()=>{
 state.table=true;
 const sourceRows=(date:string,source:string,sessions:number,converted:number)=>rows.map(row=>({...row,date,value:({sessions,converting_sessions:converted,atc_sessions:0,checkouts:0,completed_checkouts:0} as Record<string,number>)[row.metric],dimensions:{...row.dimensions,utm_source:source}}));
 const explorer=compactTrafficExplorer(detailRows([...sourceRows(filters.to,'meta',100,5),...sourceRows(filters.to,'tiktok',200,4)]),detailRows(sourceRows('2026-10-10','meta',500,10)),'traffic');
 const html=renderToStaticMarkup(createElement(ExplorerRanking,{groups:explorer.current.breakdowns.utm_source.groups,previousGroups:explorer.comparison.breakdowns.utm_source.groups,metric:'cvr',currency:'USD',title:'Conversion rate by UTM source',description:'',comparisonLabel:'Yesterday'}));
 expect(html).toContain('Yesterday: 2.00%');expect(html).toContain('+3.00 pp');expect(html).toContain('data-tone="favorable"');expect(html).toContain('Yesterday: —');expect(html).not.toContain('Yesterday: 0.00%');
});
it.each(['cvr','atc','checkoutCompletion'] as const)('ranks %s segments by traffic volume so a single perfect session cannot displace the major source',metric=>{
 state.table=true;
 const sourceRows=(source:string,sessions:number,converted:number,cart:number,checkout:number,complete:number)=>rows.map(row=>({...row,value:({sessions,converting_sessions:converted,atc_sessions:cart,checkouts:checkout,completed_checkouts:complete} as Record<string,number>)[row.metric],dimensions:{...row.dimensions,utm_source:source}}));
 const groups=compactTrafficExplorer(detailRows([...sourceRows('meta',10000,400,500,200,180),...sourceRows('one-session-campaign',1,1,1,1,1)]),[],'traffic').current.breakdowns.utm_source.groups;
 const html=renderToStaticMarkup(createElement(ExplorerRanking,{groups,metric,currency:'USD',title:'Source performance',description:'',top:1}));
 expect(html).toContain('>meta</td>');expect(html).toContain('10,000');expect(html).toContain('Top 1 by sessions');expect(html).not.toContain('one-session-campaign');
});
it('shows the five largest landing-page markets while retaining the complete market breakdown behind Show all',()=>{
 const base=compactTrafficExplorer(detailRows(rows),[],'traffic').current.pages[0],groups=Array.from({length:6},(_,index)=>({...base,key:`market-${index}`,label:`Market ${index}`,metrics:{...base.metrics,sessions:600-index*100}}));
 const render=()=>renderToStaticMarkup(createElement(LandingPageMarkets,{current:groups,previous:[],currency:'USD',comparisonLabel:'Yesterday'}));
 const compact=render();expect(compact).toContain('Show all 6 markets');expect(compact).toContain('>Market 0</td>');expect(compact).not.toContain('>Market 5</td>');
 state.table=true;const expanded=render();expect(expanded).toContain('>Market 5</td>');expect(expanded).toContain('Show top 5');
});
it('omits duplicate one-day page trend values but retains a genuine multi-day captured trend',()=>{
 state.page='/pages/dream';
 const a=workspacePresentation(queryClient(client,[...rows,...rows.map(row=>({...row,date:'2026-10-10'}))],[],filters,{preparedDatasets:['traffic','funnels']}),filters),record={...a,views:{},details:[],findings:[],reviews:[],note:{body:'',version:0}};
 const detail:TrafficPageDetail={explorer:a.trafficExplorer!,cutoff:null,warnings:[],comparison:a.comparison,currentSeries:a.datasetSeries.traffic,comparisonSeries:a.comparisonDatasetSeries.traffic,timezone:'UTC',currency:'USD',loadedAt:null};
 state.drill={key:trafficPageKey(undefined,client.id,filters,state.page,trafficRecordVersion(record,'traffic')),data:detail,loading:false,error:''};
 let selected=filters;const render=()=>renderToStaticMarkup(createElement(TrafficWorkspace,{record,filters:selected,update:()=>{}}));
 expect(render()).not.toContain('This page over time');
 detail.currentSeries.push({...detail.currentSeries[0],date:'2026-10-09'});selected={...filters,from:'2026-10-09'};state.drill.key=trafficPageKey(undefined,client.id,selected,state.page,trafficRecordVersion(record,'traffic'));expect(render()).toContain('This page over time');
});
const measurement={id:'measurement',title:'Bounce and ATC measurement change',start:'2026-09-22',metrics:['atc','bounce'],note:'Compare orders and CVR across this change; bounce and ATC are not comparable.'};
function measurementRecord(compare:'thirtyDays'|'previous'|'custom'){
 const selected:QueryFilters={...filters,from:'2026-10-14',to:'2026-10-14',mode:'partial',compare,...compare==='custom'?{compareFrom:'2026-09-14',compareTo:'2026-09-14'}:{}};
 const prior=compare==='previous'?'2026-10-13':'2026-09-14',incidentClient={...client,config:{...client.config,incidents:[measurement]}};
 const facts=[prior,selected.to].flatMap(date=>Object.entries({sessions:1000,converting_sessions:date===selected.to?30:20,atc_sessions:date===selected.to?200:100,checkouts:20,completed_checkouts:10}).map(([metric,value])=>({...rows[0],date,metric,value,dimensions:{page:'/pages/dream',market:'US',utm_source:'meta',source:'social',device:'mobile'},start:`${date}T00:00:00Z`,end:`${date}T01:00:00Z`,coverageThrough:'2026-10-14T01:00:00Z'})));
 const a=workspacePresentation(queryClient(incidentClient,facts,[{id:'s',provider:'gateway',enabled:true,coverageThrough:'2026-10-14T01:00:00Z'}] as any,selected,{preparedDatasets:['traffic','funnels']}),selected);
 return {selected,record:{...a,findings:[],reviews:[],note:{body:'',version:0}}};
}
it.each(['thirtyDays','custom'] as const)('suppresses cross-measurement ATC comparisons for %s while retaining current values and CVR comparisons',compare=>{
 const {record,selected}=measurementRecord(compare),before=JSON.stringify(record),html=renderToStaticMarkup(createElement(TrafficWorkspace,{record,filters:selected,update:()=>{}}));
 const atc=html.match(/ADD-TO-CART RATE[\s\S]*?<\/div><\/div>/)?.[0]??'',cells=[...html.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(match=>match[1]);
 expect(atc).toContain('20.00%');expect(atc).not.toContain('10.00%');expect(atc).not.toContain('+10.00 pp');
 expect(cells[3]).toContain('>200</strong>');expect(cells[3]).not.toContain('+100.0%');
 expect(cells[2]).toContain('+1.00 pp');expect(html).toContain(measurement.note);expect(JSON.stringify(record)).toBe(before);
});
it('retains clean day-over-day ATC comparisons after the configured measurement break',()=>{
 const {record,selected}=measurementRecord('previous'),html=renderToStaticMarkup(createElement(TrafficWorkspace,{record,filters:selected,update:()=>{}}));
 const atc=html.match(/ADD-TO-CART RATE[\s\S]*?<\/div><\/div>/)?.[0]??'';
 expect(atc).toContain('20.00%');expect(atc).toContain('10.00%');expect(atc).toContain('+10.00 pp');expect(atc).toContain('data-tone="favorable"');
});
it('does not reinstate cross-measurement ATC comparisons inside a loaded landing-page drawer',()=>{
 const {record,selected}=measurementRecord('thirtyDays');state.page='/pages/dream';
 const detail:TrafficPageDetail={explorer:record.trafficExplorer!,cutoff:record.cutoff,warnings:[],comparison:record.comparison,currentSeries:record.datasetSeries.traffic,comparisonSeries:record.comparisonDatasetSeries.traffic,timezone:'UTC',currency:'USD',loadedAt:null};
 state.drill={key:trafficPageKey(undefined,client.id,selected,state.page,trafficRecordVersion(record,'traffic')),data:detail,loading:false,error:''};
 const html=renderToStaticMarkup(createElement(TrafficWorkspace,{record,filters:selected,update:()=>{}})),drawer=html.match(/<aside aria-label="Landing-page drawer"[\s\S]*?<\/aside>/)?.[0]??'';
 expect(drawer).toContain('>200</strong>');expect(drawer).not.toContain('Cart sessions up: +100.0%');expect(drawer).not.toContain('Add-to-cart rate up: +10.00 pp');
 expect(drawer).toContain('Session conversion rate up: +1.00 pp');expect(drawer).toContain(measurement.note);
});
it('omits only cross-measurement ATC prior chart points while keeping a clean CVR comparison',()=>{
 const {record,selected}=measurementRecord('thirtyDays'),common={current:record.datasetSeries.traffic,previous:record.comparisonDatasetSeries.traffic,filters:selected,comparisonFrom:record.comparison.from,range:'selected' as const,incidents:[measurement]};
 const atc=explorerTrendData({...common,metric:'atc'});expect(atc.points[0].current).toBe(.2);expect(atc.points[0].previous).toBeNull();
 const cvr=explorerTrendData({...common,metric:'cvr'});expect(cvr.points[0].current).toBe(.03);expect(cvr.points[0].previous).toBe(.02);
});
it('keeps clean ATC trend pairs on either side of the change while omitting only the crossing pairs',()=>{
 const series=(dates:string[],atc:number)=>dates.map(date=>({date,metrics:{sessions:1000,atc_sessions:atc*1000},summary:{atc}}));
 const selected={...filters,from:'2026-09-21',to:'2026-09-24',compare:'custom' as const,compareFrom:'2026-09-20',compareTo:'2026-09-23'};
 const result=explorerTrendData({current:series(['2026-09-21','2026-09-22','2026-09-23','2026-09-24'],.2),previous:series(['2026-09-20','2026-09-21','2026-09-22','2026-09-23'],.1),filters:selected,comparisonFrom:'2026-09-20',metric:'atc',range:'selected',incidents:[measurement]});
 expect(result.points.map(point=>point.current)).toEqual([.2,.2,.2,.2]);
 expect(result.points.map(point=>point.previous)).toEqual([.1,null,null,.1]);
});
