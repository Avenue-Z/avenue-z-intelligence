import type {AccessScope} from '../analytics/contracts';
import type {Store} from '../server/store';
import {DailyScheduler} from './scheduler';
import {enqueueDue,runSyncBatch} from './sync';
import {planBeamHistory} from './beam-history';
export {planBeamHistory} from './beam-history';
import {pruneArchivedMaterializations} from './archive-materialization-retention';
import {warmSuccessfulSourceJobs} from '../server/cache-warming';

export async function runBeamSync(store:Store,organizationId:string,history=false){
 const organization=await store.first<{initialized:number}>('SELECT initialized FROM organizations WHERE id=?',organizationId);if(!organization?.initialized)throw Error('Workspace must be initialized before Beam reporting runs');
 const scope:AccessScope={organizationId,actorId:'application-beam-scheduler',role:'service',permittedClientIds:['beam']},scheduler=new DailyScheduler(store),id=`${organizationId}:beam:reporting`,started=Date.now(),token=await scheduler.acquire(id,new Date(started).toISOString(),900000);
 if(!token)return {skipped:'already-running',completed:[],failed:[]};
 try{
  await enqueueDue(scope,undefined,store);
  if(history){
   const pending=await store.first("SELECT j.id FROM jobs j JOIN connections c ON c.id=j.sourceId AND c.organizationId=j.organizationId WHERE j.organizationId=? AND j.clientId='beam' AND c.enabled=1 AND j.id NOT LIKE '%:hourly-history:____-__-__' AND j.status IN ('pending','running') AND j.dueAt<=? LIMIT 1",organizationId,new Date().toISOString());
   if(pending)return {skipped:'current-hour-first',completed:[],failed:[]};
   await planBeamHistory(store,scope);
  }
  const result=await runSyncBatch(scope,{maxJobs:history?5:7,deadline:started+700000,includeHistory:history},store);
  // Prepare ordinary live tabs only after source publication has drained.
  let cacheWarm={attempted:0,completed:0},maintenance:Awaited<ReturnType<typeof pruneArchivedMaterializations>>|undefined;
  const optionalFailures:string[]=[];
  const deferred=(stage:string,error:unknown)=>{optionalFailures.push(stage);console.warn('Beam optional source tail deferred',{stage,kind:error instanceof Error&&['Error','TypeError','TimeoutError','AbortError'].includes(error.name)?error.name:'Unknown'});};
  let drained=false;
  try{drained=!await store.first("SELECT id FROM jobs WHERE organizationId=? AND clientId='beam' AND id NOT LIKE '%:hourly-history:____-__-__' AND status IN ('pending','running') AND dueAt<=? LIMIT 1",organizationId,new Date().toISOString());}
  catch(error){deferred('pending-current-check',error);}
  if(drained){
   try{cacheWarm=await warmSuccessfulSourceJobs(store,scope,result.completed,Math.min(started+760000,Date.now()+100000));}
   catch(error){deferred('cache-warm',error);}
   if(Date.now()+40000<started+770000){try{maintenance=await pruneArchivedMaterializations(store,scope,{clientId:'beam',maxSnapshots:8,maxRows:200000,deadline:Math.min(started+770000,Date.now()+60000),monthlyRetention:true});}catch(error){deferred('maintenance',error);}}
  }
  return {...result,cacheWarm,...maintenance?{maintenance}:{},...optionalFailures.length?{optionalFailures}:{}};
 }finally{await scheduler.release(id,token);}
}
