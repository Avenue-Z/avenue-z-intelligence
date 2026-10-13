import {describe,expect,it} from 'vitest';
import {revenueContextSeries,revenueMetricChange,revenuePeriodTotals,revenueSeries,type RevenueDailyPoint} from '../../lib/analytics/revenue-presentation';
import {unsupportedClientFilterReset,supportedClientFilters} from '../../lib/analytics/client-filter-policy';
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
});
