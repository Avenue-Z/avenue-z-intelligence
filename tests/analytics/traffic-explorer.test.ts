import {describe,expect,it} from 'vitest';
import {aggregateExplorerRows,alignExplorerSeries,explorerMetric,trafficChannel} from '../../lib/analytics/traffic-explorer';
import {detailRows} from '../../lib/analytics/query';
import type {Observation} from '../../lib/analytics/contracts';

function row(page:string,source:string,values:Record<string,number|null>){return detailRows(Object.entries(values).map(([metric,value])=>({date:'2026-10-10',metric,value,dataset:'traffic',dimensions:{page,source},population:'human_public_sessions',definition:'human_public_sessions',currency:null,sourceId:'shopify',retrievedAt:'2026-10-11T00:00:00Z',coverageThrough:'2026-10-11T00:00:00Z',quality:'complete'} as Observation)))[0];}

describe('traffic explorer counts',()=>{
 it('derives weighted funnel rates from the complete source segments rather than averaging segment rates',()=>{
  const rows=[row('/pages/dream','social',{sessions:100,atc_sessions:20,checkouts:10,completed_checkouts:4,converting_sessions:5}),row('/pages/dream','search',{sessions:900,atc_sessions:90,checkouts:90,completed_checkouts:45,converting_sessions:18})];
  const pages=aggregateExplorerRows(rows,'page');
  expect(pages).toHaveLength(1);expect(pages[0].metrics.sessions).toBe(1000);
  expect(explorerMetric(pages[0],'cvr')).toBe(.023);expect(explorerMetric(pages[0],'atc')).toBe(.11);expect(explorerMetric(pages[0],'checkoutCompletion')).toBe(.49);
 });
 it('keeps incomplete numerators unavailable instead of treating missing source counts as zero',()=>{
  const pages=aggregateExplorerRows([row('/a','meta',{sessions:100,converting_sessions:0}),row('/a','tiktok',{sessions:50})],'page');
  expect(explorerMetric(pages[0],'sessions')).toBe(150);expect(explorerMetric(pages[0],'cvr')).toBeNull();
  expect(explorerMetric(aggregateExplorerRows([row('/a','meta',{sessions:100,converting_sessions:0})],'page')[0],'cvr')).toBe(0);
 });
 it('keeps pages independent and identifies UTM source without inventing a paid attribution claim',()=>{
  const a=row('/a','social',{sessions:100});a.dimensions.utm_source='facebook';
  const b=row('/b','search',{sessions:50});b.dimensions.utm_source='tiktok';
  expect(trafficChannel(a.dimensions)).toBe('Meta · UTM');expect(trafficChannel(b.dimensions)).toBe('TikTok · UTM');
  expect(trafficChannel({source:'search'})).toBe('search · referrer');expect(trafficChannel({})).toBe('Unspecified source');
  expect(aggregateExplorerRows([a,b],'page').map(p=>[p.label,p.metrics.sessions])).toEqual([['/a',100],['/b',50]]);
 });
 it('does not reuse rounded historical rates for a multi-segment aggregate',()=>{
  const rows=[row('/a','social',{sessions:100,reported_conversion_rate:.1}),row('/a','search',{sessions:100,reported_conversion_rate:.2})];
  expect(explorerMetric(aggregateExplorerRows(rows,'page')[0],'cvr')).toBeNull();
 });
 it('preserves an unavailable prepared rate even when raw numerator and denominator counts are present',()=>{
  const segment=row('/a','meta',{sessions:100,converting_sessions:50});segment.summary.cvr=null;
  expect(explorerMetric(segment,'cvr')).toBeNull();
  expect(explorerMetric(aggregateExplorerRows([segment,row('/a','tiktok',{sessions:100,converting_sessions:10})],'page')[0],'cvr')).toBeNull();
 });
 it('allows a known zero-count segment without losing the qualified nonempty funnel rate',()=>{
  const groups=aggregateExplorerRows([row('/a','meta',{sessions:100,checkouts:10,completed_checkouts:4}),row('/a','tiktok',{sessions:100,checkouts:0,completed_checkouts:0})],'page');
  expect(explorerMetric(groups[0],'checkoutCompletion')).toBe(.4);
 });
});

describe('aligned period trend',()=>{
 it('aligns by period day while retaining the real comparison date and explicit gaps',()=>{
  const points=alignExplorerSeries([{date:'2026-10-10',metrics:{sessions:10}},{date:'2026-10-12',metrics:{sessions:30}}],[{date:'2026-09-12',metrics:{sessions:5}},{date:'2026-09-14',metrics:{sessions:15}}],'sessions',{from:'2026-10-10',to:'2026-10-12',comparisonFrom:'2026-09-12'});
  expect(points).toEqual([{date:'2026-10-10',comparisonDate:'2026-09-12',current:10,previous:5},{date:'2026-10-11',comparisonDate:'2026-09-13',current:null,previous:null},{date:'2026-10-12',comparisonDate:'2026-09-14',current:30,previous:15}]);
 });
 it('calculates daily rates from count series and leaves zero denominators blank',()=>{
  const points=alignExplorerSeries([{date:'2026-10-10',metrics:{sessions:100,converting_sessions:3}},{date:'2026-10-11',metrics:{sessions:0,converting_sessions:0}}],[],'cvr',{from:'2026-10-10',to:'2026-10-11',comparisonFrom:'2026-10-08'});
  expect(points.map(p=>p.current)).toEqual([.03,null]);
 });
 it('retains population qualification from a prepared daily summary instead of deriving a contradictory chart rate',()=>{
  const points=alignExplorerSeries([{date:'2026-10-10',metrics:{sessions:100,converting_sessions:50},summary:{cvr:null}}],[],'cvr',{from:'2026-10-10',to:'2026-10-10',comparisonFrom:'2026-10-09'});
  expect(points[0].current).toBeNull();
 });
});
