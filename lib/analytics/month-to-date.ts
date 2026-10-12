import {Temporal} from '@js-temporal/polyfill';
import type {Client,Observation,QueryFilters} from './contracts';
import {dayWindow,shiftDate,todayIn} from './windows';
import {preferredObservations} from './source-precedence';
import {summarize,sumMetric} from './query';
import {ratio} from './metrics';
import {sanitizePage,sourceMarket} from '../sources/kind-patches';
const dimensions=['market','stream','source','device','page'] as const;
type MetricCoverage={missingDates:string[];unconfirmedDates:string[];complete:boolean};
function matchingGrain(rows:Observation[],numerator:string,denominator:string){
 const keys=(metric:string)=>rows.filter(row=>row.metric===metric).map(row=>JSON.stringify([row.sourceId,row.date,row.start,row.end,row.population,row.definition,Object.entries(row.dimensions).sort()])).sort();
 const a=rows.filter(row=>row.metric===numerator),b=rows.filter(row=>row.metric===denominator);
 return a.length>0&&b.length>0&&[...a,...b].every(row=>!!row.population)&&JSON.stringify(keys(numerator))===JSON.stringify(keys(denominator));
}
function confirmedDay(rows:Observation[],date:string,timezone:string,end:number){
 const window=dayWindow(date,timezone),start=Date.parse(window.start),fullEnd=Date.parse(window.end);
 if(!rows.length||rows.some(row=>row.value===null||row.quality!=='complete'||!row.coverageThrough||Date.parse(row.coverageThrough)<end||!Number.isFinite(Date.parse(row.coverageThrough))))return false;
 const timed=rows.filter(row=>row.start||row.end);
 if(!timed.length)return end===fullEnd;
 if(timed.length!==rows.length)return false;
 const intervals=[...new Map(timed.map(row=>[JSON.stringify([row.start,row.end]),[Date.parse(row.start!),Date.parse(row.end!)] as const])).values()].sort((a,b)=>a[0]-b[0]);let cursor=start;
 for(const [from,to] of intervals){if(!Number.isFinite(from)||!Number.isFinite(to)||from<start||to>end||from>=to||from>cursor)return false;cursor=Math.max(cursor,to);}
 return cursor===end;
}

/** Calendar MTD preserves complete earlier days; only its final day may be
 * partial. A prior-month comparison maps the shared clock to that date's UTC
 * offset, and missing facts remain observed totals with explicit coverage. */
export function monthToDateSummary(client:Client,input:Observation[],filters:QueryFilters,sharedCutoff:string|null){
 const {from,to}=filters,warnings:string[]=[],today=todayIn(client.timezone),active=dimensions.filter(key=>!!filters[key]);
 let finalCutoff:string|null=null;
 if(filters.mode==='partial'&&sharedCutoff)try{const instant=Temporal.Instant.from(sharedCutoff),local=instant.toZonedDateTimeISO(client.timezone);finalCutoff=local.toPlainDate().toString()===to?instant.toString():Temporal.PlainDate.from(to).toZonedDateTime({timeZone:client.timezone,plainTime:local.toPlainTime()}).toInstant().toString();}catch{/* An unknown clock cannot establish a partial day. */}
 if(filters.mode==='partial'&&!finalCutoff)warnings.push('The final store-day cutoff is unconfirmed. Earlier closed-day values are observed totals; complete MTD coverage is not established.');
 const expectedDates:string[]=[];for(let date=from;date<=to;date=shiftDate(date,1)){expectedDates.push(date);if(expectedDates.length>62)throw Error('MTD window exceeds 62 days');}
 const normalized=input.filter(row=>row.dataset==='overview'&&row.date>=from&&row.date<=to).map(row=>{const page=row.dimensions.page?sanitizePage(row.dimensions.page):undefined;return page&&page!==row.dimensions.page?{...row,dimensions:{...row.dimensions,page}}:row;});
 const earlier=preferredObservations(normalized.filter(row=>row.date<to&&row.date<today),{timezone:client.timezone,partial:false});
 const final=preferredObservations(normalized.filter(row=>row.date===to&&(filters.mode==='partial'||row.date<today)),{timezone:client.timezone,partial:filters.mode==='partial'});
 const scoped=[...earlier,...final].map(row=>{const market=row.dimensions.market?sourceMarket(row.dimensions.market):undefined;return market&&market!==row.dimensions.market?{...row,dimensions:{...row.dimensions,market}}:row;});
 const blocked=new Set(scoped.filter(row=>active.some(key=>row.dimensions[key]===undefined)).map(row=>row.metric));
 if(blocked.size)warnings.push(`Unsupported requested dimensions make these MTD metrics unavailable: ${[...blocked].sort().join(', ')}.`);
 const market=filters.market?sourceMarket(filters.market):'';
 const selected=scoped.filter(row=>!blocked.has(row.metric)&&active.every(key=>row.dimensions[key]===(key==='market'?market:filters[key]))&&(row.date!==to||filters.mode!=='partial'||!!finalCutoff&&!!row.start&&!!row.end&&Number.isFinite(Date.parse(row.start))&&Date.parse(row.start)>=Date.parse(dayWindow(to,client.timezone).start)&&Date.parse(row.end)>Date.parse(row.start)&&Date.parse(row.end)<=Date.parse(finalCutoff)));
 const metrics=summarize(selected),coverage:Record<string,MetricCoverage>={};
 for(const metric of new Set(['revenue','orders','spend','new_orders',...selected.map(row=>row.metric)])){
  const missingDates:string[]=[],unconfirmedDates:string[]=[];
  for(const date of expectedDates){const rows=selected.filter(row=>row.date===date&&row.metric===metric),end=date===to&&filters.mode==='partial'?(finalCutoff?Date.parse(finalCutoff):NaN):Date.parse(dayWindow(date,client.timezone).end);
   if(!rows.length)missingDates.push(date);else if(!Number.isFinite(end)||!confirmedDay(rows,date,client.timezone,end)||sumMetric(rows,metric)===null)unconfirmedDates.push(date);
  }
  coverage[metric]={missingDates,unconfirmedDates,complete:expectedDates.length>0&&!missingDates.length&&!unconfirmedDates.length&&sumMetric(selected,metric)!==null};
 }
 metrics.aov=matchingGrain(selected,'revenue','orders')?ratio(metrics.revenue,metrics.orders):null;
 metrics.cvr=matchingGrain(selected,'converting_sessions','sessions')?metrics.cvr:null;
 metrics.atc=matchingGrain(selected,'atc_sessions','sessions')?metrics.atc:null;
 metrics.checkoutCompletion=matchingGrain(selected,'completed_checkouts','checkouts')?metrics.checkoutCompletion:null;
 const spending=selected.filter(row=>row.metric==='spend'),revenue=selected.filter(row=>row.metric==='revenue');
 const qualifiedMer=coverage.revenue.complete&&coverage.spend.complete&&client.config.spendChannels.length>0&&spending.length>0&&spending.every(row=>row.currency===client.currency&&client.config.spendChannels.every(channel=>(row.channels??[]).includes(channel)))&&revenue.every(row=>row.currency===client.currency&&row.definition===client.config.revenueDefinition);
 if(!qualifiedMer)metrics.mer=null;
 const fullElapsedDayCoverage=coverage.revenue.complete&&coverage.orders.complete&&(filters.mode!=='partial'||!!finalCutoff);
 for(const metric of ['revenue','orders'])if(!coverage[metric].complete){const c=coverage[metric];warnings.push(`Complete elapsed-period ${metric} coverage is not established${c.missingDates.length?`; missing dates: ${c.missingDates.join(', ')}`:''}${c.unconfirmedDates.length?`; unconfirmed dates: ${c.unconfirmedDates.join(', ')}`:''}. These values are observed totals.`);}
 const quality=[...new Set(selected.map(row=>row.quality))];if(quality.some(value=>value!=='complete'))warnings.push(`MTD evidence includes ${quality.filter(value=>value!=='complete').join(', ')} observations.`);
 return {from,to,metrics,warnings,observedDates:[...new Set(selected.map(row=>row.date))].sort(),quality,finalCutoff,coverage,fullElapsedDayCoverage,scopeLabel:fullElapsedDayCoverage?`MTD ${from}–${to}${finalCutoff?`; final store day through ${finalCutoff}`:''}`:`Observed totals ${from}–${to}; complete elapsed-period coverage is not established`};
}
