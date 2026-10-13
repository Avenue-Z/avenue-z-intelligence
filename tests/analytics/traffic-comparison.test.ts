import {describe,expect,it} from 'vitest';
import {trafficMetricComparison} from '../../lib/analytics/traffic-comparison';

describe('traffic metric comparisons',()=>{
 it('shows conversion and checkout rates as percentage-point changes',()=>{
  const cvr=trafficMetricComparison('cvr',.05,.02);expect(cvr).toMatchObject({unit:'pp',direction:'up',tone:'favorable'});expect(cvr.value).toBeCloseTo(3);
  const checkout=trafficMetricComparison('checkoutCompletion',.4,.5);expect(checkout).toMatchObject({unit:'pp',direction:'down',tone:'unfavorable'});expect(checkout.value).toBeCloseTo(-10);
 });
 it('shows finite count growth from zero without inventing a percent',()=>{
  expect(trafficMetricComparison('atc_sessions',12,0)).toMatchObject({value:12,unit:'count',direction:'up',tone:'favorable'});
  expect(trafficMetricComparison('sessions',80,100)).toMatchObject({value:-20,unit:'percent',direction:'down',tone:'unfavorable'});
 });
 it('retains an absent qualified baseline or metric as unavailable',()=>{
  expect(trafficMetricComparison('cvr',null,.02).value).toBeNull();
  expect(trafficMetricComparison('sessions',100,undefined).direction).toBe('unavailable');
  expect(trafficMetricComparison('sessions',Infinity,100).value).toBeNull();
 });
});
