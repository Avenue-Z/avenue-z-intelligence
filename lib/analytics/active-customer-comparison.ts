import {Temporal} from '@js-temporal/polyfill';
import type {ActiveCustomerComparison,Observation} from './contracts';
export function rawActiveCustomerSnapshot(value:unknown):value is Observation&{value:number;coverageThrough:string}{
 if(!value||typeof value!=='object')return false;const row=value as Observation;
 return row.dataset==='subscriptions'&&row.metric==='active_customers'&&row.definition==='recharge_raw_active_customers_not_subscription_count_or_baseline_adjusted'&&row.population==='recharge_active_customers'&&row.currency===null&&row.quality==='complete'&&Number.isSafeInteger(row.value)&&row.value!>=0&&!!row.sourceId&&typeof row.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(row.date)&&Number.isFinite(Date.parse(row.retrievedAt))&&typeof row.coverageThrough==='string'&&Number.isFinite(Date.parse(row.coverageThrough))&&Date.parse(row.retrievedAt)>=Date.parse(row.coverageThrough)&&row.start===undefined&&row.end===undefined&&!!row.dimensions&&JSON.stringify(Object.entries(row.dimensions).sort())==='[["source","recharge"]]';
}
export function activeCustomerBaselineHour(current:Observation,timezone:string){
 const clock=Temporal.Instant.from(current.coverageThrough!).toZonedDateTimeISO(timezone),target=clock.subtract({days:1});
 // Calendar subtraction moves a nonexistent spring-forward clock forward.
 // That is another hour's stock count, never a same-hour baseline.
 if(!target.toPlainTime().equals(clock.toPlainTime()))throw Error('Yesterday has no matching store hour');
 const start=target.with({minute:0,second:0,millisecond:0,microsecond:0,nanosecond:0}),end=start.add({hours:1});
 return {date:target.toPlainDate().toString(),target:target.toInstant().toString(),start:start.toInstant().toString(),end:end.toInstant().toString(),currentDate:clock.toPlainDate().toString()};
}
export function validActiveCustomerComparison(value:unknown,current:Observation|undefined,timezone:string,prefix?:string):value is ActiveCustomerComparison{
 if(!value||typeof value!=='object'||!rawActiveCustomerSnapshot(current))return false;const comparison=value as ActiveCustomerComparison,baseline=comparison.baseline;
 if(Object.keys(value).sort().join(',')!=='alignment,baseline,delta,relativeChange'||!baseline||typeof baseline!=='object'||Object.keys(baseline).sort().join(',')!=='asOf,retrievedAt,snapshotId,value'||comparison.alignment!=='same-store-hour'||!Number.isSafeInteger(baseline.value)||baseline.value<0||typeof baseline.snapshotId!=='string'||!baseline.snapshotId||prefix&&!baseline.snapshotId.startsWith(prefix)||!Number.isFinite(Date.parse(baseline.asOf))||!Number.isFinite(Date.parse(baseline.retrievedAt))||Date.parse(baseline.retrievedAt)<Date.parse(baseline.asOf))return false;
 try{const hour=activeCustomerBaselineHour(current,timezone),asOf=Date.parse(baseline.asOf);return current.date===hour.currentDate&&asOf>=Date.parse(hour.start)&&asOf<Date.parse(hour.end)&&comparison.delta===current.value-baseline.value&&comparison.relativeChange===(baseline.value?comparison.delta/baseline.value:null);}catch{return false;}
}
