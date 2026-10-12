import {getStore} from '../server/access';
import {serverSecret} from '../server/secrets';
import {DailyScheduler,dueReview,type DueReview} from './scheduler';
import {enqueueDue,runSyncBatch,generateReview} from './sync';
import type {AccessScope,Client} from '../analytics/contracts';
import type {Store} from '../server/store';
import {dayWindow} from '../analytics/windows';

async function serviceScope(s:Store):Promise<AccessScope>{
 const organizationId=serverSecret('APP_ORGANIZATION_ID')||'avenue-z';
 const org=await s.first('SELECT initialized FROM organizations WHERE id=?',organizationId);
 if(!org?.initialized)throw new Error('Workspace must be initialized before scheduled jobs run');
 return {organizationId,actorId:'application-scheduler',role:'admin',permittedClientIds:(await s.clients(organizationId)).map(c=>c.id)};
}
async function freshCore(s:Store,scope:AccessScope,c:Client,now:Date,due:DueReview|null=dueReview(c,now)){
 const sources=(await s.connections(scope.organizationId,c.id)).filter(x=>x.enabled);
 const core=[];if(!due)return false;
 for(const source of sources){const q=await s.qualification(scope.organizationId,source.id);const profiles=q?.payload?.profiles??[];if(profiles.some((p:any)=>p.dataset==='overview'&&p.metric==='revenue')){if(q.connectionVersion!==source.version||q.clientVersion!==c.version)return false;core.push(source);}}
 const window=dayWindow(due.storeDate,c.timezone);
 if(due.mode==='partial'&&now.getTime()>=Date.parse(window.end))return false;
 return core.length>0&&core.every(x=>{
  const covered=Date.parse(x.coverageThrough??''),retrieved=Date.parse(x.lastSuccess??''),maxAge=Math.max(15,x.pollMinutes*2)*60000;
  return !x.error&&Number.isFinite(covered)&&Number.isFinite(retrieved)&&retrieved<=now.getTime()&&now.getTime()-retrieved<=maxAge&&
   (due.mode==='closed'?covered>=Date.parse(window.end):covered>Date.parse(window.start)&&covered<=now.getTime()&&now.getTime()-covered<=maxAge+3600000);
 });
}
export async function syncTick(){
 const s=getStore(),scope=await serviceScope(s),scheduler=new DailyScheduler(s),id=`${scope.organizationId}:sync`,token=await scheduler.acquire(id,new Date().toISOString());
 if(!token)return {skipped:'already-running',completed:[],failed:[]};
 try{await enqueueDue(scope);return await runSyncBatch(scope,{maxJobs:7,deadline:Date.now()+240000});}
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
  catch{await scheduler.fail(j,'Daily review generation failed',new Date().toISOString());return {completed:[],failed:[{id:j.id}]};}
 }finally{await scheduler.release(id,token);}
}
