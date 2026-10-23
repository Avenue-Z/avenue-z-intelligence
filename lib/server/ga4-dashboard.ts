import {ga4Profile,type Ga4ClientId} from '../analytics/ga4-profile';
import {ga4AppConfig} from './ga4-profile-config';
import type {AccessScope} from '../analytics/contracts';
import {buildGa4Dashboard,parseGa4DashboardFilters} from '../analytics/ga4-dashboard';
import {comparisonPeriod,shiftDate,todayIn} from '../analytics/windows';
import {ga4CachedDays,loadGa4Reports} from './ga4-report-cache';
import type {Ga4ReportKind} from './ga4-report-cache';
import {authorize} from './policy';
import type {Store} from './store';
type Dependencies={scope:()=>Promise<AccessScope|null>;store:()=>Pick<Store,'all'>;secret:(key:string)=>string|null;now?:()=>number;completeGroups?:boolean};

const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, max-age=30','Vary':'Cookie','X-Content-Type-Options':'nosniff'};
function error(message:string,status:number){return Response.json({error:message},{status,headers:{...headers,'Cache-Control':'private, no-store'}});}
function ranges(input:[string,string][],first:string,last:string):[string,string][]{
 const clipped=input.map(([from,to]):[string,string]=>[from<first?first:from,to>last?last:to]).filter(([from,to])=>from<=to).sort(([a],[b])=>a.localeCompare(b)),result:[string,string][]=[];
 for(const [from,to]of clipped){const prior=result.at(-1);if(prior&&from<=shiftDate(prior[1],1)){if(to>prior[1])prior[1]=to;}else result.push([from,to]);}
 return result;
}

/** Reads only the organization-scoped GA report cache. Authorization and cheap
 * version metadata are checked on every request, including response-cache hits. */
export function createGa4DashboardHandler(deps:Dependencies,clientId:Ga4ClientId='beam'){
 const profile=ga4Profile(clientId),{propertyId,timezone}=profile;
 const now=deps.now??Date.now,responses=new Map<string,{expiresAt:number;body:string}>();
 return async(request:Request)=>{
  let scope:AccessScope;try{scope=authorize(await deps.scope(),clientId);}catch{return error(`${profile.name} access required`,403);}
  const nowMs=now();let filters;try{filters=parseGa4DashboardFilters(new URL(request.url).searchParams,nowMs,clientId);}catch{return error('Invalid GA4 report selection',400);}
  try{const config=ga4AppConfig(deps.secret,clientId);if(config.propertyId!==propertyId)throw Error();}catch{return error('GA4 reports are not configured',503);}
  try{
   const store=deps.store(),today=todayIn(timezone,new Date(nowMs)),first=shiftDate(today,-29),comparison=comparisonPeriod(filters);
   const metadata=await ga4CachedDays(store,scope.organizationId,propertyId,first,today);
   const hour=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date(nowMs));
   const versions=metadata.map(({storeDate,kind,capturedAt})=>[storeDate,kind,capturedAt]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
   const key=JSON.stringify([scope.organizationId,clientId,propertyId,profile.streamId,filters,today,hour,versions]),cached=responses.get(key);
   if(cached&&cached.expiresAt>nowMs){responses.delete(key);responses.set(key,cached);return new Response(cached.body,{headers});}
   if(cached)responses.delete(key);
   const offset=Math.round((Date.parse(comparison.from)-Date.parse(filters.from))/86400000),contextFrom=shiftDate(filters.to,-29);
   const context=ranges([[contextFrom,filters.to],[shiftDate(contextFrom,offset),comparison.to]],first,today);
   const filtered=!!(filters.market||filters.source||filters.device||filters.page),detail=filtered?context:ranges([[filters.from,filters.to],[comparison.from,comparison.to]],first,today);
   const read=(window:[string,string],kinds:Ga4ReportKind[])=>loadGa4Reports(store,scope.organizationId,propertyId,window[0],window[1],{kinds});
   const reports=metadata.length?(await Promise.all([...context.map(window=>read(window,['total','hourly'])),...detail.map(window=>read(window,['detail']))])).flat():[];
   const body=JSON.stringify(buildGa4Dashboard(reports,filters,{nowMs,availableDays:metadata,completeGroups:deps.completeGroups,clientId}));
   responses.set(key,{body,expiresAt:nowMs+30000});while(responses.size>8)responses.delete(responses.keys().next().value!);
   return new Response(body,{headers});
  }catch{return error('Cached GA4 reports are temporarily unavailable',503);}
 };
}
