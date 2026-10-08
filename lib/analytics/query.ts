import type {Observation,QueryFilters,Client,Connection} from './contracts';
import {ratio,change,compatibleTotal,spendVerdict,opportunity} from './metrics';
import {shiftDate,todayIn,dayWindow,matchedCutoff} from './windows';
import {subscriptionComparison} from './subscriptions';
import {chooseBenchmark} from './benchmark';
import {Temporal} from '@js-temporal/polyfill';
export function filtered(rows:Observation[],f:Partial<QueryFilters>) {return rows.filter(r=>(!f.from||r.date>=f.from)&&(!f.to||r.date<=f.to)&&['market','stream','source','device','page'].every(k=>!(f as any)[k]||r.dimensions[k]===(f as any)[k]));}
export function sumMetric(rows:Observation[],metric:string) {const r=rows.filter(x=>x.metric===metric);if(new Set(r.map(x=>x.population)).size>1)return null;const seen=new Set<string>();for(const x of r){const key=JSON.stringify([x.date,x.start,x.end,Object.entries(x.dimensions).sort()]);if(seen.has(key))return null;seen.add(key);}return compatibleTotal(r);}
function populationRatio(rows:Observation[],n:string,d:string){const a=[...new Set(rows.filter(r=>r.metric===n).map(r=>r.population))].sort(),b=[...new Set(rows.filter(r=>r.metric===d).map(r=>r.population))].sort();return !a.length||a.includes(undefined)||JSON.stringify(a)!==JSON.stringify(b)?null:ratio(sumMetric(rows,n),sumMetric(rows,d));}
export function summarize(rows:Observation[]) {const revenue=sumMetric(rows,'revenue'),orders=sumMetric(rows,'orders'),spend=sumMetric(rows,'spend'),sessions=sumMetric(rows,'sessions');return {revenue,orders,spend,sessions,cvr:populationRatio(rows,'converting_sessions','sessions'),aov:ratio(revenue,orders),mer:ratio(revenue,spend),newOrders:sumMetric(rows,'new_orders'),recurringRevenue:sumMetric(rows,'recurring_revenue'),atc:populationRatio(rows,'atc_sessions','sessions'),checkoutCompletion:populationRatio(rows,'completed_checkouts','checkouts')};}
export function detailRows(rows:Observation[]) {
  const groups=new Map<string,Observation[]>();for(const r of rows){const key=JSON.stringify(Object.entries(r.dimensions).sort());groups.set(key,[...(groups.get(key)??[]),r]);}
  return [...groups].map(([key,values])=>{const metrics:Record<string,number|null>={};for(const id of new Set(values.map(x=>x.metric)))metrics[id]=sumMetric(values,id);return {key,dimensions:values[0].dimensions,metrics,summary:summarize(values),evidence:values};});
}
export function queryClient(client:Client,all:Observation[],connections:Connection[],f:QueryFilters) {
  const days=Math.round((Date.parse(f.to)-Date.parse(f.from))/86400000)+1,offset=f.compare==='weekday'?7:f.compare==='fourWeeks'?28:days;
  const comparison={...f,from:shiftDate(f.from,-offset),to:shiftDate(f.to,-offset)};
  let current=filtered(all,f),previous=filtered(all,comparison);
  const warnings:string[]=[];let cutoff:string|null=null;
  if(f.mode==='partial') {
    cutoff=matchedCutoff(connections.filter(c=>c.enabled).map(c=>c.coverageThrough).filter((x):x is string=>!!x),client.timezone);
    if(!cutoff) {current=[];previous=[];warnings.push('An intraday comparison needs confirmed hourly source coverage.');}
    else {const clock=Temporal.Instant.from(cutoff).toZonedDateTimeISO(client.timezone).toPlainTime();
      const selectedEnd=Temporal.PlainDate.from(f.to).toZonedDateTime({timeZone:client.timezone,plainTime:clock});
      const previousEnd=Temporal.PlainDate.from(comparison.to).toZonedDateTime({timeZone:client.timezone,plainTime:clock});
      const endCurrent=Number(selectedEnd.epochMilliseconds),endPrevious=Number(previousEnd.epochMilliseconds);cutoff=selectedEnd.toInstant().toString();
      current=current.filter(r=>r.end&&Date.parse(r.end)<=endCurrent);previous=previous.filter(r=>r.end&&Date.parse(r.end)<=endPrevious);
      if(current.some(r=>r.quality==='historical'))warnings.push('Historical imports are reference data; they do not establish live source coverage.');
  if(current.some(r=>r.quality==='partial'||r.quality==='estimated'))warnings.push('This selection includes partial or estimated observations.');
  if(!current.length)warnings.push('Daily aggregates cannot supply a same-hour comparison.');
    }
  } else {const today=todayIn(client.timezone);current=current.filter(r=>r.date<today);previous=previous.filter(r=>r.date<today);}
  const headline=current.filter(r=>r.dataset==='overview'),previousHeadline=previous.filter(r=>r.dataset==='overview');
  const metrics=summarize(headline),prior=summarize(previousHeadline);
  const matched=[...headline,...previousHeadline];const spendRows=matched.filter(r=>r.metric==='spend');
  const covers=client.config.spendChannels.length>0&&spendRows.length>0&&spendRows.every(r=>client.config.spendChannels.every(c=>(r.channels??[r.dimensions.channel]).includes(c)));
  const expected=matched.filter(r=>r.metric==='revenue').every(r=>r.definition===client.config.revenueDefinition);
  const verdict=spendVerdict({spend:[prior.spend,metrics.spend],revenue:[prior.revenue,metrics.revenue],newOrders:[prior.newOrders,metrics.newOrders],complete:covers&&expected&&matched.length>0&&matched.every(r=>r.quality==='complete')});
  if(current.some(r=>r.quality==='historical'))warnings.push('Historical imports are reference data; they do not establish live source coverage.');
  if(current.some(r=>r.quality==='partial'||r.quality==='estimated'))warnings.push('This selection includes partial or estimated observations.');
  if(!current.length)warnings.push('No source observations are available for this selection.');
  if(!covers&&metrics.spend!==null)warnings.push('Spend coverage is incomplete for the configured channels.');
  if(!expected)warnings.push('Revenue definitions differ from the configured efficiency scope.');
  const activeIncidents=client.config.incidents.filter(i=>f.to>=i.start&&comparison.from<=(i.end??i.start));
  const today=todayIn(client.timezone);const history=filtered(all,{...f,from:shiftDate(f.to,-29)}).filter(r=>r.dataset==='overview'&&r.date<today);
  const series=[];if(history.length)for(let date=shiftDate(f.to,-29);date<=f.to&&date<today;date=shiftDate(date,1)){const day=history.filter(x=>x.date===date),summary=summarize(day),spend=day.filter(r=>r.metric==='spend'),qualified=day.length>0&&day.every(r=>r.quality==='complete')&&day.filter(r=>r.metric==='revenue').every(r=>r.definition===client.config.revenueDefinition)&&client.config.spendChannels.length>0&&spend.length>0&&spend.every(r=>client.config.spendChannels.every(c=>(r.channels??[]).includes(c)));series.push({date,...summary,mer:qualified?summary.mer:null});}
  const dataset=f.view==='overview'?'funnels':f.view;
  const details=detailRows(current.filter(r=>r.dataset===dataset));
  const priorDetails=detailRows(previous.filter(r=>r.dataset===dataset));
  const peerDetails=detailRows(filtered(all,{...f,market:''}).filter(x=>x.dataset===dataset));
  const opportunities=details.filter(r=>r.summary.sessions!==null&&r.summary.cvr!==null).map(r=>{const benchmark=chooseBenchmark(r,peerDetails,priorDetails,client.config.benchmarkMarket),own=priorDetails.find(x=>x.key===r.key),b=benchmark.cvr;return {...r,benchmark:b,benchmarkReason:benchmark.reason,opportunity:b===null?null:opportunity(r.summary.sessions!,r.summary.cvr!,b),actualOrdersChange:change(r.summary.orders,own?.summary.orders??null)};}).filter(x=>x.opportunity!==null).sort((a,b)=>b.opportunity!-a.opportunity!);
  const actions=opportunities.filter(x=>x.summary.sessions!>=client.config.minSessions&&x.opportunity!>=client.config.minOpportunity).slice(0,client.config.maxActions);
  const availableDimensions=Object.fromEntries(['market','stream','source','device','page'].map(k=>[k,[...new Set(all.flatMap(r=>r.dimensions[k]?[r.dimensions[k]]:[]))].sort()]));
  return {client,metrics,prior,comparison,verdict,series,details,actions,opportunities,activeIncidents,warnings,cutoff,availableDimensions,evidence:current,connections,selectedCount:current.length,subscriptions:subscriptionComparison(filtered(all,{...f,from:undefined,to:undefined}),f.to,client.config.incidents,f.mode==='partial'?{timezone:client.timezone,cutoff}:undefined)};
}
export type ClientAnalytics=ReturnType<typeof queryClient>;
