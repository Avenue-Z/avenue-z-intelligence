import {expect,it} from 'vitest';
import {orderStreamRows,orderStreamSeries,renewalMixRows,hygieneRows} from '../../lib/analytics/order-diagnostics';
const row=(dimensions:Record<string,string>,metrics:Record<string,number|null>)=>({dimensions,metrics});
it('separates acquisition streams from renewals and derives weighted order values and units',()=>{
 const facts=[row({store_date:'2026-10-10',order_stream:'one_time'},{revenue:100,orders:10,units:20}),row({store_date:'2026-10-11',order_stream:'one_time'},{revenue:900,orders:30,units:180}),row({store_date:'2026-10-11',order_stream:'recurring_renewal'},{recurring_revenue:300,recurring_orders:15,recurring_units:45})];
 expect(orderStreamRows(facts).map(r=>[r.stream,r.revenue,r.orders,r.aov,r.unitsPerOrder])).toEqual([['one_time',1000,40,25,5],['recurring_renewal',300,15,20,3]]);
 expect(orderStreamSeries(facts,'aov')).toEqual([{date:'2026-10-10',one_time:10},{date:'2026-10-11',one_time:30,recurring_renewal:20}]);
});
it('keeps missing stream counts unknown and does not read renewals as web revenue',()=>{
 const facts=[row({store_date:'2026-10-10',order_stream:'one_time'},{revenue:100,orders:10,units:20}),row({store_date:'2026-10-11',order_stream:'one_time'},{revenue:200,orders:null,units:30}),row({store_date:'2026-10-11',order_stream:'recurring_renewal'},{revenue:999,orders:999})];
 expect(orderStreamRows(facts).map(r=>[r.stream,r.orders,r.aov])).toEqual([['one_time',null,null],['recurring_renewal',null,null]]);
});
it('uses matching billed-revenue and refund amounts, while keeping order-currency groups separate',()=>{
 const mix=renewalMixRows([row({reported_currency:'GBP'},{renewal_orders:10,renewal_units:30,renewal_refund_money:10,renewal_billed_revenue:100}),row({reported_currency:'GBP'},{renewal_orders:90,renewal_units:270,renewal_refund_money:10,renewal_billed_revenue:900}),row({reported_currency:'USD'},{renewal_orders:5,renewal_units:5,renewal_refund_money:0,renewal_billed_revenue:0})]);
 expect(mix.map(r=>[r.currency,r.orders,r.unitsPerOrder,r.refundedAmountShare])).toEqual([['GBP',100,3,.02],['USD',5,1,null]]);
});
it('distinguishes zero-value promo orders, cancelled order cohorts and calendar cancellation events',()=>{
 const hygiene=hygieneRows([row({promo_code:'ONBRAND',store_date:'2026-09-22'},{orders_with_promo:124,revenue_with_promo:1000,orders_without_promo:100,revenue_without_promo:1000,promo_orders:24,promo_zero_orders:24,promo_cancelled_orders:21,promo_units:15700,promo_cancelled_units:12000})]);
 expect(hygiene[0]).toMatchObject({code:'ONBRAND',withPromoAov:1000/124,withoutPromoAov:10,promoOrders:24,zeroOrders:24,cancelledOrders:21,units:15700,cancelledUnits:12000});
 expect(hygieneRows([row({promo_code:'ONBRAND'},{orders_with_promo:0,revenue_with_promo:0,orders_without_promo:0,revenue_without_promo:0,promo_orders:0,promo_zero_orders:0,promo_cancelled_orders:0,promo_units:0,promo_cancelled_units:0})])[0].withPromoAov).toBeNull();
});
