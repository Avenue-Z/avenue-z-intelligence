import {getStore,requireClientAccess} from './access';
import {workspacePresentation} from '../analytics/presentation';
import {queryClient} from '../analytics/query';
import {todayIn,shiftDate} from '../analytics/windows';
import {initialReportingDate} from '../analytics/reporting-date';
import type {QueryFilters} from '../analytics/contracts';
import {serverSecret} from './secrets';
export function workspaceSearchParams(input:Record<string,string|string[]|undefined>){const p=new URLSearchParams();for(const [key,value]of Object.entries(input))if(value!==undefined)p.set(key,Array.isArray(value)?value[0]:value);return p;}
export function parseFilters(p:URLSearchParams):QueryFilters {const yesterday=shiftDate(todayIn('America/New_York'),-1);const date=(key:string)=>{const v=p.get(key)||yesterday;if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||Number.isNaN(Date.parse(v)))throw new Error('Invalid date');return v;};const from=date('from'),to=date('to');if(from>to||Date.parse(to)-Date.parse(from)>61*86400000)throw new Error('Choose a range of up to 62 days');return {from,to,compare:['previous','weekday','fourWeeks'].includes(p.get('compare')??'')?p.get('compare') as QueryFilters['compare']:'previous',mode:p.get('mode')==='partial'?'partial':'closed',view:p.get('view')||'overview',market:p.get('market')||'',stream:p.get('stream')||'',source:p.get('source')||'',device:p.get('device')||'',page:p.get('page')||''};}
export async function loadWorkspace(p:URLSearchParams){
 const scope=await requireClientAccess(),s=getStore(),filters=parseFilters(p),clients=(await s.clients(scope.organizationId)).filter(c=>scope.permittedClientIds.includes(c.id));
 const connections=await Promise.all(clients.map(c=>s.connections(scope.organizationId,c.id)));let reportingDate:string|null=null;
 if(!p.has('from')&&!p.has('to')&&filters.mode==='closed'&&!connections.some(rows=>rows.some(c=>c.enabled))){
  const history=await Promise.all(clients.map(c=>s.observations(scope.organizationId,c.id,undefined,true)));
  reportingDate=initialReportingDate(p,history.map((rows,i)=>({rows,connections:connections[i]})),filters.to);if(reportingDate){filters.from=reportingDate;filters.to=reportingDate;}
 }
 const all=await Promise.all(clients.map(async(client,i)=>{const [rows,findings,reviews,note,lastJob]=await Promise.all([s.observations(scope.organizationId,client.id,filters),s.findings(scope.organizationId,client.id),s.reviews(scope.organizationId,client.id),s.note(scope.organizationId,client.id),s.first('SELECT storeDate,mode,status,completedAt,error FROM scheduled_reviews WHERE organizationId=? AND clientId=? ORDER BY dueAt DESC LIMIT 1',scope.organizationId,client.id)]);return {...workspacePresentation(queryClient(client,rows,connections[i],filters,{prepareAllViews:true}),filters),findings,reviews,note,scheduleState:{active:serverSecret('APP_SCHEDULER_ACTIVE')==='true',waitingForSources:!connections[i].some(c=>c.enabled),lastJob:lastJob??undefined}};}));
 return {scope,filters,clients:all,reportingDateNote:reportingDate?`Latest available closed reporting day · ${reportingDate}`:null,jobs:(await s.jobs(scope.organizationId)).filter(j=>scope.permittedClientIds.includes(j.clientId)),loadedAt:new Date().toISOString()};
}
export type Workspace=Awaited<ReturnType<typeof loadWorkspace>>;
