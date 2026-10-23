import {ga4ProfileForProperty,type Ga4Profile} from '../analytics/ga4-profile';
import {privateSafeGa4Report} from '../analytics/ga4-page-privacy';
import {gzipSync,gunzipSync} from 'node:zlib';
import type {Ga4Report} from '../sources/ga4-data';
import type {Store} from './store';
export type Ga4ReportKind='total'|'hourly'|'detail';
export type Ga4CachedReport={storeDate:string;kind:Ga4ReportKind;capturedAt:string;report:Ga4Report};
type Day=Pick<Ga4CachedReport,'storeDate'|'kind'|'capturedAt'>;
const kinds:Ga4ReportKind[]=['total','hourly','detail'],maximumExpandedBytes=16*1024*1024,maximumCompressedBytes=4*1024*1024,maximumEncodedCharacters=Math.ceil(maximumCompressedBytes/3)*4;
const metricTypes=new Set(['TYPE_INTEGER','TYPE_FLOAT','TYPE_SECONDS','TYPE_CURRENCY']);
const credentialKeys=/^(?:access_?token|refresh_?token|client_?secret|authorization|credentials|password|api_?key|cookie|set-cookie)$/i;
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function validDate(value:unknown):value is string{return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;}
function validTimestamp(value:unknown):value is string{return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)&&validDate(value.slice(0,10))&&Number.isFinite(Date.parse(value));}
function scope(org:string,propertyId:string){if(typeof org!=='string'||!org.trim()||org.length>256||/[\u0000-\u001f\u007f]/.test(org))throw Error();const profile=ga4ProfileForProperty(propertyId);return [org,profile.clientId,propertyId];}
function range(from:string,to:string){if(!validDate(from)||!validDate(to)||from>to||Date.parse(to)-Date.parse(from)>=32*86400000)throw Error();return (Date.parse(to)-Date.parse(from))/86400000+1;}
function day(value:unknown):Day{
 if(!record(value)||!validDate(value.storeDate)||!kinds.includes(value.kind as Ga4ReportKind)||!validTimestamp(value.capturedAt))throw Error();
 return {storeDate:value.storeDate,kind:value.kind as Ga4ReportKind,capturedAt:value.capturedAt};
}
function jsonValue(key:string,value:unknown):unknown{if(credentialKeys.test(key)||typeof value==='number'&&!Number.isFinite(value))throw Error();return value;}
function report(value:unknown,profile:Ga4Profile):asserts value is Ga4Report{
 if(!record(value)||!Number.isSafeInteger(value.rowCount)||Number(value.rowCount)<0||Number(value.rowCount)>50000||!Array.isArray(value.rows)||value.rowCount!==value.rows.length||!Array.isArray(value.dimensionHeaders)||value.dimensionHeaders.length>9||!Array.isArray(value.metricHeaders)||!value.metricHeaders.length||value.metricHeaders.length>10)throw Error();
 const dimensionNames:string[]=[],metricNames:string[]=[];
 for(const header of value.dimensionHeaders){if(!record(header)||typeof header.name!=='string'||!header.name.length||header.name.length>128||dimensionNames.includes(header.name))throw Error();dimensionNames.push(header.name);}
 for(const header of value.metricHeaders){if(!record(header)||typeof header.name!=='string'||!header.name.length||header.name.length>128||metricNames.includes(header.name)||typeof header.type!=='string'||!metricTypes.has(header.type))throw Error();metricNames.push(header.name);}
 const headers=value.metricHeaders;
 for(const row of value.rows){
  if(!record(row)||!record(row.dimensions)||!record(row.metrics)||Object.keys(row.dimensions).length!==dimensionNames.length||Object.keys(row.metrics).length!==metricNames.length)throw Error();
  const dimensions=row.dimensions,metrics=row.metrics;
  if(dimensionNames.some(name=>typeof dimensions[name]!=='string')||metricNames.some((name,index)=>typeof metrics[name]!=='number'||!Number.isFinite(metrics[name])||headers[index].type==='TYPE_INTEGER'&&!Number.isSafeInteger(metrics[name])))throw Error();
 }
 if(profile.streamId&&(!dimensionNames.includes('streamId')||value.rows.some(row=>row.dimensions.streamId!==profile.streamId)))throw Error();
 const metadata=value.metadata;
 if(!record(metadata)||metadata.timeZone!==profile.timezone||metadata.currencyCode!==profile.currency)throw Error();
 for(const key of ['subjectToThresholding','dataLossFromOtherRow'])if(metadata[key]!==undefined&&typeof metadata[key]!=='boolean')throw Error();
 if(metadata.emptyReason!==undefined&&typeof metadata.emptyReason!=='string')throw Error();
 if(metadata.samplingMetadatas!==undefined&&(!Array.isArray(metadata.samplingMetadatas)||metadata.samplingMetadatas.some(sample=>!record(sample)||typeof sample.samplesReadCount!=='string'||typeof sample.samplingSpaceSize!=='string'||!/^\d{1,20}$/.test(sample.samplesReadCount)||!/^\d{1,20}$/.test(sample.samplingSpaceSize)||BigInt(sample.samplesReadCount)>BigInt(sample.samplingSpaceSize))))throw Error();
 if(metadata.schemaRestrictionResponse!==undefined){const restrictions=metadata.schemaRestrictionResponse;if(!record(restrictions)||restrictions.activeMetricRestrictions!==undefined&&(!Array.isArray(restrictions.activeMetricRestrictions)||restrictions.activeMetricRestrictions.some(item=>!record(item)||typeof item.metricName!=='string'||!Array.isArray(item.restrictedMetricTypes)||item.restrictedMetricTypes.some(type=>typeof type!=='string'))))throw Error();}
 if(metadata.dataTruncationReasons!==undefined&&(!Array.isArray(metadata.dataTruncationReasons)||metadata.dataTruncationReasons.some(reason=>!record(reason))))throw Error();
}
function encode(value:unknown,profile:Ga4Profile){
 const json=JSON.stringify(value,jsonValue);if(typeof json!=='string'||Buffer.byteLength(json,'utf8')>maximumExpandedBytes)throw Error();const parsed:unknown=JSON.parse(json);report(parsed,profile);
 const sanitized=JSON.stringify(privateSafeGa4Report(parsed));if(Buffer.byteLength(sanitized,'utf8')>maximumExpandedBytes)throw Error();
 const compressed=gzipSync(sanitized,{maxOutputLength:maximumCompressedBytes});if(compressed.byteLength>maximumCompressedBytes)throw Error();return compressed.toString('base64');
}
function decode(payload:unknown,profile:Ga4Profile):Ga4Report{
 if(typeof payload!=='string'||!payload.length||payload.length>maximumEncodedCharacters||payload.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(payload))throw Error();
 const compressed=Buffer.from(payload,'base64');if(compressed.byteLength>maximumCompressedBytes||compressed.toString('base64')!==payload)throw Error();
 const json=gunzipSync(compressed,{maxOutputLength:maximumExpandedBytes}),value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(json),jsonValue);report(value,profile);return privateSafeGa4Report(value);
}
const insertPrefix='INSERT INTO ga4_report_cache (organizationId,clientId,propertyId,storeDate,kind,payload,capturedAt) ';
const insert=insertPrefix+'VALUES ';
const upsert=' ON CONFLICT(organizationId,clientId,propertyId,storeDate,kind) DO UPDATE SET payload=excluded.payload,capturedAt=excluded.capturedAt';
function values(identity:string[],item:Ga4CachedReport){const entry=day(item);return [...identity,entry.storeDate,entry.kind,encode(item.report,ga4ProfileForProperty(identity[2])),entry.capturedAt];}

export async function saveGa4Report(store:Pick<Store,'run'>,org:string,propertyId:string,item:Ga4CachedReport):Promise<void>{
 try{await store.run(insert+'(?,?,?,?,?,?,?)'+upsert,...values(scope(org,propertyId),item));}catch{throw Error('GA4 report cache could not be saved');}
}
export async function saveGa4DayReports(store:Pick<Store,'run'>,org:string,propertyId:string,items:Ga4CachedReport[],options?:{lease:{id:string;token:string}}):Promise<void>{
 try{
  const identity=scope(org,propertyId);if(!Array.isArray(items)||items.length!==3)throw Error();const entries=Array.from(items,day);
  if(new Set(entries.map(entry=>entry.kind)).size!==3||entries.some(entry=>entry.storeDate!==entries[0].storeDate||entry.capturedAt!==entries[0].capturedAt))throw Error();
  if(options!==undefined&&(!record(options)||!record(options.lease)||options.lease.id!==`${org}:${identity[1]}:ga4-sync`||typeof options.lease.token!=='string'||!/^[\x21-\x7e]{1,256}$/.test(options.lease.token)))throw Error();
  const bound=items.map(item=>values(identity,item)),lease=options?.lease;
  const sql=lease?insertPrefix+bound.map(()=>'SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM runner_leases WHERE id=? AND token=?)').join(' UNION ALL ')+upsert:insert+'(?,?,?,?,?,?,?),(?,?,?,?,?,?,?),(?,?,?,?,?,?,?)'+upsert;
  const result=await store.run(sql,...bound.flatMap(row=>lease?[...row,lease.id,lease.token]:row));if(result?.meta?.changes!==3)throw Error();
 }catch{throw Error('GA4 report cache day could not be saved');}
}
export async function loadGa4Reports(store:Pick<Store,'all'>,org:string,propertyId:string,from:string,to:string,options?:{kinds?:Ga4ReportKind[]}):Promise<Ga4CachedReport[]>{
 try{
  const identity=scope(org,propertyId),days=range(from,to);if(options!==undefined&&!record(options))throw Error();const selected=options?.kinds===undefined?kinds:options.kinds;
  if(!Array.isArray(selected)||!selected.length||selected.length>3||new Set(selected).size!==selected.length||selected.some(kind=>!kinds.includes(kind)))throw Error();
  const rows=await store.all<{storeDate:string;kind:Ga4ReportKind;capturedAt:string;payload:string}>(`SELECT storeDate,kind,capturedAt,payload FROM ga4_report_cache WHERE organizationId=? AND clientId=? AND propertyId=? AND storeDate BETWEEN ? AND ? AND kind IN (${selected.map(()=>'?').join(',')}) ORDER BY storeDate,kind LIMIT ?`,...identity,from,to,...selected,days*selected.length+1);
  if(!Array.isArray(rows)||rows.length>days*selected.length)throw Error();
  return rows.map(row=>{const entry=day(row);if(entry.storeDate<from||entry.storeDate>to||!selected.includes(entry.kind))throw Error();return {...entry,report:decode(row.payload,ga4ProfileForProperty(propertyId))};});
 }catch{throw Error('GA4 report cache could not be loaded');}
}
export async function ga4CachedDays(store:Pick<Store,'all'>,org:string,propertyId:string,from:string,to:string):Promise<Day[]>{
 try{
  const identity=scope(org,propertyId),days=range(from,to);
  const rows=await store.all<Day>('SELECT storeDate,kind,capturedAt FROM ga4_report_cache WHERE organizationId=? AND clientId=? AND propertyId=? AND storeDate BETWEEN ? AND ? ORDER BY storeDate,kind LIMIT ?',...identity,from,to,days*3+1);
  if(!Array.isArray(rows)||rows.length>days*3)throw Error();return rows.map(row=>{const entry=day(row);if(entry.storeDate<from||entry.storeDate>to)throw Error();return entry;});
 }catch{throw Error('GA4 report cache days could not be loaded');}
}
export async function pruneGa4Reports(store:Pick<Store,'run'>,org:string,propertyId:string,before:string):Promise<void>{
 try{const identity=scope(org,propertyId);if(!validDate(before))throw Error();await store.run('DELETE FROM ga4_report_cache WHERE organizationId=? AND clientId=? AND propertyId=? AND storeDate<?',...identity,before);}catch{throw Error('GA4 report cache could not be pruned');}
}
