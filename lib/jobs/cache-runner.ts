import {getStore} from '../server/access';
import {serverSecret} from '../server/secrets';
import {warmSuccessfulSourceJobs} from '../server/cache-warming';
import type {AccessScope} from '../analytics/contracts';
import {DailyScheduler} from './scheduler';

/** Prepare shared frames from published facts without claiming source jobs. */
export async function cacheTick(clientId:'kind-patches'|'beam'|'autobrush'='kind-patches',providedStore?:import('../server/store').Store){
 if(clientId!=='kind-patches'&&clientId!=='beam'&&clientId!=='autobrush')throw Error('Unsupported cache client');
 const store=providedStore??getStore(),organizationId=serverSecret('APP_ORGANIZATION_ID')||'avenue-z';
 const organization=await store.first<{initialized:number}>('SELECT initialized FROM organizations WHERE id=?',organizationId);
 if(!organization?.initialized)throw Error('Workspace must be initialized before cache warming runs');
 const scope:AccessScope={organizationId,actorId:'application-cache-scheduler',role:'service',permittedClientIds:[clientId]},scheduler=new DailyScheduler(store),id=`${organizationId}:cache${clientId==='kind-patches'?'':':'+clientId}`,token=await scheduler.acquire(id,new Date().toISOString(),900000);
 if(!token)return {skipped:'already-running',completed:[],failed:[]};
 try{
  const started=Date.now(),jobs=await store.all<{id:string}>("SELECT id FROM jobs WHERE organizationId=? AND clientId=? AND status='complete' AND id NOT LIKE '%:hourly-history:%' AND dueAt<=? ORDER BY dueAt DESC,id DESC LIMIT 13",organizationId,clientId,new Date(started).toISOString());
  if(!jobs.length)return {skipped:'no-completed-source-jobs',completed:[],failed:[]};
  const cacheWarm=await warmSuccessfulSourceJobs(store,scope,jobs.map(job=>job.id),started+700000);
  return {completed:[],failed:[],cacheWarm};
 }finally{await scheduler.release(id,token);}
}
