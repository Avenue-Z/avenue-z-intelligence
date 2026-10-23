import {describe,it,expect} from 'vitest';
import type {Client,QueryFilters} from '../../lib/analytics/contracts';
import type {ClientRecord} from '../../components/analytics/records';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import {buildPortfolioOverview} from '../../lib/analytics/portfolio';

const filters:QueryFilters={from:'2026-10-16',to:'2026-10-16',compare:'previous',mode:'partial',view:'overview',market:'',stream:'',source:'',device:'',page:''};
function record(id='kind-patches',currency='USD'):ClientRecord{
 const client:Client={id,name:id==='beam'?'Beam':'Kind Patches',slug:id,currency,timezone:id==='beam'?'America/New_York':'Europe/Stockholm',color:'#39f',version:1,config:{markets:[],benchmarkMarket:'US',revenueDefinition:id==='beam'?'net_sales':'web_nonrecurring',spendChannels:['Meta'],recurringLabel:'Recurring',minSessions:100,minOpportunity:5,maxActions:6,reviewTime:'08:00',reviewTimezone:'America/New_York',reviewMode:'closed',incidents:[]}};
 const base=workspacePresentation(queryClient(client,[],[],filters),filters);
 return {...base,metrics:{...base.metrics,revenue:120,orders:12,sessions:100,cvr:.12,aov:10,spend:60},prior:{...base.prior,revenue:100,orders:10,sessions:100,cvr:.1,aov:10,spend:70},reviews:[],findings:[],note:{body:'',version:0},connections:[]};
}
function point(date:string,revenue:number|null){return {date,metrics:{revenue},summary:{...record().metrics,revenue}} as ClientRecord['datasetSeries'][string][number];}

describe('executive portfolio evidence',()=>{
 it('keeps brand cohorts separate, colors useful changes and never invents a blended total',()=>{
  const kp=record(),beam=record('beam');beam.metrics.revenue=80;
  const result=buildPortfolioOverview([kp,beam],filters,{metric:'revenue',window:'7d'});
  expect(result.counts).toMatchObject({growing:1,declining:1,flat:0});
  expect(result.brands[0].metrics.revenue).toMatchObject({value:120,previous:100,change:.2,tone:'positive'});
  expect(result.brands[0].metrics.spend).toMatchObject({value:60,change:-1/7,tone:'neutral'});
  expect(result.brands[1].scope).toContain('US');expect(result.brands[0].scope).toContain('global');
  expect(result).not.toHaveProperty('totalRevenue');expect(result).not.toHaveProperty('averageCvr');
  expect(result.movers.improving[0].id).toBe('kind-patches');expect(result.movers.declining[0].id).toBe('beam');
 });
 it('retains zeros and missing dates and uses matched context instead of full earlier days',()=>{
  const kp=record();kp.datasetSeries.overview=[point('2026-10-15',900),point('2026-10-16',120)];kp.trendDatasetSeries.overview=[point('2026-10-10',0),point('2026-10-15',110),point('2026-10-16',999)];kp.trendComparisonDatasetSeries.overview=[point('2026-10-09',10),point('2026-10-14',100),point('2026-10-15',110)];
  const brand=buildPortfolioOverview([kp],filters,{metric:'revenue',window:'7d'}).brands[0];
  expect(brand.points).toHaveLength(7);expect(brand.points[0]).toMatchObject({date:'2026-10-10',comparisonDate:'2026-10-09',value:0,previous:10,change:-1});
  expect(brand.points[1].value).toBeNull();expect(brand.points[5].value).toBe(110);expect(brand.points[6].value).toBe(120);
  expect(brand.metrics.revenue.value).toBe(120);
 });
 it('does not divide by zero, color missing changes red or mix currencies silently',()=>{
  const kp=record(),beam=record('beam','EUR');kp.prior.revenue=0;beam.metrics.revenue=null;
  const result=buildPortfolioOverview([kp,beam],filters);
  expect(result.mixedCurrencies).toBe(true);expect(result.counts.unavailable).toBe(2);
  expect(result.brands[0].metrics.revenue.change).toBeNull();expect(result.brands[1].metrics.revenue.tone).toBe('neutral');
 });
 it('keeps the Selected multi-day chart in the exact selected KPI population',()=>{
  const selected={...filters,from:'2026-10-15'},kp=record();kp.comparison={...kp.comparison,from:'2026-10-13',to:'2026-10-14'};
  kp.datasetSeries.overview=[point('2026-10-15',900),point('2026-10-16',120)];kp.trendDatasetSeries.overview=[point('2026-10-15',110),point('2026-10-16',999)];
  kp.comparisonDatasetSeries.overview=[point('2026-10-13',800),point('2026-10-14',100)];kp.trendComparisonDatasetSeries.overview=[point('2026-10-13',90),point('2026-10-14',80)];
  expect(buildPortfolioOverview([kp],selected,{window:'selected'}).brands[0].points).toEqual([{date:'2026-10-15',comparisonDate:'2026-10-13',value:900,previous:800,change:.125},{date:'2026-10-16',comparisonDate:'2026-10-14',value:120,previous:100,change:.2}]);
  expect(buildPortfolioOverview([kp],selected,{window:'7d'}).brands[0].points.find(point=>point.date==='2026-10-15')?.value).toBe(110);
 });
 it('uses resolved brand-local dates for links, comparison and chart context',()=>{
  const kp={...record(),resolvedFilters:{...filters,from:'2026-10-17',to:'2026-10-17'}},beam={...record('beam'),resolvedFilters:filters};kp.comparison={...kp.comparison,from:'2026-10-16',to:'2026-10-16'};
  const result=buildPortfolioOverview([kp,beam],{...filters,period:'today'});
  expect(result.brands[0]).toMatchObject({from:'2026-10-17',comparisonFrom:'2026-10-16',timezone:'Europe/Stockholm'});
  expect(result.brands[0].href).toContain('from=2026-10-17');expect(result.brands[0].points.at(-1)?.date).toBe('2026-10-17');
  expect(result.brands[1].points.at(-1)?.date).toBe('2026-10-16');
 });
 it('uses the same latest-review priorities for pulse and scorecard',()=>{
  const kp=record();kp.reviews=[{id:'review-1',clientId:kp.client.id,storeDate:'2026-10-15',revision:1,fingerprint:'x',createdAt:'2026-10-16T12:00:00Z',current:true,payload:{type:'ai',actions:[{title:'Check acquisition cost',detail:'Evidence',nextStep:'Inspect channels',severity:'act',impact:null,sourceIds:[]}]}}];
  const result=buildPortfolioOverview([kp],filters);
  expect(result.alerts).toHaveLength(1);expect(result.counts.priorities).toBe(1);expect(result.brands[0].priorities).toBe(1);expect(result.counts.unassigned).toBe(1);
  expect(result.brands[0].review?.href).toContain('review-1');
 });
 it('shows Motion provider-date spend but withholds a live matched-hour growth claim',()=>{
  const beam={...record('beam'),portfolioMediaReports:[{date:'2026-10-16',spend:500,currency:'USD',asOf:'2026-10-16T18:00:00Z',timezone:'provider_account_timezone_unverified',quality:'partial' as const,sourceId:'motion'},{date:'2026-10-15',spend:400,currency:'USD',asOf:'2026-10-16T16:00:00Z',timezone:null,quality:'complete' as const,sourceId:'motion'}]};
  const brand=buildPortfolioOverview([beam],filters,{metric:'spend'}).brands[0];
  expect(brand.metrics.spend).toMatchObject({value:500,previous:400,change:null,tone:'neutral'});expect(brand.spendScope).toContain('Motion');
  expect(brand.points.at(-1)).toMatchObject({value:500,previous:400,change:null});
  const earlier={...beam,portfolioMediaReports:[...beam.portfolioMediaReports,{date:'2026-10-14',spend:200,currency:'USD',asOf:'2026-10-15T16:00:00Z',timezone:null,quality:'complete' as const,sourceId:'motion'}]};
  expect(buildPortfolioOverview([earlier],filters,{metric:'spend'}).brands[0].points.find(point=>point.date==='2026-10-15')?.change).toBe(1);
 });
 it('qualifies closed Motion growth only with one complete report per actual date and compatible currency',()=>{
  const closed={...filters,from:'2026-10-15',to:'2026-10-15',mode:'closed' as const},beam={...record('beam'),resolvedFilters:closed,comparison:{...filters,from:'2026-10-14',to:'2026-10-14'},portfolioMediaReports:[{date:'2026-10-15',spend:500,currency:'USD',asOf:'2026-10-16T16:00:00Z',timezone:null,quality:'complete' as const,sourceId:'motion'},{date:'2026-10-14',spend:400,currency:'USD',asOf:'2026-10-15T16:00:00Z',timezone:null,quality:'complete' as const,sourceId:'motion'}]};
  expect(buildPortfolioOverview([beam],closed).brands[0].metrics.spend.change).toBe(.25);
  expect(buildPortfolioOverview([{...beam,portfolioMediaReports:[...beam.portfolioMediaReports,beam.portfolioMediaReports[0]]}],closed).brands[0].metrics.spend.change).toBeNull();
  expect(buildPortfolioOverview([{...beam,portfolioMediaReports:beam.portfolioMediaReports.map(r=>({...r,quality:'partial' as const}))}],closed).brands[0].metrics.spend.change).toBeNull();
 });
 it('identifies missing provider dates as subtotals in both spend periods',()=>{
  const selected={...filters,from:'2026-10-15'},beam={...record('beam'),resolvedFilters:selected,comparison:{...filters,from:'2026-10-13',to:'2026-10-14'},portfolioMediaReports:[{date:'2026-10-16',spend:500,currency:'USD',asOf:'2026-10-16T18:00:00Z',timezone:null,quality:'partial' as const,sourceId:'motion'},{date:'2026-10-14',spend:400,currency:'USD',asOf:'2026-10-15T16:00:00Z',timezone:null,quality:'complete' as const,sourceId:'motion'}]};
  const brand=buildPortfolioOverview([beam],selected).brands[0];expect(brand.spendNote).toContain('Reported subtotal · 1/2');expect(brand.spendNote).toContain('Comparison subtotal 1/2');expect(brand.metrics.spend.change).toBeNull();expect(brand.spendScope).toContain('timezone unverified');
 });
});
