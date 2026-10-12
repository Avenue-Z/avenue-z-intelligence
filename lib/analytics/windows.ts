import { Temporal } from '@js-temporal/polyfill';
import type {QueryFilters} from './contracts';
export function comparisonPeriod(f:QueryFilters){const days=Temporal.PlainDate.from(f.from).until(Temporal.PlainDate.from(f.to)).days+1,offset=f.compare==='weekday'?7:f.compare==='fourWeeks'?28:f.compare==='thirtyDays'?30:days;const from=f.compare==='custom'&&f.compareFrom?Temporal.PlainDate.from(f.compareFrom).toString():shiftDate(f.from,-offset),to=shiftDate(from,days-1);if(f.compare==='custom'&&f.compareTo&&f.compareTo!==to)throw new Error(`Choose a comparison of ${days} calendar days, matching the selected period`);return {...f,from,to};}
export function dayWindow(date:string,timezone:string) {
  const d=Temporal.PlainDate.from(date);const start=d.toZonedDateTime({timeZone:timezone,plainTime:'00:00'});const end=d.add({days:1}).toZonedDateTime({timeZone:timezone,plainTime:'00:00'});
  return {start:start.toInstant().toString(),end:end.toInstant().toString(),timezone,durationHours:Number(end.epochMilliseconds-start.epochMilliseconds)/3600000};
}
export function recurringWindows(date:string) {const d=Temporal.PlainDate.from(date),m=d.subtract({days:d.dayOfWeek-1});return {current:m.toString(),comparison:m.subtract({weeks:4}).toString()};}
export function shiftDate(date:string,days:number){return Temporal.PlainDate.from(date).add({days}).toString();}
export function todayIn(timezone:string,now=new Date()) {return Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(timezone).toPlainDate().toString();}
export function matchedCutoff(values:string[],timezone='UTC') {if(!values.length) return null;const ms=Math.min(...values.map(x=>Date.parse(x)));const local=Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timezone);return local.with({minute:0,second:0,millisecond:0,microsecond:0,nanosecond:0}).toInstant().toString();}
