import {expect,it} from 'vitest';
import {evidenceReviewTables} from '../../lib/reviews/tables';
import {evidenceDetailRows} from '../../lib/ai/evidence';
import type {Observation,QueryFilters} from '../../lib/analytics/contracts';
const filters:QueryFilters={from:'2026-10-11',to:'2026-10-11',mode:'closed',compare:'previous',view:'overview',market:'',stream:'',source:'',device:'',page:''};
function details(dataset:string,dimensions:Record<string,string>,metrics:Record<string,number|null>){return evidenceDetailRows(Object.entries(metrics).map(([metric,value]):Observation=>({date:dimensions.store_date,dataset,metric,value,dimensions,definition:'Qualified source cohort',population:dataset,currency:/revenue|refund_money/.test(metric)?'USD':null,sourceId:'native-diagnostics',retrievedAt:'2026-10-12T12:00:00Z',coverageThrough:'2026-10-12T00:00:00Z',quality:'complete'})));}
function client(datasetDetails:Record<string,ReturnType<typeof details>>){return {client:{name:'Brand',timezone:'UTC',currency:'USD',config:{incidents:[]}},sourceId:'selection:brand',comparison:{from:'2026-10-10',to:'2026-10-10'},datasetDetails,comparisonDatasetDetails:{},dailyRenewals:[],channelMonthToDate:[],channelSpendComparison:{current:{rows:[]},comparison:{rows:[]}},spendChannelTrend:[],trend:[]} as any;}
it('keeps first-subscription, one-time and tagged-renewal AOV and units separate',()=>{
 const cuts=[details('orderStreams',{store_date:filters.to,order_stream:'one_time'},{revenue:90,orders:3,units:6}),details('orderStreams',{store_date:filters.to,order_stream:'first_subscription'},{revenue:40,orders:2,units:2}),details('orderStreams',{store_date:filters.to,order_stream:'recurring_renewal'},{recurring_revenue:120,recurring_orders:4,recurring_units:8}),details('orderStreams',{store_date:filters.to,order_stream:'unclassified'},{revenue:10,orders:1})];
 const tables=evidenceReviewTables(client({orderStreams:{...cuts[0],rows:cuts.flatMap(cut=>cut.rows)}}),filters),table=tables.find(table=>table.title==='AOV and units by order stream')!;
 expect(table.rows).toEqual([['2026-10-11','one_time','$90.00','3','$30.00','6','2'],['2026-10-11','first_subscription','$40.00','2','$20.00','2','1'],['2026-10-11','recurring_renewal','$120.00','4','$30.00','8','2'],['2026-10-11','unclassified','$10.00','1','$10.00','Unavailable','Unavailable']]);expect(table.sourceIds).toEqual(['selection:brand']);expect(table.scope).toContain('separate tagged-renewal cohort');
});
it('labels currency as the original mix while computing the supplied USD refunded billed-revenue share',()=>{
 const cuts=[details('renewalDiagnostics',{store_date:filters.to,reported_currency:'CAD'},{renewal_orders:4,renewal_units:12,renewal_refund_money:20,renewal_billed_revenue:100}),details('renewalDiagnostics',{store_date:filters.to,reported_currency:'JPY'},{renewal_orders:0,renewal_units:0,renewal_refund_money:null,renewal_billed_revenue:0})];
 const table=evidenceReviewTables(client({renewalDiagnostics:{...cuts[0],rows:cuts.flatMap(cut=>cut.rows)}}),filters).find(table=>table.title==='Renewal currency mix and refunded billed revenue')!;
 expect(table.rows).toEqual([['2026-10-11','CAD','4','12','3','$100.00','$20.00','20.00%'],['2026-10-11','JPY','0','0','Unavailable','$0.00','Unavailable','Unavailable']]);expect(table.scope).toContain('Amounts in USD');expect(table.scope).toContain('include shipping and tax');expect(table.scope).toContain('refunded-order rate');
});
it('reconciles observed promotion orders, units and AOV without presenting cohort cancellations as events',()=>{
 const hygiene=details('orderHygiene',{store_date:filters.to,promo_code:'ONBRAND'},{orders_with_promo:5,revenue_with_promo:100,orders_without_promo:2,revenue_without_promo:80,promo_orders:3,promo_zero_orders:2,promo_cancelled_orders:1,promo_units:15,promo_cancelled_units:7});
 const tables=evidenceReviewTables(client({orderHygiene:hygiene}),filters),aov=tables.find(table=>table.title==='AOV with and without observed promotion')!,cohort=tables.find(table=>table.title==='Promotion order and unit reconciliation')!;
 expect(aov.rows).toEqual([['2026-10-11','ONBRAND','$100.00','5','$20.00','$80.00','2','$40.00']]);expect(cohort.rows).toEqual([['2026-10-11','ONBRAND','3','2','1','15','7']]);expect(cohort.scope).toContain('original order-date cohort');expect(cohort.scope).toContain('not cancellation events');expect(aov.sourceIds).toEqual(['selection:brand']);
});
it('uses an explicitly dated closed reference and its citation when current partial diagnostics are absent',()=>{
 const c=client({}),cut=details('orderStreams',{store_date:'2026-10-10',order_stream:'one_time'},{revenue:80,orders:2,units:4});c.priorClosedDetail={datasets:{orderStreams:{...cut,storeDate:'2026-10-10',comparisonDate:'2026-10-09',sourceId:'closed-detail:brand:2026-10-10',scopeLabel:'Closed-day reference · 2026-10-10',comparison:{rows:[]}}}};
 const table=evidenceReviewTables(c,{...filters,mode:'partial'}).find(table=>table.title==='AOV and units by order stream')!;expect(table.scope).toContain('Closed-day reference · 2026-10-10');expect(table.rows[0][0]).toBe('2026-10-10');expect(table.sourceIds).toEqual(['closed-detail:brand:2026-10-10']);
 expect(evidenceReviewTables(client({}),filters).some(table=>/order stream|currency mix|promotion/i.test(table.title))).toBe(false);
});
