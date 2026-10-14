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
import {timestamp} from '../../lib/analytics/display';
it('renders retrieval times in an explicit store timezone on server and browser',()=>{expect(timestamp('2026-10-12T13:00:00Z','Europe/Stockholm')).toContain('3:00 PM');expect(timestamp('bad','UTC')).toBe('Unavailable');});

const client:Client={id:'test',name:'Test client',slug:'test',timezone:'UTC',currency:'USD',color:'#2549c5',version:1,config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'net_sales',spendChannels:['meta'],recurringLabel:'Subscriptions',minSessions:100,minOpportunity:5,maxActions:6,reviewTime:'09:00',reviewTimezone:'UTC',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-07',to:'2026-10-07',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'overview'};
function observation(metric:string,value:number,dimensions:Record<string,string>,dataset='funnels'):Observation{return {date:filters.to,metric,value,dataset,dimensions,population:'human_sessions',definition:metric,currency:metric==='revenue'?'USD':null,sourceId:'source',retrievedAt:'2026-10-08T00:00:00Z',coverageThrough:'2026-10-08T00:00:00Z',quality:'complete'};}
function workspace(view:string,observations:Observation[]){const f={...filters,view},record={...workspacePresentation(queryClient(client,observations,[],f,{prepareAllViews:true}),f),reviews:[],findings:[],note:{body:'',version:0}};return renderToStaticMarkup(createElement(ClientWorkspace,{record,filters:f,mutate:async()=>({}),update:()=>{},admin:true}));}

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
    expect(html).toContain(view==='products'?'>PRODUCT ORDERS<':view==='revenue'?'>Orders<':'>ORDERS<');
    expect(html).toContain('$20');
  });
  it('shows human traffic landing pages with paired sessions and conversion rankings',()=>{
    const dimensions={market:'FR',device:'mobile',source:'social',utm_source:'meta',utm_campaign:'Prospecting',page:'/pages/glp'};
    const html=workspace('traffic',[observation('sessions',1000,dimensions,'traffic'),observation('converting_sessions',20,dimensions,'traffic')]);
    expect(html).toContain('SESSIONS');
    expect(html).toContain('Top landing pages by sessions');
    expect(html).toContain('Landing-page conversion rate');
    expect(html).toContain('Landing pages &amp; funnels');
    expect(html).toContain('/pages/glp');
    expect(html).toContain('>SESSIONS<');
    expect(html).toContain('2.00%');
    expect(html).not.toContain('>REVENUE<');
  });
  it('omits unmatched platform attribution and empty experimental panels from spend view',()=>{
    const dims={ad:'Ad example',campaign:'Acquisition',reporting_timezone:'Europe/Stockholm',attribution:'account'};
    const html=workspace('media',[observation('meta_ad_spend',1250,dims,'creatives'),observation('meta_ad_impressions',10000,dims,'creatives')]);
    expect(html).toContain('Spend &amp; efficiency');
    expect(html).not.toContain('Meta ad performance · platform attribution');
    expect(html).not.toContain('Ad example');
    expect(html).not.toContain('Experiments &amp; test context');
    expect(html).not.toContain('$1,250');
  });
});
