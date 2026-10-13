import {it,expect} from 'vitest';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
it('keeps complete table totals while loading bulk evidence only on inspection',()=>{const client={id:'a',timezone:'UTC',currency:'USD',config:{spendChannels:[],incidents:[],benchmarkMarket:'US',minSessions:1,minOpportunity:1,maxActions:6}} as any,f={from:'2026-10-07',to:'2026-10-07',mode:'closed',compare:'previous',view:'products'} as any,rows=[{date:f.to,dataset:'products',metric:'revenue',value:25,definition:'product',population:'product',currency:'USD',dimensions:{product:'A'},sourceId:'s'},{date:f.to,dataset:'products',metric:'orders',value:5,definition:'product',population:'product',currency:null,dimensions:{product:'A'},sourceId:'s'}] as any,a=queryClient(client,rows,[],f),p=workspacePresentation(a,f);expect(p.details[0].metrics.revenue).toBe(25);expect(p.viewMetrics.aov).toBe(5);expect(p.details[0].evidence).toEqual([]);expect(p.evidence).toEqual([]);expect(p.selectedCount).toBe(2);expect(a.evidence).toHaveLength(2);});

import type {Observation,QueryFilters} from '../../lib/analytics/contracts';
import {buildAlertQueue,qualifiedConversionAlerts} from '../../lib/analytics/alerts';
const f:QueryFilters={from:'2026-10-07',to:'2026-10-07',mode:'closed',compare:'previous',view:'traffic',market:'',stream:'',source:'',device:'',page:''};
const c={id:'a',name:'Client A',timezone:'UTC',currency:'USD',config:{spendChannels:['meta'],revenueDefinition:'web',incidents:[],benchmarkMarket:'US',minSessions:100,minOpportunity:5,maxActions:6}} as any;
function facts(){return ['2026-10-06','2026-10-07'].flatMap(date=>{
 const base={date,retrievedAt:'2026-10-08T00:00:00Z',coverageThrough:'2026-10-08T00:00:00Z',quality:'complete',sourceId:'s',definition:'web',population:'web_orders',currency:null};
 const overview=[['revenue',date===f.to?110:100],['spend',date===f.to?20:10],['new_orders',10]].map(([metric,value])=>({...base,dataset:'overview',metric,value,currency:metric==='new_orders'?null:'USD',channels:['meta'],dimensions:{}}));
 const funnels=[['sessions',1000],['converting_sessions',date===f.to?10:30]].map(([metric,value])=>({...base,dataset:'funnels',metric,value,population:'human_sessions',dimensions:{page:'/lp',market:'US'}}));
 const traffic=['meta','tiktok'].flatMap((utm_source,index)=>[['sessions',index?100:900],['converting_sessions',index?0:date===f.to?10:30],['atc_sessions',index?5:95],['checkouts',index?5:95],['completed_checkouts',index?1:49]].map(([metric,value])=>({...base,dataset:'traffic',metric,value,population:'human_sessions',dimensions:{page:'/lp',market:'US',source:'social',utm_source,utm_medium:'paid',utm_campaign:`Long campaign ${index}`,device:'mobile'}})));
 const diagnostics=[['orders',10],['revenue',100]].map(([metric,value])=>({...base,dataset:'orderStreams',metric,value,population:'web_orders',currency:metric==='revenue'?'USD':null,dimensions:{order_stream:'one_time',store_date:date}}));
 return [...overview,...funnels,...traffic,...diagnostics] as Observation[];
 });}
it('ships exact compact traffic, quality and dated comparison diagnostics without repeating leaf facts',()=>{
 const a=queryClient(c,facts(),[],f,{preparedDatasets:['overview','traffic','funnels','orderStreams']}),before=JSON.stringify(a),p=workspacePresentation(a,f);
 expect(p.trafficExplorer?.current.totals?.metrics.sessions).toBe(1000);expect(p.trafficExplorer?.current.pages[0].summary.cvr).toBe(.01);expect(p.trafficExplorer?.comparison.pages[0].summary.cvr).toBe(.03);
 expect(p.details).toEqual([]);expect(p.views.funnels.details).toEqual([]);expect(p.actions).toEqual([]);expect(Object.values(p.views).every(view=>view.actions.length===0)).toBe(true);expect(p.evidence).toEqual([]);expect(p.comparisonEvidence).toEqual([]);
 expect(p.sourceQuality).toEqual({historical:false,partial:false,estimated:false,count:a.selectedCount});expect(p.comparisonViews?.orderStreams.details[0].metrics.revenue).toBe(100);expect(p.comparisonViews?.orderStreams.details[0].evidence).toEqual([]);expect(JSON.stringify(a)).toBe(before);
 const htmlFacts=JSON.stringify(p);expect(htmlFacts).not.toContain('"utm_source":"meta"');expect(htmlFacts).not.toContain('"utm_campaign":"Long campaign 0"');
});
it('preserves canonically qualified page and spend actions with dated source links after stripping observations',()=>{
 const a=queryClient(c,facts(),[],f,{preparedDatasets:['overview','traffic','funnels']}),canonical=qualifiedConversionAlerts({...a,actions:a.views.funnels.actions},f),p={...workspacePresentation(a,f),findings:[],reviews:[]} as any;
 expect(canonical).toHaveLength(1);const alerts=buildAlertQueue([p],f),conversion=alerts.find(alert=>alert.category==='Conversion opportunity');expect(conversion?.key).toBe(canonical[0].key);expect(conversion?.figures).toEqual(canonical[0].figures);expect(conversion?.evidence[1]).toMatch(/^\/clients\/a\?/);expect(new URL(conversion!.evidence[1],'https://example.com').searchParams.get('page')).toBe('/lp');
 const efficiency=alerts.find(alert=>alert.category==='Spend efficiency');expect(efficiency?.figures.find(figure=>figure.label==='Spend')).toMatchObject({current:20,previous:10});expect(efficiency?.evidence.some(ref=>ref.includes('2026-10-06:overview:revenue'))).toBe(true);expect(p.efficiencyEvidence.length).toBeLessThanOrEqual(99);
 const noQualified=queryClient({...c,config:{...c.config,minOpportunity:1000}},facts(),[],f,{preparedDatasets:['overview','traffic','funnels']});expect(workspacePresentation(noQualified,f).qualifiedPageAlerts).toEqual([]);
 const broken=facts();for(const fact of broken)if(fact.dataset==='funnels'&&fact.date==='2026-10-06')fact.coverageThrough=null;
 expect(workspacePresentation(queryClient(c,broken,[],f,{preparedDatasets:['overview','traffic','funnels']}),f).qualifiedPageAlerts).toEqual([]);
});
it('retains source-quality flags independently of removed browser observations',()=>{
 const rows=facts();rows.find(row=>row.dataset==='overview'&&row.date===f.to)!.quality='historical';const p=workspacePresentation(queryClient(c,rows,[],f,{preparedDatasets:['overview','traffic','funnels']}),f);expect(p.sourceQuality?.historical).toBe(true);expect(p.evidence).toEqual([]);
});

it('ships matched prior product metrics and dimension cohorts without repeating leaf observations',()=>{
 const filters={...f,view:'products'};
 const rows=['2026-10-06','2026-10-07'].flatMap(date=>[['revenue',date===filters.to?120:100],['orders',date===filters.to?12:5]].map(([metric,value])=>({date,dataset:'products',metric:String(metric),value:Number(value),definition:'product_net_sales',population:'product_sales',dimensions:{product_id:'sku-1',product:'Patch'},sourceId:'p',retrievedAt:'2026-10-08T00:00:00Z',coverageThrough:'2026-10-08T00:00:00Z',currency:metric==='revenue'?'USD':null,quality:'complete'} as Observation)));
 const presented=workspacePresentation(queryClient(c,rows,[],filters,{preparedDatasets:['products']}),filters);
 expect(presented.viewMetrics).toMatchObject({revenue:120,orders:12,aov:10});
 expect(presented.viewPriorMetrics).toMatchObject({revenue:100,orders:5,aov:20});
 expect(presented.comparisonViews?.products.details[0]).toMatchObject({dimensions:{product_id:'sku-1',product:'Patch'},metrics:{revenue:100,orders:5},evidence:[]});
 expect(presented.comparisonEvidence).toEqual([]);
});

it('ships matched landing-page baselines for the overview table without traffic leaf facts',()=>{
 const filters={...f,view:'overview'},p=workspacePresentation(queryClient(c,facts(),[],filters,{preparedDatasets:['overview','traffic','funnels']}),filters);
 expect(p.details[0]).toMatchObject({dimensions:{page:'/lp',market:'US'},metrics:{sessions:1000,converting_sessions:10},evidence:[]});
 expect(p.comparisonViews?.funnels.details[0]).toMatchObject({dimensions:{page:'/lp',market:'US'},metrics:{sessions:1000,converting_sessions:30},evidence:[]});
 expect(p.comparisonViews?.traffic.details).toEqual([]);
 expect(p.comparisonEvidence).toEqual([]);
});
