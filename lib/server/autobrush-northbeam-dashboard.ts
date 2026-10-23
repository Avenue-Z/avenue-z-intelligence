import {buildNorthbeamDashboard,parseNorthbeamRange,northbeamProfile} from '../analytics/northbeam-dashboard';
import {shiftDate,todayIn} from '../analytics/windows';
import type {AccessScope} from '../analytics/contracts';
import {loadNorthbeamDays,northbeamExportStates,type NorthbeamError} from './northbeam-report-cache';
import {authorize} from './policy';
import type {Store} from './store';
type Dependencies={scope:()=>Promise<AccessScope|null>;store:()=>Pick<Store,'all'>;secret:(key:string)=>string|null;now?:()=>number};
const headers={'Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff'};
const messages:Record<NorthbeamError,string>={export_empty:'A completed Northbeam export had no rows; the day remains unavailable until a later refresh.',export_creation_unconfirmed:'An export creation is unconfirmed and requires reconciliation before retry.',export_capture_failed:'A Northbeam refresh failed; the previous saved data was preserved.',export_scope_mismatch:'A Northbeam export returned incomplete or mismatched data.',export_resume_invalid:'A saved Northbeam export could not be resumed safely.',durable_checkpoint_failed:'An export checkpoint could not be confirmed safely.'};
/** Authenticated cache-only reader. Request input cannot select an account,
 * model, credentials or unsupported country/channel/device dimensions. */
export function createAutobrushNorthbeamDashboard(deps:Dependencies){return async(request:Request):Promise<Response>=>{
 let scope:AccessScope;try{scope=authorize(await deps.scope(),'autobrush');}catch{return Response.json({error:'Autobrush access required'},{status:403,headers});}
 const now=new Date((deps.now??Date.now)());let range;try{range=parseNorthbeamRange(new URL(request.url).searchParams,now);}catch{return Response.json({error:'Invalid Northbeam report selection; only from/to provider dates are supported'},{status:400,headers});}
 const enabled=deps.secret('AUTOBRUSH_NORTHBEAM_REPORTING_ENABLED')==='true';
 if(!enabled)return Response.json(buildNorthbeamDashboard([],range,false,now),{headers});
 try{
  const store=deps.store(),today=todayIn(northbeamProfile.reportingTimezone,now),first=shiftDate(today,-29),rows=await loadNorthbeamDays(store,scope.organizationId,first,today),states=await northbeamExportStates(store,scope.organizationId,first,today);
  const latest=[...states].sort((a,b)=>b.lastAttempt.localeCompare(a.lastAttempt))[0],failure=[...states].filter(state=>state.lastError).sort((a,b)=>b.lastAttempt.localeCompare(a.lastAttempt))[0],freshness={lastSuccess:rows.map(row=>row.capturedAt).sort().at(-1)??null,lastAttempt:latest?.lastAttempt??null,lastError:failure?.lastError?messages[failure.lastError]:null};
  return Response.json(buildNorthbeamDashboard(rows,range,true,now,freshness),{headers});
 }catch{return Response.json({error:'Cached Northbeam reports are temporarily unavailable'},{status:503,headers});}
};}
