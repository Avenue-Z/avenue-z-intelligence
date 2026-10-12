import type {Observation} from './contracts';
import {summarize,sumMetric} from './query';
import {shiftDate} from './windows';
export function datasetSeries(rows:Observation[],from:string,to:string,datasets:string[]){
 const groups=new Map<string,Observation[]>();for(const row of rows){const key=`${row.dataset}:${row.date}`;const values=groups.get(key);if(values)values.push(row);else groups.set(key,[row]);}
 return Object.fromEntries(datasets.map(dataset=>{const points=[];for(let date=from;date<=to;date=shiftDate(date,1)){const values=groups.get(`${dataset}:${date}`)??[],metrics=Object.fromEntries([...new Set(values.map(r=>r.metric))].map(metric=>[metric,sumMetric(values,metric)]));points.push({date,metrics,summary:summarize(values)});}return [dataset,points];}));
}
