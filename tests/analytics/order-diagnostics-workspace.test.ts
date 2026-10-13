import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {OrderStreamDiagnostics} from '../../components/analytics/order-diagnostics';
import type {ClientRecord} from '../../components/analytics/records';
import type {QueryFilters} from '../../lib/analytics/contracts';

const filters:QueryFilters={from:'2026-10-13',to:'2026-10-13',compare:'previous',market:'',stream:'',source:'',device:'',page:'',mode:'closed',view:'subscriptions'};
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
