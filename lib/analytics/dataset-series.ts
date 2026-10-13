import type {Observation} from './contracts';
import type {FunnelRollupObservation} from './funnel-rollup';
import {metricSummary} from './query';
import {shiftDate,dayWindow} from './windows';
export function datasetSeries(rows:Observation[],from:string,to:string,datasets:string[]){
 const groups=new Map<string,Observation[]>();for(const row of rows){const key=`${row.dataset}:${row.date}`;const values=groups.get(key);if(values)values.push(row);else groups.set(key,[row]);}
 return Object.fromEntries(datasets.map(dataset=>{const points=[];for(let date=from;date<=to;date=shiftDate(date,1)){const values=groups.get(`${dataset}:${date}`)??[],{metrics,summary}=metricSummary(values);points.push({date,metrics,summary});}return [dataset,points];}));
}
/** Real elapsed-hour buckets preserve 23/25-hour store days. Longer source
 * intervals remain daily evidence; they cannot produce hourly chart points.
 */
export function datasetHourlySeries(rows:Observation[],date:string,timezone:string,datasets:string[],through?:string){
 const window=dayWindow(date,timezone),start=Date.parse(window.start),end=Math.min(Date.parse(window.end),through?Date.parse(through):Infinity),groups=new Map<string,Map<number,Observation[]>>();
 for(const row of rows){if(row.date!==date||!row.start||!row.end||!datasets.includes(row.dataset)||(row as FunnelRollupObservation).aggregation)continue;const from=Date.parse(row.start),to=Date.parse(row.end);if(to-from!==3600000||from<start||to>end||(from-start)%3600000!==0)continue;let hours=groups.get(row.dataset);if(!hours){hours=new Map();groups.set(row.dataset,hours);}const values=hours.get(from);if(values)values.push(row);else hours.set(from,[row]);}
 return Object.fromEntries(datasets.map(dataset=>{const hours=groups.get(dataset),points=[];if(hours?.size)for(let instant=start;instant+3600000<=end;instant+=3600000){const {metrics,summary}=metricSummary(hours.get(instant)??[]);points.push({date,start:new Date(instant).toISOString().replace('.000Z','Z'),end:new Date(instant+3600000).toISOString().replace('.000Z','Z'),metrics,summary});}return [dataset,points];}));
}
