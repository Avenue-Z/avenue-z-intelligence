import type {AccessScope,QueryFilters} from '../analytics/contracts';
import {shiftDate,todayIn} from '../analytics/windows';
import {workspaceObservationSelection} from '../analytics/workspace-datasets';
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
  const today=todayIn(client.timezone),base={compare:'previous',view:'overview',market:'',stream:'',source:'',device:'',page:''} as const;
  // Match the exact dataset selection used by foreground workspace reads.
  // Prioritize the expensive closed Traffic scopes before the lighter modes;
  // later native ticks fill remaining misses within the same bounded budget.
  const primary=['previous','fourWeeks'] as const,secondary=['weekday','thirtyDays'] as const;
  const selections:QueryFilters[]=[];
  for(const mode of ['closed','partial'] as const)for(const comparisons of [primary,secondary])for(const view of ['traffic','overview'])for(const compare of comparisons){const date=mode==='closed'?shiftDate(today,-1):today;selections.push({...base,view,compare,from:date,to:date,mode});}

  for(const filters of selections){
   if(Date.now()+40000>=deadline)break;
   result.attempted++;await store.observations(scope.organizationId,client.id,filters,false,{deadline},workspaceObservationSelection(filters.view));
   if(Date.now()>=deadline)break;result.completed++;
  }
 }catch{/* Derived cache failures cannot change source job state. */}
 return result;
}
