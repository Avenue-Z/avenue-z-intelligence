import {describe,expect,it} from 'vitest';
import {alignMetricSeries,formatChartMetric,availableChartMetrics,channelSpendRows} from '../../lib/analytics/visualization';

describe('dated visual comparisons',()=>{
 it('aligns by store-day offset and preserves missing current dates and reported zero',()=>{
  const values=alignMetricSeries([{date:'2026-10-10',revenue:0},{date:'2026-10-12',revenue:200}],[{date:'2026-10-07',revenue:50},{date:'2026-10-08',revenue:80},{date:'2026-10-09',revenue:null}],['revenue'],'2026-10-10','2026-10-07');
  expect(values).toEqual([{date:'2026-10-10',comparisonDate:'2026-10-07',revenue:0,comparison_revenue:50},{date:'2026-10-11',comparisonDate:'2026-10-08',revenue:null,comparison_revenue:80},{date:'2026-10-12',comparisonDate:'2026-10-09',revenue:200,comparison_revenue:null}]);
 });
 it('keeps a gap when both periods are missing an internal store day',()=>{
  expect(alignMetricSeries([{date:'2026-10-10',orders:3},{date:'2026-10-12',orders:4}],[],['orders'])).toEqual([{date:'2026-10-10',comparisonDate:null,orders:3,comparison_orders:null},{date:'2026-10-11',comparisonDate:null,orders:null,comparison_orders:null},{date:'2026-10-12',comparisonDate:null,orders:4,comparison_orders:null}]);
 });
 it('does not convert absent or non-finite metrics to zero',()=>{
  const values=alignMetricSeries([{date:'2026-10-10',cvr:NaN}],[],['cvr']);
  expect(values[0].cvr).toBeNull();expect(values[0].comparison_cvr).toBeNull();
  expect(availableChartMetrics(values,[{key:'cvr',label:'CVR',unit:'percent'},{key:'revenue',label:'Revenue',unit:'currency'}])).toEqual([]);
 });
 it('shows available comparison data even when the current period has no rows',()=>{
  expect(alignMetricSeries([],[{date:'2026-10-07',orders:4}],['orders'],'2026-10-10','2026-10-07')).toEqual([{date:'2026-10-10',comparisonDate:'2026-10-07',orders:null,comparison_orders:4}]);
 });
 it('formats rates, money, counts and multiples with their actual units',()=>{
  expect(formatChartMetric(.034,'percent','USD')).toBe('3.40%');
  expect(formatChartMetric(12.34,'currency','USD')).toBe('$12.34');
  expect(formatChartMetric(0,'count','USD')).toBe('0');
  expect(formatChartMetric(1.2,'multiple','USD')).toBe('1.20×');
  expect(formatChartMetric(null,'percent','USD')).toBe('Unavailable');
 });
});
describe('store-day channel spend visualization',()=>{
 it('sums only the store-day spend metric and leaves UTC platform spend separate',()=>{
  const rows:{dimensions:Record<string,string>;metrics:Record<string,number|null>}[]=[{dimensions:{channel:'meta'},metrics:{spend:100,platform_spend:900}},{dimensions:{channel:'google'},metrics:{spend:50}},{dimensions:{channel:'meta',campaign:'extra'},metrics:{spend:10}},{dimensions:{channel:'applovin'},metrics:{platform_spend:1000}},{dimensions:{channel:'tiktok'},metrics:{spend:0}}];
  expect(channelSpendRows(rows)).toEqual([{name:'Meta',spend:110},{name:'Google',spend:50},{name:'TikTok',spend:0}]);
 });
 it('labels verified paid-provider aliases consistently without rewriting raw dimensions or treating referrers as paid spend',()=>{
  const rows:{dimensions:Record<string,string>;metrics:Record<string,number|null>}[]=[{dimensions:{channel:'Facebook'},metrics:{spend:100}},{dimensions:{channel:'meta'},metrics:{spend:20}},{dimensions:{channel:'instagram'},metrics:{spend:5}},{dimensions:{channel:'facebook organic'},metrics:{spend:2}},{dimensions:{source:'facebook',utm_source:'facebook'},metrics:{sessions:500}}];
  expect(channelSpendRows(rows)).toEqual([{name:'Meta',spend:125},{name:'facebook organic',spend:2}]);
  expect(rows.map(row=>row.dimensions.channel)).toEqual(['Facebook','meta','instagram','facebook organic',undefined]);
 });
});
