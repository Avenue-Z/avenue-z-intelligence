import {expect,it,vi} from 'vitest';
vi.mock('@/lib/utils',async()=>await import('../../lib/utils'));
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DetailTable} from '../../components/analytics/detail-table';
import {detailRows} from '../../lib/analytics/query';
import type {Observation} from '../../lib/analytics/contracts';
function rows(dimensions:Record<string,string>,metrics:Record<string,number>,date='2026-10-13'){
 return detailRows(Object.entries(metrics).map(([metric,value])=>({date,metric,value,dataset:'products',definition:'product_sales',population:'product_sales',dimensions,sourceId:'source',retrievedAt:'2026-10-13T12:00:00Z',currency:['revenue','refunds'].includes(metric)?'USD':null,quality:'complete'} as Observation)));
}
const render=(current:ReturnType<typeof detailRows>,previous:ReturnType<typeof detailRows>)=>renderToStaticMarkup(createElement(DetailTable,{rows:current,previousRows:previous,comparisonLabel:'yesterday',currency:'USD',exportHref:'/api/export'}));
it('matches prior product rows by complete dimensions independent of dimension ordering and row keys',()=>{
 const current=rows({product:'Dream',market:'US'},{revenue:150,orders:15}),previous=rows({market:'US',product:'Dream'},{revenue:100,orders:10});
 current[0].key='current-id';previous[0].key='old-id';
 const html=render(current,[...rows({product:'Dream',market:'CA'},{revenue:300,orders:30}),...previous]);
 expect(html).toContain('vs yesterday · $100');expect(html).toContain('vs yesterday · 10');expect(html).toContain('+50.0%');expect(html).not.toContain('vs yesterday · $300');
});
it('renders rate comparisons in percentage points and increasing refunds as unfavorable',()=>{
 const html=render(rows({product:'Dream'},{conversion_rate:.05,refunds:20}),rows({product:'Dream'},{conversion_rate:.03,refunds:10}));
 expect(html).toContain('5.00%');expect(html).toContain('+2.00 pp');expect(html).toContain('vs yesterday · 3.00%');
 const refundCell=html.match(/<td>\$20([\s\S]*?)<\/td>/)?.[1]??'';
 expect(refundCell).toContain('data-tone="unfavorable"');expect(refundCell).toContain('+100.0%');
});
it('keeps missing prior segments and missing prior metrics unavailable rather than treating them as zero',()=>{
 const html=render(rows({product:'Dream',market:'US'},{revenue:150,orders:15}),rows({product:'Dream',market:'CA'},{revenue:100,orders:10}));
 expect(html).toContain('— vs yesterday');expect(html).not.toContain('vs yesterday · $0');expect(html).not.toContain('data-tone="favorable"');
 const missing=render(rows({product:'Dream'},{revenue:150,orders:15}),rows({product:'Dream'},{orders:10}));
 expect(missing).toContain('— vs yesterday');expect(missing).toContain('vs yesterday · 10');
});
