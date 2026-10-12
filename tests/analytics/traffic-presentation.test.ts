import {expect,it} from 'vitest';
import {compactTrafficExplorer,TRAFFIC_BREAKDOWNS} from '../../lib/analytics/traffic-presentation';
import {aggregateExplorerRows,explorerMetric,type ExplorerRow} from '../../lib/analytics/traffic-explorer';
const row=(index:number):ExplorerRow=>({key:`leaf-${index}`,dimensions:{page:`/page-${index%150}`,market:index%2?'US':'CA',device:index%2?'mobile':'desktop',source:'social',utm_source:index%2?'meta':'tiktok',utm_medium:'paid',utm_campaign:`Campaign ${index}`},metrics:{sessions:100+index,converting_sessions:index%5,atc_sessions:10,checkouts:5,completed_checkouts:2},summary:{sessions:100+index,revenue:null,orders:null,spend:null,cvr:(index%5)/(100+index),aov:null,mer:null,newOrders:null,recurringRevenue:null,atc:10/(100+index),checkoutCompletion:.4}});
it('retains all pages and pools exact whole-dataset totals before any segment ranking cap',()=>{
 const rows=Array.from({length:3000},(_,index)=>row(index)),before=JSON.stringify(rows),projection=compactTrafficExplorer(rows,[],'traffic');
 expect(projection.current.totals).toEqual(aggregateExplorerRows(rows,'all')[0]);expect(projection.current.pages).toHaveLength(150);expect(projection.current.pages.reduce((sum,page)=>sum+page.metrics.sessions!,0)).toBe(rows.reduce((sum,row)=>sum+row.metrics.sessions!,0));expect(JSON.stringify(rows)).toBe(before);
 expect(projection.current.breakdowns.utm_campaign.groupCount).toBe(3000);expect(projection.current.breakdowns.utm_campaign.omitted).toBeGreaterThan(2800);expect(projection.comparison.totals).toBeNull();
 for(const dimension of TRAFFIC_BREAKDOWNS)for(const metric of ['sessions','converting_sessions','cvr','atc','checkoutCompletion'] as const){const original=aggregateExplorerRows(rows,dimension).filter(group=>explorerMetric(group,metric)!==null).sort((a,b)=>explorerMetric(b,metric)!-explorerMetric(a,metric)!||a.label.localeCompare(b.label)).slice(0,20),retained=projection.current.breakdowns[dimension].groups.filter(group=>explorerMetric(group,metric)!==null).sort((a,b)=>explorerMetric(b,metric)!-explorerMetric(a,metric)!||a.label.localeCompare(b.label)).slice(0,20);expect(retained).toEqual(original);}
 expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThan(1024*1024);
});
it('preserves unavailable population-qualified rates and missing counts through compaction',()=>{
 const bad=row(0);bad.summary.cvr=null;bad.metrics.converting_sessions=50;const missing=row(1);missing.metrics.atc_sessions=null;
 const compact=compactTrafficExplorer([bad,missing],[],'funnels');expect(compact.current.totals?.summary.cvr).toBeNull();expect(compact.current.totals?.metrics.atc_sessions).toBeNull();expect(compact.current.breakdowns.utm_campaign.groups.find(group=>group.label==='Campaign 0')?.summary.cvr).toBeNull();expect(compact.current.dataset).toBe('funnels');
});
