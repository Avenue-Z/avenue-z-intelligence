import {z} from 'zod';
import {northbeamProfile,validNorthbeamDate,type NorthbeamCachedDay} from '../analytics/northbeam-dashboard';
import type {Store} from './store';
const date=z.string().refine(validNorthbeamDate),stamp=z.string().datetime({offset:true});
const metadata=z.object({dates:z.array(z.string()).max(32),accountingModes:z.array(z.string()).max(32),models:z.array(z.string()).max(32),windows:z.array(z.string()).max(32),currencies:z.array(z.string()).max(32),timezones:z.array(z.string()).max(32)}).strict();
const daySchema=z.object({date,spend:z.number().finite().nonnegative(),attributedRevenue:z.number().finite(),capturedAt:stamp,providerAsOf:z.literal(null),exportId:z.string().uuid(),exportCreatedAt:stamp,exportFinishedAt:stamp.nullable(),returned:metadata,revenueMetric:z.object({id:z.string().regex(/^[A-Za-z0-9:_-]{1,120}$/),label:z.string().regex(/^Attributed (?:Rev|Revenue)(?: \(7d\))?$/i)}).strict(),fileHashes:z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(4)}).strict().superRefine((day,ctx)=>{
 const m=day.returned;if(m.dates.length!==1||m.dates[0]!==day.date||!m.accountingModes.length||m.accountingModes.some(v=>!['accrual','accrual performance'].includes(v.toLowerCase()))||!m.models.length||m.models.some(v=>!['Clicks only','northbeam_custom'].includes(v))||m.windows.length!==1||m.windows[0]!=='7'||m.currencies.length>1||m.currencies.some(v=>v!=='USD')||m.timezones.length>1||m.timezones.some(v=>v!==northbeamProfile.reportingTimezone)||day.revenueMetric.id==='rev')ctx.addIssue({code:'custom',message:'Northbeam profile mismatch'});
});
const errors=['export_empty','export_creation_unconfirmed','export_capture_failed','export_scope_mismatch','export_resume_invalid','durable_checkpoint_failed'] as const;
export type NorthbeamError=typeof errors[number];
const resumeSchema=z.string().max(4096).regex(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const stateSchema=z.object({date,status:z.enum(['creating','pending','complete','retry','blocked']),bucket:z.number().int().nonnegative(),resume:resumeSchema.nullable(),lastAttempt:stamp,lastError:z.enum(errors).nullable()}).strict();
export type NorthbeamExportState=z.infer<typeof stateSchema>;
export type NorthbeamLease={id:string;token:string;now:string};
function identity(org:string){if(typeof org!=='string'||!/^[A-Za-z0-9:_-]{1,120}$/.test(org))throw Error();return [org,'autobrush',northbeamProfile.id];}
function range(org:string,from:string,to:string){const scope=identity(org);date.parse(from);date.parse(to);if(from>to||(Date.parse(to)-Date.parse(from))/86400000>29)throw Error();return scope;}
function guard(org:string,lease:NorthbeamLease){if(lease.id!==`${org}:autobrush:northbeam-sync`||!/^[\x21-\x7e]{1,256}$/.test(lease.token))throw Error();stamp.parse(lease.now);return [lease.id,lease.token,lease.now];}
const live='EXISTS (SELECT 1 FROM runner_leases WHERE id=? AND token=? AND leaseUntil>?)';
async function changed(store:Pick<Store,'run'>,sql:string,values:unknown[]){const r=await store.run(sql,...values);if(r?.meta?.changes!==1)throw Error();}
export function validatedNorthbeamDay(value:unknown):NorthbeamCachedDay{return daySchema.parse(value);}
export async function loadNorthbeamDays(store:Pick<Store,'all'>,org:string,from:string,to:string):Promise<NorthbeamCachedDay[]>{
 try{const scope=range(org,from,to),rows=await store.all<{date:string;capturedAt:string;payload:string}>('SELECT date,capturedAt,payload FROM northbeam_report_cache WHERE organizationId=? AND clientId=? AND profile=? AND date BETWEEN ? AND ? ORDER BY date LIMIT 31',...scope,from,to);if(rows.length>30)throw Error();return rows.map(row=>{if(typeof row.payload!=='string'||row.payload.length>16000)throw Error();const value=validatedNorthbeamDay(JSON.parse(row.payload));if(value.date!==row.date||value.capturedAt!==row.capturedAt||value.date<from||value.date>to)throw Error();return value;});}catch{throw Error('Northbeam daily cache could not be loaded');}
}
export async function northbeamExportStates(store:Pick<Store,'all'>,org:string,from:string,to:string):Promise<NorthbeamExportState[]>{
 try{const scope=range(org,from,to),rows=await store.all<NorthbeamExportState>('SELECT date,status,bucket,resume,lastAttempt,lastError FROM northbeam_export_state WHERE organizationId=? AND clientId=? AND profile=? AND date BETWEEN ? AND ? ORDER BY date LIMIT 31',...scope,from,to);if(rows.length>30)throw Error();return rows.map(row=>{const state=stateSchema.parse(row);if(state.date<from||state.date>to||state.status==='pending'&&!state.resume)throw Error();return state;});}catch{throw Error('Northbeam export state could not be loaded');}
}
/** A durable intent is mandatory before the only create POST. A marker left by
 * an interrupted request is deliberately not eligible for automatic replay. */
export async function beginNorthbeamExport(store:Pick<Store,'run'>,org:string,day:string,bucket:number,lease:NorthbeamLease){
 try{const scope=identity(org);date.parse(day);z.number().int().nonnegative().parse(bucket);const owner=guard(org,lease);await changed(store,`INSERT INTO northbeam_export_state (organizationId,clientId,profile,date,status,bucket,resume,lastAttempt,lastError) SELECT ?,?,?,?,'creating',?,NULL,?,NULL WHERE ${live} ON CONFLICT(organizationId,clientId,profile,date) DO UPDATE SET status='creating',bucket=excluded.bucket,resume=NULL,lastAttempt=excluded.lastAttempt,lastError=NULL WHERE northbeam_export_state.status IN ('complete','retry') AND northbeam_export_state.bucket<excluded.bucket`,[...scope,day,bucket,lease.now,...owner]);}catch{throw Error('Northbeam export intent could not be confirmed');}
}
export async function rememberNorthbeamExport(store:Pick<Store,'run'>,org:string,day:string,resume:string,lease:NorthbeamLease){
 try{const scope=identity(org);date.parse(day);resumeSchema.parse(resume);await changed(store,`UPDATE northbeam_export_state SET status='pending',resume=?,lastAttempt=?,lastError=NULL WHERE organizationId=? AND clientId=? AND profile=? AND date=? AND (status='creating' OR (status='pending' AND resume=?)) AND ${live}`,[resume,lease.now,...scope,day,resume,...guard(org,lease)]);}catch{throw Error('Northbeam export identity could not be confirmed');}
}
export async function publishNorthbeamDay(store:Pick<Store,'run'>,org:string,value:NorthbeamCachedDay,lease:NorthbeamLease){
 try{const scope=identity(org),day=validatedNorthbeamDay(value),payload=JSON.stringify(day),owner=guard(org,lease);if(payload.length>16000||Date.parse(day.capturedAt)>Date.parse(lease.now))throw Error();await changed(store,`INSERT INTO northbeam_report_cache (organizationId,clientId,profile,date,payload,capturedAt) SELECT ?,?,?,?,?,? WHERE ${live} AND EXISTS (SELECT 1 FROM northbeam_export_state WHERE organizationId=? AND clientId=? AND profile=? AND date=? AND status='pending') ON CONFLICT(organizationId,clientId,profile,date) DO UPDATE SET payload=excluded.payload,capturedAt=excluded.capturedAt`,[...scope,day.date,payload,day.capturedAt,...owner,...scope,day.date]);await changed(store,`UPDATE northbeam_export_state SET status='complete',resume=NULL,lastError=NULL WHERE organizationId=? AND clientId=? AND profile=? AND date=? AND status='pending' AND ${live}`,[...scope,day.date,...owner]);}catch{throw Error('Northbeam daily cache could not be saved');}
}
export async function failNorthbeamExport(store:Pick<Store,'run'>,org:string,day:string,error:NorthbeamError,blocked:boolean,lease:NorthbeamLease){
 try{const scope=identity(org);date.parse(day);z.enum(errors).parse(error);await changed(store,`INSERT INTO northbeam_export_state (organizationId,clientId,profile,date,status,bucket,resume,lastAttempt,lastError) SELECT ?,?,?,?,'retry',?,NULL,?,? WHERE ${live} ON CONFLICT(organizationId,clientId,profile,date) DO UPDATE SET status=CASE WHEN ?=1 OR northbeam_export_state.status IN ('creating','blocked') THEN 'blocked' WHEN northbeam_export_state.status='pending' THEN 'pending' ELSE 'retry' END,lastAttempt=excluded.lastAttempt,lastError=excluded.lastError`,[...scope,day,Math.floor(Date.parse(lease.now)/3600000),lease.now,error,...guard(org,lease),blocked?1:0]);}catch{throw Error('Northbeam export failure could not be recorded');}
}
export async function pruneNorthbeamDays(store:Pick<Store,'run'>,org:string,before:string,lease:NorthbeamLease){
 const scope=identity(org);date.parse(before);const owner=guard(org,lease);await store.run(`DELETE FROM northbeam_report_cache WHERE organizationId=? AND clientId=? AND profile=? AND date<? AND ${live}`,...scope,before,...owner);
 // Ambiguous creation markers are never discarded by routine retention. They
 // remain durable evidence even after their reporting date leaves the cache.
 await store.run(`DELETE FROM northbeam_export_state WHERE organizationId=? AND clientId=? AND profile=? AND date<? AND status IN ('complete','retry') AND ${live}`,...scope,before,...owner);
}

/** Only a definitively completed empty export may be retired. Its missing day
 * stays unknown, and its attempt hour prevents another create in this bucket. */
export async function retireEmptyNorthbeamExport(store:Pick<Store,'run'>,org:string,day:string,lease:NorthbeamLease){
 try{const scope=identity(org);date.parse(day);await changed(store,`UPDATE northbeam_export_state SET status='retry',resume=NULL,bucket=?,lastAttempt=?,lastError='export_empty' WHERE organizationId=? AND clientId=? AND profile=? AND date=? AND status='pending' AND resume IS NOT NULL AND ${live}`,[Math.floor(Date.parse(lease.now)/3600000),lease.now,...scope,day,...guard(org,lease)]);}catch{throw Error('Northbeam empty export could not be retired');}
}
