import type {Observation} from './contracts';

const rates={cvr:['converting_sessions','sessions'],atc:['atc_sessions','sessions'],checkoutCompletion:['completed_checkouts','checkouts']} as const;

/** A segment with a reported zero denominator has no individual rate. Its
 * matching count cohort can still contribute to a pooled rate. Null sums,
 * duplicate observations and unknown/different populations cannot qualify.
 */
export function compatibleZeroDenominatorRates(rows:Observation[],metrics:Record<string,number|null>):string[]{
 return Object.entries(rates).flatMap(([rate,[numerator,denominator]])=>{
  const n=metrics[numerator],d=metrics[denominator];
  if(typeof n!=='number'||!Number.isFinite(n)||n<=0||d!==0)return [];
  const populations=(metric:string)=>[...new Set(rows.filter(row=>row.metric===metric).map(row=>row.population))].sort();
  const a=populations(numerator),b=populations(denominator);
  return a.length&&a.every(value=>typeof value==='string'&&value.length>0)&&JSON.stringify(a)===JSON.stringify(b)?[rate]:[];
 });
}
