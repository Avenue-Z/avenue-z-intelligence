import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {ProductWorkspace,productChartContext} from '../../components/analytics/product-workspace';
import {ClientWorkspace} from '../../components/analytics/client-workspace';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';

const client:Client={id:'kind',name:'Kind',slug:'kind',timezone:'Europe/Stockholm',currency:'USD',color:'#4368c4',version:1,config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'net_sales',spendChannels:[],recurringLabel:'Recurring orders',minSessions:100,minOpportunity:5,maxActions:6,reviewTime:'09:00',reviewTimezone:'America/New_York',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-11',to:'2026-10-11',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'products'};
const base={...workspacePresentation(queryClient(client,[],[],filters),filters),reviews:[],findings:[],note:{body:'',version:0}};
const history=Array.from({length:7},(_,index)=>({date:`2026-10-${String(index+5).padStart(2,'0')}`,metrics:{revenue:100+index*10,orders:10,discounts:index},summary:{revenue:100+index*10,orders:10,aov:10+index}}));
const record={...base,datasetSeries:{products:[{date:'2026-10-11',metrics:{revenue:200,orders:8},summary:{revenue:200,orders:8,aov:25}}]},comparisonDatasetSeries:{products:[{date:'2026-10-10',metrics:{revenue:180,orders:9},summary:{revenue:180,orders:9,aov:20}}]},trendDatasetSeries:{products:history},trendComparisonDatasetSeries:{products:history.map(day=>({...day,date:`2026-10-${String(Number(day.date.slice(-2))-1).padStart(2,'0')}`}))}};

it('plots loaded product history for a one-day selection and keeps the actual comparison dates',()=>{
 const context=productChartContext(record,filters,'7d');
 expect(context.series).toHaveLength(7);
 expect(context.series.map(point=>point.revenue)).toEqual([100,110,120,130,140,150,200]);
 expect(context.series.at(-1)?.aov).toBe(25);
 expect(context.comparisonSeries[0].date).toBe('2026-10-04');
 expect(context.comparisonSeries.at(-1)?.revenue).toBe(180);
 const html=renderToStaticMarkup(createElement(ProductWorkspace,{record,filters}));
 expect(html).toContain('Product performance over time');
 expect(html).toContain('7 days');
 expect(html).toContain('30 days');
 expect(html).toContain('Selected period');
 expect(html).toContain('2026-10-05 – 2026-10-11');
 expect(html).toContain('Product order counts can overlap');
});
it('uses only the selected store date when selected-period context is requested',()=>{
 const context=productChartContext(record,filters,'selected');
 expect(context.series.map(point=>[point.date,point.revenue])).toEqual([['2026-10-11',200]]);
 expect(context.comparisonSeries.map(point=>[point.date,point.revenue])).toEqual([['2026-10-10',180]]);
});

it('identifies overlapping product-order averages accurately in the card, chart control and detail comparisons',()=>{
 const observations:Observation[]=['2026-10-10','2026-10-11'].flatMap(date=>[
  {product:'Dream',revenue:date===filters.to?20:10},
  {product:'Burn',revenue:date===filters.to?10:5}
 ].flatMap(product=>Object.entries({revenue:product.revenue,orders:1}).map(([metric,value])=>({
  date,dataset:'products',metric,value,dimensions:{product:product.product,channel:'Web'},
  definition:'shopify_product_net_sales_orders_may_overlap',population:'shopify_product_sales',
  sourceId:'shopify',retrievedAt:'2026-10-12T00:00:00Z',coverageThrough:'2026-10-12T00:00:00Z',
  currency:metric==='revenue'?'USD':null,quality:'complete' as const
 }))));
 const productRecord={...workspacePresentation(queryClient(client,observations,[],filters,{prepareAllViews:true}),filters),reviews:[],findings:[],note:{body:'',version:0}};
 // One order can contain both products: the supplied product incidences sum to two,
 // so $30 / 2 is $15 per product order, not a $30 store basket average.
 expect(productRecord.viewMetrics).toMatchObject({revenue:30,orders:2,aov:15});
 expect(productRecord.viewPriorMetrics).toMatchObject({revenue:15,orders:2,aov:7.5});
 const html=renderToStaticMarkup(createElement(ClientWorkspace,{record:productRecord,filters,mutate:async()=>({}),update:()=>{},admin:false}));
 const card=html.match(/<div class="stat-card"><span class="stat-label">Revenue per product order<\/span>([\s\S]*?)<\/div>/)?.[1]??'';
 expect(card).toContain('<strong>$15</strong>');
 expect(card).toContain('vs yesterday · $8');
 expect(card).toContain('+100.0%');
 expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*><i[^>]*><\/i>Revenue per product order<\/button>/);
 expect(html).toMatch(/<th[^>]*><button>Revenue per product order<\/button><\/th>/);
 expect(html).toContain('vs yesterday · $10');
 expect(html).toContain('vs yesterday · $5');
 expect(html).not.toContain('Average order value');
 expect(html).not.toContain('>AOV<');
});
