import type {Observation,QueryFilters,Client,Connection} from './contracts';
import {ratio,change,compatibleTotal,spendVerdict,opportunity} from './metrics';
import {shiftDate,todayIn,dayWindow,matchedCutoff} from './windows';
import {subscriptionComparison} from './subscriptions';
import {chooseBenchmark} from './benchmark';
import {Temporal} from '@js-temporal/polyfill';
import {preferredObservations} from './source-precedence';
import {sanitizePage} from '../sources/kind-patches';
export function filtered(rows:Observation[],f:Partial<QueryFilters>) {return rows.filter(r=>(!f.from||r.date>=f.from)&&(!f.to||r.date<=f.to)&&['market','stream','source','device','page'].every(k=>!(f as any)[k]||r.dimensions[k]===(f as any)[k]));}
export function sumMetric(rows:Observation[],metric:string) {const r=rows.filter(x=>x.metric===metric);if(metric.endsWith('_rate')&&r.length>1)return null;if(new Set(r.map(x=>x.population)).size>1||new Set(r.map(x=>JSON.stringify(Object.keys(x.dimensions??{}).sort()))).size>1)return null;const seen=new Set<string>();for(const x of r){const key=JSON.stringify([x.date,x.start,x.end,Object.entries(x.dimensions??{}).sort()]);if(seen.has(key))return null;seen.add(key);}return compatibleTotal(r);}
function populationRatio(rows:Observation[],n:string,d:string){const a=[...new Set(rows.filter(r=>r.metric===n).map(r=>r.population))].sort(),b=[...new Set(rows.filter(r=>r.metric===d).map(r=>r.population))].sort();return !a.length||a.includes(undefined)||JSON.stringify(a)!==JSON.stringify(b)?null:ratio(sumMetric(rows,n),sumMetric(rows,d));}
export function summarize(rows:Observation[]) {const revenue=sumMetric(rows,'revenue'),orders=sumMetric(rows,'orders'),spend=sumMetric(rows,'spend'),sessions=sumMetric(rows,'sessions');return {revenue,orders,spend,sessions,cvr:populationRatio(rows,'converting_sessions','sessions'),aov:ratio(revenue,orders),mer:ratio(revenue,spend),newOrders:sumMetric(rows,'new_orders'),recurringRevenue:sumMetric(rows,'recurring_revenue'),atc:populationRatio(rows,'atc_sessions','sessions'),checkoutCompletion:populationRatio(rows,'completed_checkouts','checkouts')};}
export function detailRows(rows:Observation[]) {
  const groups=new Map<string,Observation[]>();for(const r of rows){const key=JSON.stringify(Object.entries(r.dimensions).sort()),group=groups.get(key);if(group)group.push(r);else groups.set(key,[r]);}
  return [...groups].map(([key,values])=>{const metrics:Record<string,number|null>={};for(const id of new Set(values.map(x=>x.metric)))metrics[id]=sumMetric(values,id);return {key,dimensions:values[0].dimensions,metrics,summary:summarize(values),evidence:values};});
}
function datasetAnalytics(client:Client,current:Observation[],previous:Observation[],peers:Observation[],recommend=true){
  const details=detailRows(current),candidates=recommend?details.filter(r=>r.summary.sessions!==null&&r.summary.cvr!==null):[];
  // Attribution cohorts are displayed as evidence, not ranked against a
  // different country/source mix. Commerce datasets need no funnel benchmark.
  const priorDetails=candidates.length?detailRows(previous):[],peerDetails=candidates.length?detailRows(peers):[];
  const opportunities=candidates.map(r=>{const benchmark=chooseBenchmark(r,peerDetails,priorDetails,client.config.benchmarkMarket),own=priorDetails.find(x=>x.key===r.key),b=benchmark.cvr;return {...r,benchmark:b,benchmarkReason:benchmark.reason,benchmarkEvidence:benchmark.reference?.evidence??[],opportunity:b===null?null:opportunity(r.summary.sessions!,r.summary.cvr!,b),actualOrdersChange:change(r.summary.orders,own?.summary.orders??null)};}).filter(x=>x.opportunity!==null).sort((a,b)=>b.opportunity!-a.opportunity!);
  const actions=opportunities.filter(x=>x.summary.sessions!>=client.config.minSessions&&x.opportunity!>=client.config.minOpportunity).slice(0,client.config.maxActions);
  return {details,actions,opportunities,viewMetrics:summarize(current)};
}
function byDataset(rows:Observation[]){const groups=new Map<string,Observation[]>();for(const row of rows){const group=groups.get(row.dataset);if(group)group.push(row);else groups.set(row.dataset,[row]);}return groups;}
export function queryClient(client:Client,all:Observation[],connections:Connection[],f:QueryFilters,options:{prepareAllViews?:boolean}={}) {
  all=preferredObservations(all.map(r=>r.dimensions.page?{...r,dimensions:{...r.dimensions,page:sanitizePage(r.dimensions.page)}}:r),{timezone:client.timezone,partial:f.mode==='partial'});
  const days=Math.round((Date.parse(f.to)-Date.parse(f.from))/86400000)+1,offset=f.compare==='weekday'?7:f.compare==='fourWeeks'?28:days;
  const comparison={...f,from:shiftDate(f.from,-offset),to:shiftDate(f.to,-offset)};
  const warnings:string[]=[];let cutoff:string|null=null;
  const activeFilters=['market','stream','source','device','page'].filter(k=>(f as any)[k]);
  const unscoped=filtered(all,{from:comparison.from,to:f.to}),blocked=new Set<string>();
  for(const r of unscoped){if(activeFilters.some(k=>r.dimensions[k]===undefined))blocked.add(`${r.dataset}:${r.metric}`);}
  if(blocked.size)warnings.push(`Some contributing sources cannot answer the requested dimension filters. Unsupported metrics are unavailable (${[...blocked].join(', ')}).`);
  const capable=all.filter(r=>!blocked.has(`${r.dataset}:${r.metric}`));
  let current=filtered(capable,f),previous=filtered(capable,comparison),peers=filtered(capable,{...f,market:''});
  let currentEnd=Date.parse(dayWindow(f.to,client.timezone).end),previousEnd=Date.parse(dayWindow(comparison.to,client.timezone).end);
  if(f.mode==='partial') {
    if(connections.some(c=>c.enabled&&c.provider?.startsWith('kind-')&&c.provider!=='kind-triple-whale'))warnings.push('Same-hour comparisons use qualified hourly commerce, media and human-session feeds. Shopify sales/product totals and AppLovin UTC reports use closed days; current operations are separate snapshots.');
    const sources=connections.filter(c=>c.enabled&&(!c.provider||c.provider==='gateway'||c.provider==='kind-triple-whale'||c.provider==='kind-shopify-hourly')),coverage=sources.map(c=>c.coverageThrough);
    const known=sources.length>0&&coverage.every((x):x is string=>!!x&&Date.parse(x)>=Date.parse(dayWindow(f.to,client.timezone).start));
    cutoff=known?matchedCutoff(coverage as string[],client.timezone):null;
    if(!cutoff) {current=[];previous=[];peers=[];warnings.push('An intraday comparison needs confirmed, current hourly coverage from every contributing source.');}
    else {const clock=Temporal.Instant.from(cutoff).toZonedDateTimeISO(client.timezone).toPlainTime();
      const selectedEnd=Temporal.PlainDate.from(f.to).toZonedDateTime({timeZone:client.timezone,plainTime:clock});
      const priorEnd=Temporal.PlainDate.from(comparison.to).toZonedDateTime({timeZone:client.timezone,plainTime:clock});
      currentEnd=Number(selectedEnd.epochMilliseconds);previousEnd=Number(priorEnd.epochMilliseconds);cutoff=selectedEnd.toInstant().toString();
      current=current.filter(r=>r.end&&Date.parse(r.end)<=currentEnd);previous=previous.filter(r=>r.end&&Date.parse(r.end)<=previousEnd);peers=peers.filter(r=>r.end&&Date.parse(r.end)<=currentEnd);
      if(!current.length)warnings.push('Daily aggregates cannot supply a same-hour comparison.');
    }
  } else {const today=todayIn(client.timezone);current=current.filter(r=>r.date<today);previous=previous.filter(r=>r.date<today);peers=peers.filter(r=>r.date<today);}
  function covered(rows:Observation[],from:string,to:string,end:number){return ['revenue','spend','new_orders'].every(metric=>{const values=rows.filter(r=>r.metric===metric);if(!values.length||values.some(r=>r.quality!=='complete'||!r.coverageThrough||Date.parse(r.coverageThrough)<end))return false;for(let date=from;date<=to;date=shiftDate(date,1)){const day=values.filter(r=>r.date===date);if(!day.length)return false;if(f.mode==='partial'&&date===to&&Math.max(...day.map(r=>r.end?Date.parse(r.end):0))<end)return false;}return true;});}
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
  const datasets=options.prepareAllViews?['funnels','traffic','revenue','markets','products','subscriptions','media','creatives','reviews','settings',dataset]:[dataset];
  const views:Record<string,ReturnType<typeof datasetAnalytics>>=Object.fromEntries([...new Set(datasets)].map(key=>[key,datasetAnalytics(client,currentDatasets.get(key)??[],previousDatasets.get(key)??[],peerDatasets.get(key)??[],key!=='traffic')]));
  const {details,actions,opportunities}=views[dataset];
  const operationalIds=['active_customers','active_ads','active_creatives'];
  const liveOperations=operationalIds.flatMap(metric=>{const rows=all.filter(r=>r.metric===metric&&r.quality==='complete').sort((a,b)=>b.date.localeCompare(a.date)||b.retrievedAt.localeCompare(a.retrievedAt));return rows[0]?[rows[0]]:[];});
  const availableDimensions=Object.fromEntries(['market','stream','source','device','page'].map(k=>[k,[...new Set(all.flatMap(r=>r.dimensions[k]?[r.dimensions[k]]:[]))].sort()]));
  return {client,metrics,prior,comparison,verdict,series,details,actions,opportunities,views,datasetMetrics:views[dataset].viewMetrics,activeIncidents,warnings,cutoff,availableDimensions,evidence:current,comparisonEvidence:previous,connections,selectedCount:current.length,liveOperations,subscriptions:subscriptionComparison(filtered(all,{...f,from:undefined,to:undefined}),f.to,client.config.incidents,f.mode==='partial'?{timezone:client.timezone,cutoff}:undefined)};
}
export type ClientAnalytics=ReturnType<typeof queryClient>;
