import type {Observation,QueryFilters,Client,Connection} from './contracts';
import {ratio,change,compatibleTotal,spendVerdict,opportunity} from './metrics';
import {shiftDate,todayIn,dayWindow,comparisonPeriod} from './windows';
import {datasetSeries as buildDatasetSeries,datasetHourlySeries as buildDatasetHourlySeries} from './dataset-series';
import {subscriptionComparison} from './subscriptions';
import {benchmarkLookup} from './benchmark';
import {Temporal} from '@js-temporal/polyfill';
import {preferredObservations} from './source-precedence';
import {sanitizePage,sourceMarket} from '../sources/kind-patches';
import {compatibleZeroDenominatorRates} from './rate-qualification';
import {confirmedIntradayCutoff} from './intraday-coverage';
import {trendContextRange} from './trend-context';
import type {FunnelRollupObservation} from './funnel-rollup';
export function filtered(rows:Observation[],f:Partial<QueryFilters>) {return rows.filter(r=>(!f.from||r.date>=f.from)&&(!f.to||r.date<=f.to)&&['market','stream','source','device','page'].every(k=>!(f as any)[k]||r.dimensions[k]===(f as any)[k]));}
export function sumMetric(rows:Observation[],metric:string) {const r=rows.filter(x=>x.metric===metric);if(metric.endsWith('_rate')&&r.length>1)return null;if(new Set(r.map(x=>x.population)).size>1||new Set(r.map(x=>JSON.stringify(Object.keys(x.dimensions??{}).sort()))).size>1)return null;const seen=new Set<string>();for(const x of r){const key=JSON.stringify([x.date,x.start,x.end,Object.entries(x.dimensions??{}).sort()]);if(seen.has(key))return null;seen.add(key);}return compatibleTotal(r);}
type MetricTotal=(metric:string)=>number|null;
function metricLookup(rows:Observation[]){
 const groups=new Map<string,Observation[]>(),totals=new Map<string,number|null>();
 for(const row of rows){const group=groups.get(row.metric);if(group)group.push(row);else groups.set(row.metric,[row]);}
 const total:MetricTotal=metric=>{if(totals.has(metric))return totals.get(metric)!;const value=sumMetric(groups.get(metric)??[],metric);totals.set(metric,value);return value;};
 return {total,metricIds:groups.keys()};
}
function populationRatio(rows:Observation[],n:string,d:string,total:MetricTotal){const a=[...new Set(rows.filter(r=>r.metric===n).map(r=>r.population))].sort(),b=[...new Set(rows.filter(r=>r.metric===d).map(r=>r.population))].sort();return !a.length||a.includes(undefined)||JSON.stringify(a)!==JSON.stringify(b)?null:ratio(total(n),total(d));}
function summaryWithTotals(rows:Observation[],total:MetricTotal){const revenue=total('revenue'),orders=total('orders'),spend=total('spend'),sessions=total('sessions');return {revenue,orders,spend,sessions,cvr:populationRatio(rows,'converting_sessions','sessions',total),aov:ratio(revenue,orders),mer:ratio(revenue,spend),newOrders:total('new_orders'),recurringRevenue:total('recurring_revenue'),atc:populationRatio(rows,'atc_sessions','sessions',total),checkoutCompletion:populationRatio(rows,'completed_checkouts','checkouts',total)};}
export function summarize(rows:Observation[]){return summaryWithTotals(rows,metricLookup(rows).total);}
/** Metric bags and summaries share totals validated from these exact rows.
 * Memoization lives only inside this call; callers cannot supply unvalidated
 * totals or reuse a cache after changing the evidence. */
export function metricSummary(rows:Observation[]){const lookup=metricLookup(rows),metrics=Object.fromEntries([...lookup.metricIds].map(metric=>[metric,lookup.total(metric)]));return {metrics,summary:summaryWithTotals(rows,lookup.total)};}
export function detailRows(rows:Observation[]) {
  const groups=new Map<string,Observation[]>();for(const r of rows){const key=JSON.stringify(Object.entries(r.dimensions).sort()),group=groups.get(key);if(group)group.push(r);else groups.set(key,[r]);}
  return [...groups].map(([key,values])=>{const {metrics,summary}=metricSummary(values),zeroDenominatorRates=compatibleZeroDenominatorRates(values,metrics);return {key,dimensions:values[0].dimensions,metrics,summary,evidence:values,...zeroDenominatorRates.length?{zeroDenominatorRates}:{}};});
}
function datasetAnalytics(client:Client,current:Observation[],previous:Observation[],peers:Observation[],recommend=true){
  const details=detailRows(current),candidates=recommend?details.filter(r=>r.summary.sessions!==null&&r.summary.cvr!==null):[];
  // Attribution cohorts are displayed as evidence, not ranked against a
  // different country/source mix. Commerce datasets need no funnel benchmark.
  const priorDetails=candidates.length?detailRows(previous):[],peerDetails=candidates.length?detailRows(peers):[];
  const benchmarks=benchmarkLookup(peerDetails,priorDetails,client.config.benchmarkMarket);
  const opportunities=candidates.map(r=>{const benchmark=benchmarks.choose(r),own=benchmarks.previous(r.key),b=benchmark.cvr;return {...r,benchmark:b,benchmarkReason:benchmark.reason,benchmarkEvidence:benchmark.reference?.evidence??[],opportunity:b===null?null:opportunity(r.summary.sessions!,r.summary.cvr!,b),actualOrdersChange:change(r.summary.orders,own?.summary.orders??null)};}).filter(x=>x.opportunity!==null).sort((a,b)=>b.opportunity!-a.opportunity!);
  const actions=opportunities.filter(x=>x.summary.sessions!>=client.config.minSessions&&x.opportunity!>=client.config.minOpportunity).slice(0,client.config.maxActions);
  return {details,actions,opportunities,viewMetrics:summarize(current)};
}
function byDataset(rows:Observation[]){const groups=new Map<string,Observation[]>();for(const row of rows){const group=groups.get(row.dataset);if(group)group.push(row);else groups.set(row.dataset,[row]);}return groups;}
export function queryClient(client:Client,all:Observation[],connections:Connection[],f:QueryFilters,options:{prepareAllViews?:boolean;preparedDatasets?:string[]}={}) {
  if(f.market){const market=sourceMarket(f.market);if(market!==f.market)f={...f,market};}
  const comparison=comparisonPeriod(f);
  const fullDayContext=all.filter(row=>(row as FunnelRollupObservation).contextOnly);
  all=all.filter(row=>!(row as FunnelRollupObservation).contextOnly);
  all=preferredObservations(all.map(r=>{if(!r.dimensions.page)return r;const page=sanitizePage(r.dimensions.page);return page===r.dimensions.page?r:{...r,dimensions:{...r.dimensions,page}};}),{timezone:client.timezone,partial:f.mode==='partial',partialDates:[f.to,comparison.to]});
  // Legacy country aliases must be normalized after authority selection:
  // overlapping same-grain observations remain visible to duplicate guards.
  all=all.map(r=>{if(!r.dimensions.market)return r;const market=sourceMarket(r.dimensions.market);return market===r.dimensions.market?r:{...r,dimensions:{...r.dimensions,market}};});
  const warnings:string[]=[];let cutoff:string|null=null;
  const activeFilters=['market','stream','source','device','page'].filter(k=>(f as any)[k]);
  const unscoped=filtered(all,{from:[comparison.from,f.from].sort()[0],to:[comparison.to,f.to].sort().at(-1)}),blocked=new Set<string>();
  for(const r of unscoped){if(activeFilters.some(k=>r.dimensions[k]===undefined))blocked.add(`${r.dataset}:${r.metric}`);}
  if(blocked.size)warnings.push(`Some contributing sources cannot answer the requested dimension filters. Unsupported metrics are unavailable (${[...blocked].join(', ')}).`);
  const capable=all.filter(r=>!blocked.has(`${r.dataset}:${r.metric}`));
  let current=filtered(capable,f),previous=filtered(capable,comparison),peers=filtered(capable,{...f,market:''});
  let currentEnd=Date.parse(dayWindow(f.to,client.timezone).end),previousEnd=Date.parse(dayWindow(comparison.to,client.timezone).end);
  if(f.mode==='partial') {
    if(connections.some(c=>c.enabled&&c.provider?.startsWith('kind-')&&c.provider!=='kind-triple-whale'))warnings.push('Selected and comparison periods use the same confirmed store-hour cutoff. Platform-attributed reports and current operational snapshots retain their separate reporting populations and timestamps.');
    cutoff=confirmedIntradayCutoff(connections,f.view,client.timezone,f.to);
    if(!cutoff) {current=[];previous=[];peers=[];warnings.push('An intraday comparison needs confirmed, current hourly coverage from every contributing source.');}
    else {const clock=Temporal.Instant.from(cutoff).toZonedDateTimeISO(client.timezone).toPlainTime();
      const selectedEnd=Temporal.Instant.from(cutoff).toZonedDateTimeISO(client.timezone);
      const priorEnd=Temporal.PlainDate.from(comparison.to).toZonedDateTime({timeZone:client.timezone,plainTime:clock});
      currentEnd=Number(selectedEnd.epochMilliseconds);previousEnd=Number(priorEnd.epochMilliseconds);cutoff=selectedEnd.toInstant().toString();
      const withinMatchedPeriod=(row:Observation,finalDate:string,matchedEnd:number)=>row.date<finalDate?(!row.end||Date.parse(row.end)<=Date.parse(dayWindow(row.date,client.timezone).end)):!!row.end&&Date.parse(row.end)<=matchedEnd;
      current=current.filter(row=>withinMatchedPeriod(row,f.to,currentEnd));previous=previous.filter(row=>withinMatchedPeriod(row,comparison.to,previousEnd));peers=peers.filter(row=>withinMatchedPeriod(row,f.to,currentEnd));
      if(!current.length)warnings.push('Daily aggregates cannot supply a same-hour comparison.');
    }
  } else {const today=todayIn(client.timezone);current=current.filter(r=>r.date<today);previous=previous.filter(r=>r.date<today);peers=peers.filter(r=>r.date<today);}
  function covered(rows:Observation[],from:string,to:string,end:number){return ['revenue','spend','new_orders'].every(metric=>{const values=rows.filter(r=>r.metric===metric);if(!values.length)return false;for(let date=from;date<=to;date=shiftDate(date,1)){const day=values.filter(r=>r.date===date),requiredEnd=date===to?end:Date.parse(dayWindow(date,client.timezone).end);if(!day.length||day.some(r=>r.quality!=='complete'||!r.coverageThrough||Date.parse(r.coverageThrough)<requiredEnd))return false;if(f.mode==='partial'&&date===to&&requiredEnd<Date.parse(dayWindow(date,client.timezone).end)&&Math.max(...day.map(r=>r.end?Date.parse(r.end):0))<requiredEnd)return false;}return true;});}
  const headline=current.filter(r=>r.dataset==='overview'),previousHeadline=previous.filter(r=>r.dataset==='overview');
  const metrics=summarize(headline),prior=summarize(previousHeadline);
  const matched=[...headline,...previousHeadline];const spendRows=matched.filter(r=>r.metric==='spend');
  const covers=client.config.spendChannels.length>0&&spendRows.length>0&&spendRows.every(r=>client.config.spendChannels.every(c=>(r.channels??[r.dimensions.channel]).includes(c)));
  const expected=matched.filter(r=>r.metric==='revenue').every(r=>r.definition===client.config.revenueDefinition);
  const verdict=spendVerdict({spend:[prior.spend,metrics.spend],revenue:[prior.revenue,metrics.revenue],newOrders:[prior.newOrders,metrics.newOrders],complete:covers&&expected&&matched.length>0&&covered(headline,f.from,f.to,currentEnd)&&covered(previousHeadline,comparison.from,comparison.to,previousEnd)});
  if(current.some(r=>r.quality==='historical'))warnings.push('Historical imports are reference data; they do not establish live source coverage.');
  if(current.some(r=>r.quality==='partial'||r.quality==='estimated'))warnings.push('This selection includes partial or estimated observations.');
  if(!current.length)warnings.push('No source observations are available for this selection.');
  if(!covers&&metrics.spend!==null)warnings.push('Spend coverage is incomplete for the configured channels.');
  if(!expected)warnings.push('Revenue definitions differ from the configured efficiency scope.');
  const activeIncidents=client.config.incidents.filter(i=>f.to>=i.start&&comparison.from<=(i.end??i.start));
  const today=todayIn(client.timezone);const history=filtered(capable,{...f,from:shiftDate(f.to,-29)}).filter(r=>r.dataset==='overview'&&r.date<today);
  const series=[];if(history.length)for(let date=shiftDate(f.to,-29);date<=f.to&&date<today;date=shiftDate(date,1)){const day=history.filter(x=>x.date===date),summary=summarize(day),spend=day.filter(r=>r.metric==='spend'),qualified=day.length>0&&covered(day,date,date,Date.parse(dayWindow(date,client.timezone).end))&&day.filter(r=>r.metric==='revenue').every(r=>r.definition===client.config.revenueDefinition)&&client.config.spendChannels.length>0&&spend.length>0&&spend.every(r=>client.config.spendChannels.every(c=>(r.channels??[]).includes(c)));series.push({date,...summary,mer:qualified?summary.mer:null});}
  const dataset=f.view==='overview'?'funnels':f.view,currentDatasets=byDataset(current),previousDatasets=byDataset(previous),peerDatasets=byDataset(peers);
  // All client tabs share the same dated/dimension-filtered selection. Prepare
  // each aggregate once so navigating a tab does not query sources again.
  const datasets=options.preparedDatasets??(options.prepareAllViews?['overview','funnels','traffic','revenue','markets','products','subscriptions','subscriptionEvents','media','creatives','reviews','settings',dataset]:[dataset]);
  const views:Record<string,ReturnType<typeof datasetAnalytics>>=Object.fromEntries([...new Set(datasets)].map(key=>[key,datasetAnalytics(client,currentDatasets.get(key)??[],previousDatasets.get(key)??[],peerDatasets.get(key)??[],key!=='traffic')]));
  const details=views[dataset]?.details??[],actions=views[dataset]?.actions??[],opportunities=views[dataset]?.opportunities??[];
  const operationalIds=['active_customers','active_ads','active_creatives'];
  const liveOperations=operationalIds.flatMap(metric=>{const rows=all.filter(r=>r.metric===metric&&r.quality==='complete').sort((a,b)=>b.date.localeCompare(a.date)||b.retrievedAt.localeCompare(a.retrievedAt));return rows[0]?[rows[0]]:[];});
  const dimensionRows=all.filter(row=>!operationalIds.includes(row.metric));
  const availableDimensions=Object.fromEntries(['market','stream','source','device','page'].map(k=>[k,[...new Set(dimensionRows.flatMap(r=>r.dimensions[k]?[r.dimensions[k]]:[]))].sort()]));
  const dailyDatasetNames=['overview','funnels','traffic','revenue','markets','products','subscriptions','subscriptionEvents','media'],dailyDatasets=options.preparedDatasets?dailyDatasetNames.filter(name=>options.preparedDatasets!.includes(name)):dailyDatasetNames;
  const prepareSeries=options.prepareAllViews||options.preparedDatasets!==undefined;
  function qualifiedDailySeries(rows:Observation[],from:string,to:string,lastEnd:number){
    const result=buildDatasetSeries(rows,from,to,dailyDatasets),overviewDays=new Map<string,Observation[]>();
    for(const row of rows)if(row.dataset==='overview'){const values=overviewDays.get(row.date);if(values)values.push(row);else overviewDays.set(row.date,[row]);}
    for(const point of result.overview??[]){const day=overviewDays.get(point.date)??[],spend=day.filter(row=>row.metric==='spend'),end=f.mode==='partial'&&point.date===to?lastEnd:Date.parse(dayWindow(point.date,client.timezone).end);
      // Use the existing store-day qualification for both current and comparison
      // charts; a raw arithmetic ratio cannot become qualified MER through a view.
      const qualified=day.length>0&&covered(day,point.date,point.date,end)&&day.filter(row=>row.metric==='revenue').every(row=>row.definition===client.config.revenueDefinition)&&client.config.spendChannels.length>0&&spend.length>0&&spend.every(row=>client.config.spendChannels.every(channel=>(row.channels??[]).includes(channel)));
      if(!qualified)point.summary.mer=null;
    }
    return result;
  }
  const datasetSeries=prepareSeries?qualifiedDailySeries(current,f.from,f.to,currentEnd):{},comparisonDatasetSeries=prepareSeries?qualifiedDailySeries(previous,comparison.from,comparison.to,previousEnd):{};
  const trendRange=trendContextRange(f,'30d',comparison.from);
  const contextDates=new Set(fullDayContext.map(row=>`${row.dataset}:${row.date}`));
  const contextualEvidence:Observation[]=[...capable.filter(row=>!contextDates.has(`${row.dataset}:${row.date}`)),...preferredObservations(fullDayContext,{timezone:client.timezone}).map(row=>({...row,dimensions:{...row.dimensions,...row.dimensions.market?{market:sourceMarket(row.dimensions.market)}:{},...row.dimensions.page?{page:sanitizePage(row.dimensions.page)}:{}}}))];
  const unsupportedContext=new Set(contextualEvidence.filter(row=>activeFilters.some(dimension=>row.dimensions[dimension]===undefined)).map(row=>`${row.date}:${row.dataset}:${row.metric}`));
  const contextualRows=(from:string,to:string,lastEnd:number)=>filtered(contextualEvidence,{...f,from,to}).filter(row=>{
    if(unsupportedContext.has(`${row.date}:${row.dataset}:${row.metric}`))return false;
    if(f.mode==='closed')return row.date<today;
    if(row.date<to)return !row.end||Date.parse(row.end)<=Date.parse(dayWindow(row.date,client.timezone).end);
    return !!cutoff&&!!row.end&&Date.parse(row.end)<=lastEnd;
  });
  const trendDatasetSeries=prepareSeries?qualifiedDailySeries(contextualRows(trendRange.from,trendRange.to,currentEnd),trendRange.from,trendRange.to,currentEnd):{};
  const trendComparisonDatasetSeries=prepareSeries?qualifiedDailySeries(contextualRows(trendRange.comparisonFrom,trendRange.comparisonTo,previousEnd),trendRange.comparisonFrom,trendRange.comparisonTo,previousEnd):{};
  const datasetHourlySeries=prepareSeries&&f.from===f.to?buildDatasetHourlySeries(current,f.to,client.timezone,dailyDatasets,new Date(currentEnd).toISOString()):{},comparisonDatasetHourlySeries=prepareSeries&&comparison.from===comparison.to?buildDatasetHourlySeries(previous,comparison.to,client.timezone,dailyDatasets,new Date(previousEnd).toISOString()):{};
  const historyClock=f.mode==='partial'&&cutoff?Temporal.Instant.from(cutoff).toZonedDateTimeISO(client.timezone).toPlainTime():null;
  const marketHistory=prepareSeries&&dailyDatasets.includes('markets')?filtered(capable,{...f,from:shiftDate(f.from,-1)}).filter(row=>{
    if(row.dataset!=='markets')return false;
    if(f.mode==='closed')return row.date<today;
    if(row.date<f.to)return !row.end||Date.parse(row.end)<=Date.parse(dayWindow(row.date,client.timezone).end);
    if(!historyClock||!row.end)return false;
    const end=Temporal.PlainDate.from(row.date).toZonedDateTime({timeZone:client.timezone,plainTime:historyClock});
    return Date.parse(row.end)<=Number(end.epochMilliseconds);
  }):[];
  const revenueHistory=prepareSeries&&dailyDatasets.includes('revenue')?filtered(capable,{...f,from:shiftDate(f.to,-29)}).filter(row=>{
    if(row.dataset!=='revenue')return false;
    if(f.mode==='closed')return row.date<today;
    if(row.date<f.to)return !row.end||Date.parse(row.end)<=Date.parse(dayWindow(row.date,client.timezone).end);
    if(!historyClock||!row.end)return false;
    const end=Temporal.PlainDate.from(row.date).toZonedDateTime({timeZone:client.timezone,plainTime:historyClock});
    return Date.parse(row.end)<=Number(end.epochMilliseconds);
  }):[];
  const datasetHistorySeries={...prepareSeries&&dailyDatasets.includes('markets')?buildDatasetSeries(marketHistory,shiftDate(f.from,-1),f.to,['markets']):{},...prepareSeries&&dailyDatasets.includes('revenue')?buildDatasetSeries(revenueHistory,shiftDate(f.to,-29),f.to,['revenue']):{}};
  return {client,metrics,prior,comparison,verdict,series,datasetSeries,comparisonDatasetSeries,trendDatasetSeries,trendComparisonDatasetSeries,datasetHourlySeries,comparisonDatasetHourlySeries,datasetHistorySeries,details,actions,opportunities,views,preparedDatasets:[...new Set(datasets)],datasetMetrics:views[dataset]?.viewMetrics??summarize([]),activeIncidents,warnings,cutoff,availableDimensions,evidence:current,comparisonEvidence:previous,connections,selectedCount:current.length,liveOperations,subscriptions:subscriptionComparison(filtered(all,{...f,from:undefined,to:undefined}),f.to,client.config.incidents,f.mode==='partial'?{timezone:client.timezone,cutoff}:undefined)};
}
export type ClientAnalytics=ReturnType<typeof queryClient>;
