import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import {ExecutiveOverview} from '../../components/analytics/executive-overview';
import clients from '../../data/initial-clients.json';

const filters:QueryFilters={from:'2026-10-15',to:'2026-10-15',compare:'previous',mode:'closed',view:'overview',market:'',source:'',stream:'',device:'',page:''};
function record(id:string,revenue:number){
 const client=clients.find(value=>value.id===id) as Client;
 const rows:Observation[]=['2026-10-14','2026-10-15'].flatMap((date,index)=>[['revenue',index?revenue:revenue/2],['orders',index?20:10],['sessions',index?1000:800],['converting_sessions',index?20:16]].map(([metric,value])=>({date,dataset:'overview',metric:String(metric),value:Number(value),dimensions:{},definition:'overview',population:'human_sessions',currency:metric==='revenue'?'USD':null,sourceId:`${id}-overview`,retrievedAt:'2026-10-16T12:00:00Z',coverageThrough:null,quality:'complete'})));
 return {...workspacePresentation(queryClient(client,rows,[],filters,{prepareAllViews:true}),filters),reviews:[],findings:[],note:{body:'',version:0}};
}

it('renders a comparable brand scorecard and the existing shared action queue without adding a portfolio total',()=>{
 const html=renderToStaticMarkup(createElement(ExecutiveOverview,{records:[record('kind-patches',1200),record('beam',2400)],filters,mutate:async()=>{}}));
 expect(html).toContain('Brand performance');expect(html).toContain('Selected period');
 expect(html).toContain('Needs attention');expect(html).toContain('Revenue movers');
 for(const label of ['Revenue','Orders','Sessions','CVR','AOV','Spend'])expect(html).toContain(label);
 expect(html).toContain('/clients/beam');expect(html).toContain('/clients/kind-patches');
 expect(html).not.toContain('$3,600');expect(html).not.toContain('Portfolio revenue');
});

import {buildPortfolioOverview,PORTFOLIO_METRICS} from '../../lib/analytics/portfolio';
import {PortfolioChart,PortfolioChartTooltip,PortfolioSparkline,formatPortfolioValue,portfolioChartLine,portfolioChartRows,type PortfolioBrand} from '../../components/analytics/portfolio-chart';
import {sortPortfolioBrands} from '../../components/analytics/executive-overview';
const revenueMetric=PORTFOLIO_METRICS.find(metric=>metric.key==='revenue')!;
function chartBrand():PortfolioBrand{return {...buildPortfolioOverview([record('beam',2400)],filters).brands[0],points:[{date:'2026-10-14',comparisonDate:'2026-10-07',value:0,previous:20.25,change:-1},{date:'2026-10-15',comparisonDate:'2026-10-08',value:null,previous:null,change:null},{date:'2026-10-16',comparisonDate:'2026-10-09',value:10.25,previous:5,change:1.05}]};}

it('retains zeroes and real dated gaps in both actual and own-baseline chart modes without mutating source points',()=>{
 const brand=chartBrand(),before=JSON.stringify(brand);
 expect(portfolioChartRows([brand],'actual')).toEqual([{date:'2026-10-14',brand_0:0,prior_0:20.25},{date:'2026-10-15',brand_0:null,prior_0:null},{date:'2026-10-16',brand_0:10.25,prior_0:5}]);
 expect(portfolioChartRows([brand],'change').map(row=>row.brand_0)).toEqual([-1,null,1.05]);
 expect(JSON.stringify(brand)).toBe(before);
 const rows=portfolioChartRows([brand],'actual');
 expect(portfolioChartLine(brand,0,rows).props).toMatchObject({connectNulls:false,dataKey:'brand_0',dot:{r:2.6}});
 expect(portfolioChartLine(brand,0,rows,true).props).toMatchObject({connectNulls:false,dataKey:'prior_0',strokeDasharray:'5 4'});
});

it('uses each brand’s actual comparison date, units, currency and scope in the chart tooltip',()=>{
 const brand=chartBrand(),html=renderToStaticMarkup(createElement(PortfolioChartTooltip,{active:true,label:'2026-10-14',brands:[brand],metric:revenueMetric,mode:'actual',compare:true}));
 expect(html).toContain('2026-10-14');expect(html).toContain('2026-10-07');expect(html).toContain('$0');expect(html).toContain('$20.25');
 expect(html).toContain('Beam');expect(html).toContain('America/New_York');expect(html).toContain('USD');expect(html).toContain('Net sales ex. Faire');
 const withoutComparison=renderToStaticMarkup(createElement(PortfolioChartTooltip,{active:true,label:'2026-10-14',brands:[brand],metric:revenueMetric,mode:'actual',compare:false}));
 expect(withoutComparison).not.toContain('2026-10-07');
});

it('shows provider report scope and cached freshness for Motion without calling it matched spend',()=>{
 const brand={...chartBrand(),spendScope:'Motion · full Meta account · provider dates · timezone unverified',spendNote:'Cached Oct 16 · partial · 1/2 report dates'},metric=PORTFOLIO_METRICS.find(value=>value.key==='spend')!,html=renderToStaticMarkup(createElement(PortfolioChartTooltip,{active:true,label:'2026-10-14',brands:[brand],metric,mode:'actual',compare:true}));
 expect(html).toContain('full Meta account');expect(html).toContain('timezone unverified');expect(html).toContain('Cached Oct 16');expect(html).toContain('1/2 report dates');expect(html).not.toContain('MER');expect(html).not.toContain('matched hour');
});

it('forces own-baseline change for different currencies and presents all metric/range controls',()=>{
 const brand=chartBrand(),html=renderToStaticMarkup(createElement(PortfolioChart,{brands:[brand,{...brand,id:'euro-brand',name:'Euro Brand',currency:'EUR'}],metric:revenueMetric,window:'7d',mixedCurrencies:true,onMetric:()=>{},onWindow:()=>{}}));
 expect(html).toMatch(/aria-pressed="false" disabled=""[^>]*>Actual values/);
 expect(html).toMatch(/aria-pressed="true"[^>]*>Change vs baseline/);
 expect(html).toContain('Different currencies');expect(html).toContain('Portfolio chart metric');expect(html).toContain('30D');expect(html).toContain('Selected');
 expect(html).toContain('Chart brands');expect(html).toContain('Euro Brand');expect(html).toContain('Comparison');
});

it('draws separate sparkline segments across missing days while retaining a real zero',()=>{
 const brand=chartBrand(),html=renderToStaticMarkup(createElement(PortfolioSparkline,{points:brand.points,color:brand.color,label:'Beam revenue trend'}));
 expect(html).toContain('2026-10-14: 0');expect(html).toContain('2026-10-16: 10.25');
 expect(html.match(/<circle/g)).toHaveLength(2);expect(html.match(/d="([^"]*)"/)?.[1].match(/M/g)).toHaveLength(2);
 expect(html).not.toContain('NaN');
});

it('keeps unavailable brands last in either numeric sort direction and does not reorder the input',()=>{
 const base=chartBrand(),missing={...base,id:'missing',name:'Missing',metrics:{...base.metrics,revenue:{...base.metrics.revenue,value:null}}},zero={...base,id:'zero',name:'Zero',metrics:{...base.metrics,revenue:{...base.metrics.revenue,value:0}}},input=[missing,base,zero],before=input.map(brand=>brand.id);
 expect(sortPortfolioBrands(input,{key:'revenue',direction:'desc'}).map(brand=>brand.id)).toEqual([base.id,'zero','missing']);
 expect(sortPortfolioBrands(input,{key:'revenue',direction:'asc'}).map(brand=>brand.id)).toEqual(['zero',base.id,'missing']);expect(input.map(brand=>brand.id)).toEqual(before);
});

it('shows assigned business priorities and dated review links through the shared queue',()=>{
 const base=record('beam',2400),selected={...base,findings:[{id:'action-1',clientId:'beam',title:'Check the offer mix',detail:'Compare the dated source cohorts.',owner:'Morgan',status:'investigating',severity:'act',evidence:[],version:1,updatedAt:'2026-10-16T12:00:00Z'}],reviews:[{id:'review-1',clientId:'beam',storeDate:'2026-10-15',current:true,revision:1,fingerprint:'same-evidence',createdAt:'2026-10-16T12:00:00Z',payload:{}}]},html=renderToStaticMarkup(createElement(ExecutiveOverview,{records:[selected],filters,mutate:async()=>{}}));
 expect(html).toContain('Check the offer mix');expect(html).toContain('Morgan');expect(html).toContain('Investigating');expect(html).toContain('/clients/beam/reviews/review-1');expect(html).toContain('Latest reviews');
});

it('formats actual zero, conversion rates and average order value without substituting missing values',()=>{
 expect(formatPortfolioValue(0,revenueMetric,'USD')).toBe('$0');expect(formatPortfolioValue(null,revenueMetric,'USD')).toBe('—');
 expect(formatPortfolioValue(0,PORTFOLIO_METRICS.find(metric=>metric.key==='cvr')!,'USD')).toBe('0.00%');
 expect(formatPortfolioValue(10.2,PORTFOLIO_METRICS.find(metric=>metric.key==='aov')!,'USD')).toBe('$10.20');
});

it('keeps actual count values available for brands with different currencies',()=>{
 const brand=chartBrand(),metric=PORTFOLIO_METRICS.find(value=>value.key==='sessions')!,html=renderToStaticMarkup(createElement(PortfolioChart,{brands:[brand,{...brand,id:'euro-brand',name:'Euro Brand',currency:'EUR'}],metric,window:'7d',mixedCurrencies:true,onMetric:()=>{},onWindow:()=>{}}));
 expect(html).toMatch(/aria-pressed="true"[^>]*>Actual values/);expect(html).not.toContain('Different currencies · showing change');
});

it('renders genuine prior-only chart data while leaving the missing current value blank',()=>{
 const brand={...chartBrand(),points:[{date:'2026-10-14',comparisonDate:'2026-10-07',value:null,previous:20.25,change:null}]},html=renderToStaticMarkup(createElement(PortfolioChart,{brands:[brand],metric:revenueMetric,window:'selected',mixedCurrencies:false,onMetric:()=>{},onWindow:()=>{}}));
 expect(html).toContain('role="img"');expect(html).not.toContain('No dated revenue comparison available');
 expect(portfolioChartRows([brand],'actual')).toEqual([{date:'2026-10-14',brand_0:null,prior_0:20.25}]);
});
