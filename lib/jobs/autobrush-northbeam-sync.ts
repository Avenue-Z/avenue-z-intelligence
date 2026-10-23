import {northbeamProfile,type NorthbeamCachedDay} from '../analytics/northbeam-dashboard';
import {shiftDate,todayIn} from '../analytics/windows';
import {qualifyAutobrushNorthbeamReportingDay,type NorthbeamQualificationResult} from '../server/autobrush-northbeam-qualification';
import {beginNorthbeamExport,rememberNorthbeamExport,publishNorthbeamDay,failNorthbeamExport,loadNorthbeamDays,northbeamExportStates,pruneNorthbeamDays,retireEmptyNorthbeamExport,validatedNorthbeamDay,type NorthbeamExportState,type NorthbeamLease,type NorthbeamError} from '../server/northbeam-report-cache';
import type {Store} from '../server/store';
import {DailyScheduler} from './scheduler';
type Dependencies={store:()=>Store;secret:(key:string)=>string|null;now?:()=>Date;runDay?:typeof qualifyAutobrushNorthbeamReportingDay;maxDays?:number};
type SyncResult={completed:string[];pending:string[];blocked:string[];failed:{date:string;error:string}[];remainingDays:number;skipped?:string};
/** The seven closed accrual days keep maturing. Refresh them and today once per
 * UTC hour, then bounded missing history and one rotating retained older day. */
export function planNorthbeamSync(rows:Pick<NorthbeamCachedDay,'date'|'capturedAt'>[],states:NorthbeamExportState[],now:Date):string[]{
 const today=todayIn(northbeamProfile.reportingTimezone,now),first=shiftDate(today,-29),bucket=Math.floor(now.getTime()/3600000)*3600000;
 const captured=new Map(rows.filter(row=>Number.isFinite(Date.parse(row.capturedAt))&&Date.parse(row.capturedAt)<=now.getTime()).map(row=>[row.date,Date.parse(row.capturedAt)]));
 const recent=Array.from({length:8},(_,i)=>shiftDate(today,-i)).filter(date=>(captured.get(date)??0)<bucket),priority=recent.filter(date=>date>=shiftDate(today,-1));
 const pending=states.filter(s=>s.date>=first&&s.date<=today&&['pending','creating','blocked'].includes(s.status)).map(s=>s.date).sort().reverse();
 const history=Array.from({length:22},(_,i)=>shiftDate(today,-8-i)).filter(date=>!captured.has(date)).slice(0,3),rotating=shiftDate(today,-8-Math.floor(now.getTime()/3600000)%22);
 const blocked=new Set(states.filter(state=>['blocked','creating'].includes(state.status)||state.status==='retry'&&state.bucket>=Math.floor(now.getTime()/3600000)).map(state=>state.date));
 return [...new Set([...priority,...pending,...recent,...history,...((captured.get(rotating)??0)<bucket?[rotating]:[])])].filter(date=>!blocked.has(date));
}
function cachedDay(result:NorthbeamQualificationResult,capturedAt:string):NorthbeamCachedDay{
 const summary=result.summary,metric=result.discovery?.selectedRevenueMetric;
 if(result.clientId!=='autobrush'||result.provider!=='northbeam'||result.profile!==northbeamProfile.id||result.status!=='scope-verified'||!result.reportingScopeValidated||result.grain!=='daily'||result.dateBasis!=='provider_calendar_date'||result.coverageThrough!==null||!summary||!result.export||summary.missingCells.spend||summary.missingCells.attributedRevenue||summary.totals.spend===null||summary.totals.attributedRevenue===null||!metric)throw Error('Northbeam scope is incomplete');
 return {date:result.date,spend:summary.totals.spend,attributedRevenue:summary.totals.attributedRevenue,capturedAt,providerAsOf:null,exportId:result.export.id,exportCreatedAt:result.export.createdAt,exportFinishedAt:result.export.finishedAt,returned:summary.actual,revenueMetric:metric,fileHashes:summary.fileHashes};
}
export function createAutobrushNorthbeamSync(deps:Dependencies){return async():Promise<SyncResult>=>{
 const output:SyncResult={completed:[],pending:[],blocked:[],failed:[],remainingDays:30};
 if(deps.secret('AUTOBRUSH_NORTHBEAM_REPORTING_ENABLED')!=='true')return {...output,skipped:'disabled'};
 const org=deps.secret('APP_ORGANIZATION_ID')||'avenue-z',store=deps.store(),client=await store.first<{timezone:string;currency:string}>('SELECT c.timezone,c.currency FROM clients c JOIN organizations o ON o.id=c.organizationId WHERE c.organizationId=? AND c.id=? AND o.initialized=1',org,'autobrush');
 if(client?.timezone!=='America/New_York'||client.currency!=='USD')throw Error('Northbeam commerce identity changed');
 const clock=deps.now??(()=>new Date()),now=clock(),scheduler=new DailyScheduler(store),leaseId=`${org}:autobrush:northbeam-sync`,expires=now.getTime()+270000,token=await scheduler.acquire(leaseId,now.toISOString(),270000);
 if(!token)return {...output,skipped:'already-running'};
 const owner=():NorthbeamLease=>({id:leaseId,token,now:clock().toISOString()});
 try{
  const today=todayIn(northbeamProfile.reportingTimezone,now),first=shiftDate(today,-29),rows=await loadNorthbeamDays(store,org,first,today),states=await northbeamExportStates(store,org,first,today),byDate=new Map(states.map(s=>[s.date,s]));
  for(const state of states)if(state.status==='blocked'||state.status==='creating'){output.blocked.push(state.date);if(state.status==='creating')await failNorthbeamExport(store,org,state.date,'export_creation_unconfirmed',true,owner());}
  const dates=planNorthbeamSync(rows,states,now).slice(0,Math.max(1,Math.min(4,deps.maxDays??4))),run=deps.runDay??qualifyAutobrushNorthbeamReportingDay;
  for(const date of dates){
   if(Date.now()+35000>=expires)break;
   const state=byDate.get(date);
   try{
    const result=await run({date,...state?.resume?{resume:state.resume}:{}},deps.secret,{
     beforeCreate:async()=>{await beginNorthbeamExport(store,org,date,Math.floor(now.getTime()/3600000),owner());},
     knownExport:async resume=>{await rememberNorthbeamExport(store,org,date,resume,owner());}
    },fetch,clock(),{deadline:Math.min(expires-15000,Date.now()+65000),maxPolls:2,pollDelayMs:1000});
    if(result.date!==date)throw Error('Northbeam export date changed');
    if(result.reason==='empty_export'&&result.diagnostic?.phase==='download'&&result.resume){await retireEmptyNorthbeamExport(store,org,date,owner());output.failed.push({date,error:'export_empty'});continue;}
    if(result.status==='pending'&&result.resume){output.pending.push(date);continue;}
    if(result.status==='scope-verified'){
     const capturedAt=clock().toISOString();let item:NorthbeamCachedDay;
     try{item=validatedNorthbeamDay(cachedDay(result,capturedAt));}catch{await failNorthbeamExport(store,org,date,'export_scope_mismatch',true,owner());output.failed.push({date,error:'export_scope_mismatch'});continue;}
     await publishNorthbeamDay(store,org,item,owner());output.completed.push(date);continue;
    }
    const ambiguous=result.reason==='export_creation_unconfirmed',invalidResume=result.reason==='invalid_resume'||result.reason==='resume_metric_changed',mismatch=result.status==='scope-mismatch';
    const error:NorthbeamError=ambiguous?'export_creation_unconfirmed':invalidResume?'export_resume_invalid':mismatch?'export_scope_mismatch':result.reason==='durable_checkpoint_failed'?'durable_checkpoint_failed':'export_capture_failed';
    await failNorthbeamExport(store,org,date,error,ambiguous||invalidResume||mismatch||['provider_export_failed','invalid_export_metric','duplicate_export_rows','invalid_export_files','invalid_csv','empty_export','invalid_csv_columns','csv_row_limit','csv_column_limit','csv_field_limit','export_size_limit','unsafe_export_download','ambiguous_export_metadata'].includes(result.reason??''),owner());output.failed.push({date,error});
   }catch{
    // A checkpoint may have committed even when its acknowledgment was lost.
    // Re-read on the next tick; never replay a provider create from this catch.
    await failNorthbeamExport(store,org,date,'export_capture_failed',false,owner());output.failed.push({date,error:'Northbeam export capture failed; previous cache preserved'});
   }
  }
  await pruneNorthbeamDays(store,org,first,owner());const saved=await loadNorthbeamDays(store,org,first,today);output.remainingDays=30-saved.length;return output;
 }finally{await scheduler.release(leaseId,token);}
};}
