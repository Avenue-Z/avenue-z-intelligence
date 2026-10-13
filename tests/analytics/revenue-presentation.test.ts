import {describe,expect,it} from 'vitest';
import {revenueContextSeries,revenueMetricChange,revenuePeriodTotals,revenueSeries,revenueHourlySeries,type RevenueDailyPoint,type RevenueHourlyPoint} from '../../lib/analytics/revenue-presentation';
import {unsupportedClientFilterReset,supportedClientFilters,clientTodaySelection} from '../../lib/analytics/client-filter-policy';
import type {QueryFilters} from '../../lib/analytics/contracts';
const day=(date:string,revenue:number|null,orders:number|null):RevenueDailyPoint=>({date,metrics:{revenue,orders},summary:{aov:revenue!==null&&orders!==null&&orders>0?revenue/orders:null}});
describe('analyst revenue periods',()=>{
 it('weights period AOV by matching orders instead of averaging daily AOV',()=>{
  const result=revenuePeriodTotals([day('2026-10-10',100,1),day('2026-10-11',90,9)],'2026-10-10','2026-10-11');
  expect(result).toEqual({revenue:190,orders:10,aov:19,coveredDays:2,expectedDays:2});
 });
 it('does not show incomplete current or comparison days as complete sales totals',()=>{
  expect(revenuePeriodTotals([day('2026-10-10',100,5),day('2026-10-12',200,10)],'2026-10-10','2026-10-12')).toEqual({revenue:null,orders:null,aov:null,coveredDays:2,expectedDays:3});
 });
 it('preserves reported zero sales and keeps zero-order AOV unavailable',()=>{
  expect(revenuePeriodTotals([day('2026-10-10',0,0)],'2026-10-10','2026-10-10')).toEqual({revenue:0,orders:0,aov:null,coveredDays:1,expectedDays:1});
  expect(revenueMetricChange(100,0)).toEqual({absolute:100,relative:null});
  expect(revenueMetricChange(90,100)).toEqual({absolute:-10,relative:-.1});
 });
 it('shows actual daily calendar history and replaces stale selected-day values without inventing missing days',()=>{
  const result=revenueContextSeries(revenueSeries([day('2026-10-09',50,5),day('2026-10-11',80,4)]),revenueSeries([day('2026-10-11',100,4)]),'2026-10-09','2026-10-11');
  expect(result).toEqual([{date:'2026-10-09',revenue:50,orders:5,aov:10},{date:'2026-10-10',revenue:null,orders:null,aov:null},{date:'2026-10-11',revenue:100,orders:4,aov:25}]);
 });
 it('matches hourly comparison by store clock across offset changes while retaining actual intervals',()=>{
  const hourly=(date:string,start:string,revenue:number):RevenueHourlyPoint=>({...day(date,revenue,2),start,end:new Date(Date.parse(start)+3600000).toISOString()});
  const selected=[hourly('2026-11-02','2026-11-02T07:00:00Z',40),hourly('2026-11-02','2026-11-02T09:00:00Z',60)];
  const prior=[hourly('2026-10-26','2026-10-26T06:00:00Z',20),hourly('2026-10-26','2026-10-26T07:00:00Z',50)];
  const rows=revenueHourlySeries(selected,prior,'America/New_York');
  expect(rows.map(row=>[row.hourLabel,row.revenue,row.comparison_revenue])).toEqual([['02:00',40,20],['03:00',null,50],['04:00',60,null]]);
  expect(rows[0].comparisonDate).toBe('2026-10-26T06:00:00Z');expect(rows[0].date).toBe('2026-11-02T07:00:00Z');expect(rows[0].end).toBe('2026-11-02T08:00:00.000Z');
 });
 it('keeps repeated fall-back clock hours as separate actual intervals',()=>{
  const hourly=(start:string,revenue:number):RevenueHourlyPoint=>({...day('2026-11-01',revenue,1),start,end:new Date(Date.parse(start)+3600000).toISOString()});
  const rows=revenueHourlySeries([hourly('2026-11-01T05:00:00Z',10),hourly('2026-11-01T06:00:00Z',20)],[],'America/New_York');
  expect(rows).toHaveLength(2);expect(rows.map(row=>row.revenue)).toEqual([10,20]);expect(rows.map(row=>row.hourLabel)).toEqual(['01:00 · GMT-4','01:00 · GMT-5']);
 });
 it('retains a wholly uncaptured hour as unknown rather than joining its neighbors',()=>{
  const points=['2026-10-11T00:00:00Z','2026-10-11T02:00:00Z'].map(start=>({...day('2026-10-11',20,1),start,end:new Date(Date.parse(start)+3600000).toISOString()}));
  const rows=revenueHourlySeries(points,[],'UTC');
  expect(rows.map(row=>[row.hourLabel,row.revenue])).toEqual([['00:00',20],['01:00',null],['02:00',20]]);
 });
});
describe('contextual client filters',()=>{
 const filters:QueryFilters={from:'2026-10-11',to:'2026-10-11',compare:'weekday',mode:'closed',view:'traffic',market:'US',stream:'Online Store',source:'meta',device:'mobile',page:'/pages/dream'};
 it('retains the sales channel while clearing attribution dimensions unsupported by Shopify channel sales',()=>{
  expect(supportedClientFilters('revenue')).toEqual(['stream']);
  expect(supportedClientFilters('products')).toEqual(['stream']);
  expect(unsupportedClientFilterReset(filters,'revenue')).toEqual({market:'',source:'',device:'',page:''});
 });
 it('keeps traffic drilldown filters and clears incompatible channel scope before navigation',()=>{
  expect(unsupportedClientFilterReset(filters,'traffic')).toEqual({stream:''});
  expect(unsupportedClientFilterReset(filters,'markets')).toEqual({stream:'',source:'',device:'',page:''});
  expect(unsupportedClientFilterReset({...filters,market:'',source:'',device:'',page:'',stream:''},'revenue')).toEqual({});
 });
 it('opens today inside the selected view and retains its supported filters and comparison',()=>{
  expect(clientTodaySelection({...filters,view:'revenue'},'2026-10-13')).toEqual({from:'2026-10-13',to:'2026-10-13',mode:'partial',period:'today',view:'revenue',market:'',source:'',device:'',page:''});
  expect(clientTodaySelection({...filters,view:'products',market:'',source:'',device:'',page:''},'2026-10-13')).toEqual({from:'2026-10-13',to:'2026-10-13',mode:'partial',period:'today',view:'products'});
 });
});
