import {dayWindow,shiftDate} from './windows';
import {Temporal} from '@js-temporal/polyfill';
import type {QueryFilters,Finding,Observation} from './contracts';
import type {Workspace} from '../server/workspace';
import type {ClientAnalytics} from './query';
import {reviewHref} from '../reviews/document';
import {liveReportingDate} from './reporting-date';
export type AlertFigure={label:string;current:number|null;previous:number|null;format:'number'|'money'|'percent'|'ratio'};
export type BusinessAlert={key:string;clientId:string;clientName:string;title:string;detail:string;nextStep:string;category:string;severity:string;status:string;owner:string;evidence:string[];basis:string;impact:number|null;finding?:Finding;period?:QueryFilters;figures:AlertFigure[];currency:string;referenceLabels?:{label:string;url:string}[]};
export function reviewMatchesScope(value:unknown,filters:QueryFilters){
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const scope=value as Record<string,unknown>;
 return (['from','to','mode','compare','compareFrom','compareTo','market','stream','source','device','page'] as const).every(key=>scope[key]===filters[key]);
}
const delta=(n:number|null)=>n===null?'unavailable':`${n>=0?'+':''}${(n*100).toFixed(1)}%`;
const refs=(rows:Observation[])=>rows.map(r=>`${r.sourceId}:${r.date}:${r.dataset}:${r.metric}:${JSON.stringify(r.dimensions)}`);
const pagePath=(value:string)=>{try{return new URL(value,'https://analytics.invalid').pathname.replace(/\/+$/,'')||'/';}catch{return '';}};
function citedPages(text:string){return new Set((text.match(/https?:\/\/[^\s"'`<>()\[\]{},;]+|\/[^\s"'`<>()\[\]{},;]+/gu)??[]).map(value=>pagePath(value.replace(/[.!:]+$/,''))));}
function conversionPage(alert:BusinessAlert,clientId:string,actions:ClientAnalytics['actions']){
 if(alert.category!=='Conversion opportunity')return null;
 const raw=actions.find(action=>alert.key.endsWith(`:${action.key}`));
 if(raw?.dimensions.page&&raw.dimensions.market)return {page:pagePath(raw.dimensions.page),market:raw.dimensions.market,ownPrevious:raw.benchmarkReason==='Own previous period'};
 // Prepared and already-cached frames retain this server-created drill link
 // after stripping bulk observations and raw action dimensions.
 for(const ref of alert.evidence){if(!ref.startsWith(`/clients/${encodeURIComponent(clientId)}?`))continue;
  const params=new URL(ref,'https://analytics.invalid').searchParams,page=params.get('page'),market=params.get('market');
  if(params.get('view')==='traffic'&&page&&market)return {page:pagePath(page),market,ownPrevious:alert.detail.includes('Own previous period.')};
 }
 return null;
}
function conversionCovered(rows:Observation[],from:string,to:string,timezone:string,cutoff:string|null){
 const sessions=rows.filter(r=>r.metric==='sessions'),conversions=rows.filter(r=>r.metric==='converting_sessions');
 const clock=cutoff?Temporal.Instant.from(cutoff).toZonedDateTimeISO(timezone).toPlainTime():null;
 // Next-midnight coverage completes the selected day and its matched prior
 // day; its 00:00 clock must not become either day's starting boundary.
 const windowEnd=clock&&!clock.equals(Temporal.PlainTime.from('00:00'))?Temporal.PlainDate.from(to).toZonedDateTime({timeZone:timezone,plainTime:clock}).toInstant().toString():dayWindow(to,timezone).end;
 const end=Date.parse(windowEnd);
 const interval=(r:Observation)=>{const day=dayWindow(r.date,timezone);return {start:Date.parse(r.start??day.start),end:Date.parse(r.end??day.end)};};
 const identity=(r:Observation)=>JSON.stringify([r.date,interval(r),r.population,r.sourceId,Object.entries(r.dimensions).sort()]);
 if(!sessions.length||!conversions.length||[...sessions,...conversions].some(r=>r.quality!=='complete'||r.value===null||r.value<0||!r.population||!r.coverageThrough||Date.parse(r.coverageThrough)<end))return false;
 const a=sessions.map(identity).sort(),b=conversions.map(identity).sort();
 if(new Set(a).size!==a.length||JSON.stringify(a)!==JSON.stringify(b))return false;
 for(let date=from;date<=to;date=shiftDate(date,1)){
  const day=dayWindow(date,timezone),expectedEnd=date===to?end:Date.parse(day.end);
  let cursor=Date.parse(day.start);
  const parts=sessions.filter(r=>r.date===date).map(interval).sort((a,b)=>a.start-b.start);
  if(!parts.length)return false;
  const reconciledPublicPages=sessions.filter(r=>r.date===date).every(r=>r.dataset==='funnels'&&r.definition==='shopify_human_public_landing_pages'&&r.population==='human_public_landing_page_sessions');
  if(reconciledPublicPages){if(parts.some(p=>p.start<Date.parse(day.start)||p.end>expectedEnd||p.end<=p.start))return false;continue;}
  for(const part of parts){if(part.start!==cursor||part.end<=part.start||part.end>expectedEnd)return false;cursor=part.end;}
  if(cursor!==expectedEnd)return false;
 }
 return true;
}
/** The same canonical qualification runs before browser presentation strips
 * bulk observations and on older raw frames. No browser boolean can establish
 * source coverage or a same-page benchmark. */
export function qualifiedConversionAlerts(r:Pick<ClientAnalytics,'client'|'actions'|'comparison'|'cutoff'>,filters:QueryFilters):BusinessAlert[]{
 const result:BusinessAlert[]=[],scope=JSON.stringify([filters.from,filters.to,filters.mode,filters.compare,filters.market,filters.stream,filters.source,filters.device,filters.page]);
 for(const a of r.actions){const benchmark=a.benchmarkReason==='Own previous period'?r.comparison:filters;
  if(filters.mode==='partial'&&!r.cutoff||!conversionCovered(a.evidence,filters.from,filters.to,r.client.timezone,r.cutoff)||!conversionCovered(a.benchmarkEvidence,benchmark.from,benchmark.to,r.client.timezone,r.cutoff))continue;
  const key=`signal:conversion:${r.client.id}:${scope}:${a.key}`;
  result.push({clientId:r.client.id,clientName:r.client.name,status:'open',owner:'',currency:r.client.currency,key,title:`Review ${a.dimensions.page||'segment'} conversion`,detail:`${a.summary.sessions?.toLocaleString()} sessions at ${((a.summary.cvr??0)*100).toFixed(2)}% CVR, versus ${((a.benchmark??0)*100).toFixed(2)}%. ${a.benchmarkReason}. Estimated gap: ${a.opportunity?.toFixed(0)} orders at this traffic volume.`,nextStep:'Compare source and device mix, offer, pricing, localisation and cart evidence before choosing a change.',category:'Conversion opportunity',severity:'investigate',basis:'Qualified source evidence',impact:a.opportunity,period:filters,figures:[{label:'Sessions',current:a.summary.sessions,previous:null,format:'number'},{label:'Conversion rate',current:a.summary.cvr,previous:a.benchmark,format:'percent'}],evidence:[key,...refs([...a.evidence,...a.benchmarkEvidence])].slice(0,100)});
 }
 return result;
}
export function buildAlertQueue(records:Omit<Workspace['clients'][number],'scheduleState'>[],requestedFilters:QueryFilters,options:{includeLatestReview?:boolean}={}):BusinessAlert[]{
 const result:BusinessAlert[]=[];
 for(const r of records){
  // Live portfolio records use each client's captured store day. Fixed dates
  // retain their exact scope and cannot inherit alerts from another selection.
  const liveDate=requestedFilters.period==='today'?liveReportingDate(r.connections,requestedFilters.view,r.client.timezone):null;
  const filters=liveDate?{...requestedFilters,from:liveDate,to:liveDate}:requestedFilters;
  const base={clientId:r.client.id,clientName:r.client.name,status:'open',owner:'',figures:[] as AlertFigure[],currency:r.client.currency};
  const scope=JSON.stringify([filters.from,filters.to,filters.mode,filters.compare,filters.market,filters.stream,filters.source,filters.device,filters.page]);
  const generated:BusinessAlert[]=[];
  if(r.verdict.growth==='inefficient'&&r.verdict.spendComparison!=='unavailable'){
   const key=`signal:efficiency:${r.client.id}:${scope}`;
   generated.push({...base,key,title:'Review paid media efficiency',detail:`Revenue ${delta(r.verdict.rd)} versus spend ${delta(r.verdict.sd)}. Cost per new-customer order is ${r.verdict.cost?.toFixed(2)??'unavailable'} ${r.client.currency}, versus ${r.verdict.previousCost?.toFixed(2)??'unavailable'} in the comparison period.`,nextStep:'Inspect channel and campaign changes, then review budgets against new-customer acquisition cost.',category:'Spend efficiency',severity:'act',basis:'Qualified source evidence',impact:null,period:filters,figures:[{label:'Revenue',current:r.metrics.revenue,previous:r.prior.revenue,format:'money'},{label:'Spend',current:r.metrics.spend,previous:r.prior.spend,format:'money'},{label:'MER',current:r.metrics.mer,previous:r.prior.mer,format:'ratio'},{label:'New-customer orders',current:r.metrics.newOrders,previous:r.prior.newOrders,format:'number'},{label:'Spend per new-customer order',current:r.verdict.cost,previous:r.verdict.previousCost,format:'money'}],evidence:[key,...((r as typeof r&{efficiencyEvidence?:string[]}).efficiencyEvidence??refs([...r.evidence,...r.comparisonEvidence].filter(x=>x.dataset==='overview'&&['revenue','spend','new_orders'].includes(x.metric))))].slice(0,100)});
  }
  const prepared=(r as typeof r&{qualifiedPageAlerts?:BusinessAlert[]}).qualifiedPageAlerts;
  generated.push(...(prepared?prepared.filter(alert=>alert.clientId===r.client.id&&alert.period&&['from','to','mode','compare','compareFrom','compareTo','market','stream','source','device','page'].every(key=>(alert.period as any)[key]===(filters as any)[key])):qualifiedConversionAlerts(r,filters)));
  const sameTitle=(a:string,b:string)=>a.toLowerCase().replace(/[^a-z0-9]/g,'')===b.toLowerCase().replace(/[^a-z0-9]/g,'');
  const matchesScope=(p:unknown)=>reviewMatchesScope(p,filters);
  const latest=(r.reviews??[]).filter(x=>x.current&&x.payload.type==='ai').sort((a,b)=>b.storeDate.localeCompare(a.storeDate)||b.createdAt.localeCompare(a.createdAt))[0];
  for(const review of (r.reviews??[]).filter(x=>x.current&&x.payload.type==='ai'&&(matchesScope(x.payload.filters)||options.includeLatestReview&&x.id===latest?.id))){
   const actions=review.payload.actions as {title:string;detail:string;nextStep:string;severity:string;impact:number|null;sourceIds:string[];existingFindingId?:string|null}[]|undefined;
   for(const a of actions||[]){
    if(a.existingFindingId)continue;
    const pages=citedPages(`${a.title} ${a.detail}`),markets:string[]=a.title.match(/[\p{L}\p{N}]+/gu)??[];
    const dates=(`${a.title} ${a.detail}`).match(/\b\d{4}-\d{2}-\d{2}\b/g)??[],selected=(date:string)=>date>=filters.from&&date<=filters.to;
    const matchingDates=!dates.length||dates.some(selected)&&dates.every(date=>selected(date)||date>=r.comparison.from&&date<=r.comparison.to);
    const pageMatches=matchingDates&&matchesScope(review.payload.filters)&&/\bown (?:previous|prior) period\b/i.test(a.detail)?generated.flatMap((alert,index)=>{const identity=conversionPage(alert,r.client.id,r.actions);return identity?.ownPrevious&&identity.page!=='/'&&pages.has(identity.page)&&markets.includes(identity.market)?[index]:[];}):[];
    if(pageMatches.length===1){
     const index=pageMatches[0],live=generated[index],url=reviewHref(r.client.id,review.id),referenceLabels=live.referenceLabels??[];
     generated[index]={...live,evidence:[...new Set([...live.evidence,url])],referenceLabels:referenceLabels.some(ref=>ref.url===url)?referenceLabels:[...referenceLabels,{label:`Daily review · ${review.storeDate}`,url}]};
     continue;
    }
    const key=`signal:ai:${r.client.id}:${review.storeDate}:${a.title}`,equivalents=generated.filter(s=>sameTitle(s.title,a.title));
    if(equivalents.length||r.findings.some(f=>sameTitle(f.title,a.title)&&(f.status!=='closed'||f.evidence.includes(key)||equivalents.some(e=>f.evidence.includes(e.key)))))continue;
    const sourceLabels=(review.payload.sources as {id:string;label:string;url:string}[]|undefined)?.filter(s=>a.sourceIds.includes(s.id)).map(({label,url})=>({label,url}));generated.push({...base,...a,key,category:matchesScope(review.payload.filters)?'AI review recommendation':'Latest daily review',basis:`AI analysis · ${review.storeDate} · fixed source evidence`,period:review.payload.filters as QueryFilters,referenceLabels:sourceLabels,evidence:[key,reviewHref(r.client.id,review.id)]});
   }
  }
  for(const signal of generated){if(!r.findings.some(f=>f.evidence.includes(signal.key)))result.push(signal);}
  for(const f of r.findings){if(f.status==='closed')continue;const historical=f.evidence.some(e=>e.startsWith('https://claude.ai/artifact/')),nextStep=f.latestCheck?.nextStep?.trim()||f.detail.match(/\bNext step\s*:\s*([^\r\n]+)/i)?.[1]?.trim()||'';result.push({...base,key:f.id,title:f.title,detail:f.latestCheck?.detail??f.detail,nextStep,category:historical?'Daily review action':'Team follow-up',severity:f.severity,status:f.status,owner:f.owner,evidence:[...f.evidence,...f.latestCheck?[reviewHref(r.client.id,f.latestCheck.reviewId)]:[]],basis:f.latestCheck?`Rechecked · ${f.latestCheck.storeDate}`:historical?'Imported Claude review':'Tracked by the team',impact:null,finding:f});}
 }
 const rank:Record<string,number>={act:0,investigate:1,watch:2};
 return result.sort((a,b)=>(rank[a.severity]??1)-(rank[b.severity]??1)||(b.impact??0)-(a.impact??0));
}
