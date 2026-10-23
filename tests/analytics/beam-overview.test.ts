import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import {buildBeamOverview} from '../../lib/analytics/beam-overview';
import {BeamOverview} from '../../components/analytics/beam-overview';

const client:Client={id:'beam',name:'Beam',slug:'beam',timezone:'America/New_York',currency:'USD',color:'#4368c4',version:1,config:{markets:['US'],benchmarkMarket:'US',revenueDefinition:'all_channel_net_including_recurring_excl_faire',spendChannels:['Meta'],recurringLabel:'Loop Subscriptions',minSessions:100,minOpportunity:5,maxActions:6,reviewTime:'09:00',reviewTimezone:'America/New_York',reviewMode:'closed',incidents:[]}};
const filters:QueryFilters={from:'2026-10-07',to:'2026-10-07',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'overview'};
function observation(date:string,dataset:string,metric:string,value:number,dimensions:Record<string,string>={}):Observation{return {date,dataset,metric,value,dimensions,definition:metric,population:dataset==='funnels'?'US_human_sessions':'orders',currency:['revenue','spend','recurring_revenue'].includes(metric)?'USD':null,quality:'historical',sourceId:'dated-report',retrievedAt:'2026-10-08T12:00:00Z',coverageThrough:null};}
function sales(date:string,all:number,online:number,loop:number,spend:number){return [observation(date,'overview','revenue',all),observation(date,'overview','spend',spend),observation(date,'overview','orders',100),observation(date,'revenue','revenue',online,{channel:'Online Store'}),observation(date,'revenue','orders',10,{channel:'Online Store'}),observation(date,'revenue','revenue',loop,{channel:'Loop Subscriptions'}),observation(date,'revenue','orders',90,{channel:'Loop Subscriptions'}),observation(date,'subscriptions','recurring_revenue',loop),observation(date,'subscriptions','recurring_orders',90)];}
function record(rows:Observation[],selected=filters){return {...workspacePresentation(queryClient(client,rows,[],selected,{prepareAllViews:true}),selected),reviews:[],findings:[],note:{body:'',version:0}};}
const current=sales(filters.to,10000,2000,8000,1000),previous=sales('2026-10-06',9000,3000,6000,500);

describe('Beam overview scope',()=>{
 it('does not divide partially captured multi-day channel revenue or orders by a full-period denominator',()=>{
  const selected={...filters,from:'2026-10-06'},rows=[...current,...previous].filter(row=>!(row.dataset==='revenue'&&row.dimensions.channel==='Online Store'&&(row.date==='2026-10-06'&&row.metric==='revenue'||row.date==='2026-10-07'&&row.metric==='orders')));
  const result=buildBeamOverview(record(rows,selected),selected);
  expect(result.current.onlineStoreNetSales).toBe(2000);expect(result.current.onlineStoreOrders).toBe(10);
  expect(result.current.onlineStoreAov).toBeNull();expect(result.current.onlineStoreMer).toBeNull();
  expect(result.revenueMix.find(row=>row.channel==='Online Store')?.share).toBeNull();
  expect(result.current.allChannelMer).toBeCloseTo(12.6666666667);
 });
 it.each(['revenue','spend'])('withholds all-channel MER when a multi-day overview is missing one daily %s value',metric=>{
  const selected={...filters,from:'2026-10-06'},rows=[...current,...previous].filter(row=>!(row.dataset==='overview'&&row.date==='2026-10-06'&&row.metric===metric));
  const result=buildBeamOverview(record(rows,selected),selected);
  expect(result.current.allChannelMer).toBeNull();
 });
 it('checks actual comparison-day coverage independently of the selected period',()=>{
  const selected={...filters,from:'2026-10-06',compare:'custom' as const,compareFrom:'2026-10-04',compareTo:'2026-10-05'},rows=[...current,...previous,...sales('2026-10-05',8000,1000,7000,400),...sales('2026-10-04',7000,1000,6000,300)].filter(row=>!(row.dataset==='overview'&&row.date==='2026-10-04'&&row.metric==='spend'));
  const result=buildBeamOverview(record(rows,selected),selected);
  expect(result.current.allChannelMer).toBeCloseTo(12.6666666667);
  expect(result.previous.allChannelMer).toBeNull();expect(result.previous.onlineStoreMer).toBeNull();
 });
 it('keeps all-channel sales separate from Online Store sales and uses the actual comparison',()=>{
  const result=buildBeamOverview(record([...current,...previous]),filters);
  expect(result.current).toMatchObject({allChannelNetSales:10000,onlineStoreNetSales:2000,onlineStoreOrders:10,onlineStoreAov:200,metaSpend:1000,allChannelMer:10,onlineStoreMer:2});
  expect(result.previous).toMatchObject({allChannelNetSales:9000,onlineStoreNetSales:3000,onlineStoreAov:300,metaSpend:500,allChannelMer:18,onlineStoreMer:6});
  expect(result.historical).toBe(true);
 });
 it('never substitutes all-channel or product sales when Online Store evidence is missing',()=>{
  const rows=current.filter(row=>row.dimensions.channel!=='Online Store');
  rows.push(observation(filters.to,'products','revenue',2000,{product:'Online Store'}));
  const result=buildBeamOverview(record(rows),filters);
  expect(result.current.onlineStoreNetSales).toBeNull();expect(result.current.onlineStoreOrders).toBeNull();expect(result.current.onlineStoreMer).toBeNull();
  expect(result.current.allChannelNetSales).toBe(10000);
 });
 it('does not add repeated or overlapping channel scopes to the authoritative total',()=>{
  const base=record(current),online=base.views.revenue.details.find(row=>row.dimensions.channel==='Online Store')!;
  const duplicate={...base,views:{...base.views,revenue:{...base.views.revenue,details:[...base.views.revenue.details,online]}}};
  expect(buildBeamOverview(duplicate,filters).current.onlineStoreNetSales).toBeNull();
  const overlapping={...base,views:{...base.views,revenue:{...base.views.revenue,details:[...base.views.revenue.details,{...online,key:'us-detail',dimensions:{channel:'Online Store',market:'US'}}]}}};
  const result=buildBeamOverview(overlapping,filters);
  expect(result.current.onlineStoreNetSales).toBe(2000);expect(result.current.allChannelNetSales).toBe(10000);
  expect(result.revenueMix.find(row=>row.channel==='Online Store')?.revenue).toBe(2000);
 });
 it('accepts exact stream identities but rejects conflicting channel and stream identities',()=>{
  const base=record(current),revenue=base.views.revenue;
  const stream={...base,views:{...base.views,revenue:{...revenue,details:revenue.details.map(row=>({...row,dimensions:{stream:row.dimensions.channel}}))}}};
  expect(buildBeamOverview(stream,filters).current.onlineStoreNetSales).toBe(2000);
  const conflict={...base,views:{...base.views,revenue:{...revenue,details:revenue.details.map(row=>row.dimensions.channel==='Online Store'?{...row,dimensions:{...row.dimensions,stream:'Loop Subscriptions'}}:row)}}};
  expect(buildBeamOverview(conflict,filters).current.onlineStoreNetSales).toBeNull();
 });
 it('retains zero sales but leaves ratios with zero spend or zero orders unavailable',()=>{
  const rows=sales(filters.to,0,0,0,0).map(row=>row.metric==='orders'?{...row,value:0}:row),result=buildBeamOverview(record(rows),filters);
  expect(result.current.onlineStoreNetSales).toBe(0);expect(result.current.onlineStoreOrders).toBe(0);
  expect(result.current.onlineStoreAov).toBeNull();expect(result.current.onlineStoreMer).toBeNull();
 });
 it('retains gaps and rejects non-finite or overlapping trend points',()=>{
  const base=record(current),point={...base.series.find(row=>row.date===filters.to)!};
  const result=buildBeamOverview({...base,metrics:{...base.metrics,revenue:Infinity},series:[point,point,{...point,date:'2026-10-06',revenue:null,spend:null},{...point,date:'2026-10-05',revenue:3000,spend:500}]},filters);
  expect(result.current.allChannelNetSales).toBeNull();expect(result.current.allChannelMer).toBeNull();
  expect(result.trend).toEqual([{date:'2026-10-05',revenue:3000,spend:500,mer:null},{date:'2026-10-06',revenue:null,spend:null,mer:null},{date:filters.to,revenue:null,spend:null,mer:null}]);
 });
 it('does not label mixed-channel overview spend as Meta spend',()=>{
  const base=record(current),result=buildBeamOverview({...base,client:{...client,config:{...client.config,spendChannels:['Meta','Google']}}},filters);
  expect(result.current.metaSpend).toBeNull();expect(result.current.allChannelMer).toBeNull();expect(result.current.onlineStoreMer).toBeNull();
 });
});

describe('Beam human traffic evidence',()=>{
 it('does not combine multi-day sessions and conversions when one date has no conversion observation',()=>{
  const selected={...filters,from:'2026-10-06'},rows=[...current,...previous,...['2026-10-06','2026-10-07'].flatMap(date=>[observation(date,'funnels','sessions',1000,{market:'US'}),observation(date,'funnels','sessions',500,{market:'US',page:'/products/dream'})]),observation(filters.to,'funnels','converting_sessions',20,{market:'US'}),observation(filters.to,'funnels','converting_sessions',10,{market:'US',page:'/products/dream'})];
  const result=buildBeamOverview(record(rows,selected),selected);
  expect(result.current.usHumanSessions).toBe(2000);expect(result.current.usCvr).toBeNull();expect(result.current.usCvrBasis).toBe('unavailable');
  expect(result.pages[0].sessions).toBe(1000);expect(result.pages[0].cvr).toBeNull();expect(result.pages[0].rateBasis).toBe('unavailable');
 });
 it('does not pool landing-page rows into an invented US total or infer converting sessions from reported rates',()=>{
  const rows=[...current,observation(filters.to,'funnels','sessions',1000,{market:'US',page:'/products/dream'}),observation(filters.to,'funnels','reported_conversion_rate',.025,{market:'US',page:'/products/dream'})];
  const result=buildBeamOverview(record(rows),filters);
  expect(result.current.usHumanSessions).toBeNull();expect(result.current.usCvr).toBeNull();
  expect(result.pages).toEqual([expect.objectContaining({page:'/products/dream',sessions:1000,cvr:.025,rateBasis:'reported'})]);
  expect(result.pages[0]).not.toHaveProperty('convertingSessions');
 });
 it('labels an exact historical US aggregate rate as reported and uses a real prior aggregate',()=>{
  const rows=[...current,...previous,observation(filters.to,'funnels','sessions',1000,{market:'US'}),observation(filters.to,'funnels','reported_conversion_rate',.025,{market:'US'}),observation('2026-10-06','funnels','sessions',800,{market:'US'}),observation('2026-10-06','funnels','reported_conversion_rate',.03,{market:'US'})];
  const result=buildBeamOverview(record(rows),filters);
  expect(result.current).toMatchObject({usHumanSessions:1000,usCvr:.025,usCvrBasis:'reported'});
  expect(result.previous).toMatchObject({usHumanSessions:800,usCvr:.03,usCvrBasis:'reported'});
 });
 it('does not average rounded report rates across days',()=>{
  const selected={...filters,from:'2026-10-06'},rows=[...current,...previous,...['2026-10-06','2026-10-07'].flatMap(date=>[observation(date,'funnels','sessions',1000,{market:'US'}),observation(date,'funnels','reported_conversion_rate',.025,{market:'US'})])];
  const result=buildBeamOverview(record(rows,selected),selected);
  expect(result.current.usHumanSessions).toBe(2000);expect(result.current.usCvr).toBeNull();
 });
 it('calculates CVR from actual matching session counts instead of a conflicting rounded report rate',()=>{
  const rows=[...current,observation(filters.to,'funnels','sessions',1000,{market:'US'}),observation(filters.to,'funnels','converting_sessions',21,{market:'US'}),observation(filters.to,'funnels','reported_conversion_rate',.025,{market:'US'})];
  expect(buildBeamOverview(record(rows),filters).current).toMatchObject({usHumanSessions:1000,usCvr:.021,usCvrBasis:'matched-counts'});
 });
});

it('retains historical status without showing obsolete connection warnings',()=>{
 const base=record(current),connected={...base,connections:[{id:'pending',clientId:client.id,name:'Pending connection',provider:'gateway' as const,endpoint:'',secretRef:'',pollMinutes:60,enabled:true,lastSuccess:null,coverageThrough:null,error:null,version:1}]};
 const html=renderToStaticMarkup(createElement(BeamOverview,{record:connected,filters,update:()=>{}}));
 expect(html).toContain('Historical report');expect(html).not.toContain('Live diagnostics unavailable');expect(html).not.toContain('Connections needed');
});

it('labels multi-day channel amounts as captured totals and explains why derived values are unavailable',()=>{
 const selected={...filters,from:'2026-10-06'},base=record([...current,...previous,...sales('2026-10-04',7000,1000,6000,300),...sales('2026-10-05',8000,1000,7000,400)],selected),html=renderToStaticMarkup(createElement(BeamOverview,{record:base,filters:selected,update:()=>{}}));
 expect(html).toContain('Captured channel total');expect(html).toContain('daily coverage');
 const onlineCard=html.match(/ONLINE STORE NET SALES<\/span>.*?<\/div>/)?.[0];
 expect(onlineCard).toContain('— vs previous period');expect(onlineCard).not.toContain('Increased');
});

it('renders separate sales scopes and reported historical page rates without subscription cards',()=>{
 const base=record([...current,...previous,observation(filters.to,'funnels','sessions',1000,{market:'US',page:'/products/dream'}),observation(filters.to,'funnels','reported_conversion_rate',.025,{market:'US',page:'/products/dream'})]);
 const html=renderToStaticMarkup(createElement(BeamOverview,{record:base,filters,update:()=>{}}));
 expect(html).toContain('ONLINE STORE NET SALES');expect(html).toContain('ALL-CHANNEL NET SALES');
 expect(html).toContain('Historical report');expect(html).toContain('2.50%');expect(html).toContain('Reported CVR');
 expect(html).not.toContain('Connections needed');expect(html).not.toContain('RENEWAL REVENUE SHARE');expect(html).not.toContain('efficient growth');expect(html).not.toContain('converting sessions: 25');
});

function liveSales(date:string,revenue:number,online:number,orders:number,sessions:number,converting:number){
 return [observation(date,'overview','revenue',revenue),observation(date,'overview','orders',orders),observation(date,'overview','online_store_revenue',online),observation(date,'overview','online_store_orders',orders/2),observation(date,'overview','sessions',sessions),observation(date,'overview','converting_sessions',converting)].map(row=>({...row,quality:'complete' as const,sourceId:'beam-shopify-hourly',population:['sessions','converting_sessions'].includes(row.metric)?'human_us_online_store_sessions':row.metric.startsWith('online_store')?'beam_shopify_online_store_sales':'beam_shopify_sales_excluding_faire'}));
}

it('uses live overview sales scopes and pooled matching US session counts for multi-day KPIs',()=>{
 const selected={...filters,from:'2026-10-06'},rows=[...liveSales('2026-10-06',1000,700,10,100,5),...liveSales('2026-10-07',2000,900,20,900,9),...liveSales('2026-10-04',500,400,10,100,2),...liveSales('2026-10-05',1000,500,10,100,4)];
 const result=buildBeamOverview(record(rows,selected),selected);
 expect(result.current).toMatchObject({allChannelNetSales:3000,allChannelOrders:30,allChannelAov:100,onlineStoreNetSales:1600,onlineStoreOrders:15,onlineStoreAov:1600/15,usHumanSessions:1000,usCvr:.014,usCvrBasis:'matched-counts'});
 expect(result.previous).toMatchObject({allChannelNetSales:1500,onlineStoreNetSales:900,usCvr:.03});
 expect(result.current).not.toHaveProperty('loopNetSales');
});

it('withholds multi-day live derived rates when a contributing day is missing one count',()=>{
 const selected={...filters,from:'2026-10-06'},rows=[...liveSales('2026-10-06',1000,700,10,100,5),...liveSales('2026-10-07',2000,900,20,900,9)].filter(row=>!(row.date==='2026-10-06'&&['online_store_orders','converting_sessions'].includes(row.metric)));
 const result=buildBeamOverview(record(rows,selected),selected);
 expect(result.current.onlineStoreAov).toBeNull();expect(result.current.usCvr).toBeNull();expect(result.current.usHumanSessions).toBe(1000);
});

it('does not turn daily platform spend into live same-hour MER or a spend comparison',()=>{
 const base=record([...liveSales(filters.to,1000,700,10,100,5),observation(filters.to,'overview','spend',100)]),selected={...filters,mode:'partial' as const};
 const result=buildBeamOverview({...base,sourceQuality:{...base.sourceQuality!,historical:false}},selected);
 expect(result.current.allChannelMer).toBeNull();expect(result.current.onlineStoreMer).toBeNull();
 const html=renderToStaticMarkup(createElement(BeamOverview,{record:{...base,sourceQuality:{...base.sourceQuality!,historical:false}},filters:selected,update:()=>{}}));
 expect(html).not.toContain('META SPEND');expect(html).not.toContain('Meta MER');
});

it('retains each Intelligems report day instead of adding daily rates and confidence intervals',()=>{
 const dimensions={experiment_id:'experiment-1',experiment:'Header test',variant_id:'variant-1',variant:'New header',is_control:'false',market:'US',status:'started'};
 const rows=['2026-10-06','2026-10-07'].flatMap((date,index)=>[observation(date,'experiments','visitors',100,dimensions),observation(date,'experiments','conversion_rate',index?.1:.2,dimensions),observation(date,'experiments','conversion_rate_ci_low',index?.05:.1,dimensions)]);
 const base=record(rows,{...filters,from:'2026-10-06'});
 expect(base.experimentDailyDetails).toHaveLength(2);
 expect(base.experimentDailyDetails?.[0].details[0].metrics.conversion_rate).toBe(.2);
 expect(base.experimentDailyDetails?.[1].details[0].metrics.conversion_rate).toBe(.1);
});

it('renders dated experiment variation results without inventing a winner or combining confidence across days',()=>{
 const dimensions={experiment_id:'experiment-1',experiment:'Header test',variant_id:'variant-1',variant:'New header',is_control:'false',market:'US',status:'started'};
 const rows=['2026-10-06','2026-10-07'].flatMap((date,index)=>[observation(date,'experiments','visitors',100,dimensions),observation(date,'experiments','conversion_rate',index?.1:.2,dimensions),observation(date,'experiments','conversion_rate_ci_low',index?.05:.1,dimensions),observation(date,'experiments','conversion_rate_ci_high',index?.15:.3,dimensions),observation(date,'experiments','conversion_rate_probability_to_beat_control',.7,dimensions)]);
 const selected={...filters,from:'2026-10-06'},html=renderToStaticMarkup(createElement(BeamOverview,{record:record(rows,selected),filters:selected,update:()=>{}}));
 expect(html).toContain('Header test');expect(html).toContain('New header');expect(html).toContain('Analysis date');expect(html).toContain('10.00%');expect(html).toContain('5.00% – 15.00%');expect(html).not.toContain('winning variant');expect(html).not.toContain('30.00%');
});

it('keeps zero-traffic days in an otherwise matched multi-day session rate',()=>{
 const selected={...filters,from:'2026-10-06'},rows=[...liveSales('2026-10-06',0,0,0,0,0),...liveSales('2026-10-07',1000,700,10,100,2)];
 expect(buildBeamOverview(record(rows,selected),selected).current.usCvr).toBe(.02);
});

it('uses the workspace actual custom comparison and matched hourly counts for live KPIs',()=>{
 const selected={...filters,mode:'partial' as const,compare:'custom' as const,compareFrom:'2026-10-01',compareTo:'2026-10-01'};
 const hour=(date:string,hour:number,amount:number)=>liveSales(date,amount,amount/2,10,100,2).map(row=>({...row,start:`${date}T0${hour}:00:00Z`,end:`${date}T0${hour+1}:00:00Z`,coverageThrough:`${date}T06:00:00Z`}));
 const rows=[...hour('2026-10-07',4,500),...hour('2026-10-07',5,1000),...hour('2026-10-01',4,200),...hour('2026-10-01',5,300),...hour('2026-10-01',6,99999)];
 const connection={id:'hourly',clientId:'beam',name:'Shopify',provider:'gateway' as const,endpoint:'',secretRef:'',pollMinutes:60,enabled:true,lastSuccess:'2026-10-07T06:05:00Z',coverageThrough:'2026-10-07T06:00:00Z',error:null,version:1};
 const base={...workspacePresentation(queryClient(client,rows,[connection],selected,{prepareAllViews:true}),selected),reviews:[],findings:[],note:{body:'',version:0}},result=buildBeamOverview(base,selected);
 expect(result.current).toMatchObject({allChannelNetSales:1500,onlineStoreNetSales:750,usHumanSessions:200,usCvr:.02});
 expect(result.previous).toMatchObject({allChannelNetSales:500,onlineStoreNetSales:250,usHumanSessions:200,usCvr:.02});
});
