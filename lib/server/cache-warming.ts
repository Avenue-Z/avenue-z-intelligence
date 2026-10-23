import {runtimePlatform} from '@avenue/runtime';
import type {AccessScope,QueryFilters} from '../analytics/contracts';
import {shiftDate,todayIn} from '../analytics/windows';
import {liveReportingDate} from '../analytics/reporting-date';
import {workspaceDatasets,workspaceObservationSelection} from '../analytics/workspace-datasets';
import {portfolioDatasets,portfolioObservationSelection,compactPortfolioPresentation} from '../analytics/portfolio-scope';
import {queryClient} from '../analytics/query';
import {workspacePresentation} from '../analytics/presentation';
import {preparedWorkspaceFrame} from './prepared-workspace-cache';
import {withAnalyticsMemory} from './analytics-memory';
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
  const selections:(QueryFilters&{portfolio?:true})[]=[];
  if(native){const date=liveReportingDate(liveConnections,'overview',client.timezone);selections.push({...base,from:date,to:date,mode:'partial',portfolio:true});}
  for(const compare of ['previous','weekday'] as const)for(const view of client.id==='beam'||client.config.subscriptionsEnabled===false?['overview','revenue','traffic','media','markets','products','reviews','settings']:['revenue','overview','media','markets','subscriptions','products','traffic','reviews','settings']){const date=liveReportingDate(liveConnections,view,client.timezone);selections.push({...base,compare,view,from:date,to:date,mode:'partial'});}
  if(native){const date=shiftDate(today,-1);selections.push({...base,view:'traffic',from:date,to:date,mode:'closed'},{...base,view:'overview',from:date,to:date,mode:'closed'},...([7,30] as const).map(days=>({...base,view:'traffic',from:shiftDate(date,-(days-1)),to:date,mode:'closed' as const})));}
  for(const mode of ['closed','partial'] as const)for(const comparisons of [primary,secondary])for(const view of ['traffic','overview'])for(const compare of comparisons){const date=mode==='closed'?shiftDate(today,-1):liveReportingDate(liveConnections,view,client.timezone);selections.push({...base,view,compare,from:date,to:date,mode});}

  const seen=new Set<string>();let landingPages:QueryFilters[]=[];
  for(let index=0;index<selections.length;index++){
   const {portfolio,...filters}=selections[index];
   const key=JSON.stringify(portfolio?[filters,portfolioDatasets(client.id)]:filters);if(seen.has(key))continue;seen.add(key);
   // Prepared storage keeps 32 frames. Prioritize common drawers ahead of
   // secondary comparisons without evicting the primary live tabs just warmed.
   if(Date.now()+40000>=deadline||native&&result.attempted>=32)break;
   // Current-hour publication owns database capacity. A separate cache cron
   // can outlive the idle window in which it started, so recheck before every
   // optional frame and let the next normal tick resume warming after ingestion.
   if(native&&await store.first("SELECT j.id FROM jobs j JOIN connections c ON c.id=j.sourceId AND c.organizationId=j.organizationId AND c.clientId=j.clientId WHERE j.organizationId=? AND j.clientId=? AND c.enabled=1 AND j.id NOT LIKE '%:hourly-history:____-__-__' AND j.status IN ('pending','running') AND j.dueAt<=? LIMIT 1",scope.organizationId,client.id,new Date().toISOString()))break;
   result.attempted++;
   const preparedDatasets=portfolio?portfolioDatasets(client.id):filters.page?['traffic','funnels']:workspaceDatasets(filters.view,client.id);
   const selection=portfolio?portfolioObservationSelection(client.id):filters.page?{datasets:preparedDatasets,dimensions:true,includePriorWeek:false,includeOperations:false,trendDatasets:[]}:workspaceObservationSelection(preparedDatasets,client.id);
   // A ready browser frame can precede the native tick. Prepare immutable
   // chart days once here even when that full prepared frame is already ready.
   const trendDeadline=Math.min(deadline,Date.now()+60000);
   if(native&&filters.view==='traffic'&&filters.mode==='partial'&&filters.compare==='previous'&&!filters.page)await withAnalyticsMemory(async()=>{await store.observations(scope.organizationId,client.id,filters,false,{deadline:trendDeadline},selection);if(Date.now()>=trendDeadline)throw Error('Observation cache warm budget elapsed');});
   if(native){const frame=await preparedWorkspaceFrame({store,organizationId:scope.organizationId,client,filters,preparedDatasets,selection,deadline},async(connections,canonicalFilters)=>{
    const rows=await store.observations(scope.organizationId,client.id,canonicalFilters,false,{deadline},selection);
    if(Date.now()>=deadline)throw Error('Prepared frame warm budget elapsed');
    const frame=workspacePresentation(queryClient(client,rows,connections,canonicalFilters,{preparedDatasets}),canonicalFilters);
    if(Date.now()>=deadline)throw Error('Prepared frame warm budget elapsed');return portfolio?compactPortfolioPresentation(frame):frame;
   });
    if(filters.view==='traffic'&&filters.mode==='partial'&&filters.compare==='previous'&&!filters.page){
     const pages=[...new Set((frame.trafficExplorer?.current.pages??[]).filter(page=>page.label.startsWith('/')&&!page.label.includes('[private]')&&!page.label.includes('[invalid]')&&typeof page.metrics.sessions==='number'&&Number.isFinite(page.metrics.sessions)&&page.metrics.sessions>0).map(page=>page.label))].slice(0,3);
     landingPages=pages.map(page=>({...filters,page}));
    }
    // Finish every primary live tab before optional page details. They use
    // precisely the existing drawer selection and source-aware prepared key.
    if(filters.view==='settings'&&filters.mode==='partial'&&filters.compare==='previous')selections.splice(index+1,0,...landingPages);
   }
   else await store.observations(scope.organizationId,client.id,filters,false,{deadline},selection);
   if(Date.now()>=deadline)break;result.completed++;
  }
 }catch{/* Derived cache failures cannot change source job state. */}
 return result;
}
