import { Temporal } from '@js-temporal/polyfill';
export function dayWindow(date:string,timezone:string) {
  const d=Temporal.PlainDate.from(date);const start=d.toZonedDateTime({timeZone:timezone,plainTime:'00:00'});const end=d.add({days:1}).toZonedDateTime({timeZone:timezone,plainTime:'00:00'});
  return {start:start.toInstant().toString(),end:end.toInstant().toString(),timezone,durationHours:Number(end.epochMilliseconds-start.epochMilliseconds)/3600000};
}
export function recurringWindows(date:string) {const d=Temporal.PlainDate.from(date),m=d.subtract({days:d.dayOfWeek-1});return {current:m.toString(),comparison:m.subtract({weeks:4}).toString()};}
export function shiftDate(date:string,days:number){return Temporal.PlainDate.from(date).add({days}).toString();}
export function todayIn(timezone:string,now=new Date()) {return Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(timezone).toPlainDate().toString();}
export function matchedCutoff(values:string[]) {if(!values.length) return null;const ms=Math.min(...values.map(x=>Date.parse(x)));return Temporal.Instant.fromEpochMilliseconds(Math.floor(ms/3600000)*3600000).toString();}
