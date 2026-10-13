import {runtimePlatform} from '@avenue/runtime';
import type {AccessScope,QueryFilters} from '../analytics/contracts';
import {shiftDate,todayIn} from '../analytics/windows';
import {liveReportingDate} from '../analytics/reporting-date';
import {workspaceDatasets,workspaceObservationSelection} from '../analytics/workspace-datasets';
import {queryClient} from '../analytics/query';
import {workspacePresentation} from '../analytics/presentation';
import {preparedWorkspaceFrame} from './prepared-workspace-cache';
import type {Store} from './store';

/** Warm one changed client after its source jobs have already completed.
 * The scheduler identity and stored job ownership define scope, not a browser.
 */
export async function warmSuccessfulSourceJobs(store:Store,scope:AccessScope,jobIds:string[],deadline:number){
 const result={attempted:0,completed:0};
 if(!jobIds.length||Date.now()+40000>=deadline)return result;
 try{
  const changed=await store.all<{clientId:string}>(`SELECT DISTINCT clientId FROM jobs WHERE organizationId=? AND status='complete' AND id IN (${jobIds.map(()=>'?').join(',')})`,scope.organizationId,...jobIds);
  const client=(await store.clients(scope.organizationId)).filter(c=>scope.permittedClientIds.includes(c.id)&&changed.some(job=>job.clientId===c.id)).sort((a,b)=>Number(b.id==='kind-patches')-Number(a.id==='kind-patches')||a.id.localeCompare(b.id))[0];
  if(!client)return result;
  // Missing migration: warming does no source work. Browser reads still fail
  // open through the ordinary Store path until the migration is installed.
  await store.first('SELECT cacheKey FROM observation_cache_entries WHERE organizationId=? AND clientId=? LIMIT 1',scope.organizationId,client.id);
  const native=runtimePlatform==='vercel';
  if(native)await store.first('SELECT cacheKey FROM prepared_workspace_cache WHERE organizationId=? AND clientId=? LIMIT 1',scope.organizationId,client.id);
  const liveConnections=await store.connections(scope.organizationId,client.id);
  const today=todayIn(client.timezone),base={compare:'previous',view:'overview',market:'',stream:'',source:'',device:'',page:''} as const;
  // Match the exact dataset selection used by foreground workspace reads.
  // Live follows each view's latest completed store hour. Warm every live
  // tab for that comparison before alternate comparisons or historical ranges.
  const primary=['previous','fourWeeks'] as const,secondary=['weekday','thirtyDays'] as const;
  const selections:QueryFilters[]=[];
  for(const compare of ['previous','weekday'] as const)for(const view of ['revenue','overview','media','markets','subscriptions','products','traffic','reviews','settings']){const date=liveReportingDate(liveConnections,view,client.timezone);selections.push({...base,compare,view,from:date,to:date,mode:'partial'});}
  if(native){const date=shiftDate(today,-1);selections.push({...base,view:'traffic',from:date,to:date,mode:'closed'},{...base,view:'overview',from:date,to:date,mode:'closed'},...([7,30] as const).map(days=>({...base,view:'traffic',from:shiftDate(date,-(days-1)),to:date,mode:'closed' as const})));}
  for(const mode of ['closed','partial'] as const)for(const comparisons of [primary,secondary])for(const view of ['traffic','overview'])for(const compare of comparisons){const date=mode==='closed'?shiftDate(today,-1):liveReportingDate(liveConnections,view,client.timezone);selections.push({...base,view,compare,from:date,to:date,mode});}

  const seen=new Set<string>();
  for(const filters of selections){
   const key=JSON.stringify(filters);if(seen.has(key))continue;seen.add(key);
   if(Date.now()+40000>=deadline)break;
   result.attempted++;
   const selection=workspaceObservationSelection(filters.view);
   if(native){const preparedDatasets=workspaceDatasets(filters.view);await preparedWorkspaceFrame({store,organizationId:scope.organizationId,client,filters,preparedDatasets,selection,deadline},async(connections,canonicalFilters)=>{
    const rows=await store.observations(scope.organizationId,client.id,canonicalFilters,false,{deadline},selection);
    if(Date.now()>=deadline)throw Error('Prepared frame warm budget elapsed');
    const frame=workspacePresentation(queryClient(client,rows,connections,canonicalFilters,{preparedDatasets}),canonicalFilters);
    if(Date.now()>=deadline)throw Error('Prepared frame warm budget elapsed');return frame;
   });}
   else await store.observations(scope.organizationId,client.id,filters,false,{deadline},selection);
   if(Date.now()>=deadline)break;result.completed++;
  }
 }catch{/* Derived cache failures cannot change source job state. */}
 return result;
}
