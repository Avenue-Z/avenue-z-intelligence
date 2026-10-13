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
