import {describe,expect,it,vi} from 'vitest';

// UI components share a path alias; use the actual utility in this node suite.
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {money,number,percent} from '../../components/analytics/dashboard';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DetailTable} from '../../components/analytics/detail-table';
import {ClientWorkspace} from '../../components/analytics/client-workspace';
import {detailRows,queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';

const client:Client={id:'test',name:'Test client',slug:'test',timezone:'UTC',currency:'USD',color:'#2549c5',version:1,config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'net_sales',spendChannels:['meta'],recurringLabel:'Subscriptions',minSessions:100,minOpportunity:5,maxActions:6,reviewTime:'09:00',reviewTimezone:'UTC',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-07',to:'2026-10-07',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'overview'};
function observation(metric:string,value:number,dimensions:Record<string,string>,dataset='funnels'):Observation{return {date:filters.to,metric,value,dataset,dimensions,population:'human_sessions',definition:metric,currency:metric==='revenue'?'USD':null,sourceId:'source',retrievedAt:'2026-10-08T00:00:00Z',coverageThrough:'2026-10-08T00:00:00Z',quality:'complete'};}
function workspace(view:string,observations:Observation[]){const f={...filters,view},record={...workspacePresentation(queryClient(client,observations,[],f),f),reviews:[],findings:[],note:{body:'',version:0}};return renderToStaticMarkup(createElement(ClientWorkspace,{record,filters:f,mutate:async()=>({}),update:()=>{},admin:true}));}

describe('metric display',()=>{
  it.each([null,undefined,NaN,Infinity,-Infinity])('keeps unavailable or invalid values out of the display (%s)',value=>{
    expect(money(value,'USD')).toBe('—');
    expect(number(value)).toBe('—');
    expect(percent(value)).toBe('—');
  });
  it('preserves reported zero and finite values',()=>{
    expect(money(0,'USD')).toBe('$0');
    expect(number(0)).toBe('0');
    expect(percent(0)).toBe('0.00%');
    expect(money(1250,'USD')).toBe('$1,250');
    expect(percent(.024)).toBe('2.40%');
  });
});

describe('detail presentation',()=>{
  it('shows count-derived conversion and checkout rates in the overview table',()=>{
    const rows=[observation('sessions',1000,{page:'/landing'}),observation('converting_sessions',20,{page:'/landing'}),observation('checkouts',100,{page:'/landing'}),observation('completed_checkouts',40,{page:'/landing'})];
    const html=workspace('overview',rows);
    expect(html).toContain('Conversion rate');
    expect(html).toContain('2.00%');
    expect(html).toContain('Checkout completion');
    expect(html).toContain('40.00%');
  });
  it('formats checkout completion as a percentage',()=>{
    const rows=detailRows([observation('checkout_completion',.4,{page:'/landing'})]);
    const html=renderToStaticMarkup(createElement(DetailTable,{rows,currency:'USD',exportHref:'/export'}));
    expect(html).toContain('40.00%');
  });
  it('puts high-volume rows on the first page instead of sparse imported rows',()=>{
    const rows=detailRows([observation('reported_conversion_rate',.02,{page:'/sparse'}),...Array.from({length:30},(_,i)=>observation('sessions',1000+i,{page:`/volume-${i}`}))]);
    const html=renderToStaticMarkup(createElement(DetailTable,{rows,currency:'USD',exportHref:'/export'}));
    expect(html).toContain('/volume-29');
    expect(html).not.toContain('/sparse');
  });
  it.each(['revenue','markets','products'])('uses commerce KPIs for the %s dataset',view=>{
    const html=workspace(view,[observation('revenue',100,{channel:'Web',market:'US',product:'Bundle'},view),observation('orders',5,{channel:'Web',market:'US',product:'Bundle'},view)]);
    expect(html).not.toContain('>CVR<');
    expect(html).not.toContain('>CHECKOUT COMPLETION<');
    expect(html).toContain(view==='products'?'>PRODUCT ORDERS<':'>ORDERS<');
    expect(html).toContain('$20');
  });
});
