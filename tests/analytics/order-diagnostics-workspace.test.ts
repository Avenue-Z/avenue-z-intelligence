import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {OrderStreamDiagnostics,RenewalMixDiagnostics} from '../../components/analytics/order-diagnostics';
import type {ClientRecord} from '../../components/analytics/records';
import type {QueryFilters} from '../../lib/analytics/contracts';

const filters:QueryFilters={from:'2026-10-13',to:'2026-10-13',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'revenue'};
const row=(order_stream:string,revenue:number|null,previous=false)=>({dimensions:{order_stream,store_date:previous?'2026-10-12':'2026-10-13'},metrics:order_stream==='recurring_renewal'?{recurring_revenue:revenue,recurring_orders:10,recurring_units:20}:{revenue,orders:10,units:20}});
const render=(current:number|null,previous:number|null,stream='one_time')=>{
 const record={client:{currency:'USD',timezone:'Europe/Stockholm'},comparison:{from:'2026-10-12',to:'2026-10-12'},views:{orderStreams:{details:[row(stream,current)]}},comparisonViews:{orderStreams:{details:[row(stream,previous,true)]}}} as unknown as ClientRecord;
 return renderToStaticMarkup(createElement(OrderStreamDiagnostics,{filters,record}));
};

it('shows favorable rising AOV and unfavorable falling renewal AOV with signed arrows',()=>{
 const increase=render(120,100),decrease=render(80,100,'recurring_renewal');
 expect(increase).toContain('data-tone="favorable" data-direction="up"');
 expect(increase).toContain('AOV increased +20.00%; favorable');
 expect(increase).toContain('↑');
 expect(decrease).toContain('data-tone="unfavorable" data-direction="down"');
 expect(decrease).toContain('AOV decreased -20.00%; unfavorable');
 expect(decrease).toContain('↓');
});
it('keeps unchanged and missing AOV baselines neutral without inventing percentages',()=>{
 expect(render(100,100)).toContain('AOV unchanged 0.00%; neutral');
 expect(render(100,null)).toContain('AOV comparison unavailable; neutral');
 expect(render(100,0)).toContain('+$10 from 0');
 expect(render(100,0)).not.toContain('Infinity');
});

it('uses the primary renewal workspace on subscriptions without changing raw order-type data',()=>{
 const record={client:{currency:'USD',timezone:'Europe/Stockholm'},comparison:{from:'2026-10-12',to:'2026-10-12'},views:{orderStreams:{details:[row('one_time',120),row('recurring_renewal',80)]}},comparisonViews:{orderStreams:{details:[row('one_time',100,true),row('recurring_renewal',100,true)]}}} as unknown as ClientRecord;
 const raw=JSON.stringify(record),html=renderToStaticMarkup(createElement(OrderStreamDiagnostics,{filters:{...filters,view:'subscriptions'},record}));
 expect(html).toContain('One-time web orders');
 expect(html).not.toContain('Tagged recurring renewals');
 expect(html).not.toContain('recurring_renewal');
 expect(JSON.stringify(record)).toBe(raw);
 const revenue=renderToStaticMarkup(createElement(OrderStreamDiagnostics,{filters,record}));
 expect(revenue).toContain('Tagged recurring renewals');
 expect(revenue).toContain('AOV decreased -20.00%; unfavorable');
});

const renewalRender=(current:{orders:number;units:number;billed:number;refund:number},prior:{orders:number;units:number;billed:number;refund:number})=>{
 const renewal=(value:typeof current,date:string)=>({dimensions:{reported_currency:'CAD',store_date:date},metrics:{renewal_orders:value.orders,renewal_units:value.units,renewal_billed_revenue:value.billed,renewal_refund_money:value.refund}});
 const record={client:{currency:'USD',timezone:'Europe/Stockholm'},comparison:{from:'2026-10-12',to:'2026-10-12'},views:{renewalDiagnostics:{details:[renewal(current,'2026-10-13')]}},comparisonViews:{renewalDiagnostics:{details:[renewal(prior,'2026-10-12')]}}} as unknown as ClientRecord;
 const html=renderToStaticMarkup(createElement(RenewalMixDiagnostics,{filters:{...filters,view:'subscriptions'},record}));
 const cells=[...html.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(match=>match[1]);
 return {html,cells};
};

it('compares renewal mix quantities and money while treating lower refunded share as favorable',()=>{
 const {cells}=renewalRender({orders:12,units:36,billed:180,refund:30},{orders:10,units:20,billed:100,refund:20});
 expect(cells[1]).toContain('Increased +20.0% vs yesterday');
 expect(cells[2]).toContain('Increased +50.0% vs yesterday');
 expect(cells[3]).toContain('Increased +80.0% vs yesterday');
 expect(cells[4]).toContain('Increased +50.0% vs yesterday');
 expect(cells[4]).toContain('data-tone="unfavorable"');
 expect(cells[5]).toContain('Decreased -3.33 pp vs yesterday');
 expect(cells[5]).toContain('data-tone="favorable"');
 expect(cells[6]).toContain('20.00%');
 expect(cells[6]).not.toContain('data-tone');
});

it('marks an increased refunded amount share adverse using percentage points',()=>{
 const {cells}=renewalRender({orders:8,units:16,billed:80,refund:24},{orders:10,units:20,billed:100,refund:20});
 expect(cells[5]).toContain('Increased +10.00 pp vs yesterday');
 expect(cells[5]).toContain('data-tone="unfavorable"');
});
