import type {Client,Observation,QueryFilters} from '../analytics/contracts';
import {change,ratio} from '../analytics/metrics';
import {sumMetric} from '../analytics/query';
import {dayWindow,shiftDate} from '../analytics/windows';
import {Temporal} from '@js-temporal/polyfill';
import {trendCutoffEnd} from '../analytics/trend-context';
import {rechargeCancellationEventDefinition,rechargeCancellationEventPopulation} from '../sources/recharge-subscription-cohort';
import {localHourInterval} from '../sources/kind-patches';
type Period={from:string;to:string};
type Brand=Pick<Client,'timezone'|'currency'>;
const dates=(period:Period)=>{const result:string[]=[];for(let date=period.from;date<=period.to;date=shiftDate(date,1))result.push(date);return result;};
const emptyCosts=()=>({spend:null as number|null,clicks:null as number|null,impressions:null as number|null,cpc:null as number|null,cpm:null as number|null,ctr:null as number|null});
const emptyPage=()=>({sessions:null as number|null,convertingSessions:null as number|null,cvr:null as number|null,sessionShare:null as number|null});
function coverage(rows:Observation[],period:Period,metrics:string[],timezone:string,mode:QueryFilters['mode'],cutoff:string|null){
 const observedDates=[...new Set(rows.map(row=>row.date))].sort(),missingDates=dates(period).filter(date=>metrics.some(metric=>!rows.some(row=>row.date===date&&row.metric===metric)));
 const clock=mode==='partial'&&cutoff?Temporal.Instant.from(cutoff).toZonedDateTimeISO(timezone).toPlainTime():null;
 const requiredEnds=new Map(dates(period).map(date=>[date,Date.parse(clock?Temporal.PlainDate.from(date).toZonedDateTime({timeZone:timezone,plainTime:clock}).toInstant().toString():dayWindow(date,timezone).end)]));
 const qualified=rows.length>0&&missingDates.length===0&&!(mode==='partial'&&!clock)&&rows.every(row=>{
  return row.quality==='complete'&&row.value!==null&&!!row.coverageThrough&&Date.parse(row.coverageThrough)>=(requiredEnds.get(row.date)??Infinity);
 });
 return {observedDates,missingDates,qualified};
}
function samePopulation(rows:Observation[],metrics:string[]){
 const selected=rows.filter(row=>metrics.includes(row.metric)),identities=selected.map(row=>JSON.stringify([row.population,row.definition]));
 return metrics.every(metric=>selected.some(row=>row.metric===metric))&&selected.every(row=>!!row.population)&&new Set(identities).size===1;
}
function costs(rows:Observation[],currency:string,timezone:string){
 if(!rows.length||rows.some(row=>row.dimensions.reporting_timezone!==timezone)||!samePopulation(rows,['meta_ad_spend','meta_ad_clicks','meta_ad_impressions'])||rows.some(row=>row.metric==='meta_ad_spend'&&row.currency!==currency))return emptyCosts();
 const spend=sumMetric(rows,'meta_ad_spend'),clicks=sumMetric(rows,'meta_ad_clicks'),impressions=sumMetric(rows,'meta_ad_impressions');
 return {spend,clicks,impressions,cpc:ratio(spend,clicks),cpm:impressions!==null&&impressions>0&&spend!==null?spend/impressions*1000:null,ctr:ratio(clicks,impressions)};
}
/** Structural path families are observations, not inferred offers or SKU counts. */
export function observedPageFamily(row:Observation){
 if(row.dimensions.family)return row.dimensions.family;
 const path=(row.dimensions.page??'').split('?')[0].toLowerCase();
 if(path==='/')return 'Homepage';
 if(/^\/collections(?:\/|$)/.test(path))return 'Collection';
 if(/(?:^|[-/])bundle(?:s)?(?:[-/]|$)/.test(path))return 'Explicit bundle page';
 if(/^\/products(?:\/|$)/.test(path))return 'Product detail (bundle status unknown)';
 if(/^\/pages(?:\/|$)/.test(path))return 'Landing page (offer type unknown)';
 return 'Other public page';
}
function pageMetrics(rows:Observation[],totalSessions:number|null){
 if(!rows.length)return emptyPage();
 const sessions=sumMetric(rows,'sessions'),convertingSessions=sumMetric(rows,'converting_sessions');
 return {sessions,convertingSessions,cvr:samePopulation(rows,['sessions','converting_sessions'])?ratio(convertingSessions,sessions):null,sessionShare:ratio(sessions,totalSessions)};
}
/** Complete aggregates are prepared before report/model row previews. Ratios
 * use pooled denominators; missing or incompatible baselines stay unknown. */
export function strategyDiagnoses(client:Brand,filters:QueryFilters,comparison:Period,current:Observation[],previous:Observation[],cutoff:string|null=null){
 const scope=`${filters.from}–${filters.to} vs ${comparison.from}–${comparison.to} · ${filters.mode} · ${client.timezone} · ${client.currency}`,limitations:string[]=[];
 const selectedAds=current.filter(row=>row.dataset==='creatives'&&row.metric.startsWith('meta_ad_')),priorAds=previous.filter(row=>row.dataset==='creatives'&&row.metric.startsWith('meta_ad_'));
 const adMetrics=['meta_ad_spend','meta_ad_clicks','meta_ad_impressions'],adCurrentCoverage=coverage(selectedAds.filter(row=>adMetrics.includes(row.metric)),filters,adMetrics,client.timezone,'closed',null),adPriorCoverage=coverage(priorAds.filter(row=>adMetrics.includes(row.metric)),comparison,adMetrics,client.timezone,'closed',null);
 const campaigns=new Map<string,{campaignId:string;campaign:string;current:Observation[];comparison:Observation[]}>();
 for(const [period,rows] of [['current',selectedAds],['comparison',priorAds]] as const)for(const row of rows){
  const campaignId=row.dimensions.campaign_id;if(!campaignId)continue;let value=campaigns.get(campaignId);
  if(!value){value={campaignId,campaign:row.dimensions.campaign??campaignId,current:[],comparison:[]};campaigns.set(campaignId,value);}value[period].push(row);if(period==='current')value.campaign=row.dimensions.campaign??campaignId;
 }
 const campaignRows=[...campaigns.values()].map(group=>{
  const a=adCurrentCoverage.qualified&&filters.mode==='closed'?costs(group.current,client.currency,client.timezone):emptyCosts(),b=adPriorCoverage.qualified&&filters.mode==='closed'?costs(group.comparison,client.currency,client.timezone):emptyCosts();
  const changes={spend:change(a.spend,b.spend),clicks:change(a.clicks,b.clicks),impressions:change(a.impressions,b.impressions),cpc:change(a.cpc,b.cpc),cpm:change(a.cpm,b.cpm),ctr:change(a.ctr,b.ctr)};
  const explanation=changes.spend===null||changes.clicks===null?'A matched cost comparison is unavailable. New or renamed campaigns are not assumed to have a zero baseline.':Math.abs(changes.spend-changes.clicks)<=.01?'Spend and clicks moved proportionally; the click change follows actual spend arithmetically, without establishing a budget-setting change.':changes.clicks>changes.spend?'Clicks changed more than spend in percentage terms, with lower cost per click; this is descriptive traffic efficiency, not a causal creative or checkout diagnosis.':'Clicks changed less than spend in percentage terms, with higher cost per click; inspect audience, auction and creative mix before attributing the move.';
  return {campaignId:group.campaignId,campaign:group.campaign,current:a,comparison:b,changes,explanation};
 }).sort((a,b)=>(b.current.spend??b.comparison.spend??-1)-(a.current.spend??a.comparison.spend??-1));
 const campaignCosts={scope:`${scope} · Meta account-attributed closed-day ad reports; clicks are all reported clicks, not verified landing-page sessions. Pixel purchase value is separate from store revenue and MER.`,currentCoverage:adCurrentCoverage,comparisonCoverage:adPriorCoverage,total:{current:adCurrentCoverage.qualified&&filters.mode==='closed'?costs(selectedAds,client.currency,client.timezone):emptyCosts(),comparison:adPriorCoverage.qualified&&filters.mode==='closed'?costs(priorAds,client.currency,client.timezone):emptyCosts()},campaignCount:campaignRows.length,omitted:Math.max(0,campaignRows.length-40),rows:campaignRows.slice(0,40)};
 if(!campaignRows.length||!adCurrentCoverage.qualified||!adPriorCoverage.qualified||filters.mode==='partial')limitations.push('Campaign CPC, CPM and CTR comparisons require complete matched closed-day Meta spend, click and impression coverage. Same-hour media costs are not supplied.');
 if([...selectedAds,...priorAds].some(row=>row.dimensions.reporting_timezone!==client.timezone))limitations.push('Meta reporting timezone differs from the store timezone; these cost figures are unavailable for this comparison.');
 limitations.push('Market-level CPC, CPM and CTR are unavailable: the supplied click/impression feed has no country breakdown. AppLovin UTC market spend cannot establish store-day market traffic costs.');

 const pageDataset=current.some(row=>row.dataset==='traffic'&&row.dimensions.page)?'traffic':'funnels',pageMetricsNames=['sessions','converting_sessions'];
 const pageRows=(rows:Observation[])=>rows.filter(row=>row.dataset===pageDataset&&row.dimensions.page&&pageMetricsNames.includes(row.metric));
 const selectedPages=pageRows(current),priorPages=pageRows(previous),pageCurrentCoverage=coverage(selectedPages,filters,pageMetricsNames,client.timezone,filters.mode,cutoff),pagePriorCoverage=coverage(priorPages,comparison,pageMetricsNames,client.timezone,filters.mode,cutoff);
 const markets=[...new Set([...selectedPages,...priorPages].map(row=>row.dimensions.market??'Unspecified'))].map(market=>{
  const rows=(values:Observation[])=>values.filter(row=>(row.dimensions.market??'Unspecified')===market),aRows=rows(selectedPages),bRows=rows(priorPages),aSessions=sumMetric(aRows,'sessions'),bSessions=sumMetric(bRows,'sessions');
  const families=[...new Set([...aRows,...bRows].map(observedPageFamily))].map(family=>({family,current:pageMetrics(aRows.filter(row=>observedPageFamily(row)===family),aSessions),comparison:pageMetrics(bRows.filter(row=>observedPageFamily(row)===family),bSessions)}));
  const actual=pageMetrics(aRows,aSessions),old=pageMetrics(bRows,bSessions);
  // Keep old family conversion rates fixed while applying new session shares.
  // A new family with no observed old rate makes this counterfactual unknown.
  const counterfactual=pageCurrentCoverage.qualified&&pagePriorCoverage.qualified&&families.every(family=>family.current.sessions===null||family.current.sessionShare!==null&&family.comparison.cvr!==null)?families.reduce((sum,family)=>sum+(family.current.sessionShare??0)*(family.comparison.cvr??0),0):null;
  const decomposition=counterfactual!==null&&actual.cvr!==null&&old.cvr!==null?{comparisonCvr:old.cvr,counterfactualCvr:counterfactual,currentCvr:actual.cvr,mixPoints:counterfactual-old.cvr,ratePoints:actual.cvr-counterfactual}:null;
  return {market,currentSessions:aSessions,comparisonSessions:bSessions,families,decomposition};
 }).sort((a,b)=>(b.currentSessions??b.comparisonSessions??-1)-(a.currentSessions??a.comparisonSessions??-1));
 const pageFamilyMix={scope:`${scope} · Human public-page sessions. Families use an explicit supplied family or structural page path; an unnamed landing page is not assumed to be a single SKU or bundle.`,dataset:pageDataset,currentCoverage:pageCurrentCoverage,comparisonCoverage:pagePriorCoverage,marketCount:markets.length,omittedMarkets:Math.max(0,markets.length-40),markets:markets.slice(0,40),aovDecomposition:null};
 if(!markets.length||!pageCurrentCoverage.qualified||!pagePriorCoverage.qualified)limitations.push('Page-family CVR mix/rate decomposition requires complete compatible human-session and converting-session coverage for both periods.');
 limitations.push('Page-family AOV mix/rate decomposition is unavailable: the supplied page funnels do not include compatible page-attributed revenue and commerce orders. Session conversion counts are not a substitute for commerce orders. Campaign names do not establish which page family received spend.');

 const calendar=(values:Observation[],period:Period)=>{
  const selected=values.filter(row=>row.dataset==='subscriptionEvents'&&row.metric==='subscription_cancellation_events'),qualified=coverage(selected,period,['subscription_cancellation_events'],client.timezone,filters.mode,cutoff);
  // A current-day event capture is partial by calendar date, while its closed
  // hourly buckets can completely cover the selected matched-clock window.
  if(filters.mode==='partial'&&cutoff)qualified.qualified=qualified.missingDates.length===0&&dates(period).every(date=>{
   const start=Date.parse(dayWindow(date,client.timezone).start),end=date<period.to?Date.parse(dayWindow(date,client.timezone).end):trendCutoffEnd(date,{timezone:client.timezone,cutoff,anchorDate:filters.to})??NaN;
   const hours=selected.filter(row=>row.date===date).sort((a,b)=>Date.parse(a.start??'')-Date.parse(b.start??''));let cursor=start;
   if(!hours.length||!Number.isFinite(end)||end<=start)return false;
   for(const row of hours){const from=Date.parse(row.start??''),to=Date.parse(row.end??''),duration=to-from;
    const interval=Number.isFinite(from)?localHourInterval(date,Temporal.Instant.from(row.start!).toZonedDateTimeISO(client.timezone).hour,client.timezone):null;
    if(row.definition!==rechargeCancellationEventDefinition||row.population!==rechargeCancellationEventPopulation||row.currency!==null||Object.keys(row.dimensions).length||!row.sourceId||!['complete','partial'].includes(row.quality)||typeof row.value!=='number'||!Number.isSafeInteger(row.value)||row.value<0||from!==cursor||![3600000,7200000].includes(duration)||!interval||Date.parse(interval.start)!==from||Date.parse(interval.end)!==to||to>end||!row.coverageThrough||Date.parse(row.coverageThrough)<end)return false;
    cursor=to;
   }
   return cursor===end;
  });
  const rows=dates(period).map(date=>({date,cancellations:sumMetric(selected.filter(row=>row.date===date),'subscription_cancellation_events')}));
  return {...period,...qualified,total:qualified.qualified?sumMetric(selected,'subscription_cancellation_events'):null,rows};
 };
 const calendarCurrent=calendar(current,filters),calendarPrior=calendar(previous,comparison);
 const calendarCancellations={scope:`${scope} · Exact Recharge cancellation events grouped by the store calendar day, counting each subscription once at its first cancellation that day. Reactivated subscriptions retain the cancellation event. Seven-day provider retention requires previously captured events or a historical export for older dates. Separate from current-status subscription counts and cancelled renewal orders in their order-date cohort.`,current:calendarCurrent,comparison:calendarPrior,change:change(calendarCurrent.total,calendarPrior.total)};
 if(calendarCurrent.missingDates.length||calendarPrior.missingDates.length)limitations.push(`Calendar cancellation capture is incomplete. Selected missing dates: ${calendarCurrent.missingDates.join(', ')||'None'}; comparison missing dates: ${calendarPrior.missingDates.join(', ')||'None'}. Missing dates are unknown, not zero.`);
 return {scope,campaignCosts,pageFamilyMix,calendarCancellations,limitations};
}
