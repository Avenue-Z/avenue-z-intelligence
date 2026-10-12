import {expect,it} from 'vitest';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';

const client:Client={id:'kind-patches',name:'Kind Patches',slug:'kind-patches',timezone:'UTC',currency:'USD',color:'#2549c5',version:1,config:{markets:['US','DE'],benchmarkMarket:'US',revenueDefinition:'web',spendChannels:[],recurringLabel:'Subscriptions',minSessions:100,minOpportunity:5,maxActions:6,reviewTime:'09:00',reviewTimezone:'UTC',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-07',to:'2026-10-07',compare:'previous',market:'US',stream:'',source:'',device:'',page:'',mode:'closed',view:'overview'};
function row(dataset:string,metric:string,value:number,date='2026-10-07',market='US'):Observation{return {date,dataset,metric,value,dimensions:{market,...dataset==='funnels'?{page:'/landing'}:{channel:'Web'}},definition:metric,population:dataset==='funnels'?'human_sessions':'web_orders',currency:metric==='revenue'?'USD':null,sourceId:'source',retrievedAt:'2026-10-08T00:00:00Z',coverageThrough:'2026-10-08T00:00:00Z',quality:'complete'};}
const observations=[row('overview','revenue',100),row('revenue','revenue',100),row('revenue','orders',5),row('products','revenue',50),row('products','orders',5),row('revenue','revenue',700,'2026-10-07','DE'),row('revenue','orders',10,'2026-10-07','DE'),row('revenue','revenue',300,'2026-10-08'),row('funnels','sessions',1000),row('funnels','converting_sessions',10),row('funnels','sessions',1000,'2026-10-06'),row('funnels','converting_sessions',30,'2026-10-06')];

it('prepares exact-selection tab aggregates without repeating raw detail evidence',()=>{
 const presented=workspacePresentation(queryClient(client,observations,[],filters,{prepareAllViews:true}),filters);
 expect(presented.views?.revenue?.viewMetrics).toMatchObject({revenue:100,orders:5,aov:20});
 expect(presented.views?.products?.viewMetrics).toMatchObject({revenue:50,orders:5,aov:10});
 expect(presented.views?.revenue?.details).toHaveLength(1);
 expect(presented.views?.revenue?.details[0].evidence).toEqual([]);
 // The displayed dataset already occupies the top-level fields, avoiding a
 // second serialized copy of the large landing-page table.
 expect(presented.views?.funnels).toBeUndefined();
 expect(presented.details[0].metrics.sessions).toBe(1000);
 expect(presented.evidence.every(r=>r.dataset==='overview')).toBe(true);
});

it('retains qualified conversion action benchmarks when arriving from a commerce tab',()=>{
 const f={...filters,view:'revenue'},presented=workspacePresentation(queryClient(client,observations,[],f,{prepareAllViews:true}),f);
 expect(presented.actions).toEqual([]);
 expect(presented.views?.funnels?.actions).toEqual([]);
 expect(presented.qualifiedPageAlerts).toHaveLength(1);
 expect(presented.qualifiedPageAlerts?.[0].figures.find(figure=>figure.label==='Conversion rate')).toMatchObject({current:.01,previous:.03});
 expect(presented.qualifiedPageAlerts?.[0].impact).toBeCloseTo(20);
 const url=new URL(presented.qualifiedPageAlerts![0].evidence[1],'https://example.com');
 expect(url.searchParams.get('page')).toBe('/landing');expect(url.searchParams.get('from')).toBe(filters.from);
 expect(presented.evidence).toEqual([]);expect(presented.comparisonEvidence).toEqual([]);
});

it('keeps all tab aggregates unavailable when an intraday selection lacks qualified hourly coverage',()=>{
 const f={...filters,mode:'partial' as const},presented=workspacePresentation(queryClient(client,observations,[],f,{prepareAllViews:true}),f);
 expect(presented.views?.revenue?.viewMetrics).toMatchObject({revenue:null,orders:null});
 expect(presented.views?.revenue?.details).toEqual([]);
 expect(presented.views?.products?.details).toEqual([]);
});

it('keeps the detailed traffic counts separate from the overview and landing-page datasets',()=>{
 const f={...filters,view:'traffic'},presented=workspacePresentation(queryClient(client,[...observations,row('traffic','sessions',500),row('traffic','converting_sessions',25)],[],f,{prepareAllViews:true}),f);
 expect(presented.viewMetrics).toMatchObject({sessions:500,cvr:.05,revenue:null,orders:null});
 expect(presented.metrics).toMatchObject({revenue:100,sessions:null});
 expect(presented.views?.funnels?.viewMetrics).toMatchObject({sessions:1000,cvr:.01});
});

it('prepares only the requested dataset for review and AI queries unless the workspace opts in',()=>{
 const analytics=queryClient(client,observations,[],filters);
 expect(Object.keys(analytics.views)).toEqual(['funnels']);
 expect(analytics.details[0].metrics.sessions).toBe(1000);
});
it('prepares only explicit datasets while preserving daily chart values and qualification',()=>{
 const f={...filters,view:'revenue'},analytics=queryClient(client,observations,[],f,{preparedDatasets:['overview','revenue','subscriptions']} as any);
 expect(Object.keys(analytics.views)).toEqual(['overview','revenue','subscriptions']);expect(analytics.views.products).toBeUndefined();expect(analytics.datasetSeries.revenue[0].summary).toMatchObject({revenue:100,orders:5,aov:20});expect(analytics.datasetSeries.products).toBeUndefined();expect(analytics.comparisonDatasetSeries.revenue[0].date).toBe('2026-10-06');
});
it('marks an unrequested displayed dataset as unprepared instead of advertising an empty view',()=>{
 const f={...filters,view:'revenue'},analytics=queryClient(client,observations,[],f,{preparedDatasets:['overview']} as any);
 expect(Object.keys(analytics.views)).toEqual(['overview']);expect(analytics.views.revenue).toBeUndefined();expect(analytics.details).toEqual([]);expect(analytics.metrics.revenue).toBe(100);
});
it('keeps unsupported dimension metrics unavailable in explicitly prepared sales charts',()=>{
 const f={...filters,view:'revenue',device:'mobile'},analytics=queryClient(client,observations,[],f,{preparedDatasets:['overview','revenue','subscriptions']});expect(analytics.datasetMetrics.revenue).toBeNull();expect(analytics.datasetSeries.revenue[0].summary.revenue).toBeNull();expect(analytics.warnings.some(warning=>warning.includes('revenue:revenue'))).toBe(true);
});
