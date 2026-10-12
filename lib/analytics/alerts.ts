import {dayWindow,shiftDate} from './windows';
import {Temporal} from '@js-temporal/polyfill';
import type {QueryFilters,Finding,Observation} from './contracts';
import type {Workspace} from '../server/workspace';
import {reviewHref} from '../reviews/document';
export type AlertFigure={label:string;current:number|null;previous:number|null;format:'number'|'money'|'percent'|'ratio'};
export type BusinessAlert={key:string;clientId:string;clientName:string;title:string;detail:string;nextStep:string;category:string;severity:string;status:string;owner:string;evidence:string[];basis:string;impact:number|null;finding?:Finding;period?:QueryFilters;figures:AlertFigure[];currency:string;referenceLabels?:{label:string;url:string}[]};
const delta=(n:number|null)=>n===null?'unavailable':`${n>=0?'+':''}${(n*100).toFixed(1)}%`;
const refs=(rows:Observation[])=>rows.map(r=>`${r.sourceId}:${r.date}:${r.dataset}:${r.metric}:${JSON.stringify(r.dimensions)}`);
function conversionCovered(rows:Observation[],from:string,to:string,timezone:string,cutoff:string|null){
 const sessions=rows.filter(r=>r.metric==='sessions'),conversions=rows.filter(r=>r.metric==='converting_sessions');
 const windowEnd=cutoff?Temporal.PlainDate.from(to).toZonedDateTime({timeZone:timezone,plainTime:Temporal.Instant.from(cutoff).toZonedDateTimeISO(timezone).toPlainTime()}).toInstant().toString():dayWindow(to,timezone).end;
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
export function buildAlertQueue(records:Omit<Workspace['clients'][number],'scheduleState'>[],filters:QueryFilters,options:{includeLatestReview?:boolean}={}):BusinessAlert[]{
 const result:BusinessAlert[]=[];
 for(const r of records){
  const base={clientId:r.client.id,clientName:r.client.name,status:'open',owner:'',figures:[] as AlertFigure[],currency:r.client.currency};
  const scope=JSON.stringify([filters.from,filters.to,filters.mode,filters.compare,filters.market,filters.stream,filters.source,filters.device,filters.page]);
  const generated:BusinessAlert[]=[];
  if(r.verdict.growth==='inefficient'&&r.verdict.spendComparison!=='unavailable'){
   const key=`signal:efficiency:${r.client.id}:${scope}`;
   generated.push({...base,key,title:'Review paid media efficiency',detail:`Revenue ${delta(r.verdict.rd)} versus spend ${delta(r.verdict.sd)}. Cost per new-customer order is ${r.verdict.cost?.toFixed(2)??'unavailable'} ${r.client.currency}, versus ${r.verdict.previousCost?.toFixed(2)??'unavailable'} in the comparison period.`,nextStep:'Inspect channel and campaign changes, then review budgets against new-customer acquisition cost.',category:'Spend efficiency',severity:'act',basis:'Qualified source evidence',impact:null,period:filters,figures:[{label:'Revenue',current:r.metrics.revenue,previous:r.prior.revenue,format:'money'},{label:'Spend',current:r.metrics.spend,previous:r.prior.spend,format:'money'},{label:'MER',current:r.metrics.mer,previous:r.prior.mer,format:'ratio'},{label:'New-customer orders',current:r.metrics.newOrders,previous:r.prior.newOrders,format:'number'},{label:'Spend per new-customer order',current:r.verdict.cost,previous:r.verdict.previousCost,format:'money'}],evidence:[key,...refs([...r.evidence,...r.comparisonEvidence].filter(x=>x.dataset==='overview'&&['revenue','spend','new_orders'].includes(x.metric)))].slice(0,100)});
  }
  for(const a of r.actions){
   const benchmark=a.benchmarkReason==='Own previous period'?r.comparison:filters;
   if(filters.mode==='partial'&&!r.cutoff||!conversionCovered(a.evidence,filters.from,filters.to,r.client.timezone,r.cutoff)||!conversionCovered(a.benchmarkEvidence,benchmark.from,benchmark.to,r.client.timezone,r.cutoff))continue;
   const key=`signal:conversion:${r.client.id}:${scope}:${a.key}`;
   generated.push({...base,key,title:`Review ${a.dimensions.page||'segment'} conversion`,detail:`${a.summary.sessions?.toLocaleString()} sessions at ${((a.summary.cvr??0)*100).toFixed(2)}% CVR, versus ${((a.benchmark??0)*100).toFixed(2)}%. ${a.benchmarkReason}. Estimated gap: ${a.opportunity?.toFixed(0)} orders at this traffic volume.`,nextStep:'Compare source and device mix, offer, pricing, localisation and cart evidence before choosing a change.',category:'Conversion opportunity',severity:'investigate',basis:'Qualified source evidence',impact:a.opportunity,period:filters,figures:[{label:'Sessions',current:a.summary.sessions,previous:null,format:'number'},{label:'Conversion rate',current:a.summary.cvr,previous:a.benchmark,format:'percent'}],evidence:[key,...refs([...a.evidence,...a.benchmarkEvidence])].slice(0,100)});
  }
  const sameTitle=(a:string,b:string)=>a.toLowerCase().replace(/[^a-z0-9]/g,'')===b.toLowerCase().replace(/[^a-z0-9]/g,'');
  const matchesScope=(p:unknown)=>!!p&&['from','to','mode','compare','market','stream','source','device','page'].every(k=>(p as any)[k]===(filters as any)[k]);
  const latest=(r.reviews??[]).filter(x=>x.current&&x.payload.type==='ai').sort((a,b)=>b.storeDate.localeCompare(a.storeDate)||b.createdAt.localeCompare(a.createdAt))[0];
  for(const review of (r.reviews??[]).filter(x=>x.current&&x.payload.type==='ai'&&(matchesScope(x.payload.filters)||options.includeLatestReview&&x.id===latest?.id))){
   const actions=review.payload.actions as {title:string;detail:string;nextStep:string;severity:string;impact:number|null;sourceIds:string[];existingFindingId?:string|null}[]|undefined;
   for(const a of actions||[]){const key=`signal:ai:${r.client.id}:${review.storeDate}:${a.title}`,equivalents=generated.filter(s=>sameTitle(s.title,a.title));if(a.existingFindingId||equivalents.length||r.findings.some(f=>sameTitle(f.title,a.title)&&(f.status!=='closed'||f.evidence.includes(key)||equivalents.some(e=>f.evidence.includes(e.key)))))continue;const sourceLabels=(review.payload.sources as {id:string;label:string;url:string}[]|undefined)?.filter(s=>a.sourceIds.includes(s.id)).map(({label,url})=>({label,url}));generated.push({...base,...a,key,category:matchesScope(review.payload.filters)?'AI review recommendation':'Latest daily review',basis:`AI analysis · ${review.storeDate} · fixed source evidence`,period:review.payload.filters as QueryFilters,referenceLabels:sourceLabels,evidence:[key,reviewHref(r.client.id,review.id)]});}
  }
  for(const signal of generated){if(!r.findings.some(f=>f.evidence.includes(signal.key)))result.push(signal);}
  for(const f of r.findings){if(f.status==='closed')continue;const historical=f.evidence.some(e=>e.startsWith('https://claude.ai/artifact/'));result.push({...base,key:f.id,title:f.title,detail:f.latestCheck?.detail??f.detail,nextStep:f.latestCheck?.nextStep||'Open the action to review evidence, assign an owner and update its status.',category:historical?'Daily review action':'Team follow-up',severity:f.severity,status:f.status,owner:f.owner,evidence:[...f.evidence,...f.latestCheck?[reviewHref(r.client.id,f.latestCheck.reviewId)]:[]],basis:f.latestCheck?`Rechecked · ${f.latestCheck.storeDate}`:historical?'Imported Claude review':'Tracked by the team',impact:null,finding:f});}
 }
 const rank:Record<string,number>={act:0,investigate:1,watch:2};
 return result.sort((a,b)=>(rank[a.severity]??1)-(rank[b.severity]??1)||(b.impact??0)-(a.impact??0));
}
