import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import clients from '../../data/initial-clients.json';
import {MarketWorkspace} from '../../components/analytics/market-workspace';
import type {Client,Observation,QueryFilters} from '../../lib/analytics/contracts';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';

const client={...clients.find(value=>value.id==='autobrush')!,version:1} as Client;
const filters:QueryFilters={from:'2026-10-21',to:'2026-10-21',mode:'closed',compare:'previous',view:'markets',market:'',stream:'',source:'',device:'',page:''};
function observations(date:string,market:string,metrics:Record<string,number|null>):Observation[]{
 return Object.entries(metrics).map(([metric,value])=>({date,dataset:'markets',metric,value,dimensions:{market},definition:metric==='sessions'?'shopify_human_sessions_by_session_country':'shopify_net_sales_by_billing_country_all_channels',population:metric==='sessions'?'human_online_store_sessions':'shopify_sales',currency:['revenue','refunds','discounts'].includes(metric)?'USD':null,sourceId:'autobrush-shopify-markets',retrievedAt:'2026-10-22T12:00:00Z',coverageThrough:'2026-10-22T04:00:00Z',quality:'complete'}));
}
function evidence(ca:Record<string,number|null>={revenue:500,orders:10}){
 return [...observations(filters.to,'US',{revenue:1000,orders:20,sessions:100}),...observations(filters.to,'CA',ca),...observations(filters.to,'DE',{sessions:80}),...observations('2026-10-20','US',{revenue:800,orders:20}),...observations('2026-10-20','CA',{revenue:200,orders:5}),...observations('2026-10-20','DE',{sessions:40})];
}
function render(rows=evidence(),market=''){
 const selected={...filters,market},record={...workspacePresentation(queryClient(client,rows,[],selected,{preparedDatasets:['markets']}),selected),findings:[],reviews:[],note:{body:'',version:0}};
 return renderToStaticMarkup(createElement(MarketWorkspace,{record,filters:selected,update:()=>{}}));
}
function card(html:string,title:string){return html.match(new RegExp(`<div class="stat-card"><span class="stat-label">${title}</span>([\\s\\S]*?)</div>`))?.[1]??'';}

it('sums all-country financial headers and yesterday comparisons without losing session-only countries',()=>{
 const html=render();
 expect(card(html,'REVENUE')).toContain('<strong>$1,500</strong>');
 expect(card(html,'REVENUE')).toContain('vs yesterday · $1,000');
 expect(card(html,'REVENUE')).toContain('+50.0%');
 expect(card(html,'ORDERS')).toContain('<strong>30</strong>');
 expect(card(html,'ORDERS')).toContain('vs yesterday · 25');
 expect(card(html,'ORDERS')).toContain('+20.0%');
 expect(card(html,'AOV')).toContain('<strong>$50</strong>');
 expect(card(html,'AOV')).toContain('vs yesterday · $40');
 expect(card(html,'AOV')).toContain('+25.0%');
 expect(card(html,'MARKETS')).toContain('<strong>3</strong>');
 const sessionsOnly=html.match(/<tr><td><a[^>]*aria-label="View DE market"[\s\S]*?<\/tr>/)?.[0]??'';
 expect(sessionsOnly).toContain('DE');expect(sessionsOnly).toContain('<td>—');expect(sessionsOnly).not.toContain('<td>$0');
 expect(html).toContain('View US market');expect(html).toContain('View CA market');
});
it('keeps selected-market financial headers and comparisons scoped to that market',()=>{
 const html=render(evidence(),'CA');
 expect(card(html,'REVENUE')).toContain('<strong>$500</strong>');expect(card(html,'REVENUE')).toContain('vs yesterday · $200');expect(card(html,'REVENUE')).toContain('+150.0%');
 expect(card(html,'ORDERS')).toContain('<strong>10</strong>');expect(card(html,'AOV')).toContain('<strong>$50</strong>');expect(card(html,'MARKETS')).toContain('<strong>1</strong>');
 expect(html).not.toContain('aria-label="View DE market"');
});
it('retains an explicitly unknown revenue within a financial country instead of dropping its orders',()=>{
 const html=render(evidence({revenue:null,orders:10}));
 expect(card(html,'REVENUE')).toContain('<strong>—</strong>');expect(card(html,'AOV')).toContain('<strong>—</strong>');
 expect(card(html,'ORDERS')).toContain('<strong>30</strong>');expect(card(html,'ORDERS')).toContain('+20.0%');
});
it('keeps missing financial counts unknown while retaining independently complete revenue',()=>{
 const html=render(evidence({revenue:500}));
 expect(card(html,'REVENUE')).toContain('<strong>$1,500</strong>');
 expect(card(html,'ORDERS')).toContain('<strong>—</strong>');expect(card(html,'AOV')).toContain('<strong>—</strong>');
});
it('does not invent zero financial totals for a selected country with only human sessions',()=>{
 const html=render(evidence(),'DE');
 for(const title of ['REVENUE','ORDERS','AOV'])expect(card(html,title)).toContain('<strong>—</strong>');
 expect(card(html,'MARKETS')).toContain('<strong>1</strong>');expect(html).toContain('aria-label="View DE market"');
});
