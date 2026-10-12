import type {Client,Connection,Observation,QueryFilters} from '../analytics/contracts';
import {detailRows,queryClient,sumMetric} from '../analytics/query';
import {change,ratio} from '../analytics/metrics';
import {dayWindow,shiftDate,todayIn} from '../analytics/windows';

type ObservedInterval={start:string;end:string;intervalCount:number;intervalMilliseconds:number};
type AggregatedObservation=Observation&{aggregation?:string;contributionCount?:number};
const aggregation=(row:Observation)=>{const value=(row as AggregatedObservation).aggregation;return typeof value==='string'&&value?value:undefined;};
const knownContributionCount=(row:Observation)=>{const count=(row as AggregatedObservation).contributionCount;return aggregation(row)&&typeof count==='number'&&Number.isSafeInteger(count)&&count>0?count:null;};
// Counts distinguish stored aggregate records from the hourly observations they
// represent. An unknown contribution count is explicitly qualified in provenance.
const representedCount=(row:Observation)=>knownContributionCount(row)??1;
export function compressedProvenance(rows:Observation[]){
 const groups=new Map<string,{scope:{date:string;dataset:string;metric:string;sourceId:string;definition:string;population:string|null;currency:string|null;quality:Observation['quality'];retrievedAt:string;coverageThrough:string|null;aggregation?:string};rows:Observation[]}>();
 for(const row of rows){
  const scope={date:row.date,dataset:row.dataset,metric:row.metric,sourceId:row.sourceId,definition:row.definition,population:row.population??null,currency:row.currency,quality:row.quality,retrievedAt:row.retrievedAt,coverageThrough:row.coverageThrough,...aggregation(row)?{aggregation:aggregation(row)}:{}};
  const key=JSON.stringify(scope),group=groups.get(key);if(group)group.rows.push(row);else groups.set(key,{scope,rows:[row]});
 }
 return [...groups.values()].map(({scope,rows:values})=>{
  const timed=new Map<string,{start:string;end:string}>(),incomplete=new Map<string,{start:string|null;end:string|null;observationCount:number}>();const contributedBounds:{start:string|null;end:string|null;contributionCount:number|null;continuity:'unknown'}[]=[];let intervalObservationCount=0,withoutIntervalCount=0;
  for(const row of values){
   if(aggregation(row)){
    // A rollup's min/max bounds may span absent page/hour groups. Its continuity
    // is unknown; it must never masquerade as an observed continuous interval.
    contributedBounds.push({start:row.start??null,end:row.end??null,contributionCount:knownContributionCount(row),continuity:'unknown'});continue;
   }
   if(row.start&&row.end&&Number.isFinite(Date.parse(row.start))&&Date.parse(row.end)>Date.parse(row.start)){intervalObservationCount++;timed.set(JSON.stringify([row.start,row.end]),{start:row.start,end:row.end});}
   else if(!row.start&&!row.end)withoutIntervalCount++;
   else {const key=JSON.stringify([row.start??null,row.end??null]),existing=incomplete.get(key);if(existing)existing.observationCount++;else incomplete.set(key,{start:row.start??null,end:row.end??null,observationCount:1});}
  }
  const observedIntervals:ObservedInterval[]=[];
  for(const interval of [...timed.values()].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)||Date.parse(a.end)-Date.parse(b.end))){
   const duration=Date.parse(interval.end)-Date.parse(interval.start),prior=observedIntervals.at(-1);
   // Join only exactly adjacent intervals of the same grain. Gaps remain visible.
   if(prior&&prior.end===interval.start&&prior.intervalMilliseconds===duration){prior.end=interval.end;prior.intervalCount++;}
   else observedIntervals.push({...interval,intervalCount:1,intervalMilliseconds:duration});
  }
  const unknownContributionCounts=scope.aggregation?values.filter(row=>knownContributionCount(row)===null).length:0;
  return {...scope,storedObservationCount:values.length,observationCount:values.reduce((sum,row)=>sum+representedCount(row),0),...scope.aggregation?{contributionCount:unknownContributionCounts?null:values.reduce((sum,row)=>sum+representedCount(row),0),unknownContributionCounts,observationCountBasis:unknownContributionCounts?'Stored records where contribution counts are unknown':'Represented contributed observations'}:{},contributedBounds,intervalObservationCount,withoutIntervalCount,duplicateIntervalObservationCount:intervalObservationCount-timed.size,observedIntervals,incompleteIntervals:[...incomplete.values()]};
 });
}
export function evidenceDetailRows(rows:Observation[],limit=80){
 const grouped=detailRows(rows).sort((a,b)=>(b.summary.sessions??b.summary.revenue??0)-(a.summary.sessions??a.summary.revenue??0)),selected=grouped.slice(0,limit);
 const returnedStoredObservationCount=selected.reduce((sum,row)=>sum+row.evidence.length,0),observationCount=rows.reduce((sum,row)=>sum+representedCount(row),0),returnedObservationCount=selected.reduce((sum,row)=>sum+row.evidence.reduce((n,e)=>n+representedCount(e),0),0);
 return {segmentCount:grouped.length,returnedSegmentCount:selected.length,omitted:Math.max(0,grouped.length-limit),storedObservationCount:rows.length,returnedStoredObservationCount,omittedStoredObservationCount:rows.length-returnedStoredObservationCount,observationCount,returnedObservationCount,omittedObservationCount:observationCount-returnedObservationCount,rows:selected.map(row=>({key:row.key,dimensions:row.dimensions,metrics:row.metrics,summary:row.summary,
  derived:{discountRate:ratio(row.metrics.discounts??null,row.metrics.gross??null),atcToOrderClose:ratio(row.summary.cvr,row.summary.atc)},
  provenance:compressedProvenance(row.evidence)}))};
}

const arithmetic=(current:ReturnType<typeof queryClient>['metrics'],previous:ReturnType<typeof queryClient>['metrics'])=>({revenueChange:change(current.revenue,previous.revenue),ordersChange:change(current.orders,previous.orders),sessionsChange:change(current.sessions,previous.sessions),cvrChangePoints:current.cvr===null||previous.cvr===null?null:current.cvr-previous.cvr,spendChange:change(current.spend,previous.spend)});

/** Closed evidence remains a dated reference beside, never inside, current intraday metrics. */
export function supplementalReviewEvidence(client:Client,rows:Observation[],connections:Connection[],filters:QueryFilters){
 const sources:{id:string;label:string;url:string}[]=[];
 const source=(kind:string,date:string)=>{const id=`${kind}:${client.id}:${date}`;if(!sources.some(s=>s.id===id))sources.push({id,label:`${client.name} · ${date} · closed store-day evidence`,url:`/clients/${encodeURIComponent(client.id)}?${new URLSearchParams({...filters,from:date,to:date,mode:'closed',view:'overview'})}`});return id;};
 const before=filters.mode==='partial'?filters.to:shiftDate(filters.to,1),closed=rows.filter(r=>r.date<before&&r.date<todayIn(client.timezone));
 const queryDay=(date:string,compare:QueryFilters['compare']='previous')=>queryClient(client,rows,connections,{...filters,from:date,to:date,mode:'closed',compare});
 const newestByDataset=Object.fromEntries([...new Set(closed.filter(r=>r.dataset!=='overview'&&!['active_ads','active_creatives','active_customers'].includes(r.metric)).map(r=>r.dataset))].map(dataset=>{const date=closed.filter(r=>r.dataset===dataset).map(r=>r.date).sort().at(-1)!;
  const selected=queryDay(date).evidence.filter(r=>r.dataset===dataset),comparison=queryDay(date).comparisonEvidence.filter(r=>r.dataset===dataset);
  return [dataset,{storeDate:date,comparisonDate:shiftDate(date,-1),sourceId:source('closed-detail',date),scopeLabel:`Closed-day reference · ${date} · ${client.timezone}${filters.mode==='partial'?'; not the current partial day':''}`,window:dayWindow(date,client.timezone),warnings:queryDay(date).warnings,...evidenceDetailRows(selected),comparison:evidenceDetailRows(comparison)}];}));
 const priorDate=shiftDate(filters.to,-1),prior=queryDay(priorDate),previous=queryDay(shiftDate(priorDate,-1)),weekday=queryDay(shiftDate(priorDate,-7));
 const exposeDay=(date:string,a:ReturnType<typeof queryClient>)=>({storeDate:date,sourceId:source('closed-comparison',date),window:dayWindow(date,client.timezone),metrics:a.metrics,spendVerdict:a.verdict,observedDates:[...new Set(a.evidence.map(r=>r.date))],sourceQuality:[...new Set(a.evidence.map(r=>r.quality))],warnings:a.warnings,evidenceCount:a.selectedCount});
 const dailyRenewals=[];
 for(let date=shiftDate(filters.to,-7);date<filters.to;date=shiftDate(date,1)){
  const current=queryDay(date).evidence.filter(r=>r.dataset==='subscriptions');if(!current.length)continue;
  const priorRows=queryDay(shiftDate(date,-1)).evidence.filter(r=>r.dataset==='subscriptions');
  const summarize=(values:Observation[])=>{const revenue=sumMetric(values,'recurring_revenue'),orders=sumMetric(values,'recurring_orders');return {revenue,orders,aov:ratio(revenue,orders)};};
  const a=summarize(current),b=summarize(priorRows);dailyRenewals.push({storeDate:date,sourceId:source('closed-renewals',date),...a,comparison:{storeDate:shiftDate(date,-1),...b},decomposition:{revenueChange:change(a.revenue,b.revenue),ordersChange:change(a.orders,b.orders),aovChange:change(a.aov,b.aov)},...evidenceDetailRows(current),qualification:'Dated renewal order cohort. Changes in orders and AOV are descriptive, not proof of churn; refunds/cancellations may mature after the order date.'});
 }
 const spendChannelTrend=[];
 for(let date=shiftDate(filters.to,-7);date<filters.to;date=shiftDate(date,1)){
  const media=queryDay(date).evidence.filter(r=>r.dataset==='media'&&r.metric==='spend');if(!media.length)continue;
  const channels=[...new Set(media.map(r=>r.dimensions.channel).filter(Boolean))].map(channel=>{const values=media.filter(r=>r.dimensions.channel===channel);return {channel,spend:sumMetric(values,'spend'),qualifiedClosed:values.every(r=>r.quality==='complete'&&r.coverageThrough&&Date.parse(r.coverageThrough)>=Date.parse(dayWindow(date,client.timezone).end)),...evidenceDetailRows(values)};});
  spendChannelTrend.push({storeDate:date,sourceId:source('closed-spend',date),channels,qualification:'Store-day channel spend only. UTC platform_spend and current inventory are separate; channel totals do not establish MER or matched revenue scope.'});
 }
 const recurringDate=filters.mode==='partial'?priorDate:filters.to,recurring=queryDay(recurringDate).subscriptions;
 const recurringCoverage=(from:string,to:string)=>{const observedDates=[...new Set(closed.filter(r=>r.dataset==='subscriptions'&&r.metric==='recurring_revenue'&&r.date>=from&&r.date<=to).map(r=>r.date))].sort(),missingDates:string[]=[];for(let d=from;d<=to;d=shiftDate(d,1))if(!observedDates.includes(d))missingDates.push(d);return {observedDates,missingDates};};
 const closedRecurringWeeks={sourceId:source('closed-recurring',recurringDate),storeDate:recurringDate,...recurring,coverage:{current:recurringCoverage(recurring.current.from,recurring.current.to),comparison:recurringCoverage(recurring.comparison.from,recurring.comparison.to)},scopeLabel:`Closed Monday-start weeks through ${recurringDate}, compared four weeks earlier. Missing dates invalidate a complete-period claim; per-day values use elapsed calendar days, not a renewal cohort forecast.`};
 const mtdFrom=filters.to.slice(0,8)+'01',mtdTo=filters.mode==='partial'?shiftDate(filters.to,-1):filters.to;
 const expectedDates:string[]=[];for(let date=mtdFrom;date<=mtdTo;date=shiftDate(date,1))expectedDates.push(date);
 const channelMonthToDate=['revenue','media'].map(dataset=>{
  const selected=closed.filter(r=>r.dataset===dataset&&r.date>=mtdFrom&&r.date<=mtdTo&&(dataset!=='media'||r.metric==='spend'));
  const scoped=queryClient(client,selected,connections,{...filters,from:mtdFrom,to:mtdTo<mtdFrom?mtdFrom:mtdTo,mode:'closed'}).evidence;
  const metric=dataset==='media'?'spend':'revenue';
  const observedDates=[...new Set(scoped.filter(r=>r.metric===metric).map(r=>r.date))].sort(),missingDates=expectedDates.filter(d=>!observedDates.includes(d));
  const sourceId=`closed-channel-mtd:${client.id}:${mtdFrom}:${mtdTo}`;
  if(scoped.length&&!sources.some(s=>s.id===sourceId))sources.push({id:sourceId,label:`${client.name} · closed-day channel totals ${mtdFrom}–${mtdTo}`,url:`/clients/${encodeURIComponent(client.id)}?${new URLSearchParams({...filters,from:mtdFrom,to:mtdTo,mode:'closed',view:dataset})}`});
  return {dataset,sourceId,from:mtdFrom,to:mtdTo,observedDates,missingDates,fullElapsedDayCoverage:expectedDates.length>0&&!missingDates.length&&scoped.length>0&&scoped.every(r=>r.quality==='complete'&&r.coverageThrough&&Date.parse(r.coverageThrough)>=Date.parse(dayWindow(mtdTo,client.timezone).end)),scopeLabel:`Closed-day channel totals ${mtdFrom}–${mtdTo}; current partial store day excluded. Without fullElapsedDayCoverage, label as observed-day totals, not complete MTD.`,...evidenceDetailRows(scoped)};
 });
 return {sources,priorClosedDetail:{instruction:'Use these as explicitly dated closed-day references. Never blend them into selected-day KPI totals or describe their rates as current intraday rates.',datasets:newestByDataset},closedPriorDay:{current:exposeDay(priorDate,prior),previousDay:exposeDay(shiftDate(priorDate,-1),previous),sameWeekday:exposeDay(shiftDate(priorDate,-7),weekday),arithmetic:{previousDay:arithmetic(prior.metrics,previous.metrics),sameWeekday:arithmetic(prior.metrics,weekday.metrics)},instruction:'Closed prior store day compared with its previous closed day and same weekday. Separate from partial-day same-hour comparisons.'},dailyRenewals,spendChannelTrend,channelMonthToDate,closedRecurringWeeks};
}
