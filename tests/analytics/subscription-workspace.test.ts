import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {SubscriptionWorkspace,subscriptionChartExplorer} from '../../components/analytics/subscription-workspace';
import {ClientWorkspace} from '../../components/analytics/client-workspace';
import {OrderStreamDiagnostics} from '../../components/analytics/order-diagnostics';
import type {ClientRecord} from '../../components/analytics/records';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import {subscriptionMetricValue} from '../../lib/analytics/subscription-explorer';
import type {Client,QueryFilters} from '../../lib/analytics/contracts';

const client:Client={id:'kind',name:'Kind',slug:'kind',timezone:'Europe/Stockholm',currency:'USD',color:'#4368c4',version:1,config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'net_sales',spendChannels:[],recurringLabel:'Recurring orders',minSessions:100,minOpportunity:5,maxActions:6,reviewTime:'09:00',reviewTimezone:'America/New_York',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-11',to:'2026-10-11',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'subscriptions'};
const base={...workspacePresentation(queryClient(client,[],[],filters),filters),reviews:[],findings:[],note:{body:'',version:0}};
const commerce=[{date:'2026-10-11',metrics:{recurring_revenue:200,recurring_orders:10,recurring_cancelled_orders:4,recurring_refund_orders:1}}];
const prior=[{date:'2026-10-10',metrics:{recurring_revenue:180,recurring_orders:10,recurring_cancelled_orders:2,recurring_refund_orders:0}}];

it('does not display cohort cancellations as actual subscriptions cancelled on a calendar day',()=>{
 const html=renderToStaticMarkup(createElement(SubscriptionWorkspace,{record:{...base,datasetSeries:{subscriptions:commerce},comparisonDatasetSeries:{subscriptions:prior}},filters,update:()=>{}}));
 expect(html).toMatch(/SUBSCRIPTIONS CANCELLED<\/span><strong>Not captured<\/strong>/);
 expect(html).toContain('Cancelled renewal orders');
 expect(html).toContain('order-date cohort');
});
it('shows actual calendar-date events separately and exposes comparison and chart controls',()=>{
 const html=renderToStaticMarkup(createElement(SubscriptionWorkspace,{record:{...base,datasetSeries:{subscriptions:commerce,subscriptionEvents:[{date:'2026-10-11',metrics:{subscription_cancellation_events:12}}]},comparisonDatasetSeries:{subscriptions:prior,subscriptionEvents:[{date:'2026-10-10',metrics:{subscription_cancellation_events:8}}]}},filters,update:()=>{}}));
 expect(html).toMatch(/SUBSCRIPTIONS CANCELLED<\/span><strong>12<\/strong>/);
 expect(html).toContain('Subscriptions cancelled: Increased +50.00%; unfavorable');
 expect(html).toContain('data-tone="unfavorable" data-direction="up"');
 expect(html).toContain('yesterday: 8');
 expect(html).toContain('Renewal revenue: Increased +11.11%; favorable');
 expect(html).toContain('Renewal orders: Unchanged 0.00%; neutral');
 expect(html).toContain('Refunded-order rate: Increased +10.00 pp; unfavorable');
 expect(html).toContain('aria-label="Subscription comparison"');
 expect(html).toContain('value="thirtyDays"');
 expect(html).toContain('value="custom"');
 expect(html).toContain('aria-label="Cancellation &amp; refund trends chart type"');
 expect(html).toContain('Europe/Stockholm · 2026-10-05 – 2026-10-11');
 expect(html).toContain('<option value="line" selected="">Line chart</option>');
});
it('gives a one-day selection seven real daily observations without changing its KPI period',()=>{
 const history=Array.from({length:7},(_,index)=>({date:`2026-10-${String(index+5).padStart(2,'0')}`,metrics:{recurring_revenue:100+index*10,recurring_orders:10,recurring_refund_orders:index,recurring_cancelled_orders:0}}));
 const record={...base,datasetSeries:{subscriptions:commerce},comparisonDatasetSeries:{subscriptions:prior},trendDatasetSeries:{subscriptions:history},trendComparisonDatasetSeries:{subscriptions:history.map(day=>({...day,date:day.date==='2026-10-05'?'2026-10-04':`2026-10-${String(Number(day.date.slice(-2))-1).padStart(2,'0')}`}))}};
 const chart=subscriptionChartExplorer(record,filters,'7d');
 expect(chart.points).toHaveLength(7);
 expect(chart.points.map(point=>point.selected.recurring_revenue)).toEqual([100,110,120,130,140,150,200]);
 expect(chart.points[0].comparisonDate).toBe('2026-10-04');
 expect(chart.points.at(-1)?.comparison.recurring_revenue).toBe(180);
 const html=renderToStaticMarkup(createElement(SubscriptionWorkspace,{record,filters,update:()=>{}}));
 expect(html).toContain('7 days');
 expect(html).toContain('30 days');
 expect(html).toContain('Selected period');
 expect(html).toMatch(/RENEWAL REVENUE<\/span><strong>\$200<\/strong>/);
 expect(html).toContain('2026-10-05 – 2026-10-11');
});
it('retains unknown renewal history as gaps and calculates daily rates with matching daily counts',()=>{
 const record={...base,datasetSeries:{subscriptions:commerce},comparisonDatasetSeries:{subscriptions:prior},trendDatasetSeries:{subscriptions:[{date:'2026-10-06',metrics:{recurring_revenue:40,recurring_orders:2,recurring_refund_orders:1}}]}};
 const chart=subscriptionChartExplorer(record,filters,'7d');
 expect(chart.points[0].selected.recurring_orders).toBeNull();
 expect(chart.points[1].selected.recurring_orders).toBe(2);
 expect(chart.points[1].selected.recurring_refund_orders).toBe(1);
 expect(subscriptionMetricValue(chart.points[1].selected,'refund_rate')).toBe(.5);
 expect(subscriptionMetricValue(chart.points[0].selected,'refund_rate')).toBeNull();
 expect(chart.points.at(-1)?.selected.recurring_orders).toBe(10);
});

it('prominently shows creation-day cancellation rate with cohort counts and a favorable decline against the selected baseline',()=>{
 const html=renderToStaticMarkup(createElement(SubscriptionWorkspace,{record:{...base,datasetSeries:{subscriptions:commerce,subscriptionEvents:[{date:'2026-10-11',metrics:{new_subscriptions:100,same_day_subscription_cancellation_events:5,subscription_cancellation_events:12}}]},comparisonDatasetSeries:{subscriptions:prior,subscriptionEvents:[{date:'2026-10-10',metrics:{new_subscriptions:80,same_day_subscription_cancellation_events:8,subscription_cancellation_events:14}}]}},filters,update:()=>{}}));
 expect(html).toMatch(/SAME-DAY CANCELLATION RATE<\/span><strong>5.00%<\/strong>/);expect(html).toContain('5 cancellations · 100 new subscriptions');expect(html).toContain('Same-day cancellation rate: Decreased -5.00 pp; favorable');expect(html).toContain('yesterday: 10.00%');expect(html).not.toContain('About these numbers');expect(html).not.toContain('Counts and revenue sum captured days.');expect(html).not.toContain('Recurring revenue divided by matching recurring orders');
});
it('shows favorable and unfavorable percentage-point changes for the matched weekly renewal rates',()=>{
 const record={...base,subscriptions:{...base.subscriptions,current:{...base.subscriptions.current,refundRate:.05,cancellationRate:.08},comparison:{...base.subscriptions.comparison,refundRate:.10,cancellationRate:.04}}};
 const html=renderToStaticMarkup(createElement(SubscriptionWorkspace,{record,filters,update:()=>{}}));
 expect(html).toContain('Refunded-order rate: Decreased -5.00 pp; favorable');expect(html).toContain('Renewal-order cancellation rate: Increased +4.00 pp; unfavorable');
});

it('shows event-backed creation-day cancellations and leaves an older current-state-only comparison unavailable',()=>{
 const record={...base,datasetSeries:{subscriptions:commerce,subscriptionEvents:[{date:filters.to,metrics:{new_subscriptions:100,same_day_subscription_cancellations:2,same_day_subscription_cancellation_events:8,subscription_cancellation_events:12,subscription_cancellations:99}}]},comparisonDatasetSeries:{subscriptions:prior,subscriptionEvents:[{date:'2026-10-10',metrics:{new_subscriptions:100,same_day_subscription_cancellations:5,subscription_cancellations:22}}]}};
 const html=renderToStaticMarkup(createElement(SubscriptionWorkspace,{record,filters,update:()=>{}}));
 expect(html).toMatch(/SAME-DAY CANCELLATION RATE<\/span><strong>8.00%<\/strong>/);
 expect(html).toContain('8 cancellations · 100 new subscriptions');expect(html).not.toContain('2 cancellations ·');
 expect(html).toContain('Same-day cancellation rate: No prior data; neutral');expect(html).not.toContain('yesterday: 5.00%');
 expect(html).toMatch(/SUBSCRIPTIONS CANCELLED<\/span><strong>12<\/strong>/);expect(html).toContain('Subscriptions cancelled: No prior data; neutral');expect(html).not.toContain('yesterday: 22');
 expect(html).toContain('No prior data');expect(html).not.toContain('About these numbers');
});

it('promotes the actual latest active-customer snapshot once and removes both subscription disclosures',()=>{
 const record={...base,liveOperations:[{date:'2026-10-14',dataset:'subscriptions',metric:'active_customers',value:123456,definition:'recharge_raw_active_customers_not_subscription_count_or_baseline_adjusted',population:'recharge_active_customers',currency:null,dimensions:{source:'recharge'},sourceId:'source',retrievedAt:'2026-10-14T20:45:00Z',coverageThrough:null,quality:'complete' as const}]};
 const html=renderToStaticMarkup(createElement(ClientWorkspace,{record,filters:{...filters,market:'US'},update:()=>{},mutate:async()=>{},admin:false}));
 expect(html).toMatch(/ACTIVE CUSTOMERS<\/span><strong>123,456<\/strong>/);
 expect(html.match(/123,456/g)).toHaveLength(1);
 expect(html).toContain('Latest Recharge snapshot · Oct 14, 2026, 10:45 PM · Europe/Stockholm');
 expect(html).toContain('All markets · latest snapshot');
 expect(html).not.toContain('operations-strip');expect(html).not.toContain('About these numbers');expect(html).not.toContain('Subscription performance');
 expect(html).toContain('aria-label="Subscription comparison"');expect(html).toContain('Export renewal data');
});

it('keeps an unqualified multi-day same-day rate missing and shows real cohort coverage',()=>{
 const selected={...filters,from:'2026-09-14',to:'2026-10-13'},record={...base,datasetSeries:{subscriptionEvents:[{date:'2026-10-13',metrics:{new_subscriptions:100,same_day_subscription_cancellation_events:8}}]}};
 const html=renderToStaticMarkup(createElement(SubscriptionWorkspace,{record,filters:selected,update:()=>{}}));
 expect(html).toMatch(/SAME-DAY CANCELLATION RATE<\/span><strong>—<\/strong>/);
 expect(html).toContain('Creation-day coverage: 1 / 30 days');
 expect(html).toMatch(/ACTIVE CUSTOMERS<\/span><strong>—<\/strong>/);
 expect(html).not.toMatch(/SAME-DAY CANCELLATION RATE<\/span><strong>8.00%<\/strong>/);
 expect(html).toMatch(/<strong[^>]*>New subscriptions<\/strong><\/td><td>—<\/td>/);
 expect(html).toContain('2026-10-13');expect(html).toContain('<td>100<small');
});

it('uses only the optional verified same-hour customer baseline, preserving missing and zero-baseline semantics',()=>{
 const current={date:'2026-10-14',dataset:'subscriptions',metric:'active_customers',value:120,definition:'recharge_raw_active_customers_not_subscription_count_or_baseline_adjusted',population:'recharge_active_customers',currency:null,dimensions:{source:'recharge'},sourceId:'source',retrievedAt:'2026-10-14T21:20:35Z',coverageThrough:'2026-10-14T21:20:32Z',quality:'complete' as const};
 const render=(value:number,baseline?:number)=>renderToStaticMarkup(createElement(SubscriptionWorkspace,{record:{...base,liveOperations:[{...current,value}],...baseline!==undefined?{activeCustomerComparison:{baseline:{value:baseline,asOf:'2026-10-13T21:20:30Z',retrievedAt:'2026-10-13T21:20:34Z',snapshotId:'actual-prior-snapshot'},delta:value-baseline,relativeChange:baseline?(value-baseline)/baseline:null,alignment:'same-store-hour' as const}}:{}},filters,update:()=>{}}));
 const up=render(120,100),down=render(80,100),missing=render(120),zero=render(120,0);
 expect(up).toContain('Increased +20.0% vs same hour yesterday');expect(up).toContain('data-tone="favorable"');expect(up).toContain('same hour yesterday · 100');
 expect(up).toContain('Current snapshot: Oct 14, 2026, 11:20 PM');expect(up).toContain('Baseline snapshot: Oct 13, 2026, 11:20 PM');
 expect(down).toContain('Decreased -20.0% vs same hour yesterday');expect(down).toContain('data-tone="unfavorable"');
 expect(missing).toMatch(/ACTIVE CUSTOMERS<\/span><strong>120<\/strong>/);expect(missing).not.toContain('same hour yesterday');
 expect(zero).toContain('Increased +120 vs same hour yesterday');expect(zero).toContain('same hour yesterday · 0');expect(zero).not.toContain('Infinity');
});

it('removes the lower order-type disclosure only on subscriptions and retains its evidence and other views',()=>{
 const record={...base,views:{...base.views,orderStreams:{details:[{dimensions:{order_stream:'one_time',store_date:filters.to},metrics:{revenue:120,orders:10,units:20}}]}}} as unknown as ClientRecord;
 const before=JSON.stringify(record),html=renderToStaticMarkup(createElement(OrderStreamDiagnostics,{record,filters}));
 expect(html).toContain('Which order type moved?');expect(html).toContain('One-time web orders');expect(html).toContain('AOV by order type');
 expect(html).not.toContain('About these numbers');expect(html).toContain('title="Acquisition uses positive-value web orders.');expect(JSON.stringify(record)).toBe(before);
 const revenue=renderToStaticMarkup(createElement(OrderStreamDiagnostics,{record,filters:{...filters,view:'revenue'}}));
 expect(revenue).toContain('About these numbers');expect(revenue).toContain('Merchandise revenue excludes shipping and tax');
});
