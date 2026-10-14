import type {QueryFilters} from './contracts';
import {comparisonPeriod,shiftDate} from './windows';
import {Temporal} from '@js-temporal/polyfill';
export type TrendContextMode='7d'|'30d'|'selected';
export type TrendCutoff={timezone:string;cutoff:string|null;anchorDate:string};
/** The confirmed store clock maps to each chart date; next-midnight coverage
 * completes a day instead of clipping it to that day's starting boundary. */
export function trendCutoffEnd(date:string,{timezone,cutoff,anchorDate}:TrendCutoff):number|null{
 if(!cutoff)return null;
 try{const local=Temporal.Instant.from(cutoff).toZonedDateTimeISO(timezone),clock=local.toPlainTime(),day=Temporal.PlainDate.from(date),completedDay=clock.equals(Temporal.PlainTime.from('00:00'))&&Temporal.PlainDate.compare(local.toPlainDate(),Temporal.PlainDate.from(anchorDate))>0,end=completedDay?day.add({days:1}).toZonedDateTime(timezone):day.toZonedDateTime({timeZone:timezone,plainTime:clock});return Number(end.epochMilliseconds);}catch{return null;}
}
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
/** Matched live history takes precedence over full earlier selected days;
 * the final selected day remains authoritative, as does Selected period. */
export function contextSeries<T extends {date:string}>(selected:T[],history:T[],range:{from:string;to:string},preferContext=false):T[]{
 const days=new Map(history.map(point=>[point.date,point]));
 for(const point of selected)if(!preferContext||point.date===range.to||!days.has(point.date))days.set(point.date,point);
 return [...days.values()].filter(point=>point.date>=range.from&&point.date<=range.to).sort((a,b)=>a.date.localeCompare(b.date));
}
