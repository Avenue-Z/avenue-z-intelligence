import {expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {RevenueWorkspace} from '../../components/analytics/revenue-workspace';
import {ClientWorkspace} from '../../components/analytics/client-workspace';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';
import type {ClientRecord} from '../../components/analytics/records';

const filters:QueryFilters={from:'2026-10-11',to:'2026-10-11',mode:'closed',compare:'previous',view:'revenue',market:'',stream:'',source:'',device:'',page:''};
const client:Client={id:'kind-patches',slug:'kind-patches',name:'Kind Patches',version:1,timezone:'Europe/Stockholm',currency:'USD',color:'#2549c5',config:{markets:['US'],spendChannels:[],revenueDefinition:'web',incidents:[],recurringLabel:'Subscription',benchmarkMarket:'US',minSessions:100,minOpportunity:5,maxActions:6,reviewMode:'closed',reviewTime:'09:00',reviewTimezone:'America/New_York'}};
const rows:Observation[]=['2026-10-10','2026-10-11'].flatMap(date=>[['revenue',date===filters.to?200:100],['orders',date===filters.to?20:10]].map(([metric,value])=>({date,metric:String(metric),value:Number(value),dataset:'revenue',definition:'shopify_net_sales',population:'shopify_sales',dimensions:{stream:'Online Store'},sourceId:'sales',retrievedAt:'2026-10-12T00:00:00Z',coverageThrough:'2026-10-12T00:00:00Z',currency:metric==='revenue'?'USD':null,quality:'complete'})));
function record():ClientRecord{const analytics=workspacePresentation(queryClient(client,rows,[],filters,{preparedDatasets:['overview','revenue','subscriptions','subscriptionEvents','orderStreams','orderHygiene']}),filters);return {...analytics,findings:[],reviews:[],note:{body:'',version:0}};}
it('renders meaningful selected-day statistics and a daily context chart with analyst controls',()=>{
 const html=renderToStaticMarkup(createElement(RevenueWorkspace,{record:record(),filters,update:()=>{}}));
 expect(html).toContain('$200.00');expect(html).toContain('$100.00');expect(html).toContain('+100.0%');expect(html).toContain('Thirty daily totals');expect(html).toContain('2026-10-10');expect(html).toContain('Average order value');expect(html).toContain('Daily bars');expect(html).toContain('Chart + table');expect(html).toContain('Sales channel drivers');expect(html).not.toContain('Choose a longer period');
});
it('renders the supported sales-channel filter and removes four misleading unavailable filters',()=>{
 const html=renderToStaticMarkup(createElement(ClientWorkspace,{record:record(),filters,update:()=>{},mutate:async()=>({}),admin:false}));
 expect(html).toContain('Sales channel');expect(html).toContain('sales channel filter');expect(html).not.toContain('market filter');expect(html).not.toContain('device filter');expect(html).not.toContain('source filter');expect(html).not.toContain('page filter');expect(html).not.toContain('<option value="">Unavailable</option>');
});
it('uses actual hourly sales on today without diverting the user to Overview',()=>{
 const r=record(),f={...filters,mode:'partial' as const},hourly=[{date:f.to,start:'2026-10-11T00:00:00Z',end:'2026-10-11T01:00:00Z',metrics:{revenue:80,orders:4},summary:{...r.datasetSeries.revenue[0].summary,revenue:80,orders:4,aov:20}}];
 const html=renderToStaticMarkup(createElement(RevenueWorkspace,{record:{...r,cutoff:'2026-10-11T01:00:00Z',datasetHourlySeries:{revenue:hourly},comparisonDatasetHourlySeries:{}} as ClientRecord,filters:f,update:()=>{}}));
 expect(html).toContain('Actual hourly intervals');expect(html).toContain('Hourly');expect(html).toContain('Daily context');expect(html).toContain('hours reported');expect(html).not.toContain('reports cover closed store days');expect(html).not.toContain('use Overview');
});
