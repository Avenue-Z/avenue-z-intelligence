import {cronRequest} from '../../../../lib/server/cron';
import {withAutobrushStore} from '../../../../lib/server/autobrush-cron';
import {qualifyAutobrushSource} from '../../../../lib/server/autobrush-source-qualification';
import {serverSecret} from '../../../../lib/server/secrets';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=800;
// Authenticated onboarding only; deliberately absent from recurring cron entries.
export async function GET(request:Request){return cronRequest(request,async()=>{
 const params=new URL(request.url).searchParams;
 if(params.getAll('provider').length!==1||params.getAll('date').length!==1)throw Error('One provider and date are required');
 return withAutobrushStore(async store=>{
  const {DailyScheduler}=await import('../../../../lib/jobs/scheduler');
  const org=serverSecret('APP_ORGANIZATION_ID')||'avenue-z',scheduler=new DailyScheduler(store),id=`${org}:autobrush:reporting`,token=await scheduler.acquire(id,new Date().toISOString(),900000);
  if(!token)return {failed:[],skipped:'already-running'};
  try{return {failed:[],qualification:await qualifyAutobrushSource(store,org,params.get('provider')!,params.get('date')!,serverSecret)};}
  finally{await scheduler.release(id,token);}
 });
});}
