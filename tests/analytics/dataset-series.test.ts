import {it,expect,vi} from 'vitest';
vi.mock('@avenue/runtime',()=>({env:{},runtimePlatform:'sites'}));
vi.mock('../../lib/server/access',()=>({getStore:vi.fn(),requireClientAccess:vi.fn()}));
import {datasetSeries,datasetHourlySeries} from '../../lib/analytics/dataset-series';
import {comparisonPeriod} from '../../lib/analytics/windows';
import {parseFilters} from '../../lib/server/workspace';
import type {Observation,QueryFilters} from '../../lib/analytics/contracts';
const row=(date:string,metric:string,value:number,population='human'):Observation=>({date,dataset:'traffic',metric,value,population,definition:'public_human',currency:null,dimensions:{source:'meta'},sourceId:'s',retrievedAt:'2026-10-12T12:00:00Z',coverageThrough:'2026-10-12T12:00:00Z',quality:'complete'});
it('keeps missing calendar dates as gaps and calculates rates from matching daily counts',()=>{const result=datasetSeries([row('2026-10-09','sessions',100),row('2026-10-09','converting_sessions',5),row('2026-10-11','sessions',400),row('2026-10-11','converting_sessions',40)],'2026-10-09','2026-10-11',['traffic']).traffic;expect(result.map(x=>x.date)).toEqual(['2026-10-09','2026-10-10','2026-10-11']);expect(result[0].summary.cvr).toBe(.05);expect(result[1].summary.sessions).toBeNull();expect(result[2].summary.cvr).toBe(.1);});
it('does not combine distinct populations or average independently reported rates',()=>{const result=datasetSeries([row('2026-10-09','sessions',100),row('2026-10-09','converting_sessions',50,'other')],'2026-10-09','2026-10-09',['traffic']);expect(result.traffic[0].summary.cvr).toBeNull();});
const f:QueryFilters={from:'2026-10-05',to:'2026-10-11',compare:'thirtyDays',mode:'closed',view:'subscriptions',market:'',stream:'',source:'',device:'',page:''};
it('supports thirty-day and equal-length custom comparisons without changing calendar duration',()=>{expect(comparisonPeriod(f)).toMatchObject({from:'2026-09-05',to:'2026-09-11'});expect(comparisonPeriod({...f,compare:'custom',compareFrom:'2026-08-17'})).toMatchObject({from:'2026-08-17',to:'2026-08-23'});expect(()=>comparisonPeriod({...f,compare:'custom',compareFrom:'2026-08-17',compareTo:'2026-08-24'})).toThrow('7 calendar days');});
it('preserves custom dates in API scope and redirects legacy funnels to Traffic',()=>{expect(parseFilters(new URLSearchParams({...f,compare:'custom',compareFrom:'2026-08-17',view:'funnels'}))).toMatchObject({compare:'custom',compareFrom:'2026-08-17',compareTo:'2026-08-23',view:'traffic'});});
it('aggregates only actual one-hour intervals and keeps uncaptured hours unknown',()=>{
 const hourly=(start:string,metric:string,value:number):Observation=>({...row('2026-10-11',metric,value),dataset:'revenue',definition:'net_sales',population:'channel_sales',currency:metric==='revenue'?'USD':null,dimensions:{stream:'Online Store'},start,end:new Date(Date.parse(start)+3600000).toISOString()});
 const points=datasetHourlySeries([hourly('2026-10-11T00:00:00Z','revenue',80),hourly('2026-10-11T00:00:00Z','orders',4),hourly('2026-10-11T02:00:00Z','revenue',45),hourly('2026-10-11T02:00:00Z','orders',3),{...hourly('2026-10-11T00:00:00Z','revenue',900),end:'2026-10-12T00:00:00Z'}],'2026-10-11','UTC',['revenue'],'2026-10-11T03:00:00Z').revenue;
 expect(points).toHaveLength(3);expect(points.map(point=>point.metrics.revenue??null)).toEqual([80,null,45]);expect(points[0].summary.aov).toBe(20);expect(points[1].summary.aov).toBeNull();expect(points[2].summary.aov).toBe(15);expect(points[1]).toMatchObject({start:'2026-10-11T01:00:00Z',end:'2026-10-11T02:00:00Z'});
});
it('preserves the 25 real intervals of a fall-back day and does not label a daily aggregate as hourly',()=>{
 const input={...row('2026-11-01','revenue',10),dataset:'revenue',start:'2026-11-01T04:00:00Z',end:'2026-11-01T05:00:00Z'};
 expect(datasetHourlySeries([input],'2026-11-01','America/New_York',['revenue']).revenue).toHaveLength(25);
 expect(datasetHourlySeries([{...input,end:'2026-11-02T05:00:00Z'}],'2026-11-01','America/New_York',['revenue']).revenue).toEqual([]);
});
