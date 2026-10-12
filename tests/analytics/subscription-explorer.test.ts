import {describe,it,expect} from 'vitest';
import {buildSubscriptionExplorer,subscriptionMetricValue} from '../../lib/analytics/subscription-explorer';

const range={from:'2026-10-10',to:'2026-10-12'};
const comparisonRange={from:'2026-09-10',to:'2026-09-12'};
describe('subscription explorer',()=>{
 it('aligns comparison store dates without replacing missing dates with zeros',()=>{
  const result=buildSubscriptionExplorer({range,comparisonRange,current:[{date:'2026-10-10',metrics:{recurring_revenue:100,recurring_orders:5}},{date:'2026-10-12',metrics:{recurring_revenue:0,recurring_orders:0}}],comparison:[{date:'2026-09-10',metrics:{recurring_revenue:90,recurring_orders:3}},{date:'2026-09-11',metrics:{recurring_revenue:80,recurring_orders:4}}]});
  expect(result.points.map(row=>[row.date,row.comparisonDate,row.selected.recurring_revenue,row.comparison.recurring_revenue])).toEqual([['2026-10-10','2026-09-10',100,90],['2026-10-11','2026-09-11',null,80],['2026-10-12','2026-09-12',0,null]]);
  expect(result.current.coverage.recurring_revenue).toEqual({reportedDays:2,totalDays:3});
 });
 it('calculates period refund and cancellation rates from counts, not a mean of daily rates',()=>{
  const result=buildSubscriptionExplorer({range:{from:'2026-10-10',to:'2026-10-11'},comparisonRange:{from:'2026-10-08',to:'2026-10-09'},current:[{date:'2026-10-10',metrics:{recurring_revenue:200,recurring_orders:10,recurring_refund_orders:2,recurring_cancelled_orders:1}},{date:'2026-10-11',metrics:{recurring_revenue:900,recurring_orders:90,recurring_refund_orders:3,recurring_cancelled_orders:4}}],comparison:[]});
  expect(result.current.metrics.recurring_revenue).toBe(1100);
  expect(subscriptionMetricValue(result.current.metrics,'refund_rate')).toBe(.05);
  expect(subscriptionMetricValue(result.current.metrics,'cancellation_rate')).toBe(.05);
  expect(subscriptionMetricValue(result.current.metrics,'aov')).toBe(11);
 });
 it('withholds a period rate when numerator and denominator have different captured store days',()=>{
  const result=buildSubscriptionExplorer({range:{from:'2026-10-10',to:'2026-10-11'},comparisonRange:{from:'2026-10-08',to:'2026-10-09'},current:[{date:'2026-10-10',metrics:{recurring_orders:10,recurring_refund_orders:2,recurring_revenue:200}},{date:'2026-10-11',metrics:{recurring_orders:90}}],comparison:[]});
  expect(subscriptionMetricValue(result.current.metrics,'refund_rate')).toBeNull();
  expect(subscriptionMetricValue(result.current.metrics,'aov')).toBeNull();
 });
 it('keeps order-date cohort cancellations separate from calendar-date cancellation events',()=>{
  const result=buildSubscriptionExplorer({range:{from:'2026-10-10',to:'2026-10-10'},comparisonRange:{from:'2026-10-09',to:'2026-10-09'},current:[{date:'2026-10-10',metrics:{recurring_orders:100,recurring_cancelled_orders:4}}],comparison:[],currentEvents:[{date:'2026-10-10',metrics:{subscription_cancellations:12}}]});
  expect(result.current.metrics.recurring_cancelled_orders).toBe(4);
  expect(result.current.metrics.subscription_cancellations).toBe(12);
  expect(result.points[0].selected.recurring_cancelled_orders).toBe(4);
 });
 it('preserves a known invalid metric and refuses to double-count duplicate days',()=>{
  const result=buildSubscriptionExplorer({range:{from:'2026-10-10',to:'2026-10-11'},comparisonRange:{from:'2026-10-08',to:'2026-10-09'},current:[{date:'2026-10-10',metrics:{recurring_orders:10,recurring_refund_orders:null}},{date:'2026-10-11',metrics:{recurring_orders:5}},{date:'2026-10-11',metrics:{recurring_orders:5}}],comparison:[]});
  expect(result.points[1].selected.recurring_orders).toBeNull();
  expect(result.current.metrics.recurring_orders).toBeNull();
  expect(subscriptionMetricValue(result.current.metrics,'refund_rate')).toBeNull();
 });
 it('limits a custom comparison to its own date range instead of inventing extra comparison dates',()=>{
  const result=buildSubscriptionExplorer({range,comparisonRange:{from:'2026-09-10',to:'2026-09-10'},current:[],comparison:[{date:'2026-09-10',metrics:{recurring_orders:4}},{date:'2026-09-11',metrics:{recurring_orders:8}}]});
  expect(result.points.map(row=>row.comparisonDate)).toEqual(['2026-09-10',null,null]);
  expect(result.previous.metrics.recurring_orders).toBe(4);
  expect(subscriptionMetricValue({recurring_orders:0,recurring_revenue:0},'aov')).toBeNull();
 });
});
