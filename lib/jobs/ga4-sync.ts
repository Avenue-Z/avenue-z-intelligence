import {ga4Profile,ga4Dimensions,type Ga4ClientId} from '../analytics/ga4-profile';
import {ga4AppConfig} from '../server/ga4-profile-config';
import {validAutobrushGa4Grant} from '../server/autobrush-ga4-connection';
import {shiftDate,todayIn} from '../analytics/windows';
import {ga4RunReport,type Ga4ReportRequest} from '../sources/ga4-data';
import {refreshGa4Grant} from '../sources/ga4-auth';
import {validGa4Grant} from '../server/ga4-connection';
import {readProviderCredential,saveProviderCredential} from '../server/provider-credentials';
import {ga4CachedDays,pruneGa4Reports,saveGa4DayReports,type Ga4CachedReport,type Ga4ReportKind} from '../server/ga4-report-cache';
import type {Store} from '../server/store';
import {DailyScheduler} from './scheduler';
type CaptureDay={storeDate:string;kind:string;capturedAt:string};
const kinds=['total','hourly','detail'];
export function planGa4Sync(rows:CaptureDay[],now:Date,timezone='America/New_York'):string[]{
 const today=todayIn(timezone,now),bucket=Math.floor(now.getTime()/3600000)*3600000;
 const captured=(date:string)=>{
  const day=rows.filter(row=>row.storeDate===date);
  if(day.length!==3||!kinds.every(kind=>day.some(row=>row.kind===kind))||new Set(day.map(row=>row.capturedAt)).size!==1)return null;
  const at=Date.parse(day[0].capturedAt);return Number.isFinite(at)&&at<=now.getTime()?at:null;
 };
 const current=[0,-1,-2,-(3+Math.floor(now.getTime()/3600000)%10)].map(offset=>shiftDate(today,offset)).filter(date=>(captured(date)??0)<bucket);
 const history=Array.from({length:30},(_,offset)=>shiftDate(today,-offset)).filter(date=>captured(date)===null&&!current.includes(date)).slice(0,3);
 return [...new Set([...current,...history])];
}
type Dependencies={store:()=>Store;secret:(key:string)=>string|null;now?:()=>Date;runReport?:typeof ga4RunReport;refresh?:typeof refreshGa4Grant};
type SyncResult={completed:string[];failed:{date:string;error:string}[];remainingDays:number;skipped?:string};
const metrics=['sessions','engagedSessions','ecommercePurchases','purchaseRevenue'];
export function createGa4Sync(deps:Dependencies,clientId:Ga4ClientId='beam'){return async():Promise<SyncResult>=>{
 const profile=ga4Profile(clientId);
 const output:SyncResult={completed:[],failed:[],remainingDays:0},raw=deps.secret(clientId==='beam'?'SOURCE_BEAM_GA4':'SOURCE_AUTOBRUSH_GA4');if(!raw)return {...output,skipped:'not-configured'};
 const config=ga4AppConfig(deps.secret,clientId),org=deps.secret('APP_ORGANIZATION_ID')||'avenue-z',secret=deps.secret('AUTH_SECRET');
 if(config.propertyId!==profile.propertyId||!secret||secret.length<32)throw Error(`${profile.name} GA4 source configuration is invalid`);
 const store=deps.store(),client=await store.first<{timezone:string;currency:string}>('SELECT c.timezone,c.currency FROM clients c JOIN organizations o ON o.id=c.organizationId WHERE c.organizationId=? AND c.id=? AND o.initialized=1',org,clientId);
 if(client?.timezone!=='America/New_York'||client.currency!=='USD')throw Error(`${profile.name} GA4 reporting identity changed`);
 const scheduler=new DailyScheduler(store),clock=deps.now??(()=>new Date()),now=clock(),leaseId=`${org}:${clientId}:ga4-sync`,leaseExpires=now.getTime()+270000,lease=await scheduler.acquire(leaseId,now.toISOString(),270000);
 if(!lease)return {...output,skipped:'already-running'};
 try{
  const identity={organizationId:org,clientId,provider:'ga4'},saved=await readProviderCredential(store,identity,secret);if(!(clientId==='beam'?validGa4Grant(saved,config):validAutobrushGa4Grant(saved,config)))return {...output,skipped:'awaiting-authorization'};
  let grant=saved as import('../server/ga4-connection').SavedGa4Grant;
  if(grant.expiresAt<=clock().getTime()+60000){grant={...grant,...await (deps.refresh??refreshGa4Grant)(config,grant)};await saveProviderCredential(store,identity,grant,secret);}
  const today=todayIn(profile.timezone,now),first=shiftDate(today,-29),captured=await ga4CachedDays(store,org,config.propertyId,first,today),dates=planGa4Sync(captured,now,profile.timezone),captureDeadline=leaseExpires-65000;
  for(const date of dates){
   // One complete day needs at most three bounded provider calls. Never start
   // a day whose publication cannot fit before this independent lease expires.
   if(Date.now()+120000>captureDeadline)break;
   try{
    const capturedAt=clock().toISOString(),items:Ga4CachedReport[]=[];
    for(const kind of kinds as Ga4ReportKind[]){
     const query:Ga4ReportRequest={from:date,to:date,dimensions:ga4Dimensions(profile,kind),metrics,...profile.streamId?{streamId:profile.streamId}:{}};
     const report=await (deps.runReport??ga4RunReport)(grant.accessToken,config.propertyId,query);
     if(report.metadata.timeZone!==profile.timezone||report.metadata.currencyCode!==profile.currency)throw Error('GA4 reporting identity changed');
     items.push({storeDate:date,kind,capturedAt,report});
    }
    const owned=await store.first('SELECT token FROM runner_leases WHERE id=? AND token=? AND leaseUntil>?',leaseId,lease,clock().toISOString());
    if(!owned||Date.now()+35000>=leaseExpires)break;
    await saveGa4DayReports(store,org,config.propertyId,items,{lease:{id:leaseId,token:lease}});output.completed.push(date);
   }catch(error){
    const status=error instanceof Error?error.message.match(/^GA4 report returned HTTP (\d{3})$/)?.[1]:undefined;
    output.failed.push({date,error:status?`GA4 reporting returned HTTP ${status}`:'GA4 report capture failed; the last saved data was preserved'});break;
   }
  }
  await pruneGa4Reports(store,org,config.propertyId,first);
  const coverage=await ga4CachedDays(store,org,config.propertyId,first,today),complete=new Set(coverage.filter(row=>row.kind==='total'&&coverage.filter(item=>item.storeDate===row.storeDate&&item.capturedAt===row.capturedAt).length===3).map(row=>row.storeDate));output.remainingDays=30-complete.size;
  return output;
 }finally{await scheduler.release(leaseId,lease);}
};}

export const createBeamGa4Sync=(deps:Dependencies)=>createGa4Sync(deps,'beam');
export const createAutobrushGa4Sync=(deps:Dependencies)=>createGa4Sync(deps,'autobrush');
