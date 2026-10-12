import {expect,it} from 'vitest';
import {detailRows,metricSummary,summarize,sumMetric} from '../../lib/analytics/query';
import {datasetSeries} from '../../lib/analytics/dataset-series';
import type {Observation} from '../../lib/analytics/contracts';
const row=(metric:string,value:number|null,dimensions:Record<string,string>={}):Observation=>({date:'2026-10-11',dataset:'traffic',metric,value,dimensions,definition:'human',population:'human',currency:null,sourceId:'source',retrievedAt:'2026-10-12T00:00:00Z',coverageThrough:'2026-10-12T00:00:00Z',quality:'complete'});
it('retains unavailable totals and rates for duplicate authority, null values and incompatible definitions',()=>{
 const a=row('sessions',100),n=row('converting_sessions',10);
 for(const rows of [[a,{...a,sourceId:'other'},n],[a,{...a,dimensions:{page:'/b'},definition:'different'},n],[{...a,value:null},n],[a,{...a,dimensions:{page:'/b'},currency:'USD'},n]]){
  const combined=metricSummary(rows);expect(combined.metrics.sessions).toBe(sumMetric(rows,'sessions'));expect(combined.summary).toEqual(summarize(rows));expect(combined.summary.sessions).toBeNull();expect(combined.summary.cvr).toBeNull();
  const point=datasetSeries(rows,a.date,a.date,['traffic']).traffic[0];expect(point.metrics).toEqual(combined.metrics);expect(point.summary).toEqual(combined.summary);
 }
 expect(detailRows([a,{...a,sourceId:'other'},n])[0]).toMatchObject({metrics:{sessions:null},summary:{sessions:null,cvr:null}});
});
it('keeps known population equality and overall/breakdown grain checks separate from reused numeric totals',()=>{
 const rows=[row('sessions',100),{...row('converting_sessions',10),population:'another'},row('spend',100),row('spend',40,{campaign:'c'})],result=metricSummary(rows);
 expect(result.metrics.sessions).toBe(100);expect(result.metrics.converting_sessions).toBe(10);expect(result.summary.cvr).toBeNull();expect(result.metrics.spend).toBeNull();expect(result.summary.spend).toBeNull();
 expect(metricSummary([row('reported_conversion_rate',.1),row('reported_conversion_rate',.2,{page:'/b'})]).metrics.reported_conversion_rate).toBeNull();
});
it('preserves pooled ratios and serial metric addition order',()=>{
 const rows=['/a','/b'].flatMap((page,index)=>[row('sessions',index?100:200,{page}),row('converting_sessions',index?10:40,{page}),row('atc_sessions',index?20:60,{page}),row('checkouts',index?10:40,{page}),row('completed_checkouts',index?5:20,{page})]),before=JSON.stringify(rows),result=metricSummary(rows);
 expect(result.summary).toEqual(summarize(rows));expect(result.summary).toMatchObject({sessions:300,cvr:50/300,atc:80/300,checkoutCompletion:.5});expect(JSON.stringify(rows)).toBe(before);
});
it('performs dimension and duplicate guards once per metric instead of repeating them for summary ratios',()=>{
 let dimensionInspections=0;const rows=['sessions','converting_sessions','atc_sessions','checkouts','completed_checkouts'].map((metric,index)=>row(metric,index?10:100,new Proxy({page:'/a'},{ownKeys(target){dimensionInspections++;return Reflect.ownKeys(target);}})));
 expect(metricSummary(rows).summary.cvr).toBe(.1);expect(dimensionInspections).toBeLessThan(rows.length*3);
});
