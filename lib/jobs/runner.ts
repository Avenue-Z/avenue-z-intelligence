import {runtimePlatform} from '@avenue/runtime';
import {getStore} from '../server/access';
import {serverSecret} from '../server/secrets';
import {DailyScheduler,dueReview,type DueReview} from './scheduler';
import {enqueueDue,runSyncBatch,generateReview} from './sync';
import type {AccessScope,Client} from '../analytics/contracts';
import type {Store} from '../server/store';
import {dayWindow} from '../analytics/windows';
import {warmSuccessfulSourceJobs} from '../server/cache-warming';
import {intradayConnections} from '../analytics/intraday-coverage';
import {pruneArchivedMaterializations} from './archive-materialization-retention';

async function serviceScope(s:Store):Promise<AccessScope>{
 const organizationId=serverSecret('APP_ORGANIZATION_ID')||'avenue-z';
 const org=await s.first('SELECT initialized FROM organizations WHERE id=?',organizationId);
 if(!org?.initialized)throw new Error('Workspace must be initialized before scheduled jobs run');
 return {organizationId,actorId:'application-scheduler',role:'admin',permittedClientIds:(await s.clients(organizationId)).map(c=>c.id)};
}
async function freshCore(s:Store,scope:AccessScope,c:Client,now:Date,due:DueReview|null=dueReview(c,now)){
 const sources=(await s.connections(scope.organizationId,c.id)).filter(x=>x.enabled);
 const financialContributors=new Set(intradayConnections(sources,'overview').filter(source=>['kind-shopify-sales','kind-triple-whale-diagnostics'].includes(source.provider)).map(source=>source.id));
 const core=[];let hasRevenue=false;if(!due)return false;
 for(const source of sources){const q=await s.qualification(scope.organizationId,source.id);const profiles=q?.payload?.profiles??[],revenue=profiles.some((p:any)=>p.dataset==='overview'&&p.metric==='revenue'),sessions=profiles.some((p:any)=>p.dataset==='overview'&&p.metric==='sessions'&&(due.mode==='closed'||p.hourly));if(revenue||sessions||financialContributors.has(source.id)){if(!q||!profiles.length||q.connectionVersion!==source.version||q.clientVersion!==c.version)return false;hasRevenue ||= revenue;core.push(source);}}
 const window=dayWindow(due.storeDate,c.timezone);
 if(due.mode==='partial'&&now.getTime()>=Date.parse(window.end))return false;
 return hasRevenue&&core.length>0&&core.every(x=>{
  const covered=Date.parse(x.coverageThrough??''),retrieved=Date.parse(x.lastSuccess??''),maxAge=Math.max(15,x.pollMinutes*2)*60000;
  return !x.error&&Number.isFinite(covered)&&Number.isFinite(retrieved)&&retrieved<=now.getTime()&&now.getTime()-retrieved<=maxAge&&
   (due.mode==='closed'?covered>=Date.parse(window.end):covered>Date.parse(window.start)&&covered<=now.getTime()&&now.getTime()-covered<=maxAge+3600000);
 });
}
export async function syncTick(){
 const s=getStore(),scope=await serviceScope(s),scheduler=new DailyScheduler(s),id=`${scope.organizationId}:sync`,token=await scheduler.acquire(id,new Date().toISOString(),900000);
 if(!token)return {skipped:'already-running',completed:[],failed:[]};
 try{
  const started=Date.now();await enqueueDue(scope);const result=await runSyncBatch(scope,{maxJobs:7,deadline:started+700000});
  // Native cache warming has its own cron and lease; release the source runner
  // after ingestion. Legacy runtimes retain inline warming once current feeds catch up.
  const pendingCurrent=scope.permittedClientIds.length?await s.first(`SELECT j.id FROM jobs j JOIN connections c ON c.id=j.sourceId AND c.organizationId=j.organizationId AND c.clientId=j.clientId WHERE j.organizationId=? AND j.clientId IN (${scope.permittedClientIds.map(()=>'?').join(',')}) AND c.enabled=1 AND j.id NOT LIKE '%:hourly-history:____-__-__' AND j.status IN ('pending','running') AND j.dueAt<=? LIMIT 1`,scope.organizationId,...scope.permittedClientIds,new Date().toISOString()):null;
  let maintenance:Awaited<ReturnType<typeof pruneArchivedMaterializations>>|undefined;
  // Catch a genuine drain before releasing the sync owner. Reserve the last
  // 40 seconds of the native tail for release; metadata reads get one 5s budget.
  if(runtimePlatform==='vercel'&&scope.permittedClientIds.includes('kind-patches')&&!pendingCurrent&&Date.now()+5000<started+730000){
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{
    const [pages,size,free,owner]=await Promise.race([Promise.all([s.first<{page_count:number}>('PRAGMA page_count'),s.first<{page_size:number}>('PRAGMA page_size'),s.first<{freelist_count:number}>('PRAGMA freelist_count'),s.first<{token:string;leaseUntil:string}>('SELECT token,leaseUntil FROM runner_leases WHERE id=? AND token=? AND leaseUntil>?',id,token,new Date().toISOString())]),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new DOMException('Maintenance capacity read timed out','TimeoutError')),5000);})]);
    if(timer)clearTimeout(timer);
    if(pages&&size&&free&&[pages.page_count,size.page_size,free.freelist_count].every(Number.isSafeInteger)&&pages.page_count>=0&&size.page_size>=512&&size.page_size<=65536&&(size.page_size&(size.page_size-1))===0&&free.freelist_count>=0&&free.freelist_count<=pages.page_count){
     const bytes=(pages.page_count-free.freelist_count)*size.page_size;
     if(Number.isSafeInteger(bytes)&&bytes>=18000000000&&owner?.token===token&&Date.parse(owner.leaseUntil)>Date.now()&&Date.now()<started+730000){maintenance=await pruneArchivedMaterializations(s,scope,{maxSnapshots:8,maxRows:250000,deadline:Math.min(Date.now()+60000,started+730000)});console.info('Post-current archive maintenance',maintenance);}
    }
   }catch(error){console.warn('Post-current archive maintenance deferred',{kind:error instanceof Error&&['Error','TypeError','TimeoutError','AbortError'].includes(error.name)?error.name:'Unknown'});}
   finally{if(timer)clearTimeout(timer);}
  }
  const cacheWarm=runtimePlatform==='vercel'||pendingCurrent?{attempted:0,completed:0}:await warmSuccessfulSourceJobs(s,scope,result.completed,started+770000);
  return {...result,cacheWarm,...maintenance?{maintenance}:{}};
 }
 finally{await scheduler.release(id,token);}
}
export async function reviewTick(){
 const s=getStore(),scope=await serviceScope(s),scheduler=new DailyScheduler(s),now=new Date(),id=`${scope.organizationId}:reviews`,token=await scheduler.acquire(id,now.toISOString());
 if(!token)return {skipped:'already-running',completed:[],failed:[]};
 try{
  const clients=await s.clients(scope.organizationId);
  const scheduleFailures:{id:string}[]=[];
  for(const client of clients){try{const due=dueReview(client,now);if(due&&await freshCore(s,scope,client,now,due))await scheduler.enqueue(scope.organizationId,client.id,due,now.toISOString());}catch{scheduleFailures.push({id:`schedule:${client.id}`});}}
  const j=await scheduler.claim(scope.organizationId,now.toISOString());if(!j)return {completed:[],failed:scheduleFailures};
  const client=clients.find(c=>c.id===j.clientId);let due:DueReview|null=null;
  try{if(client)due=dueReview(client,now,true);}catch{/* Invalid persisted schedules are isolated to their own job. */}
  if(!client||!due||due.storeDate!==j.storeDate||due.mode!==j.mode){await scheduler.fail(j,'Reporting period superseded',now.toISOString(),true);return {completed:[],failed:[{id:j.id}]};}
  const existing=await s.first("SELECT id FROM reviews WHERE organizationId=? AND clientId=? AND storeDate=? AND json_extract(payload,'$.scheduleJobId')=? ORDER BY revision DESC LIMIT 1",scope.organizationId,client.id,j.storeDate,j.id);
  if(existing){await scheduler.complete(j,existing.id,new Date().toISOString());return {completed:[existing.id],failed:scheduleFailures};}
  if(j.mode==='partial'&&now.getTime()>=Date.parse(dayWindow(j.storeDate,client.timezone).end)){await scheduler.fail(j,'Partial review window elapsed',now.toISOString(),true);return {completed:[],failed:[...scheduleFailures,{id:j.id}]};}
  if(!await freshCore(s,scope,client,now,due)){await scheduler.defer(j,now.toISOString());return {completed:[],failed:scheduleFailures,skipped:'awaiting-fresh-data'};}
  try{const reviewId=await generateReview(scope,client,j.storeDate,j);await scheduler.complete(j,reviewId,new Date().toISOString());return {completed:[reviewId],failed:scheduleFailures};}
  catch(e){const message=e instanceof Error?e.message:'',known=['AI returned an unsupported citation','AI returned an unsupported follow-up reference','AI review omitted a required section','The AI review did not meet the required report format','The AI response was incomplete','AI analysis timed out','OpenAI usage or billing limit reached','OpenAI authentication or model access needs attention','Review job lease expired'];const reason=known.find(x=>message.startsWith(x))??(/^[A-Z_]+:/.test(message)?`Review storage error (${message.split(':')[0]})`:'Daily review generation failed');console.error('Scheduled review failed',{clientId:j.clientId,storeDate:j.storeDate,reason});await scheduler.fail(j,reason,new Date().toISOString());return {completed:[],failed:[{id:j.id}]};}
 }finally{await scheduler.release(id,token);}
}
