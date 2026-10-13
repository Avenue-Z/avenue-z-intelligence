import type {QueryFilters} from './contracts';
import {comparisonPeriod,shiftDate} from './windows';
export type TrendContextMode='7d'|'30d'|'selected';
/** Chart context does not change the selected KPI period or its comparison. */
export function trendContextRange(filters:QueryFilters,mode:TrendContextMode,comparisonFrom=comparisonPeriod(filters).from){
 const from=mode==='selected'?filters.from:shiftDate(filters.to,mode==='7d'?-6:-29),to=filters.to;
 const offset=Math.round((Date.parse(comparisonFrom)-Date.parse(filters.from))/86400000);
 return {from,to,comparisonFrom:shiftDate(from,offset),comparisonTo:shiftDate(to,offset)};
}
export function trendContextWindows(filters:QueryFilters):[string,string][]{
 const range=trendContextRange(filters,'30d');
 return [[range.from,range.to],[range.comparisonFrom,range.comparisonTo]];
}
/** A captured live selection overrides its older historical materialization. */
export function contextSeries<T extends {date:string}>(selected:T[],history:T[],range:{from:string;to:string}):T[]{
 const days=new Map(history.map(point=>[point.date,point]));
 for(const point of selected)days.set(point.date,point);
 return [...days.values()].filter(point=>point.date>=range.from&&point.date<=range.to).sort((a,b)=>a.date.localeCompare(b.date));
}
