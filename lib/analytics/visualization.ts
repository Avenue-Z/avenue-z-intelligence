import {finiteMetric} from './display';

export type ChartUnit='currency'|'count'|'percent'|'multiple';
export type ChartMetric={key:string;label:string;unit:ChartUnit;color?:string};
export type MetricSeriesPoint={date:string;[metric:string]:string|number|null|undefined};
export type AlignedMetricPoint=MetricSeriesPoint&{comparisonDate:string|null};
const DAY=86400000;
const dateValue=(date:string|undefined)=>date&&/^\d{4}-\d{2}-\d{2}$/.test(date)?Date.parse(`${date}T00:00:00Z`):NaN;
const shifted=(date:string,offset:number)=>new Date(dateValue(date)+offset*DAY).toISOString().slice(0,10);

/** The daily comparison keeps original dates in tooltips and null gaps in both periods. */
export function alignMetricSeries(current:MetricSeriesPoint[],comparison:MetricSeriesPoint[],keys:string[],currentFrom?:string,comparisonFrom?:string):AlignedMetricPoint[]{
 const selected=[...current].sort((a,b)=>a.date.localeCompare(b.date)),prior=[...comparison].sort((a,b)=>a.date.localeCompare(b.date));
 const start=dateValue(currentFrom??selected[0]?.date),previousStart=dateValue(comparisonFrom??prior[0]?.date);
 const offset=Number.isFinite(start)&&Number.isFinite(previousStart)?Math.round((start-previousStart)/DAY):0;
 const currentDays=new Map(selected.map(row=>[row.date,row])),priorDays=new Map(prior.map(row=>[shifted(row.date,offset),row]));
 const observedDates=[...new Set([...currentDays.keys(),...priorDays.keys()])].sort();
 const dates:string[]=[];if(observedDates.length)for(let date=observedDates[0];date<=observedDates.at(-1)!;date=shifted(date,1))dates.push(date);
 return dates.map(date=>{
  const row=currentDays.get(date),previous=priorDays.get(date),value:AlignedMetricPoint={date,comparisonDate:previous?.date??null};
  for(const key of keys){const currentValue=row?.[key],comparisonValue=previous?.[key];value[key]=finiteMetric(typeof currentValue==='number'?currentValue:null)?currentValue as number:null;value[`comparison_${key}`]=finiteMetric(typeof comparisonValue==='number'?comparisonValue:null)?comparisonValue as number:null;}
  return value;
 });
}
export function availableChartMetrics(rows:MetricSeriesPoint[],metrics:ChartMetric[]){return metrics.filter(metric=>rows.some(row=>finiteMetric(typeof row[metric.key]==='number'?row[metric.key] as number:null)||finiteMetric(typeof row[`comparison_${metric.key}`]==='number'?row[`comparison_${metric.key}`] as number:null)));}
export function formatChartMetric(value:number|null|undefined,unit:ChartUnit,currency:string,compact=false){
 if(!finiteMetric(value))return 'Unavailable';
 if(unit==='percent')return `${(value*100).toFixed(compact?1:2)}%`;
 if(unit==='multiple')return `${value.toFixed(2)}×`;
 return new Intl.NumberFormat('en-US',{...(unit==='currency'?{style:'currency',currency}:{}),maximumFractionDigits:compact?1:unit==='currency'?2:0,...compact?{notation:'compact'}:{}}).format(value);
}
export function channelSpendRows(rows:{dimensions:Record<string,string>;metrics:Record<string,number|null>}[]){
 const channels=new Map<string,number>();
 for(const row of rows){const spend=row.metrics.spend;if(!finiteMetric(spend))continue;const name=row.dimensions.channel||'Reported channel';channels.set(name,(channels.get(name)??0)+spend);}
 return [...channels].map(([name,spend])=>({name,spend})).sort((a,b)=>b.spend-a.spend||a.name.localeCompare(b.name));
}
