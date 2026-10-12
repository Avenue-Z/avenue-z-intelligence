import {describe,it,expect} from 'vitest';
import {blocksForPayload,parseReport,reportHtml,reviewHref} from '../../lib/reviews/document';
describe('review presentation',()=>{
 it('preserves dated narrative, KPI values and tabular source cells',()=>{
  const b=parseReport('Wed Oct 7 · closed store day\nONLINE STORE NET SALES\n$37.5k\n+12.8% vs Tuesday\nThe read in 30 seconds\n\nTraffic rose.\n\nSpend vs revenue\nMETRIC\tTODAY\tYESTERDAY\nSpend\t$24,030\t$21,068\n\nAction items\n1. Check the offer.\n2. Wait for confidence.');
  expect(b.find(x=>x.type==='kpis')).toMatchObject({items:[{label:'ONLINE STORE NET SALES',value:'$37.5k',note:'+12.8% vs Tuesday'}]});
  expect(b.find(x=>x.type==='table')).toMatchObject({columns:['METRIC','TODAY','YESTERDAY'],rows:[['Spend','$24,030','$21,068']]});
  expect(b.filter(x=>x.type==='list').flatMap(x=>x.type==='list'?x.items:[])).toEqual(['Check the offer.','Wait for confidence.']);
 });
 it('exports an inert complete document and encodes revision identities',()=>{
  const html=reportHtml('Beam','2026-10-07',2,{text:'The read in 30 seconds\n<script>steal()</script>\nPAGE\tCVR\n/biotic\t0.91%'});
  expect(html).toContain('&lt;script&gt;steal()&lt;/script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('<table>');
  expect(reviewHref('brand/a','org:x:date')).toBe('/clients/brand%2Fa/reviews/org%3Ax%3Adate');
 });
 it('does not silently lose rows with differing widths',()=>{const b=parseReport('A\tB\n1\t2\t3');expect(b.find(x=>x.type==='table')).toMatchObject({rows:[['1','2','3']]});});
 it('keeps recurring KPI labels inside the KPI group',()=>{const b=parseReport('ONLINE STORE SALES\n$100\n+2%\nRECURRING NET SALES\n$20\n+1%\nThe read in 30 seconds\nSome context.');expect(b[0]).toMatchObject({type:'kpis',items:[{label:'ONLINE STORE SALES'},{label:'RECURRING NET SALES'}]});});
 it('retains original and absolute fixed evidence links in shareable downloads',()=>{const html=reportHtml('Beam','2026-10-07',2,{headlines:['A dated finding'],sourceUrl:'https://claude.ai/artifact/original',sources:[{id:'s',label:'Beam · Oct 7',url:'/clients/beam/reviews/fixed'}]},'https://workspace.example');expect(html).toContain('https://workspace.example/clients/beam/reviews/fixed');expect(html).toContain('https://claude.ai/artifact/original');expect(html).toContain('Beam · Oct 7');});
});

it('renders multiple named tables and legacy tables without losing their dated scope',()=>{
 const payload={sections:[{title:'Detail tables',paragraphs:[],table:{columns:['Legacy'],rows:[['Original']]},tables:[{title:'Sales by country',scope:'Closed-day reference · 2026-10-07',columns:['Country','Revenue'],rows:[['US','$100']],sourceIds:['closed:s']},{title:'Paid-page funnel by UTM',scope:'2026-10-07 · Facebook · /offer',columns:['UTM','Checkout completion'],rows:[['paid','50%']],sourceIds:['closed:s']}]}]};
 const tables=blocksForPayload(payload).filter(b=>b.type==='table');expect(tables).toHaveLength(3);
 expect(tables[1]).toMatchObject({title:'Sales by country',scope:'Closed-day reference · 2026-10-07'});
 const html=reportHtml('Client','2026-10-08',1,payload);expect(html).toContain('<caption>');expect(html).toContain('Sales by country');expect(html).toContain('Paid-page funnel by UTM');expect(html).toContain('Closed-day reference · 2026-10-07');
});
it('includes partial-day cutoff and elapsed fraction in the readable fixed copy',()=>{
 const html=reportHtml('Client','2026-10-08',1,{reportTiming:{mode:'partial',timezone:'America/New_York',elapsedFraction:.5,localCutoff:'2026-10-08T12:00:00-04:00[America/New_York]',reportingTimezone:'UTC',reportingCutoff:'2026-10-08T16:00:00Z[UTC]'},headlines:['Partial day']});
 expect(html).toContain('Partial store day');expect(html).toContain('50.0% elapsed');expect(html).toContain('2026-10-08T12:00:00');
});

it('uses the thirty-second narrative when supplied and keeps legacy headline reports readable',()=>{const blocks=blocksForPayload({summary:['Traffic increased; conversion evidence is dated.','Spend grew slower than revenue, subject to matched source coverage.'],headlines:['Legacy summary']});expect(blocks).toEqual([{type:'heading',text:'The read in 30 seconds'},{type:'paragraph',text:'Traffic increased; conversion evidence is dated.'},{type:'paragraph',text:'Spend grew slower than revenue, subject to matched source coverage.'}]);});
