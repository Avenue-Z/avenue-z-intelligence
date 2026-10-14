import type {SubscriptionMetric} from './subscription-explorer';

type ComparisonDirection='up'|'down'|'unchanged'|'unavailable';
type ComparisonTone='favorable'|'unfavorable'|'neutral';
type ComparisonKind='percent'|'percentagePoints'|'absolute';
const lowerIsBetter=new Set<SubscriptionMetric>(['subscription_cancellation_events','recurring_cancelled_orders','recurring_refund_orders','cancellation_rate','refund_rate','same_day_cancellation_rate','same_day_subscription_cancellation_events']);

/** Rates compare in percentage points; volume/value changes use the numeric baseline. */
export function subscriptionComparison(metric:SubscriptionMetric,current:number|null,previous:number|null):{direction:ComparisonDirection;tone:ComparisonTone;kind:ComparisonKind;value:number|null}{
 const rate=metric==='refund_rate'||metric==='cancellation_rate'||metric==='same_day_cancellation_rate';
 if(current===null||previous===null||!Number.isFinite(current)||!Number.isFinite(previous))return {direction:'unavailable',tone:'neutral',kind:rate?'percentagePoints':'percent',value:null};
 const difference=current-previous,direction=difference>0?'up':difference<0?'down':'unchanged';
 const tone=difference===0?'neutral':(lowerIsBetter.has(metric)?difference<0:difference>0)?'favorable':'unfavorable';
 if(rate)return {direction,tone,kind:'percentagePoints',value:difference*100};
 if(previous===0&&difference!==0)return {direction,tone,kind:'absolute',value:difference};
 return {direction,tone,kind:'percent',value:previous===0?0:difference/Math.abs(previous)*100};
}
