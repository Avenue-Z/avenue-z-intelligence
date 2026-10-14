import type {ExplorerMetric} from './traffic-explorer';
import type {Client} from './contracts';
export type TrafficMeasurementIncident=Client['config']['incidents'][number];
/** Compare tracking-sensitive values only within their configured regime. */
export function trafficMeasurementCaveat(incidents:readonly TrafficMeasurementIncident[],current:{from:string;to:string},comparison:{from:string;to:string}){
 const earliest=[current.from,comparison.from].sort()[0],latest=[current.to,comparison.to].sort().at(-1)!;
 const overlaps=(period:{from:string;to:string},incident:TrafficMeasurementIncident)=>period.from<=(incident.end??incident.start)&&period.to>=incident.start;
 const incident=incidents.find(value=>value.metrics.some(metric=>['atc','atc_rate','atc_sessions'].includes(metric))&&(value.end?overlaps(current,value)||overlaps(comparison,value):earliest<=value.start&&latest>=value.start));
 return incident?`${incident.start}: ${incident.note}`:null;
}

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
