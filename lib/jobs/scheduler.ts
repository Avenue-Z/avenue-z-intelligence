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
  const r=await this.store.run('INSERT INTO runner_leases(id,token,leaseUntil) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,leaseUntil=excluded.leaseUntil WHERE runner_leases.leaseUntil<=?',id,token,until,now);
  return r.meta.changes?token:null;
 }
 async release(id:string,token:string){await this.store.run('DELETE FROM runner_leases WHERE id=? AND token=?',id,token);}
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
