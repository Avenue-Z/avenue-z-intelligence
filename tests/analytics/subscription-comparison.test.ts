import {describe,expect,it} from 'vitest';
import {subscriptionComparison} from '../../lib/analytics/subscription-comparison';

describe('subscription comparison direction and desirability',()=>{
 it('treats rising revenue, orders and AOV as favorable',()=>{
  for(const metric of ['recurring_revenue','recurring_orders','aov'] as const){
   expect(subscriptionComparison(metric,120,100)).toMatchObject({direction:'up',tone:'favorable',kind:'percent',value:20});
   expect(subscriptionComparison(metric,80,100)).toMatchObject({direction:'down',tone:'unfavorable',kind:'percent',value:-20});
  }
 });
 it('treats rising cancellation and refund counts and rates as unfavorable',()=>{
  for(const metric of ['subscription_cancellation_events','recurring_cancelled_orders','recurring_refund_orders','cancellation_rate','refund_rate','same_day_cancellation_rate','same_day_subscription_cancellation_events'] as const){
   expect(subscriptionComparison(metric,.12,.1)).toMatchObject({direction:'up',tone:'unfavorable'});
   expect(subscriptionComparison(metric,.08,.1)).toMatchObject({direction:'down',tone:'favorable'});
  }
 });
 it('uses percentage points for rates, including zero baselines',()=>{
  const result=subscriptionComparison('refund_rate',.12,.1);
  expect(result.kind).toBe('percentagePoints');
  expect(result.value).toBeCloseTo(2);
  expect(subscriptionComparison('same_day_cancellation_rate',.04,0)).toMatchObject({kind:'percentagePoints',value:4,tone:'unfavorable'});
 });
 it('keeps zero movement and missing or invalid data neutral',()=>{
  expect(subscriptionComparison('subscription_cancellation_events',8,8)).toMatchObject({direction:'unchanged',tone:'neutral',value:0});
  expect(subscriptionComparison('recurring_orders',0,0)).toMatchObject({direction:'unchanged',tone:'neutral',value:0});
  for(const value of [null,NaN,Infinity])expect(subscriptionComparison('recurring_revenue',value,100)).toMatchObject({direction:'unavailable',tone:'neutral',value:null});
 });
 it('shows an absolute change from a zero count baseline instead of an infinite percentage',()=>{
  expect(subscriptionComparison('subscription_cancellation_events',4,0)).toMatchObject({direction:'up',tone:'unfavorable',kind:'absolute',value:4});
 });
});
