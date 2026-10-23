import type {Ga4Dashboard,Ga4DashboardGroup,Ga4Summary} from '../analytics/ga4-dashboard';
import type {QueryFilters} from '../analytics/contracts';
import {ga4Profile,type Ga4ClientId} from '../analytics/ga4-profile';
import {ga4PageLabel} from '../analytics/ga4-page-privacy';

const families=['pages','sources','markets','devices'] as const;
const normalized=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const countries=new Intl.DisplayNames(['en'],{type:'region',fallback:'code'});
const summary=(value:Ga4Summary):Ga4Summary=>({sessions:value.sessions,engagedSessions:value.engagedSessions,purchases:value.purchases,revenue:value.revenue});
const group=(value:Ga4DashboardGroup):Ga4DashboardGroup=>({label:value.label,current:summary(value.current),previous:summary(value.previous)});
function matchingScore(label:string,question:string,market:boolean){
 const values=[label,...market&&/^[A-Z]{2}$/.test(label)?[countries.of(label)??label]:[]],query=normalized(question),words=new Set(query.split(' '));
 return Math.max(...values.map(value=>{const text=normalized(value);if(text.length>=2&&(` ${query} `).includes(` ${text} `))return 100+text.split(' ').length;return text.split(' ').filter(word=>word.length>=4&&!['pages','page','products','product','source'].includes(word)&&words.has(word)).length;}));
}

/** A bounded projection of the exact cached dashboard. Never infer session
 * conversions, MER, Shopify sales, or totals from retained group previews. */
export function buildGa4AIView(frame:Ga4Dashboard|null,filters:QueryFilters,question:string,completeGroups=false,clientId:Ga4ClientId='beam'){
 const profile=ga4Profile(clientId),sourceId=`ga4:${clientId}` as const,scope={filters:{...filters,page:ga4PageLabel(filters.page),view:'ga4',from:frame?.from??filters.from,to:frame?.to??filters.to},propertyId:profile.propertyId,streamId:profile.streamId,timezone:profile.timezone,currency:profile.currency,from:frame?.from??filters.from,to:frame?.to??filters.to,comparison:frame?.comparison??null,latestCapturedAt:frame?.latestCapturedAt??null,matchedThroughHour:frame?.matchedThroughHour??null};
 if(!frame)return {available:false as const,sourceId,scope,instruction:'Cached GA4 dashboard data is unavailable for this authorized selection. Do not invent GA4 figures or substitute legacy selectedView observations for GA4 coverage.'};
 const selected=Object.fromEntries(families.map(family=>{
  const ranked=frame[family].map((value,index)=>{const score=matchingScore(value.label,question,family==='markets');return {value,index,score,match:score>0};}).sort((a,b)=>(b.value.current.sessions??b.value.previous.sessions??-1)-(a.value.current.sessions??a.value.previous.sessions??-1)||a.index-b.index);
  const matched=ranked.filter(item=>item.match).sort((a,b)=>b.score-a.score||a.index-b.index),retained=new Set<number>();
  // Exact named labels reserve space before the top-volume and loose matches.
  for(const item of completeGroups?ranked:[...matched.filter(item=>item.score>=100),...ranked.slice(0,20),...matched]){if(!completeGroups&&retained.size===30)break;retained.add(item.index);}
  const items=ranked.filter(item=>retained.has(item.index)).map(item=>({...item,value:group(item.value),bytes:new TextEncoder().encode(JSON.stringify(item.value)).byteLength}));
  return [family,{groupCount:frame.groupCounts?.[family]??ranked.length,backendReturnedGroupCount:ranked.length,questionMatchCount:ranked.filter(item=>item.match).length,items}];
 })) as Record<typeof families[number],{groupCount:number;backendReturnedGroupCount:number;questionMatchCount:number;items:{value:Ga4DashboardGroup;index:number;match:boolean;score:number;bytes:number}[]}>;
 const cut=(family:typeof families[number])=>{const value=selected[family];return {groupCount:value.groupCount,backendReturnedGroupCount:value.backendReturnedGroupCount,backendOmitted:Math.max(0,value.groupCount-value.backendReturnedGroupCount),returnedGroupCount:value.items.length,omitted:value.groupCount-value.items.length,questionMatchCount:value.questionMatchCount,returnedQuestionMatches:value.items.filter(item=>item.match).length,groups:value.items.map(item=>item.value)};};
 const result=()=>({available:true as const,sourceId,scope,current:summary(frame.current),previous:summary(frame.previous),daily:frame.daily.slice(-30).map(point=>({date:point.date,comparisonDate:point.comparisonDate,current:summary(point.current),previous:summary(point.previous)})),coverage:{...frame.coverage,missingDates:[...frame.coverage.missingDates]},quality:{...frame.quality},pages:cut('pages'),sources:cut('sources'),markets:cut('markets'),devices:cut('devices'),instruction:'ga4View is the exact currently displayed GA4 data for scope.filters and its captured timestamp. Its purchases and revenue are GA4-attributed, never Shopify orders or business net sales. Current and previous retain the displayed comparison dates. For multi-day periods, earlier dates are full days and only the final current/comparison dates use exclusive matchedThroughHour. Separately, all supplied daily chart dates retain that same matched-hour cutoff. Null is unavailable; captured zero remains zero. Never calculate session CVR or MER from these metrics. Legacy selectedView numeric rows and warnings are not GA4 coverage. Each retained group is a complete filtered aggregate; groupCount and omitted include backend and AI preview omissions, not missing source data. Question matches were checked only among backend-returned groups. Never sum these previews into totals or claim omitted groups were checked. Cite sourceId.'});
 let view=result();
 while(!completeGroups&&new TextEncoder().encode(JSON.stringify(view)).byteLength>30000){
  const candidates=families.flatMap(family=>selected[family].items.map((item,index)=>({family,index,score:item.score,bytes:item.bytes}))).sort((a,b)=>a.score-b.score||b.bytes-a.bytes);
  if(!candidates.length)break;const remove=candidates[0];selected[remove.family].items.splice(remove.index,1);view=result();
 }
 return view;
}
export type Ga4AIView=ReturnType<typeof buildGa4AIView>;
