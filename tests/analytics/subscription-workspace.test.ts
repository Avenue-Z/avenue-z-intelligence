import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {SubscriptionWorkspace,subscriptionChartExplorer} from '../../components/analytics/subscription-workspace';
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
 const html=renderToStaticMarkup(createElement(SubscriptionWorkspace,{record:{...base,datasetSeries:{subscriptions:commerce,subscriptionEvents:[{date:'2026-10-11',metrics:{subscription_cancellations:12}}]},comparisonDatasetSeries:{subscriptions:prior,subscriptionEvents:[{date:'2026-10-10',metrics:{subscription_cancellations:8}}]}},filters,update:()=>{}}));
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
 const html=renderToStaticMarkup(createElement(SubscriptionWorkspace,{record:{...base,datasetSeries:{subscriptions:commerce,subscriptionEvents:[{date:'2026-10-11',metrics:{new_subscriptions:100,same_day_subscription_cancellations:5,subscription_cancellations:12}}]},comparisonDatasetSeries:{subscriptions:prior,subscriptionEvents:[{date:'2026-10-10',metrics:{new_subscriptions:80,same_day_subscription_cancellations:8,subscription_cancellations:14}}]}},filters,update:()=>{}}));
 expect(html).toMatch(/SAME-DAY CANCELLATION RATE<\/span><strong>5.00%<\/strong>/);expect(html).toContain('5 cancellations · 100 new subscriptions');expect(html).toContain('Same-day cancellation rate: Decreased -5.00 pp; favorable');expect(html).toContain('yesterday: 10.00%');expect(html).toContain('About these numbers');expect(html).not.toContain('Counts and revenue sum captured days.');expect(html).not.toContain('Recurring revenue divided by matching recurring orders');
});
it('shows favorable and unfavorable percentage-point changes for the matched weekly renewal rates',()=>{
 const record={...base,subscriptions:{...base.subscriptions,current:{...base.subscriptions.current,refundRate:.05,cancellationRate:.08},comparison:{...base.subscriptions.comparison,refundRate:.10,cancellationRate:.04}}};
 const html=renderToStaticMarkup(createElement(SubscriptionWorkspace,{record,filters,update:()=>{}}));
 expect(html).toContain('Refunded-order rate: Decreased -5.00 pp; favorable');expect(html).toContain('Renewal-order cancellation rate: Increased +4.00 pp; unfavorable');
});
