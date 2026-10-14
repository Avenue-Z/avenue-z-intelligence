import {Temporal} from '@js-temporal/polyfill';
import type {Client} from '../analytics/contracts';
import type {Store} from '../server/store';
import {shiftDate,todayIn} from '../analytics/windows';

export type DueReview={storeDate:string;mode:'closed'|'partial'};
export type ReviewJob={id:string;organizationId:string;clientId:string;storeDate:string;mode:'closed'|'partial';attempts:number;leaseToken:string};
export function dueReview(client:Client,now=new Date(),includePreviousSlot=false):DueReview|null {
 const local=Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(client.config.reviewTimezone);
 let scheduled=local.toPlainDate().toZonedDateTime({timeZone:client.config.reviewTimezone,plainTime:client.config.reviewTime});
 if(scheduled.epochMilliseconds>now.getTime()){
  if(!includePreviousSlot)return null;
  scheduled=local.toPlainDate().subtract({days:1}).toZonedDateTime({timeZone:client.config.reviewTimezone,plainTime:client.config.reviewTime});
 }
 const storeDay=todayIn(client.timezone,new Date(scheduled.epochMilliseconds));
 return {storeDate:shiftDate(storeDay,client.config.reviewMode==='closed'?-1:0),mode:client.config.reviewMode};
}
export class DailyScheduler {
 constructor(private store:Store){}
 async acquire(id:string,now:string,durationMs=360000){
  const token=crypto.randomUUID(),until=new Date(Date.parse(now)+durationMs).toISOString();
  try{
   const r=await this.store.run('INSERT INTO runner_leases(id,token,leaseUntil) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,leaseUntil=excluded.leaseUntil WHERE runner_leases.leaseUntil<=?',id,token,until,now);
   return r.meta.changes?token:null;
  }catch(error){
   const timeout=error instanceof Error&&(error.name==='TimeoutError'||error.message==='Database request timed out'),remaining=Date.parse(until)-Date.now();
   if(!timeout||remaining<=0)throw error;
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{
    // A committed acquisition can lose its acknowledgment. Recover only this
    // exact still-live owner; one short read never replays or steals the lease.
    const owned=await Promise.race([this.store.first<{token:string;leaseUntil:string}>('SELECT token,leaseUntil FROM runner_leases WHERE id=? AND token=? AND leaseUntil=? AND leaseUntil>?',id,token,until,new Date().toISOString()),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(error),Math.min(5000,remaining));})]);
    if(owned?.token===token&&owned.leaseUntil===until&&Date.parse(owned.leaseUntil)>Date.now())return token;
   }catch{/* Unverified ownership retains the original acquisition failure. */}
   finally{if(timer)clearTimeout(timer);}
   throw error;
  }
 }
 async release(id:string,token:string){
  const remove=()=>this.store.run('DELETE FROM runner_leases WHERE id=? AND token=?',id,token);
  try{await remove();}
  catch(error){
   if(!(error instanceof Error&&(error.name==='TimeoutError'||error.message==='Database request timed out')))throw error;
   const bounded=async<T>(work:()=>Promise<T>):Promise<T>=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([work(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(error),5000);})]);}
    finally{if(timer)clearTimeout(timer);}
   };
   let owned:{token:string}|null;
   try{owned=await bounded(()=>this.store.first<{token:string}>('SELECT token FROM runner_leases WHERE id=?',id));}
   catch{throw error;}
   // A lost acknowledgment may already have released this owner. A late
   // exact-token retry also cannot remove a replacement acquired meanwhile.
   if(owned?.token!==token)return;
   await bounded(remove);
  }
 }
 async enqueue(org:string,client:string,due:DueReview,now:string){
  await this.store.run("INSERT INTO scheduled_reviews(id,organizationId,clientId,storeDate,mode,status,attempts,dueAt) VALUES(?,?,?,?,?,'pending',0,?) ON CONFLICT DO NOTHING",`${org}:${client}:${due.storeDate}:${due.mode}`,org,client,due.storeDate,due.mode,now);
 }
 async claim(org:string,now:string):Promise<ReviewJob|null>{
  const j=await this.store.first("SELECT * FROM scheduled_reviews WHERE organizationId=? AND ((status='pending' AND dueAt<=?) OR (status='running' AND leaseUntil<=?)) ORDER BY dueAt LIMIT 1",org,now,now);if(!j)return null;
  const token=crypto.randomUUID(),until=new Date(Date.parse(now)+300000).toISOString();
  const r=await this.store.run("UPDATE scheduled_reviews SET status='running',leaseToken=?,leaseUntil=?,attempts=attempts+1 WHERE id=? AND organizationId=? AND ((status='pending' AND dueAt<=?) OR (status='running' AND leaseUntil<=?))",token,until,j.id,org,now,now);
  return r.meta.changes?{...j,attempts:j.attempts+1,leaseToken:token}:null;
 }
 async complete(j:ReviewJob,reviewId:string,now:string){await this.store.run("UPDATE scheduled_reviews SET status='complete',reviewId=?,completedAt=?,error=NULL,leaseToken=NULL,leaseUntil=NULL WHERE id=? AND leaseToken=?",reviewId,now,j.id,j.leaseToken);}
 async defer(j:ReviewJob,now:string){await this.store.run("UPDATE scheduled_reviews SET status='pending',dueAt=?,attempts=attempts-1,error='Awaiting fresh core sources',leaseToken=NULL,leaseUntil=NULL WHERE id=? AND leaseToken=?",new Date(Date.parse(now)+300000).toISOString(),j.id,j.leaseToken);}
 async fail(j:ReviewJob,error:string,now:string,permanent=false){await this.store.run('UPDATE scheduled_reviews SET status=?,dueAt=?,error=?,leaseToken=NULL,leaseUntil=NULL WHERE id=? AND leaseToken=?',permanent||j.attempts>=3?'failed':'pending',new Date(Date.parse(now)+Math.min(30,2**j.attempts)*60000).toISOString(),error,j.id,j.leaseToken);}
}
