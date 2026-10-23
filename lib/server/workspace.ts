import {sourceMarket} from '../sources/kind-patches';
import {getStore,requireClientAccess} from './access';
import {workspacePresentation} from '../analytics/presentation';
import {queryClient} from '../analytics/query';
import {ga4Profile,isGa4Client} from '../analytics/ga4-profile';
import {parseGa4DashboardFilters} from '../analytics/ga4-dashboard';
import {parseNorthbeamViewFilters} from '../analytics/northbeam-view';
import {isClientReportView} from '../analytics/client-feature-policy';
import {todayIn,shiftDate,comparisonPeriod} from '../analytics/windows';
import {initialReportingDate,liveReportingDate} from '../analytics/reporting-date';
import type {AccessScope,Client,QueryFilters} from '../analytics/contracts';
import {serverSecret} from './secrets';
import {withAnalyticsMemory} from './analytics-memory';
import {bridgedWorkspace} from './company-workspace-bridge';
import {authorize} from './policy';
import {preparedWorkspaceFrame} from './prepared-workspace-cache';
import {workspaceDatasets,workspaceObservationSelection} from '../analytics/workspace-datasets';
import {workspaceReviewIndex} from '../reviews/index';
import {isPortfolioScope,canonicalPortfolioFilters,compactPortfolioMediaReports,portfolioReviewSummaries,portfolioDatasets,portfolioObservationSelection,compactPortfolioPresentation} from '../analytics/portfolio-scope';
export {workspaceDatasets} from '../analytics/workspace-datasets';
export function workspaceSearchParams(input:Record<string,string|string[]|undefined>){const p=new URLSearchParams();for(const [key,value]of Object.entries(input))if(value!==undefined)p.set(key,Array.isArray(value)?value[0]:value);return p;}
export function parseFilters(p:URLSearchParams):QueryFilters {
 const today=todayIn('America/New_York'),live=p.get('period')==='today'||!p.has('from')&&!p.has('to')&&p.get('mode')!=='closed',fallback=live?today:shiftDate(today,-1),date=(key:string,defaultDate=fallback)=>{const v=p.get(key)||defaultDate;if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||Number.isNaN(Date.parse(v)))throw new Error('Invalid date');shiftDate(v,0);return v;},from=live?today:date('from'),to=live?today:date('to');if(from>to||Date.parse(to)-Date.parse(from)>61*86400000)throw new Error('Choose a range of up to 62 days');
 const compare=['previous','weekday','fourWeeks','thirtyDays','custom'].includes(p.get('compare')??'')?p.get('compare') as QueryFilters['compare']:'previous';
 const f:QueryFilters={from,to,compare,...live?{period:'today' as const}:{},mode:live||p.get('mode')==='partial'?'partial':'closed',view:p.get('view')==='funnels'?'traffic':p.get('view')||'overview',market:p.get('market')?sourceMarket(p.get('market')):'',stream:p.get('stream')||'',source:p.get('source')||'',device:p.get('device')||'',page:p.get('page')||''};
 if(compare==='custom'){f.compareFrom=date('compareFrom',shiftDate(from,-(Math.round((Date.parse(to)-Date.parse(from))/86400000)+1)));if(p.get('compareTo'))f.compareTo=date('compareTo');const c=comparisonPeriod(f);f.compareTo=c.to;}return f;
}
export async function loadWorkspace(p:URLSearchParams):Promise<Awaited<ReturnType<typeof loadWorkspaceForScope>>>{
 const started=Date.now();console.info('Workspace read phase',{phase:'access-start',drill:p.get('drill')==='traffic-page'});
 const scope=await requireClientAccess(p.get('clientId')||undefined);
 console.info('Workspace read phase',{phase:'access-complete',ms:Date.now()-started});
 validateWorkspaceQuery(p);
 const remote=await bridgedWorkspace(scope,p);
 const result=remote??await loadWorkspaceForScope(p,scope);
 if(result.navigationClients!==undefined&&(!Array.isArray(result.navigationClients)||result.navigationClients.some(client=>!result.scope.permittedClientIds.includes(client.id))))throw Error('Company workspace access changed. Please reload.');
 console.info('Workspace read phase',{phase:'analytics-complete',ms:Date.now()-started});return result;
}
function validateWorkspaceQuery(p:URLSearchParams){
 const clientId=p.get('clientId');let filters:QueryFilters;
 if(p.get('view')==='northbeam'&&clientId!=='autobrush')throw Error('Attribution is available only for Autobrush');
 if(p.get('view')==='northbeam'&&clientId==='autobrush')filters=parseNorthbeamViewFilters(p);
 else if(p.get('view')==='ga4'&&isGa4Client(clientId)){
  const now=Date.now(),selection=new URLSearchParams(p);
  // A bare workspace opens live or on yesterday; report API defaults stay separate.
  if(!p.has('from')&&!p.has('to')&&p.getAll('period').length<=1){
   if(p.get('period')==='today'||p.get('mode')!=='closed')selection.set('period','today');
   else {const yesterday=shiftDate(todayIn(ga4Profile(clientId).timezone,new Date(now)),-1);selection.set('from',yesterday);selection.set('to',yesterday);}
  }
  filters=parseGa4DashboardFilters(selection,now,clientId);
 }else filters=parseFilters(p);
 if(p.has('drill')&&(p.get('drill')!=='traffic-page'||!isPortfolioScope(p)&&(!p.get('clientId')||filters.view!=='traffic'||!filters.page)))throw Error('Invalid workspace drill');
 return filters;
}
export async function loadWorkspaceForScope(p:URLSearchParams,scope:AccessScope){
 authorize(scope,p.get('clientId')||undefined);
 return loadWorkspaceWithinBudget(p,scope);
}
async function loadWorkspaceWithinBudget(p:URLSearchParams,scope:AccessScope){
 const focusedClientId=p.get('clientId')||undefined,s=getStore(),portfolio=isPortfolioScope(p),requested=validateWorkspaceQuery(p),filters=portfolio?canonicalPortfolioFilters(requested):requested,pageDrill=!portfolio&&p.get('drill')==='traffic-page',globalFindings=!focusedClientId&&p.get('section')==='findings';
 if(focusedClientId&&!scope.permittedClientIds.includes(focusedClientId))throw Error('Client access denied');
 const navigationClients=(await s.clients(scope.organizationId)).filter(c=>scope.permittedClientIds.includes(c.id));
 const clients=focusedClientId?navigationClients.filter(client=>client.id===focusedClientId):navigationClients;
 if(focusedClientId&&!clients.some(client=>client.id===focusedClientId))throw Error('Client unavailable');
 const focusedClient=clients.find(client=>client.id===focusedClientId),providerReport=isClientReportView(focusedClientId,filters.view);
 const connections=await Promise.all(clients.map(c=>s.connections(scope.organizationId,c.id)));let reportingDate:string|null=null;
 if(!providerReport&&focusedClient&&(filters.period==='today'||!p.has('from')&&!p.has('to'))){const today=todayIn(focusedClient.timezone),focusedConnections=connections[clients.indexOf(focusedClient)];filters.from=filters.to=filters.mode==='partial'?liveReportingDate(focusedConnections,filters.view,focusedClient.timezone):shiftDate(today,-1);}
 if(!providerReport&&!p.has('from')&&!p.has('to')&&p.get('period')!=='today'&&!connections.some(rows=>rows.some(c=>c.enabled))){
  filters.mode='closed';delete filters.period;filters.from=filters.to=shiftDate(todayIn(focusedClient?.timezone??'America/New_York'),-1);
  const history=await withAnalyticsMemory(()=>Promise.all(clients.map(c=>s.observations(scope.organizationId,c.id,undefined,true))));
  reportingDate=initialReportingDate(p,history.map((rows,i)=>({rows,connections:connections[i]})),filters.to);if(reportingDate){filters.from=reportingDate;filters.to=reportingDate;}
 }
 const all=await Promise.all(clients.map(async(client,i)=>{
  const fullReviews=p.get('section')==='reviews'||filters.view==='reviews'&&focusedClientId===client.id;
  const liveDate=!providerReport&&filters.period==='today'?liveReportingDate(connections[i],filters.view,client.timezone):null;
  const clientFilters=liveDate?{...filters,from:liveDate,to:liveDate}:filters;
  const preparedDatasets=pageDrill?['traffic','funnels']:focusedClientId?workspaceDatasets(filters.view,client.id):portfolio?portfolioDatasets(client.id):['overview','subscriptions','subscriptionEvents',...globalFindings?['funnels']:[]];
  // The drawer renders this page's selected/comparison funnel only. Keep the
  // main workspace's thirty-day chart context outside this scoped drill read.
  // The action queue needs qualified selected/comparison page evidence, not
  // the thirty-day page or UTM history used by interactive client charts.
  const selection=pageDrill?{datasets:preparedDatasets,dimensions:true,includePriorWeek:false,includeOperations:false,trendDatasets:[]}:portfolio?portfolioObservationSelection(client.id):globalFindings?{datasets:preparedDatasets,includePriorWeek:false,includeOperations:false,trendDatasets:[]}:workspaceObservationSelection(preparedDatasets,client.id);
  // Drawer consumers use only the scoped analytics frame. Avoid fetching the
  // saved-review archive or operations that are not rendered in that drawer.
  const portfolioMedia=portfolio&&(client.id==='beam'||client.id==='autobrush');
  const [frame,findings,reviews,note,lastJob,mediaRows]=await Promise.all([providerReport?Promise.resolve(workspacePresentation(queryClient(client,[],[],clientFilters,{preparedDatasets:[]}),clientFilters)):preparedWorkspaceFrame({store:s,organizationId:scope.organizationId,client,filters:clientFilters,preparedDatasets,selection,freshConnections:connections[i]},async(freshConnections,canonicalFilters)=>{
   const rows=await s.observations(scope.organizationId,client.id,canonicalFilters,false,undefined,selection);
   const presentation=workspacePresentation(queryClient(client,rows,freshConnections,canonicalFilters,{preparedDatasets}),canonicalFilters);
   return portfolio?compactPortfolioPresentation(presentation):presentation;
  }),pageDrill?Promise.resolve([]):s.findings(scope.organizationId,client.id),pageDrill?Promise.resolve([]):s.reviews(scope.organizationId,client.id,!fullReviews),pageDrill?Promise.resolve({body:''}):s.note(scope.organizationId,client.id),pageDrill?Promise.resolve(null):s.first('SELECT storeDate,mode,status,completedAt,error FROM scheduled_reviews WHERE organizationId=? AND clientId=? ORDER BY dueAt DESC LIMIT 1',scope.organizationId,client.id),portfolioMedia?s.observations(scope.organizationId,client.id,clientFilters,false,undefined,{datasets:['media'],includeOperations:false,includePriorWeek:false,trendDatasets:['media']}):Promise.resolve([])]);
  const indexedReviews=fullReviews?reviews:reviews.map(workspaceReviewIndex);
  return {...frame,...({resolvedFilters:{...clientFilters}} as {resolvedFilters?:QueryFilters}),...portfolioMedia?{portfolioMediaReports:compactPortfolioMediaReports(mediaRows)}:{},...({browserScopeKey:JSON.stringify([scope.organizationId,scope.actorId,scope.role,[...scope.permittedClientIds].sort()])} as {browserScopeKey?:string}),...({reviewsIndexOnly:!fullReviews} as {reviewsIndexOnly?:boolean}),findings,reviews:portfolio?portfolioReviewSummaries(indexedReviews,clientFilters):indexedReviews,note,scheduleState:{active:serverSecret('APP_SCHEDULER_ACTIVE')==='true',waitingForSources:!connections[i].some(c=>c.enabled),lastJob:lastJob??undefined}};
 }));
 const navigation:{navigationClients?:Client[]}={navigationClients};
 return {scope,filters,...focusedClientId?{focusedClientId}:{},...navigation,clients:all,reportingDateNote:reportingDate?`Latest available closed reporting day · ${reportingDate}`:null,jobs:pageDrill?[]:(await s.jobs(scope.organizationId)).filter(j=>scope.permittedClientIds.includes(j.clientId)&&(!focusedClientId||j.clientId===focusedClientId)),loadedAt:new Date().toISOString()};
}
export type Workspace=Awaited<ReturnType<typeof loadWorkspaceForScope>>;
