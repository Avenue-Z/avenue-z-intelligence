import type {ExplorerMetric} from './traffic-explorer';

const rateMetrics=new Set<ExplorerMetric>(['cvr','atc','checkoutCompletion']);
const adverseMetrics=new Set<ExplorerMetric>(['refunds','discounts']);
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);

/** Compare qualified values from the same prepared current/comparison cohort. */
export function trafficMetricComparison(metric:ExplorerMetric,current:number|null|undefined,previous:number|null|undefined){
 if(!finite(current)||!finite(previous))return {direction:'unavailable' as const,tone:'neutral' as const,value:null,unit:rateMetrics.has(metric)?'pp' as const:'percent' as const};
 const difference=current-previous,direction=difference>0?'up' as const:difference<0?'down' as const:'unchanged' as const;
 const tone=difference===0?'neutral' as const:(difference>0)!==adverseMetrics.has(metric)?'favorable' as const:'unfavorable' as const;
 if(rateMetrics.has(metric))return {direction,tone,value:difference*100,unit:'pp' as const};
 return {direction,tone,value:previous===0?difference:difference/Math.abs(previous)*100,unit:previous===0?'count' as const:'percent' as const};
}
