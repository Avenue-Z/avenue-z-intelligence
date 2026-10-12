import {expect,it} from 'vitest';
import {monthToDateSummary} from '../../lib/analytics/month-to-date';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';
import initial from '../../data/initial-clients.json';
const client:Client={...initial[0],timezone:'UTC',version:1,config:{...initial[0].config,spendChannels:['meta']}} as Client;
const filters:QueryFilters={from:'2026-10-01',to:'2026-10-02',mode:'partial',compare:'previous',view:'overview',market:'',stream:'',source:'',device:'',page:''};
function row(date:string,metric:string,value:number,start?:string,end?:string):Observation{return {date,dataset:'overview',metric,value,definition:client.config.revenueDefinition,population:'web_nonrecurring',currency:metric==='revenue'?'USD':null,dimensions:{},sourceId:'source',retrievedAt:'2026-10-03T00:00:00Z',coverageThrough:'2026-11-01T00:00:00Z',quality:'complete',...start?{start}:{},...end?{end}:{}};}
function facts(){return [['2026-10-01','2026-10-01T00:00:00Z','2026-10-01T12:00:00Z',10,1],['2026-10-01','2026-10-01T12:00:00Z','2026-10-02T00:00:00Z',20,2],['2026-10-02','2026-10-02T00:00:00Z','2026-10-02T12:00:00Z',5,1],['2026-10-02','2026-10-02T12:00:00Z','2026-10-03T00:00:00Z',99,99]].flatMap(([date,start,end,revenue,orders])=>[row(String(date),'revenue',Number(revenue),String(start),String(end)),row(String(date),'orders',Number(orders),String(start),String(end))]);}
it('includes every completed earlier day and only the final partial-day window',()=>{
 const input=facts(),before=JSON.stringify(input),result=monthToDateSummary(client,input,filters,'2026-10-02T12:00:00Z');
 expect(result.metrics).toMatchObject({revenue:35,orders:4,aov:8.75});expect(result.fullElapsedDayCoverage).toBe(true);expect(result.finalCutoff).toBe('2026-10-02T12:00:00Z');expect(JSON.stringify(input)).toBe(before);
 expect(monthToDateSummary(client,input,{...filters,mode:'closed'},null).metrics.revenue).toBe(134);
});
it('maps the current clock onto the prior-month final date using its own timezone offset',()=>{
 const stockholm={...client,timezone:'Europe/Stockholm'},prior={...filters,from:'2026-09-30',to:'2026-09-30'},rows=[row(prior.to,'revenue',7,'2026-09-30T09:00:00Z','2026-09-30T10:00:00Z'),row(prior.to,'revenue',99,'2026-09-30T10:00:00Z','2026-09-30T11:00:00Z')];
 const result=monthToDateSummary(stockholm,rows,prior,'2026-10-31T11:00:00Z');expect(result.finalCutoff).toBe('2026-09-30T10:00:00Z');expect(result.metrics.revenue).toBe(7);
});
it('preserves the actual current cutoff during a repeated local DST hour',()=>{
 const stockholm={...client,timezone:'Europe/Stockholm'},date='2026-10-25',scope={...filters,from:date,to:date};
 const rows=[row(date,'revenue',7,'2026-10-25T00:00:00Z','2026-10-25T01:00:00Z'),row(date,'revenue',99,'2026-10-25T01:00:00Z','2026-10-25T02:00:00Z')],result=monthToDateSummary(stockholm,rows,scope,'2026-10-25T01:00:00Z');
 expect(result.finalCutoff).toBe('2026-10-25T01:00:00Z');expect(result.metrics.revenue).toBe(7);
});
it('reports a missing day without treating it as zero or claiming complete MTD coverage',()=>{
 const result=monthToDateSummary(client,[row(filters.from,'revenue',10),row(filters.from,'orders',1)],filters,'2026-10-02T12:00:00Z');expect(result.metrics.revenue).toBe(10);expect(result.coverage.revenue.missingDates).toEqual(['2026-10-02']);expect(result.fullElapsedDayCoverage).toBe(false);
 const empty=monthToDateSummary(client,[],filters,'2026-10-02T12:00:00Z');expect(empty.metrics.revenue).toBeNull();expect(empty.metrics.orders).toBeNull();expect(empty.fullElapsedDayCoverage).toBe(false);
});
it('preserves earlier observed totals but withholds the final date when the shared cutoff is unknown',()=>{
 const result=monthToDateSummary(client,facts(),filters,null);expect(result.metrics.revenue).toBe(30);expect(result.observedDates).toEqual(['2026-10-01']);expect(result.fullElapsedDayCoverage).toBe(false);expect(result.warnings.join(' ')).toMatch(/cutoff.*unconfirmed/i);
});
it('withholds ratios for mismatched populations and totals for a requested unsupported dimension',()=>{
 const rows=[row(filters.from,'revenue',10),{...row(filters.from,'orders',2),population:'subscription_recurring'}],scope={...filters,from:filters.from,to:filters.from,mode:'closed'} as QueryFilters;
 expect(monthToDateSummary(client,rows,scope,null).metrics.aov).toBeNull();const filtered=monthToDateSummary(client,rows,{...scope,market:'US'},null);expect(filtered.metrics.revenue).toBeNull();expect(filtered.warnings.join(' ')).toMatch(/unsupported.*dimension/i);
 const mixed=[row(filters.from,'revenue',10),{...row(filters.from,'revenue',20,'2026-10-01T00:00:00Z','2026-10-02T00:00:00Z'),population:'other'}];expect(monthToDateSummary(client,mixed,scope,null).metrics.revenue).toBeNull();
});
it('keeps estimated facts explicitly unconfirmed and never qualifies an incomplete hourly day',()=>{
 const rows=facts().map(r=>r.date===filters.from?{...r,quality:'estimated' as const}:r),result=monthToDateSummary(client,rows,filters,'2026-10-02T12:00:00Z');expect(result.metrics.revenue).toBe(35);expect(result.coverage.revenue.unconfirmedDates).toEqual([filters.from]);expect(result.fullElapsedDayCoverage).toBe(false);expect(result.quality).toContain('estimated');
 const sparse=facts().filter(r=>r.start!=='2026-10-01T12:00:00Z');expect(monthToDateSummary(client,sparse,filters,'2026-10-02T12:00:00Z').coverage.revenue.unconfirmedDates).toContain(filters.from);
});
it('uses complete daily human-session facts for earlier days when their hourly cut is incomplete',()=>{
 const rows=[{...row(filters.from,'sessions',100),currency:null,population:'human_online_store_sessions',definition:'shopify_human_sessions'},{...row(filters.from,'sessions',20,'2026-10-01T00:00:00Z','2026-10-01T01:00:00Z'),currency:null,population:'human_online_store_sessions',definition:'shopify_human_sessions'}];
 expect(monthToDateSummary(client,rows,filters,'2026-10-02T12:00:00Z').metrics.sessions).toBe(100);
});
