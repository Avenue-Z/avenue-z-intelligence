import {Temporal} from '@js-temporal/polyfill';
import type {Observation} from './contracts';
export type FunnelRollupOptions={timezone:string;cutoffClock?:string};
export type FunnelRollupObservation=Observation&{aggregation?:'hourly_public_page_funnel_rollup';contributionCount?:number};
const metrics=new Set(['sessions','atc_sessions','checkouts','converting_sessions','completed_checkouts']);
type Interval={start:number;end:number};

/** Read-time compaction of an already reconciled, sparse public-page export.
 * Bounds describe contributed rows; they never establish continuous coverage.
 */
export class FunnelRollupAccumulator {
 private rows:FunnelRollupObservation[]=[];
 private groups=new Map<string,FunnelRollupObservation>();
 private intervals=new Map<string,Interval|null>();
 private cutoffs=new Map<string,number|null>();
 private clock:Temporal.PlainTime|null=null;
 private enabled=true;
 constructor(private options:FunnelRollupOptions){
  try{
   Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(options.timezone);
   if(options.cutoffClock!==undefined)this.clock=Temporal.PlainTime.from(options.cutoffClock);
  }catch{this.enabled=false;}
 }
 private interval(row:Observation):Interval|null {
  const key=JSON.stringify([row.date,row.start,row.end]);
  if(this.intervals.has(key))return this.intervals.get(key)!;
  let result:Interval|null=null;
  try{
   const day=Temporal.PlainDate.from(row.date),start=Temporal.Instant.from(row.start!),end=Temporal.Instant.from(row.end!),local=start.toZonedDateTimeISO(this.options.timezone);
   const expectedStart=day.toZonedDateTime({timeZone:this.options.timezone,plainTime:`${String(local.hour).padStart(2,'0')}:00`});
   const expectedEnd=local.hour===23?day.add({days:1}).toZonedDateTime(this.options.timezone):day.toZonedDateTime({timeZone:this.options.timezone,plainTime:`${String(local.hour+1).padStart(2,'0')}:00`});
   // Match the provider's hour_of_day grain, including its merged repeated
   // hour. Daily totals and arbitrary spans stay available as raw evidence.
   if(local.toPlainDate().equals(day)&&start.epochNanoseconds===expectedStart.epochNanoseconds&&end.epochNanoseconds===expectedEnd.epochNanoseconds)result={start:Number(start.epochMilliseconds),end:Number(end.epochMilliseconds)};
  }catch{/* Unknown interval: preserve the original observation. */}
  this.intervals.set(key,result);return result;
 }
 private cutoff(date:string):number|null {
  if(this.cutoffs.has(date))return this.cutoffs.get(date)!;
  let result:number|null=null;
  try{result=Number(Temporal.PlainDate.from(date).toZonedDateTime({timeZone:this.options.timezone,plainTime:this.clock!}).epochMilliseconds);}catch{/* Preserve unknown dates. */}
  this.cutoffs.set(date,result);return result;
 }
 add(row:Observation){
  const dimensions=Object.keys(row.dimensions??{});
  const known=this.enabled&&row.quality==='complete'&&row.dataset==='funnels'&&row.definition==='shopify_human_public_landing_pages'&&row.population==='human_public_landing_page_sessions'&&metrics.has(row.metric)&&!!row.sourceId&&!!row.start&&!!row.end&&!!row.coverageThrough&&dimensions.length===2&&typeof row.dimensions.page==='string'&&typeof row.dimensions.market==='string'&&(row.value===null||(Number.isSafeInteger(row.value)&&row.value>=0))&&row.numerator===undefined&&row.denominator===undefined&&!(row as FunnelRollupObservation).aggregation;
  if(!known){this.rows.push(row);return;}
  const interval=this.interval(row);
  if(!interval||!Number.isFinite(Date.parse(row.coverageThrough!))||Date.parse(row.coverageThrough!)<interval.end){this.rows.push(row);return;}
  if(this.clock){const cutoff=this.cutoff(row.date);if(cutoff===null){this.rows.push(row);return;}if(interval.end>cutoff)return;}
  const key=JSON.stringify([row.sourceId,row.date,row.metric,Object.entries(row.dimensions).sort(),row.definition,row.population,row.currency,row.quality,row.coverageThrough,[...(row.channels??[])].sort()]);
  const existing=this.groups.get(key);
  if(existing){
   const value=existing.value===null||row.value===null?null:existing.value+row.value;
   if(value!==null&&!Number.isSafeInteger(value))throw new Error('Funnel rollup exceeds the safe count range');
   existing.value=value;existing.contributionCount!++;
   if(interval.start<Date.parse(existing.start!))existing.start=row.start;
   if(interval.end>Date.parse(existing.end!))existing.end=row.end;
   if(Date.parse(row.retrievedAt)>Date.parse(existing.retrievedAt))existing.retrievedAt=row.retrievedAt;
  }else{
   const aggregate:FunnelRollupObservation={...row,dimensions:{...row.dimensions},...row.channels?{channels:[...row.channels]}:{},aggregation:'hourly_public_page_funnel_rollup',contributionCount:1};
   this.groups.set(key,aggregate);this.rows.push(aggregate);
  }
 }
 finish(){return this.rows;}
}
