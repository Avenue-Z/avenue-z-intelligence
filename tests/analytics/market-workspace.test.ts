import {expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketWorkspace,marketWorkspaceHref} from '../../components/analytics/market-workspace';
import {ExplorerComparisonPicker} from '../../components/analytics/traffic-workspace';
import {detailRows,queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';
const filters:QueryFilters={from:'2026-10-13',to:'2026-10-13',mode:'partial',compare:'weekday',view:'markets',market:'US',stream:'',source:'',device:'',page:'',period:'today'};
const client:Client={id:'a',slug:'client-a',name:'Client A',version:1,timezone:'UTC',currency:'USD',color:'#4368c4',config:{markets:['US'],spendChannels:[],revenueDefinition:'web',incidents:[],recurringLabel:'Recurring',benchmarkMarket:'US',minSessions:100,minOpportunity:5,maxActions:6,reviewMode:'closed',reviewTime:'09:00',reviewTimezone:'UTC'}};
const rows=[['revenue',300],['orders',10]].map(([metric,value])=>({date:filters.to,metric:String(metric),value:Number(value),dataset:'markets',definition:'market_sales',population:'market_sales',dimensions:{market:'US'},sourceId:'s',retrievedAt:'2026-10-13T12:00:00Z',coverageThrough:'2026-10-13T12:00:00Z',currency:metric==='revenue'?'USD':null,quality:'partial'} as Observation));
it('markets uses historical chart dates while its headline retains the selected-day revenue',()=>{
 const analytics=workspacePresentation(queryClient(client,rows,[],filters,{preparedDatasets:['overview','markets']}),filters);
 const record={...analytics,views:{},details:detailRows(rows),findings:[],reviews:[],note:{body:'',version:0},trendDatasetSeries:{markets:[{date:'2026-10-07',metrics:{revenue:999,orders:10},summary:{...detailRows(rows)[0].summary,revenue:999,aov:99.9}},{date:'2026-10-13',metrics:{revenue:300,orders:10},summary:detailRows(rows)[0].summary}]},trendComparisonDatasetSeries:{markets:[]}};
 const html=renderToStaticMarkup(createElement(MarketWorkspace,{record,filters,update:()=>{}}));
 expect(html).toContain('2026-10-07 – 2026-10-13');expect(html).toContain('<strong>$300</strong>');expect(html).not.toContain('<strong>$1,299</strong>');expect(html).toContain('value="weekday" selected=""');expect(html).toContain('Yesterday');
});
it('local comparison selection updates the dashboard comparison filter',()=>{
 const update=vi.fn(),element=ExplorerComparisonPicker({filters,update,label:'Market trend comparison'}),select=element.props.children[1] as {props:{onChange:(event:{target:{value:string}})=>void}};
 select.props.onChange({target:{value:'previous'}});
 expect(update).toHaveBeenCalledWith({compare:'previous'});
});

it('shows market headline and per-market changes from the matching comparison cohort',()=>{
 const selected={...filters,from:'2026-10-12',to:'2026-10-12',mode:'closed' as const,market:'',compare:'previous' as const},marketRows=(date:string,market:string,revenue:number,orders:number,refunds:number,discounts:number)=>Object.entries({revenue,orders,refunds,discounts}).map(([metric,value])=>({...rows[0],date,metric,value,dimensions:{market}}));
 const current=[...marketRows(selected.to,'US',300,10,20,15),...marketRows(selected.to,'CA',200,10,10,5)],prior=marketRows('2026-10-11','US',200,10,10,5);
 const analytics=workspacePresentation(queryClient(client,[...current,...prior],[],selected,{preparedDatasets:['markets']}),selected),record={...analytics,findings:[],reviews:[],note:{body:'',version:0}};
 const html=renderToStaticMarkup(createElement(MarketWorkspace,{record,filters:selected,update:()=>{}}));
 expect(html).toContain('<strong>$500</strong>');expect(html).toContain('vs yesterday · $200');expect(html).toContain('+150.0%');
 const us=html.match(/<tr><td><(?:button|a)[^>]*>US[\s\S]*?<\/tr>/)?.[0]??'',ca=html.match(/<tr><td><(?:button|a)[^>]*>CA[\s\S]*?<\/tr>/)?.[0]??'';
 expect(us).toContain('+50.0%');expect(us).toContain('vs yesterday · $20');expect(us).toContain('vs yesterday · 10');
 expect(us.match(/<td>\$20([\s\S]*?)<\/td>/)?.[1]).toContain('data-tone="unfavorable"');
 expect(ca).toContain('— vs yesterday');expect(ca).not.toContain('vs yesterday · $0');
 expect(html).not.toContain('Revenue / matching orders');
});
it('opens a shareable entire-market workspace with the exact dates and comparison and no unsupported leftover filters',()=>{
 const href=marketWorkspaceHref('kind-patches',{...filters,market:'',source:'facebook',device:'mobile',page:'/lp',compare:'custom',compareFrom:'2026-10-06',compareTo:'2026-10-06'},'US'),url=new URL(href,'https://example.test');
 expect(url.pathname).toBe('/clients/kind-patches');expect(url.searchParams.get('view')).toBe('markets');expect(url.searchParams.get('market')).toBe('US');expect(url.searchParams.get('period')).toBe('today');expect(url.searchParams.get('from')).toBe(filters.from);expect(url.searchParams.get('compareFrom')).toBe('2026-10-06');
 for(const key of ['stream','source','device','page'])expect(url.searchParams.get(key)).toBe('');
 expect(new URL(marketWorkspaceHref('kind-patches',filters,''),'https://example.test').searchParams.get('market')).toBe('');
});
it('renders market navigation links and market-scoped KPI totals, prior totals and chart evidence',()=>{
 const selected={...filters,from:'2026-10-12',to:'2026-10-12',mode:'closed' as const,period:undefined,market:'US',compare:'previous' as const},observations=['2026-10-11','2026-10-12'].flatMap((date,index)=>['US','CA'].flatMap(market=>['revenue','orders'].map(metric=>({...rows[0],date,metric,value:metric==='revenue'?market==='US'?100+index*20:900:market==='US'?10:90,dimensions:{market}}))));
 const analytics=workspacePresentation(queryClient(client,observations,[],selected,{preparedDatasets:['markets']}),selected),record={...analytics,findings:[],reviews:[],note:{body:'',version:0}},html=renderToStaticMarkup(createElement(MarketWorkspace,{record,filters:selected,update:()=>{}}));
 expect(html).toContain('aria-label="View US market"');expect(html).toContain('market=US');expect(html).toContain('US market');expect(html).toContain('<strong>$120</strong>');expect(html).toContain('vs yesterday · $100');expect(html).not.toContain('<strong>$1,020</strong>');
 expect(record.datasetSeries.markets[0].metrics.revenue).toBe(120);expect(record.comparisonDatasetSeries.markets[0].metrics.revenue).toBe(100);expect(record.trendDatasetSeries.markets.filter(day=>typeof day.metrics.revenue==='number').map(day=>day.metrics.revenue)).toEqual([100,120]);
});
