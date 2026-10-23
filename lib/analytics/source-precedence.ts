import type {Observation} from './contracts';
import {dayWindow} from './windows';
type PreferenceOptions={timezone?:string;partial?:boolean;partialDates?:readonly string[]};
const sessionMetrics=new Set(['sessions','atc_sessions','checkouts','converting_sessions','completed_checkouts']);
function shopifySessions(r:Observation){return sessionMetrics.has(r.metric)&&((r.dataset==='overview'&&['shopify_human_sessions','shopify_human_us_sessions'].includes(r.definition))||(r.dataset==='funnels'&&['shopify_human_public_landing_pages','shopify_human_us_public_landing_pages'].includes(r.definition)));}
function family(r:Observation){return JSON.stringify([r.date,r.dataset,r.metric,r.definition,r.population,r.currency,Object.keys(r.dimensions??{}).sort()]);}
function fullDay(rows:Observation[],timezone?:string){
 if(!timezone||!rows.length)return false;const window=dayWindow(rows[0].date,timezone),start=Date.parse(window.start),end=Date.parse(window.end);
 if(rows.some(r=>r.quality!=='complete'||!r.coverageThrough||Date.parse(r.coverageThrough)<end))return false;
 // The public-page export is sparse: absent page/hour groups are zero only
 // after its bounded full-day query reconciles to independent public totals.
 // Unlike the dense overview, a page need not receive traffic in every hour.
 if(rows.every(r=>r.dataset==='funnels'&&['shopify_human_public_landing_pages','shopify_human_us_public_landing_pages'].includes(r.definition)&&['human_public_landing_page_sessions','human_us_public_landing_page_sessions'].includes(r.population??'')))return rows.every(r=>Number.isFinite(Date.parse(r.start!))&&Number.isFinite(Date.parse(r.end!))&&Date.parse(r.start!)>=start&&Date.parse(r.end!)<=end&&Date.parse(r.start!)<Date.parse(r.end!));
 const intervals=rows.map(r=>[Date.parse(r.start!),Date.parse(r.end!)]).sort((a,b)=>a[0]-b[0]);let cursor=start;
 for(const [a,b] of intervals){if(!Number.isFinite(a)||!Number.isFinite(b)||a<start||b>end||a>=b||a>cursor)return false;cursor=Math.max(cursor,b);}
 return cursor===end;
}
export function preferredObservations(rows:Observation[],options?:PreferenceOptions):Observation[] {
 // Only the verified Shopify session family can arbitrate its hourly and daily
 // contracts. Other providers retain their existing historical/live precedence.
 const unique=new Map<string,Observation>();
 for(const r of rows)if(shopifySessions(r)&&r.quality==='complete'){
  const key=JSON.stringify([family(r),r.start,r.end,Object.entries(r.dimensions??{}).sort()]),old=unique.get(key);
  if(!old||(r.retrievedAt??'')>(old.retrievedAt??''))unique.set(key,r);
 }
 let selected=rows.filter(r=>!shopifySessions(r)||r.quality!=='complete'||unique.get(JSON.stringify([family(r),r.start,r.end,Object.entries(r.dimensions??{}).sort()]))===r);
 if(options){
  const groups=new Map<string,Observation[]>();for(const r of selected)if(shopifySessions(r)){const key=family(r),group=groups.get(key);if(group)group.push(r);else groups.set(key,[r]);}
  const keep=new Set<Observation>();
  for(const group of groups.values()){
   const hourly=group.filter(r=>r.start&&r.end&&r.quality==='complete'),daily=group.filter(r=>!r.start&&!r.end);
   const partial=options.partial&&(!options.partialDates||options.partialDates.includes(group[0].date));
   const useHourly=hourly.length>0&&(partial||fullDay(hourly,options.timezone));
   for(const r of useHourly?hourly:daily.length?daily:group)keep.add(r);
  }
  selected=selected.filter(r=>!shopifySessions(r)||keep.has(r));
 }
 const live=new Set(selected.filter(r=>r.quality!=='historical'&&(!shopifySessions(r)||!r.start)).map(r=>`${r.date}:${r.dataset}:${r.metric}`));
 const sessionLive=new Set(selected.filter(r=>shopifySessions(r)&&r.quality!=='historical'&&(options||!r.start)).map(family));
 return selected.filter(r=>r.quality!=='historical'||!(shopifySessions(r)?sessionLive.has(family(r)):live.has(`${r.date}:${r.dataset}:${r.metric}`)));
}
