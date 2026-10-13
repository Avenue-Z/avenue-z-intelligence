import {sourceMarket} from '../sources/kind-patches';
import {getStore,requireClientAccess} from './access';
import {workspacePresentation} from '../analytics/presentation';
import {queryClient} from '../analytics/query';
import {todayIn,shiftDate,comparisonPeriod} from '../analytics/windows';
import {initialReportingDate} from '../analytics/reporting-date';
import type {AccessScope,QueryFilters} from '../analytics/contracts';
import {serverSecret} from './secrets';
import {withAnalyticsMemory} from './analytics-memory';
import {bridgedWorkspace} from './company-workspace-bridge';
import {authorize} from './policy';
import {preparedWorkspaceFrame} from './prepared-workspace-cache';
import {workspaceDatasets,workspaceObservationSelection} from '../analytics/workspace-datasets';
import {workspaceReviewIndex} from '../reviews/index';
export {workspaceDatasets} from '../analytics/workspace-datasets';
export function workspaceSearchParams(input:Record<string,string|string[]|undefined>){const p=new URLSearchParams();for(const [key,value]of Object.entries(input))if(value!==undefined)p.set(key,Array.isArray(value)?value[0]:value);return p;}
export function parseFilters(p:URLSearchParams):QueryFilters {
 const today=todayIn('America/New_York'),live=p.get('period')==='today'||!p.has('from')&&!p.has('to')&&p.get('mode')!=='closed',fallback=live?today:shiftDate(today,-1),date=(key:string,defaultDate=fallback)=>{const v=p.get(key)||defaultDate;if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||Number.isNaN(Date.parse(v)))throw new Error('Invalid date');shiftDate(v,0);return v;},from=live?today:date('from'),to=live?today:date('to');if(from>to||Date.parse(to)-Date.parse(from)>61*86400000)throw new Error('Choose a range of up to 62 days');
 const compare=['previous','weekday','fourWeeks','thirtyDays','custom'].includes(p.get('compare')??'')?p.get('compare') as QueryFilters['compare']:'previous';
 const f:QueryFilters={from,to,compare,...live?{period:'today' as const}:{},mode:live||p.get('mode')==='partial'?'partial':'closed',view:p.get('view')==='funnels'?'traffic':p.get('view')||'overview',market:p.get('market')?sourceMarket(p.get('market')):'',stream:p.get('stream')||'',source:p.get('source')||'',device:p.get('device')||'',page:p.get('page')||''};
 if(compare==='custom'){f.compareFrom=date('compareFrom',shiftDate(from,-(Math.round((Date.parse(to)-Date.parse(from))/86400000)+1)));if(p.get('compareTo'))f.compareTo=date('compareTo');const c=comparisonPeriod(f);f.compareTo=c.to;}return f;
}
export async function loadWorkspace(p:URLSearchParams):Promise<Awaited<ReturnType<typeof loadWorkspaceForScope>>>{
 const scope=await requireClientAccess(p.get('clientId')||undefined);
 validateWorkspaceQuery(p);
 const remote=await bridgedWorkspace(scope,p);
 return remote??loadWorkspaceForScope(p,scope);
}
function validateWorkspaceQuery(p:URLSearchParams){
 const filters=parseFilters(p);
 if(p.has('drill')&&(p.get('drill')!=='traffic-page'||!p.get('clientId')||filters.view!=='traffic'||!filters.page))throw Error('Invalid workspace drill');
 return filters;
}
export async function loadWorkspaceForScope(p:URLSearchParams,scope:AccessScope){
 authorize(scope,p.get('clientId')||undefined);
 return loadWorkspaceWithinBudget(p,scope);
}
async function loadWorkspaceWithinBudget(p:URLSearchParams,scope:AccessScope){
 const focusedClientId=p.get('clientId')||undefined,s=getStore(),filters=validateWorkspaceQuery(p);
 if(focusedClientId&&!scope.permittedClientIds.includes(focusedClientId))throw Error('Client access denied');
 const clients=(await s.clients(scope.organizationId)).filter(c=>scope.permittedClientIds.includes(c.id));
 if(focusedClientId&&!clients.some(client=>client.id===focusedClientId))throw Error('Client unavailable');
 const focusedClient=clients.find(client=>client.id===focusedClientId);
 if(focusedClient&&(filters.period==='today'||!p.has('from')&&!p.has('to'))){const today=todayIn(focusedClient.timezone);filters.from=filters.to=filters.mode==='partial'?today:shiftDate(today,-1);}
 const connections=await Promise.all(clients.map(c=>s.connections(scope.organizationId,c.id)));let reportingDate:string|null=null;
 if(!p.has('from')&&!p.has('to')&&p.get('period')!=='today'&&!connections.some(rows=>rows.some(c=>c.enabled))){
  filters.mode='closed';delete filters.period;filters.from=filters.to=shiftDate(todayIn(focusedClient?.timezone??'America/New_York'),-1);
  const history=await withAnalyticsMemory(()=>Promise.all(clients.map(c=>s.observations(scope.organizationId,c.id,undefined,true))));
  reportingDate=initialReportingDate(p,history.map((rows,i)=>({rows,connections:connections[i]})),filters.to);if(reportingDate){filters.from=reportingDate;filters.to=reportingDate;}
 }
 const all=await Promise.all(clients.map(async(client,i)=>{
  const fullReviews=p.get('section')==='reviews'||filters.view==='reviews'&&focusedClientId===client.id;
  const clientFilters=filters.period==='today'?{...filters,from:todayIn(client.timezone),to:todayIn(client.timezone)}:filters;
  const preparedDatasets=focusedClientId?(client.id===focusedClientId?workspaceDatasets(filters.view):['overview']):['overview','subscriptions','subscriptionEvents'];
  const selection={...workspaceObservationSelection(preparedDatasets),...(p.get('drill')==='traffic-page'&&client.id===focusedClientId?{dimensions:true}:{})};
  const [frame,findings,reviews,note,lastJob]=await Promise.all([preparedWorkspaceFrame({store:s,organizationId:scope.organizationId,client,filters:clientFilters,preparedDatasets,selection},async freshConnections=>{
   const rows=await s.observations(scope.organizationId,client.id,clientFilters,false,undefined,selection);
   return workspacePresentation(queryClient(client,rows,freshConnections,clientFilters,{preparedDatasets}),clientFilters);
  }),s.findings(scope.organizationId,client.id),s.reviews(scope.organizationId,client.id),s.note(scope.organizationId,client.id),s.first('SELECT storeDate,mode,status,completedAt,error FROM scheduled_reviews WHERE organizationId=? AND clientId=? ORDER BY dueAt DESC LIMIT 1',scope.organizationId,client.id)]);
  return {...frame,...({browserScopeKey:JSON.stringify([scope.organizationId,scope.actorId,scope.role,[...scope.permittedClientIds].sort()])} as {browserScopeKey?:string}),...({reviewsIndexOnly:!fullReviews} as {reviewsIndexOnly?:boolean}),findings,reviews:fullReviews?reviews:reviews.map(workspaceReviewIndex),note,scheduleState:{active:serverSecret('APP_SCHEDULER_ACTIVE')==='true',waitingForSources:!connections[i].some(c=>c.enabled),lastJob:lastJob??undefined}};
 }));
 return {scope,filters,...focusedClientId?{focusedClientId}:{},clients:all,reportingDateNote:reportingDate?`Latest available closed reporting day · ${reportingDate}`:null,jobs:(await s.jobs(scope.organizationId)).filter(j=>scope.permittedClientIds.includes(j.clientId)),loadedAt:new Date().toISOString()};
}
export type Workspace=Awaited<ReturnType<typeof loadWorkspaceForScope>>;
