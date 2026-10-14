import {expect,it} from 'vitest';
import {queryClient} from '../../lib/analytics/query';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';
const client:Client={id:'c',name:'C',slug:'c',version:1,timezone:'UTC',currency:'USD',color:'#426ac0',config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'web',spendChannels:['meta'],recurringLabel:'Recurring',minSessions:10,minOpportunity:1,maxActions:4,reviewTime:'09:00',reviewTimezone:'UTC',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-12',to:'2026-10-12',compare:'weekday',mode:'closed',view:'traffic',market:'US',stream:'',source:'',device:'',page:''};
const rows:Observation[]=Array.from({length:12},(_,index)=>`2026-10-${String(index+1).padStart(2,'0')}`).flatMap((date,index)=>['US','CA'].flatMap(market=>['traffic','products','markets','subscriptions','subscriptionEvents','overview'].flatMap(dataset=>[['revenue',100+index],['orders',10],['sessions',1000+index],['converting_sessions',20],['spend',50],['new_orders',8],['recurring_revenue',200],['recurring_orders',20],['subscription_cancellations',index]].map(([metric,value])=>({date,dataset,metric:String(metric),value:Number(value),definition:'web',population:'matching',dimensions:{market},currency:['revenue','spend','recurring_revenue'].includes(String(metric))?'USD':null,sourceId:'source',retrievedAt:'2026-10-13T00:00:00Z',coverageThrough:'2026-10-13T00:00:00Z',quality:'complete' as const,channels:['meta']})))));
it('supplies daily history for every rendered trend without broadening selected KPIs or market scope',()=>{
 const record=queryClient(client,rows,[],filters,{preparedDatasets:['overview','traffic','products','markets','subscriptions','subscriptionEvents']});
 expect(record.datasetSeries.traffic).toHaveLength(1);expect(record.datasetSeries.traffic[0].summary.sessions).toBe(1011);
 expect(record.trendDatasetSeries.traffic.filter(point=>point.summary.sessions!==null)).toHaveLength(12);
 expect(record.trendDatasetSeries.products.at(-1)?.summary.revenue).toBe(111);
 expect(record.trendDatasetSeries.subscriptionEvents.at(-1)?.metrics.subscription_cancellations).toBe(11);
 expect(record.trendComparisonDatasetSeries.traffic.at(-1)?.date).toBe('2026-10-05');
 expect(record.trendComparisonDatasetSeries.traffic.at(-1)?.summary.sessions).toBe(1004);
});
it('does not silently chart incomplete older totals when a source cannot answer a selected dimension',()=>{
 const dimensionless={...rows.find(row=>row.date==='2026-10-01'&&row.dataset==='traffic'&&row.metric==='sessions')!,sourceId:'unsupported',dimensions:{},value:5000};
 const record=queryClient(client,[...rows,dimensionless],[],filters,{preparedDatasets:['traffic']});
 expect(record.datasetSeries.traffic[0].summary.sessions).toBe(1011);
 expect(record.trendDatasetSeries.traffic.find(point=>point.date==='2026-10-01')?.summary.sessions).toBeNull();
});
it('normalizes both live history curves and qualified MER to the same completed hour on every date',()=>{
 const selected={...filters,from:'2026-10-12',to:'2026-10-12',compare:'previous' as const,mode:'partial' as const,market:'',view:'media'},hourly=['2026-10-09','2026-10-10','2026-10-11','2026-10-12'].flatMap(date=>[0,1].flatMap(hour=>Object.entries({revenue:hour?900:100,spend:hour?300:50,new_orders:hour?100:10}).map(([metric,value])=>({...rows[0],date,dataset:'overview',metric,value,dimensions:{},start:`${date}T0${hour}:00:00Z`,end:`${date}T0${hour+1}:00:00Z`,coverageThrough:'2026-10-12T01:00:00Z'}))));
 const record=queryClient(client,hourly,[{id:'tw',enabled:true,provider:'kind-triple-whale',coverageThrough:'2026-10-12T01:00:00Z'}] as any,selected,{preparedDatasets:['overview']});
 for(const series of [record.trendDatasetSeries.overview,record.trendComparisonDatasetSeries.overview])for(const point of series.filter(point=>point.summary.revenue!==null)){expect(point.summary.revenue).toBe(100);expect(point.summary.spend).toBe(50);expect(point.summary.mer).toBe(2);}
 expect(record.trendDatasetSeries.overview.filter(point=>point.summary.revenue!==null)).toHaveLength(4);expect(record.metrics.revenue).toBe(100);
});
it('keeps daily-only legacy history as live gaps and preserves its closed-day values',()=>{
 const daily=rows.filter(row=>row.date==='2026-10-10'&&row.dataset==='products'),live={...filters,mode:'partial' as const,view:'products'},sources=[{id:'products',enabled:true,provider:'kind-shopify-products',coverageThrough:'2026-10-12T01:00:00Z'}] as any;
 expect(queryClient(client,daily,sources,live,{preparedDatasets:['products']}).trendDatasetSeries.products.find(point=>point.date==='2026-10-10')?.summary.revenue).toBeNull();
 expect(queryClient(client,daily,[],{...live,mode:'closed'},{preparedDatasets:['products']}).trendDatasetSeries.products.find(point=>point.date==='2026-10-10')?.summary.revenue).toBe(109);
 expect(queryClient(client,daily,[],live,{preparedDatasets:['products']}).trendDatasetSeries.products.every(point=>point.summary.revenue===null)).toBe(true);
});
it('maps midnight completion and DST wall clocks consistently onto every historical trend date',()=>{
 const make=(date:string,end:string,value:number)=>({...rows[0],date,dataset:'markets',metric:'revenue',value,dimensions:{market:'US'},start:new Date(Date.parse(end)-3600000).toISOString(),end,coverageThrough:'2026-11-01T08:00:00Z'});
 const dst={...filters,from:'2026-11-01',to:'2026-11-01',mode:'partial' as const,compare:'previous' as const,view:'markets'},ny={...client,timezone:'America/New_York'},sources=[{id:'tw',enabled:true,provider:'kind-triple-whale',coverageThrough:'2026-11-01T08:00:00Z'}] as any;
 const record=queryClient(ny,[make('2026-10-30','2026-10-30T07:00:00Z',10),make('2026-10-30','2026-10-30T08:00:00Z',900)],sources,dst,{preparedDatasets:['markets']});
 expect(record.trendDatasetSeries.markets.find(point=>point.date==='2026-10-30')?.summary.revenue).toBe(10);
 const midnight={...dst,from:'2026-10-12',to:'2026-10-12'},stockholm={...client,timezone:'Europe/Stockholm'},complete=[{id:'tw',enabled:true,provider:'kind-triple-whale',coverageThrough:'2026-10-12T22:00:00Z'}] as any;
 expect(queryClient(stockholm,[make('2026-10-10','2026-10-10T22:00:00Z',10)],complete,midnight,{preparedDatasets:['markets']}).trendDatasetSeries.markets.find(point=>point.date==='2026-10-10')?.summary.revenue).toBe(10);
});
it('does not turn a same-day midnight capture with zero completed hours into full historical live days',()=>{
 const selected={...filters,mode:'partial' as const,view:'markets'},hourly={...rows[0],date:'2026-10-10',dataset:'markets',start:'2026-10-10T00:00:00Z',end:'2026-10-10T01:00:00Z'},sources=[{id:'tw',enabled:true,provider:'kind-triple-whale',coverageThrough:'2026-10-12T00:00:00Z'}] as any;
 const result=queryClient(client,[hourly],sources,selected,{preparedDatasets:['markets']});expect(result.cutoff).toBe('2026-10-12T00:00:00Z');expect(result.trendDatasetSeries.markets.every(point=>point.summary.revenue===null)).toBe(true);
});
