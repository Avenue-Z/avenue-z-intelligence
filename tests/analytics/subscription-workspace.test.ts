import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {SubscriptionWorkspace} from '../../components/analytics/subscription-workspace';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
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
 expect(html).toContain('+50.00% vs comparison');
 expect(html).toContain('aria-label="Subscription comparison"');
 expect(html).toContain('value="thirtyDays"');
 expect(html).toContain('value="custom"');
 expect(html).toContain('aria-label="Cancellation &amp; refund trends chart type"');
 expect(html).toContain('Europe/Stockholm calendar dates');
 expect(html).toContain('<option value="bar" selected="">Bar chart</option>');
});
