import type {Observation} from './contracts';
import {metricSummary} from './query';
import {shiftDate} from './windows';
export function datasetSeries(rows:Observation[],from:string,to:string,datasets:string[]){
 const groups=new Map<string,Observation[]>();for(const row of rows){const key=`${row.dataset}:${row.date}`;const values=groups.get(key);if(values)values.push(row);else groups.set(key,[row]);}
 return Object.fromEntries(datasets.map(dataset=>{const points=[];for(let date=from;date<=to;date=shiftDate(date,1)){const values=groups.get(`${dataset}:${date}`)??[],{metrics,summary}=metricSummary(values);points.push({date,metrics,summary});}return [dataset,points];}));
}
