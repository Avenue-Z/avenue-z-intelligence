import {it,expect} from 'vitest';
import {supplementalReviewEvidence} from '../../lib/ai/evidence';
import clients from '../../data/initial-clients.json';
import type {Observation} from '../../lib/analytics/contracts';
const client=clients[0] as any;
const filters={from:'2026-10-08',to:'2026-10-08',view:'overview',mode:'partial',compare:'previous',market:'',source:'',page:'',stream:'',device:''} as const;
const row=(date:string,dataset:string,metric:string,value:number,dimensions:Record<string,string>={}):Observation=>({date,dataset,metric,value,dimensions,definition:'qualified definition',population:dataset,currency:['revenue','spend','recurring_revenue'].includes(metric)?client.currency:null,sourceId:'shopify',retrievedAt:'2026-10-08T12:00:00Z',coverageThrough:'2026-10-09T04:00:00Z',quality:'complete'});
it('keeps last closed detail dated and separate from intraday current evidence',()=>{
 const e=supplementalReviewEvidence(client,[row('2026-10-07','funnels','sessions',1600,{page:'/offer',market:'US'}),row('2026-10-07','funnels','converting_sessions',32,{page:'/offer',market:'US'})],[],filters);
 expect(e.priorClosedDetail.datasets.funnels.storeDate).toBe('2026-10-07');
 expect(e.priorClosedDetail.datasets.funnels.scopeLabel).toContain('Closed-day reference');
 expect(e.priorClosedDetail.datasets.funnels.rows[0].summary.cvr).toBe(.02);
 expect(e.priorClosedDetail.datasets.funnels.rows[0].provenance[0]).toMatchObject({date:'2026-10-07',sourceId:'shopify',quality:'complete'});
 expect(e.sources.some(s=>s.id===e.priorClosedDetail.datasets.funnels.sourceId)).toBe(true);
});
it('does not turn absent closed comparisons into zeros and separates renewal order volume from AOV',()=>{
 const rows=[row('2026-10-07','subscriptions','recurring_revenue',120),row('2026-10-07','subscriptions','recurring_orders',4),row('2026-10-06','subscriptions','recurring_revenue',100),row('2026-10-06','subscriptions','recurring_orders',5)];
 const e=supplementalReviewEvidence(client,rows,[],filters);
 expect(e.closedPriorDay.previousDay.metrics.revenue).toBeNull();
 expect(e.dailyRenewals.find(d=>d.storeDate==='2026-10-07')).toMatchObject({revenue:120,orders:4,aov:30,comparison:{revenue:100,orders:5,aov:20},decomposition:{ordersChange:-.2,aovChange:.5,revenueChange:.2}});
});
it('keeps platform UTC spend out of store-day channel MER evidence',()=>{
 const e=supplementalReviewEvidence(client,[row('2026-10-07','media','spend',50,{channel:'meta'}),row('2026-10-07','media','platform_spend',90,{channel:'applovin',reporting_timezone:'UTC'})],[],filters);
 expect(e.spendChannelTrend[0].channels).toHaveLength(1);expect(e.spendChannelTrend[0].channels[0]).toMatchObject({channel:'meta',spend:50});
});
it('preserves weekday and previous closed-day periods independently',()=>{
 const e=supplementalReviewEvidence(client,[row('2026-10-07','overview','revenue',120),row('2026-10-06','overview','revenue',100),row('2026-09-30','overview','revenue',80)],[],filters);
 expect(e.closedPriorDay.current.storeDate).toBe('2026-10-07');expect(e.closedPriorDay.previousDay.storeDate).toBe('2026-10-06');expect(e.closedPriorDay.sameWeekday.storeDate).toBe('2026-09-30');
 expect(e.closedPriorDay.arithmetic.previousDay.revenueChange).toBeCloseTo(.2);expect(e.closedPriorDay.arithmetic.sameWeekday.revenueChange).toBeCloseTo(.5);
});

it('labels channel totals as incomplete observed-day totals when MTD dates are missing',()=>{const e=supplementalReviewEvidence(client,[row('2026-10-07','media','spend',50,{channel:'meta'})],[],filters);const mtd=e.channelMonthToDate.find(d=>d.dataset==='media')!;expect(mtd.from).toBe('2026-10-01');expect(mtd.to).toBe('2026-10-07');expect(mtd.fullElapsedDayCoverage).toBe(false);expect(mtd.missingDates).toContain('2026-10-01');expect(mtd.rows[0].metrics.spend).toBe(50);});
