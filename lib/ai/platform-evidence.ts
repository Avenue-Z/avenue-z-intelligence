import type {AISource,buildAIContext} from './context';
import {Temporal} from '@js-temporal/polyfill';

export type AIContext=ReturnType<typeof buildAIContext>;
type EvidenceSort='decline'|'growth'|'value'|'impact';
export type PlatformEvidenceOptions={breakdown?:string|null;metric?:string|null;sort?:EvidenceSort|null;limit?:number;offset?:number;question?:string};
type EvidenceClient=AIContext['clients'][number];
type DetailCollection=EvidenceClient['datasetDetails'][string];
type DetailRow=DetailCollection['rows'][number];
type TrafficPeriod=NonNullable<EvidenceClient['visualBreakdowns']['traffic']['current']>;
type NumericBag=Record<string,number|null>;
type PeriodValues={metrics:NumericBag;summary:NumericBag};
type RowPair={current:DetailRow|null;previous:DetailRow|null};

const dimensions=new Set(['market','page','traffic_channel','source','utm_source','utm_medium','utm_campaign','device']);
const rateMetrics=new Set(['cvr','atc','checkoutCompletion','refund_rate','cancellation_rate','same_day_cancellation_rate','discountRate']);
const summaryMetrics=new Set(['cvr','atc','checkoutCompletion','aov','mer','newOrders','recurringRevenue']);
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const number=(value:unknown)=>finite(value)?value:null;
const unique=<T>(values:T[])=>[...new Set(values)];
const boundedInteger=(value:number|undefined,fallback:number,min:number,max:number)=>finite(value)?Math.max(min,Math.min(max,Math.floor(value))):fallback;

function values(row:DetailRow):PeriodValues{
 // Counts remain in metrics once; summary retains prepared rates, including null
 // qualification. Recomputing a null rate from present counts changes its scope.
 return {metrics:Object.fromEntries(Object.entries(row.metrics).filter(([key,value])=>finite(value)||['sessions','converting_sessions','atc_sessions','checkouts','completed_checkouts'].includes(key)).map(([key,value])=>[key,number(value)])),summary:Object.fromEntries(Object.entries(row.summary).filter(([key,value])=>summaryMetrics.has(key)&&(finite(value)||rateMetrics.has(key))).map(([key,value])=>[key,number(value)]))};
}
function metricValue(period:PeriodValues|null,metric:string){
 if(!period)return null;
 return number(Object.prototype.hasOwnProperty.call(period.summary,metric)?period.summary[metric]:period.metrics[metric]);
}
function arithmetic(current:number|null,previous:number|null,metric:string){
 const absolute=current===null||previous===null?null:current-previous;
 return {current,previous,absolute,relative:absolute===null||previous===null||previous===0?null:absolute/Math.abs(previous),percentagePoints:absolute!==null&&rateMetrics.has(metric)?absolute*100:null};
}
function compareNumbers(a:number|null,b:number|null,direction:number){
 if(a===null)return b===null?0:1;
 if(b===null)return -1;
 return direction*(a-b);
}

function pairedRows(current:DetailRow[],previous:DetailRow[],label:(row:DetailRow)=>string){
 const groups=new Map<string,RowPair>();
 for(const row of current)groups.set(label(row),{current:row,previous:null});
 for(const row of previous){const key=label(row),group=groups.get(key);if(group)group.previous=row;else groups.set(key,{current:null,previous:row});}
 return groups;
}
function rankedRows(groups:Map<string,RowPair>,metric:string,sort:EvidenceSort){
 const ranked=[...groups].map(([dimension,pair])=>{
  const a=pair.current?values(pair.current):null,b=pair.previous?values(pair.previous):null;
  const currentValue=metricValue(a,metric),previousValue=metricValue(b,metric),change=arithmetic(currentValue,previousValue,metric);
  const currentCvr=metricValue(a,'cvr'),previousCvr=metricValue(b,'cvr'),sessions=number(a?.metrics.sessions);
  return {dimension,dimensions:(pair.current??pair.previous)!.dimensions,current:a,previous:b,change,baselineStatus:!b?'missing':previousValue===null?'unqualified':previousValue===0?'zero':'available',
   estimatedConvertingSessionGap:sessions!==null&&sessions>=0&&currentCvr!==null&&previousCvr!==null?sessions*Math.max(0,previousCvr-currentCvr):null,
   qualification:'Descriptive; statistical significance is unknown.'};
 });
 ranked.sort((a,b)=>{
  const selected=sort==='impact'?compareNumbers(a.estimatedConvertingSessionGap,b.estimatedConvertingSessionGap,-1):sort==='value'?compareNumbers(a.change.current,b.change.current,-1):compareNumbers(a.change.relative,b.change.relative,sort==='decline'?1:-1);
  return selected||a.dimension.localeCompare(b.dimension);
 });
 return ranked;
}

/** Pair and sort complete dimension aggregates; row limits are applied last. */
function trafficTable(client:EvidenceClient,dimension:string,metric:string,sort:EvidenceSort,limit:number,offset:number){
 const {current,comparison}=client.visualBreakdowns.traffic;
 const currentCut=current?.cuts[dimension],comparisonCut=comparison?.cuts[dimension];
 const groups=pairedRows(currentCut?.rows??[],comparisonCut?.rows??[],row=>row.dimensions[dimension]??row.key),ranked=rankedRows(groups,metric,sort);
 const complete=(period:TrafficPeriod|null,cut:typeof currentCut)=>period!==null&&!!cut&&cut.omitted===0&&cut.returnedSegmentCount===cut.segmentCount&&cut.rows.length===cut.returnedSegmentCount;
 const fullCohort=complete(current,currentCut)&&complete(comparison,comparisonCut),rows=ranked.slice(offset,offset+limit);
 return {dataset:'traffic',dimension,metric,sort,scope:{current:current?.scope??null,comparison:comparison?.scope??null},fullCohort,rankingComplete:fullCohort,
  totalGroups:ranked.length,currentGroups:currentCut?.segmentCount??0,comparisonGroups:comparisonCut?.segmentCount??0,returnedGroups:rows.length,omittedGroups:ranked.length-rows.length,offset,limit,hasMore:offset+rows.length<ranked.length,
  unavailableChangeGroups:ranked.filter(row=>row.change.relative===null).length,rows,
  qualification:'Ranked across all supplied complete traffic groups before pagination. Prepared null rates, absent periods and zero baselines remain unknown. Estimated converting-session gap holds the same group’s previous qualified CVR fixed under its current sessions; it is descriptive, not predicted orders or causation.',
  ...!fullCohort?{warning:'Complete traffic aggregates are unavailable; this is not a complete-cohort ranking.'}:{}};
}

function comparisonCutoff(client:EvidenceClient){
 if(!client.cutoff)return null;
 const current=Temporal.Instant.from(client.cutoff).toZonedDateTimeISO(client.client.timezone),last=Temporal.PlainDate.from(client.comparison.to);
 const date=current.toPlainDate().toString()>client.selectedView.scope.filters.to?last.add({days:1}):last;
 return date.toZonedDateTime({timeZone:client.client.timezone,plainTime:current.toPlainTime()}).toInstant().toString();
}

/** Preserve raw dataset grain: incompatible dimensions are never pooled. */
function datasetTable(client:EvidenceClient,dataset:string,metric:string,sort:EvidenceSort,limit:number,offset:number){
 const current=client.datasetDetails[dataset],comparison=client.comparisonDatasetDetails[dataset];
 const groups=pairedRows(current?.rows??[],comparison?.rows??[],row=>JSON.stringify(Object.entries(row.dimensions).sort(([a],[b])=>a.localeCompare(b)))),ranked=rankedRows(groups,metric,sort),rows=ranked.slice(offset,offset+limit);
 const complete=(collection:DetailCollection|undefined)=>!!collection&&collection.omitted===0&&collection.rows.length===collection.segmentCount;
 const fullCohort=complete(current)&&complete(comparison),scope=client.selectedView.scope;
 return {dataset,dimension:'stored_dimensions',metric,sort,scope:{current:{...scope,filters:scope.filters,cutoff:client.cutoff},comparison:{...scope,filters:client.comparison,cutoff:comparisonCutoff(client)}},fullCohort,rankingComplete:fullCohort,
  totalGroups:ranked.length,currentGroups:current?.segmentCount??0,comparisonGroups:comparison?.segmentCount??0,returnedGroups:rows.length,omittedGroups:ranked.length-rows.length,offset,limit,hasMore:offset+rows.length<ranked.length,
  unavailableChangeGroups:ranked.filter(row=>row.change.relative===null).length,rows,
  qualification:'Paired by exact stored dimensions at their prepared grain, sorted before pagination. Different dimension grains are not pooled. Prepared null rates, missing periods and zero baselines remain unknown. Use selectedView for authoritative dataset totals; changes and converting-session gaps are descriptive, not statistical or causal claims.',
  ...!fullCohort?{warning:'The supplied dataset is incomplete or has a capped preview; this is not a complete-cohort ranking.'}:{}};
}

function ga4Table(client:EvidenceClient,dimension:string,metric:string,sort:EvidenceSort,limit:number,offset:number){
 const view=client.ga4View,available=view?.available===true,family=({page:'pages',source:'sources',market:'markets',device:'devices'} as const)[dimension as 'page'|'source'|'market'|'device'];
 const cut=available&&family?view[family]:null,supported=['sessions','engagedSessions','purchases','revenue'].includes(metric),groups=cut?.groups??[];
 const toRow=(group:typeof groups[number],period:'current'|'previous'):DetailRow=>({key:group.label,dimensions:{[dimension]:group.label},metrics:{...group[period]},summary:{revenue:null,orders:null,spend:null,sessions:null,cvr:null,aov:null,mer:null,newOrders:null,recurringRevenue:null,atc:null,checkoutCompletion:null},derived:{discountRate:null,atcToOrderClose:null},provenance:[]});
 const ranked=rankedRows(pairedRows(groups.map(group=>toRow(group,'current')),groups.map(group=>toRow(group,'previous')),row=>row.key),supported?metric:'unavailable',sort),rows=ranked.slice(offset,offset+limit);
 const fullCohort=!!cut&&cut.omitted===0&&cut.groupCount===groups.length,rankingComplete=fullCohort&&supported&&sort!=='impact';
 const currentScope=view?.scope??null,comparisonRange=currentScope?.comparison;
 return {dataset:'ga4',dimension,metric,sort,scope:{current:currentScope,comparison:currentScope?{...currentScope,from:comparisonRange?.from??null,to:comparisonRange?.to??null,filters:{...currentScope.filters,from:comparisonRange?.from??null,to:comparisonRange?.to??null}}:null},fullCohort,rankingComplete,
  totalGroups:cut?.groupCount??0,currentGroups:groups.length,comparisonGroups:groups.length,returnedGroups:rows.length,omittedGroups:Math.max(0,(cut?.groupCount??0)-rows.length),offset,limit,hasMore:offset+rows.length<groups.length,
  unavailableChangeGroups:ranked.filter(row=>row.change.relative===null).length,rows,
  qualification:'GA4-attributed sessions, engaged sessions, purchases and revenue only. Purchases are not Shopify business orders or converting sessions. Do not calculate session CVR, MER or a converting-session gap. Groups are paired and sorted before pagination; preserve capture, sampling and missing-date coverage.',
  ...!rankingComplete?{warning:!supported||sort==='impact'?'This GA4 metric or impact ranking is unavailable; use sessions, engagedSessions, purchases or revenue with decline, growth or value sort.':'GA4 groups have backend or context omissions; this is not a complete-cohort ranking.'}:{}};
}

function ga4Summary(client:EvidenceClient,history:boolean){
 const view=client.ga4View;if(!view?.available)return view;
 const {pages,sources,markets,devices,daily,...summary}=view;
 return {...summary,...history?{daily}:{},groupCounts:{pages:pages.groupCount,sources:sources.groupCount,markets:markets.groupCount,devices:devices.groupCount},groupEvidence:'Requested dimension groups are in tables; complete source totals remain above.'};
}

function reviewSummary(review:EvidenceClient['sourceReviews'][number]){
 const {type,kpis,summary,headlines}=review.payload;
 return {...review,payload:{type,kpis,summary,headlines},detailTool:'read_reviews returns the full fixed saved report.'};
}

function collectionScope(collection:DetailCollection){
 const scopes=collection.rows.flatMap(row=>row.provenance);
 return {definitions:unique(scopes.map(scope=>scope.definition)),populations:unique(scopes.map(scope=>scope.population)),currencies:unique(scopes.map(scope=>scope.currency)),sourceIds:unique(scopes.map(scope=>scope.sourceId)),sourceQuality:unique(scopes.map(scope=>scope.quality)),observedDates:unique(scopes.map(scope=>scope.date)).sort(),
  retrievedAt:unique(scopes.map(scope=>scope.retrievedAt)).sort(),coverageThrough:unique(scopes.map(scope=>scope.coverageThrough))};
}
function datasetPreview(collection:DetailCollection|undefined,limit:number,offset:number,includeRows:boolean,includeScope=true){
 if(!collection)return null;
 const selected=includeRows?collection.rows.slice(offset,offset+limit):[],rows=selected.map(row=>({dimensions:row.dimensions,...values(row),derived:row.derived}));
 const returnedObservationCount=selected.reduce((sum,row)=>sum+row.provenance.reduce((count,scope)=>count+scope.observationCount,0),0);
 return {fullCohort:collection.omitted===0,segmentCount:collection.segmentCount,availablePreviewGroups:collection.returnedSegmentCount,sourceOmittedGroups:collection.omitted,returnedGroups:rows.length,omittedGroups:collection.segmentCount-rows.length,
  observationCount:collection.observationCount,availablePreviewObservationCount:collection.returnedObservationCount,sourceOmittedObservationCount:collection.omittedObservationCount,returnedObservationCount,omittedObservationCount:collection.observationCount-returnedObservationCount,storedObservationCount:collection.storedObservationCount,offset,limit,...includeScope?{scope:collectionScope(collection)}:{},rows,
  qualification:collection.omitted?'Bounded source preview; omitted groups prevent complete-cohort totals or ranking. Use authoritative selectedView totals where supplied.':'Prepared detail groups. Summaries preserve population-qualified nulls; preview pagination does not establish significance.'};
}

function selectedView(client:EvidenceClient,includeHistory:boolean){
 const {dataset,scope,current,comparison,instruction,dailyChart,history,hourlyChart}=client.selectedView;
 return {dataset,scope,current,comparison,instruction,...includeHistory&&dailyChart?{dailyChart}:{},...includeHistory&&history?{history}:{},...includeHistory&&hourlyChart?{hourlyChart}:{}};
}
function trafficTotals(period:TrafficPeriod|null){
 const row=period?.cuts.all?.rows[0];return row?values(row):null;
}

/**
 * A bounded analytical projection for cross-platform chat. No providers, storage
 * or framework code are read here; buildAIContext supplies the authorized scope.
 */
export function buildPlatformEvidence(input:AIContext,options:PlatformEvidenceOptions={},namespace:string){
 const limit=boundedInteger(options.limit,20,1,50),offset=boundedInteger(options.offset,0,0,Number.MAX_SAFE_INTEGER),metric=options.metric?.trim()||'cvr',sort=options.sort??'decline';
 const requested=options.breakdown?.trim()||'all',requestedDimensions=requested==='all'?['market','page']:dimensions.has(requested)?[requested]:[];
 const sources:AISource[]=[],sourceMap=new Map<string,string>(),sourceRecords=new Map(input.sources.map(source=>[source.id,source]));
 const prefix=`${encodeURIComponent(namespace)}:${input.clients.map(client=>encodeURIComponent(client.client.id)).sort().join(',')}`;
 const mapSource=(id:string,fallback:AISource):string=>{
  let mapped=sourceMap.get(id);if(mapped)return mapped;
  if(!sourceRecords.has(id)&&id!==fallback.id)return mapSource(fallback.id,fallback);
  mapped=`${prefix}:${id}`;sourceMap.set(id,mapped);const source=sourceRecords.get(id)??{...fallback,id,label:`${fallback.label} · observed source ${id}`};sources.push({...source,id:mapped});return mapped;
 };
 const remap=(value:unknown,fallback:AISource,key=''):unknown=>{
  if(Array.isArray(value))return value.map(item=>remap(item,fallback,key));
  if(value===null||typeof value!=='object')return typeof value==='string'&&/sourceIds?$/i.test(key)?mapSource(value,fallback):value;
  return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,remap(item,fallback,name)]));
 };
 const clients=input.clients.map(client=>{
  const fallback=sourceRecords.get(client.sourceId)??{id:client.sourceId,label:client.client.name,url:`/clients/${encodeURIComponent(client.client.id)}`};
  const question=options.question??'',history=!options.question||/\b(trend|history|historical|daily|hourly|week|weekly|month|monthly|pace|over time)\b/i.test(question);
  const subscription=!options.question||client.selectedView.dataset==='subscriptions'||/\b(subscription|subscriptions|recurring|renewal|renewals|cancellation|cancellations|cancelled|canceled)\b/i.test(question);
  const diagnoses=!options.question||/\b(campaign|campaigns|cpc|cpm|ctr|clicks?|impressions?|auction|costs?|family|families|mix|bundle|bundles|cancellation|cancellations)\b/i.test(question);
  const traffic=!options.question||client.selectedView.dataset==='traffic'||client.selectedView.dataset==='funnels'||/\b(traffic|pages?|markets?|sources?|devices?|utm)\b/i.test(question);
  const relevant=(dataset:string)=>!options.question||dataset===client.selectedView.dataset||dataset==='traffic'&&traffic||dataset.startsWith('subscription')&&subscription;
  const datasets=Object.fromEntries(unique([...Object.keys(client.datasetDetails),...Object.keys(client.comparisonDatasetDetails),client.selectedView.dataset]).map(dataset=>[dataset,{
   // Traffic rows would duplicate the complete tables. Other datasets retain a
   // bounded single preview, with full source omissions and scopes exposed.
   current:datasetPreview(client.datasetDetails[dataset],limit,offset,dataset!=='traffic'&&relevant(dataset),relevant(dataset)),comparison:datasetPreview(client.comparisonDatasetDetails[dataset],limit,offset,dataset!=='traffic'&&relevant(dataset),relevant(dataset)),
   ...dataset==='traffic'?{totals:{current:trafficTotals(client.visualBreakdowns.traffic.current),comparison:trafficTotals(client.visualBreakdowns.traffic.comparison)},totalsBasis:'Complete prepared traffic aggregates, computed before detail previews; null rates retain population qualification.'}:dataset===client.selectedView.dataset?{totals:{current:client.selectedView.current,comparison:client.selectedView.comparison},totalsBasis:'Authoritative selectedView totals across the full prepared selected dataset.'}:{totals:null,totalsBasis:'Complete totals are not supplied for this dataset; do not reconstruct them from preview rows.'}
  }]));
  const tables:Record<string,ReturnType<typeof trafficTable>|ReturnType<typeof datasetTable>|ReturnType<typeof ga4Table>>={};
  if(client.selectedView.dataset==='ga4'){for(const dimension of requestedDimensions)tables[dimension]=ga4Table(client,dimension,metric,sort,limit,offset);}
  else {if(traffic)for(const dimension of requestedDimensions)tables[dimension]=trafficTable(client,dimension,metric,sort,limit,offset);if(client.selectedView.dataset!=='traffic')tables[client.selectedView.dataset]=datasetTable(client,client.selectedView.dataset,metric,sort,limit,offset);}
  if(client.selectedView.dataset==='northbeam'){
   const view=client.northbeamView,scope=view?.scope??null,key=metric==='revenue'?'attributedRevenue':metric,previous=new Map((view?.comparisonDaily??[]).map(row=>[row.date,row])),offsetDays=scope?Math.round((Date.parse(scope.comparison.from)-Date.parse(scope.from))/86400000):0;
   const daily=view?.daily??[],rows=daily.map(row=>{const prior=view?.comparisonAllowed?previous.get(Temporal.PlainDate.from(row.date).add({days:offsetDays}).toString()):undefined;return {date:row.date,current:{spend:row.spend,attributedRevenue:row.attributedRevenue,roas:row.roas},previous:prior?{spend:prior.spend,attributedRevenue:prior.attributedRevenue,roas:prior.roas}:null,change:arithmetic(number(row[key as keyof typeof row]),prior?number(prior[key as keyof typeof prior]):null,key)};});
   rows.sort((a,b)=>(sort==='value'?compareNumbers(a.change.current,b.change.current,-1):compareNumbers(a.change.relative,b.change.relative,sort==='decline'?1:-1))||a.date.localeCompare(b.date));
   const northbeamResult={client:{id:client.client.id,name:client.client.name,slug:client.client.slug,timezone:scope?.timezone??null,currency:scope?.currency??null},sourceId:view?.sourceId??client.sourceId,cutoff:null,reportTiming:scope?{from:scope.from,to:scope.to,timezone:scope.timezone,granularity:'daily',containsCurrentDay:scope.containsCurrentDay}:null,comparison:scope?.comparison??null,selectedView:{dataset:'northbeam',scope,current:view?.current??null,comparison:view?.previous??null,instruction:view?.instruction??'Northbeam attribution is unavailable; native commerce data is not a substitute.'},northbeamView:view,datasets:{},tables:{daily:{dataset:'northbeam',metric:key,sort,scope,fullCohort:view?.coverage.complete===true,rankingComplete:view?.coverage.complete===true&&(sort==='value'||view.comparisonAllowed),totalGroups:rows.length,returnedGroups:rows.slice(offset,offset+limit).length,offset,limit,rows:rows.slice(offset,offset+limit),qualification:'Daily all-platform attribution under the fixed profile. Comparisons require complete closed periods; missing values remain unknown.'}}};
   return remap(northbeamResult,fallback) as typeof result;
  }
  if(client.selectedView.dataset==='ga4'){
   const view=client.ga4View,scope=view?.scope??null,available=view?.available===true;
   // Native commerce cutoffs and dates do not describe a GA4 report capture.
   const ga4Result={client:{id:client.client.id,name:client.client.name,slug:client.client.slug,timezone:scope?.timezone??null,currency:scope?.currency??null},sourceId:view?.sourceId??client.sourceId,
    reportTiming:scope?{storeDate:scope.to,mode:scope.filters.mode,timezone:scope.timezone,matchedThroughHour:scope.matchedThroughHour,latestCapturedAt:scope.latestCapturedAt}:null,comparison:scope?.comparison??null,cutoff:null,
    selectedView:{dataset:'ga4',scope,current:available?view.current:null,comparison:available?view.previous:null,instruction:view?.instruction??'GA4 evidence is unavailable for this selection; native commerce data is not a substitute.'},
    ga4View:ga4Summary(client,history),datasets:{},tables,instruction:'GA4 report dates and exclusive matchedThroughHour use only the supplied GA4 timezone. latestCapturedAt is the capture timestamp, not a completeness watermark. Native commerce cutoffs, store clocks and financial metrics do not describe this GA4 evidence. Missing hours remain unknown.'};
   return remap(ga4Result,fallback) as typeof result;
  }
  const result={client:{id:client.client.id,name:client.client.name,slug:client.client.slug,timezone:client.client.timezone,currency:client.client.currency,config:client.client.config},sourceId:client.sourceId,reportTiming:client.reportTiming,comparison:client.comparison,cutoff:client.cutoff,
   metrics:client.metrics,prior:client.prior,comparisonArithmetic:client.comparisonArithmetic,spendVerdict:client.spendVerdict,selectedView:selectedView(client,history),
   ...client.beamReporting?{beamReporting:{...client.beamReporting,experiments:{evidencePath:'datasets.experiments',instruction:client.beamReporting.experiments.instruction}}}:{},
   ...client.providerReporting?{providerReporting:client.providerReporting}:{},
   ...client.ga4View?{ga4View:ga4Summary(client,history)}:{},selectedReview:client.selectedReview?{...client.selectedReview,scopeLabel:'Fixed saved report; its dates and values may differ from the dashboard selection.'}:null,sourceReviews:options.question?client.sourceReviews.map(reviewSummary):client.sourceReviews,priorSourceReviews:options.question?client.priorSourceReviews.map(reviewSummary):client.priorSourceReviews,
   notes:client.notes,findings:client.findings,incidents:client.incidents,warnings:client.warnings,sourceQuality:client.sourceQuality,observedDates:client.observedDates,selectedObservationCount:client.selectedObservationCount,
   ...subscription?{subscriptions:client.subscriptions}:{},visualBreakdowns:{...subscription?{subscriptions:client.visualBreakdowns.subscriptions}:{}},...diagnoses?{strategyDiagnoses:client.strategyDiagnoses}:{},...client.monthToDate?{monthToDate:client.monthToDate}:{},...client.activeCustomerComparison?{activeCustomerComparison:client.activeCustomerComparison}:{},liveOperations:client.liveOperations,
   datasets,tables,
   ...!requestedDimensions.length?{breakdownWarning:`Unsupported traffic breakdown: ${requested}. Supported dimensions: ${[...dimensions].join(', ')}.`}:{}};
  return remap(result,fallback) as typeof result;
 });
 // Keep saved-report citations even if a report payload has no sourceId field.
 for(const source of input.sources)mapSource(source.id,source);
 return {format:'avenuez-platform-evidence-v1',filters:input.filters,options:{breakdown:requested,metric,sort,limit,offset},sources,clients};
}
