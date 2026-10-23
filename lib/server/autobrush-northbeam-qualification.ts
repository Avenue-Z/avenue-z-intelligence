import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {dayWindow,shiftDate,todayIn} from '../analytics/windows';
import {createNorthbeamExport,discoverNorthbeamOptions,readNorthbeamExport,type NorthbeamConfig,type NorthbeamExportRequest,type NorthbeamExportJob} from '../sources/autobrush-northbeam';

// Fingerprint of the Autobrush Data-Client-ID used by the authenticated Oct 21
// discovery/export proof. The credential itself remains a Production secret.
const accountFingerprint='ecb409dff55a2162244e323d3ae806115fd62c40f93e8a6f421440021739edb9';
const profile='clicks-only-accrual-7d-daily-v1',aad='avenue-z:autobrush:northbeam:qualification:v1';
const inputSchema=z.object({date:z.string(),resume:z.string().min(1).max(4096).optional()}).strict();
const metricSchema=z.object({id:z.string().regex(/^[A-Za-z0-9:_-]{1,120}$/),label:z.string().regex(/^[A-Za-z0-9 ()+_/-]{1,100}$/)}).strict();
const stateSchema=z.object({date:z.string(),exportId:z.string().uuid(),metric:metricSchema,account:z.string(),issuedAt:z.number().int(),expiresAt:z.number().int()}).strict();
type Input=z.infer<typeof inputSchema>;
type Config=NorthbeamConfig&{sealingSecret:string};
type Budget={deadline:number;maxPolls?:number;pollDelayMs?:number};
export type NorthbeamReportingLifecycle={beforeCreate:()=>Promise<void>;knownExport:(resume:string)=>Promise<void>};
type Actual={dates:string[];accountingModes:string[];models:string[];windows:string[];currencies:string[];timezones:string[]};
type Summary={rowCount:number;files:number;fileHashes:string[];actual:Actual;currency:string|null;reportingTimezone:string|null;missingCells:{spend:number;attributedRevenue:number};totals:{spend:number|null;attributedRevenue:number|null}};
export type NorthbeamQualificationResult={clientId:'autobrush';provider:'northbeam';profile:string;date:string;grain:'daily';dateBasis:'provider_calendar_date';status:'failed'|'pending'|'scope-verified'|'scope-mismatch';reason?:string;reportingScopeValidated:boolean;qualifiedForActivation:false;sourceActivationPerformed:false;coverageThrough:null;sourceCoverageVerified:false;remainingGaps:string[];resume?:string;diagnostic?:{phase:string;providerCode?:string};discovery?:{metricCount:number;revenueCandidates:{id:string;label:string}[];selectedRevenueMetric?:{id:string;label:string}};requested?:NorthbeamExportRequest;summary?:Summary;export?:{id:string;createdAt:string;finishedAt:string|null}};
class QualificationError extends Error{constructor(readonly reason:string){super(reason);}}
function fail(reason:string):never{throw new QualificationError(reason);}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function result(date:string,status:NorthbeamQualificationResult['status'],reason?:string):NorthbeamQualificationResult{return {clientId:'autobrush',provider:'northbeam',profile,date,grain:'daily',dateBasis:'provider_calendar_date',status,...reason?{reason}:{},reportingScopeValidated:false,qualifiedForActivation:false,sourceActivationPerformed:false,coverageThrough:null,sourceCoverageVerified:false,remainingGaps:['independent_reconciliation_unverified','source_not_activated']};}
function key(secret:string){return createHash('sha256').update(aad).update(secret).digest();}
function seal(state:z.infer<typeof stateSchema>,secret:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(secret),iv);cipher.setAAD(Buffer.from(aad));return ['v1',iv.toString('base64url'),Buffer.concat([cipher.update(JSON.stringify(state),'utf8'),cipher.final()]).toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');}
function unseal(token:string,secret:string,date:string,account:string,now:number,lifetime=3600000){
 try{const parts=token.split('.');if(parts.length!==4||parts[0]!=='v1'||parts.slice(1).some(part=>!part||!/^[A-Za-z0-9_-]+$/.test(part)))throw Error();const iv=Buffer.from(parts[1],'base64url'),tag=Buffer.from(parts[3],'base64url');if(iv.length!==12||tag.length!==16)throw Error();const decipher=createDecipheriv('aes-256-gcm',key(secret),iv);decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(tag);const state=stateSchema.parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[2],'base64url')),decipher.final()]).toString('utf8')));if(state.date!==date||state.account!==account||state.issuedAt>now+300000||state.expiresAt<=now||state.expiresAt-state.issuedAt!==lifetime)throw Error();return state;}catch{fail('invalid_resume');}
}
function request(date:string,metric:{id:string;label:string}):NorthbeamExportRequest{return {export_file_name:`avenuez_autobrush_accrual7_${date.replaceAll('-','')}`,level:'platform',time_granularity:'DAILY',period_type:'FIXED',period_options:{period_starting_at:`${date}T00:00:00.000Z`,period_ending_at:`${date}T23:59:59.999Z`},attribution_options:{attribution_models:['northbeam_custom'],attribution_windows:['7'],accounting_modes:['accrual']},metrics:[{id:'spend',label:'nb_spend'},{id:metric.id,label:'nb_attributed_revenue'}],breakdowns:[],options:{export_aggregation:'DATE',remove_zero_spend:false,aggregate_data:true,include_ids:false,include_kind_and_platform:false}};}
function validDate(date:string,now:Date,reporting=false){const today=todayIn(reporting?'America/Detroit':'America/New_York',now);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||(reporting?date>today:date>=today)||date<shiftDate(today,-29))fail('invalid_closed_date');try{dayWindow(date,reporting?'America/Detroit':'America/New_York');}catch{fail('invalid_closed_date');}}
function selectedMetric(metrics:readonly {id:string;label?:string|null}[]){
 const found=metrics.filter(metric=>metric.id!=='rev'&&typeof metric.label==='string'&&/^attributed (?:rev|revenue)(?: \(7d\))?$/i.test(metric.label.trim()));
 if(found.length!==1)fail('attributed_revenue_metric_unavailable_or_ambiguous');
 const selected=metricSchema.safeParse(found[0]);if(!selected.success)fail('invalid_revenue_metric');return selected.data;
}
function safeValue(value:string,secrets:readonly string[]){if(!value||value.length>100||secrets.some(secret=>secret&&value.includes(secret))||!/^[A-Za-z0-9_+ .():/-]+$/.test(value))return '[invalid]';return value;}
function csvRows(text:string){
 const records:string[][]=[];let row:string[]=[],field='',quoted=false,closed=false;
 const fieldDone=()=>{if(row.length>=64)fail('csv_column_limit');row.push(field);field='';closed=false;};
 const rowDone=()=>{if(row.some(value=>value!=='')){records.push(row);if(records.length>50001)fail('csv_row_limit');}row=[];};
 for(let i=0;i<text.length;i++){
  const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;}
  else if(c==='"'){if(field||closed)fail('invalid_csv');quoted=true;}
  else if(c===','){fieldDone();}
  else if(c==='\r'||c==='\n'){fieldDone();rowDone();if(c==='\r'&&text[i+1]==='\n')i++;}
  else{if(closed)fail('invalid_csv');field+=c;}
  if(field.length>8192)fail('csv_field_limit');
 }
 if(quoted)fail('invalid_csv');if(field||row.length||closed){fieldDone();rowDone();}
 if(records.length<2)fail('empty_export');const headers=records.shift()!.map(value=>value.replace(/^\uFEFF/,'').trim().toLowerCase());
 if(new Set(headers).size!==headers.length||headers.some(value=>!value||!/^[a-z0-9_ ]{1,100}$/.test(value))||['date','accounting_mode','attribution_model','attribution_window','nb_spend','nb_attributed_revenue'].some(header=>!headers.includes(header)))fail('invalid_csv_columns');
 if(records.some(row=>row.length!==headers.length))fail('invalid_csv');return records.map(row=>Object.fromEntries(headers.map((header,index)=>[header,row[index]])));
}
function downloadUrl(value:string){try{const url=new URL(value),host=url.hostname.toLowerCase();if(url.protocol!=='https:'||url.username||url.password||url.port||!(host==='storage.googleapis.com'||host.endsWith('.storage.googleapis.com')||host==='s3.amazonaws.com'||/\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host)||host==='documents.northbeam.io'||host.endsWith('.documents.northbeam.io')))throw Error();return url.toString();}catch{fail('unsafe_export_download');}}
async function download(url:string,fetcher:typeof fetch,deadline:number){
 const remaining=deadline-Date.now();if(remaining<=0)fail('qualification_deadline');const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();void reader?.cancel().catch(()=>{});reject(new QualificationError('export_download_timeout'));},Math.min(30000,remaining));});
 try{return await Promise.race([timeout,(async()=>{const response=await fetcher(downloadUrl(url),{method:'GET',redirect:'error',cache:'no-store',signal:controller.signal,headers:{Accept:'text/csv'}});if(!response.ok||response.redirected)fail('export_download_failed');if(Number(response.headers.get('content-length'))>20000000)fail('export_size_limit');reader=response.body?.getReader();if(!reader)fail('invalid_csv');let size=0,text='';const decoder=new TextDecoder('utf8',{fatal:true});for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>20000000)fail('export_size_limit');text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();return {text,size};})()]);}finally{clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>{});}
}
function number(value:string,spend=false){if(value==='')return null;if(!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value))fail('invalid_export_metric');const n=Number(value);if(!Number.isFinite(n)||spend&&n<0)fail('invalid_export_metric');return n;}
async function summarize(files:readonly string[],date:string,config:Config,fetcher:typeof fetch,deadline:number){
 if(files.length<1||files.length>4||new Set(files).size!==files.length)fail('invalid_export_files');
 const actual:Actual={dates:[],accountingModes:[],models:[],windows:[],currencies:[],timezones:[]},sets=Object.fromEntries(Object.keys(actual).map(key=>[key,new Set<string>()])) as Record<keyof Actual,Set<string>>;
 let rowCount=0,size=0,spend=0,revenue=0,scope=true;const missingCells={spend:0,attributedRevenue:0},fileHashes:string[]=[],seen=new Set<string>();
 for(const file of files){const document=await download(file,fetcher,deadline);size+=document.size;if(size>20000000)fail('export_size_limit');fileHashes.push(hash(document.text));for(const row of csvRows(document.text)){
  if(++rowCount>50000)fail('csv_row_limit');
  const values={dates:row.date,accountingModes:row.accounting_mode,models:row.attribution_model,windows:row.attribution_window};
  for(const [key,value]of Object.entries(values))sets[key as keyof Actual].add(safeValue(value,[config.apiKey,config.dataClientId]));
  for(const key of ['reporting_currency','currency','currency_code'])if(row[key])sets.currencies.add(safeValue(row[key],[config.apiKey,config.dataClientId]));
  for(const key of ['reporting_timezone','account_timezone','timezone','iana_timezone'])if(row[key])sets.timezones.add(safeValue(row[key],[config.apiKey,config.dataClientId]));
  const dimensions=Object.entries(row).filter(([key])=>!['nb_spend','nb_attributed_revenue'].includes(key)).sort(([a],[b])=>a.localeCompare(b));const rowKey=JSON.stringify(dimensions);
  if(seen.has(rowKey))fail('duplicate_export_rows');seen.add(rowKey);
  const s=number(row.nb_spend,true),r=number(row.nb_attributed_revenue);if(s===null)missingCells.spend++;else spend+=s;if(r===null)missingCells.attributedRevenue++;else revenue+=r;
  if(row.date!==date||!['accrual','accrual performance'].includes(row.accounting_mode.toLowerCase())||!['Clicks only','northbeam_custom'].includes(row.attribution_model)||row.attribution_window!=='7')scope=false;
 }}
 for(const key of Object.keys(actual) as (keyof Actual)[]){if(sets[key].size>32)fail('ambiguous_export_metadata');actual[key]=[...sets[key]].sort();}
 const currency=actual.currencies.length===1&&/^[A-Z]{3}$/.test(actual.currencies[0])?actual.currencies[0]:null;let reportingTimezone:string|null=null;
 if(actual.timezones.length===1)try{new Intl.DateTimeFormat('en',{timeZone:actual.timezones[0]}).format();reportingTimezone=actual.timezones[0];}catch{/* Invalid provider timezone remains unavailable. */}
 if(actual.currencies.length>1||actual.timezones.length>1)scope=false;
 if(!rowCount)fail('empty_export');scope&&=missingCells.spend===0&&missingCells.attributedRevenue===0;
 if(!Number.isFinite(spend)||!Number.isFinite(revenue))fail('invalid_export_metric');
 const summary:Summary={rowCount,files:files.length,fileHashes,actual,currency,reportingTimezone,missingCells,totals:{spend:scope?Number(spend.toFixed(6)):null,attributedRevenue:scope?Number(revenue.toFixed(6)):null}};
 return {summary,scope};
}

/** Internal fixed-profile engine; only the wrapper below obtains production
 * credentials. There are no database, source-registration or activation writes. */
export async function qualifyNorthbeamDailyProfile(raw:unknown,config:Config,fetcher:typeof fetch=fetch,now=new Date(),budget:Budget={deadline:Date.now()+180000},lifecycle?:NorthbeamReportingLifecycle):Promise<NorthbeamQualificationResult>{
 let date='',phase='input',job:NorthbeamExportJob|undefined,revenueMetric:{id:string;label:string}|undefined,discovery:NorthbeamQualificationResult['discovery'],resume:string|undefined;
 try{
  const parsed=inputSchema.safeParse(raw);if(!parsed.success)fail('invalid_request');const input:Input=parsed.data;date=input.date;validDate(date,now,!!lifecycle);
  if(!config.apiKey||!config.dataClientId||config.sealingSecret.length<32)fail('server_credentials_unavailable');if(!Number.isFinite(budget.deadline)||budget.deadline<=Date.now())fail('qualification_deadline');
  const credentials={apiKey:config.apiKey,dataClientId:config.dataClientId},account=hash(config.dataClientId),identity={clientId:'autobrush' as const,dataClientId:config.dataClientId};
  const saved=input.resume?unseal(input.resume,config.sealingSecret,date,account,now.getTime(),lifecycle?604800000:3600000):undefined;
  phase='discovery';const options=await discoverNorthbeamOptions(credentials,identity,fetcher,budget.deadline);
  discovery={metricCount:options.metrics.length,revenueCandidates:options.metrics.flatMap(metric=>{const parsed=metricSchema.safeParse(metric);return parsed.success&&/^attributed (?:rev|revenue)(?:$|[ (])/i.test(parsed.data.label)&&![config.apiKey,config.dataClientId].some(secret=>parsed.data.id.includes(secret)||parsed.data.label.includes(secret))?[parsed.data]:[];}).slice(0,16)};
  revenueMetric=selectedMetric(options.metrics);
  if(!options.metrics.some(metric=>metric.id==='spend')||!options.attributionModels.some(model=>model.id==='northbeam_custom'&&model.name==='Clicks only'))fail('fixed_profile_not_discovered');
  if([revenueMetric.id,revenueMetric.label].some(value=>value.includes(config.apiKey)||value.includes(config.dataClientId)))fail('invalid_revenue_metric');
  discovery.selectedRevenueMetric=revenueMetric;
  if(saved){if(saved.metric.id!==revenueMetric.id||saved.metric.label!==revenueMetric.label)fail('resume_metric_changed');job={exportId:saved.exportId,identity,request:request(date,revenueMetric)};}
  else{if(lifecycle){phase='checkpoint';await lifecycle.beforeCreate();}phase='creation';job=await createNorthbeamExport(credentials,identity,options,request(date,revenueMetric),fetcher,budget.deadline);}
  resume=input.resume??seal({date,exportId:job.exportId,metric:revenueMetric,account,issuedAt:now.getTime(),expiresAt:now.getTime()+(lifecycle?604800000:3600000)},config.sealingSecret);
  if(lifecycle){phase='checkpoint';await lifecycle.knownExport(resume);}
  phase='result';const polls=Math.max(1,Math.min(30,budget.maxPolls??20)),delay=Math.max(0,Math.min(5000,budget.pollDelayMs??2000));
  for(let attempt=0;attempt<polls;attempt++){
   if(Date.now()+1000>=budget.deadline)break;
   const exported=await readNorthbeamExport(credentials,identity,job,fetcher,budget.deadline);
   if(exported.status==='ERROR')fail('provider_export_failed');
   if(exported.status==='SUCCESS'){
    phase='download';const {summary,scope}=await summarize(exported.files,date,config,fetcher,budget.deadline),out=result(date,scope?'scope-verified':'scope-mismatch',scope?undefined:'returned_scope_or_metric_mismatch');
    out.reportingScopeValidated=scope;out.discovery=discovery;out.requested=job.request;out.summary=summary;out.export={id:job.exportId,createdAt:exported.createdAt,finishedAt:exported.finishedAt};out.resume=resume;
    if(!summary.currency)out.remainingGaps.unshift('currency_unverified');if(!summary.reportingTimezone)out.remainingGaps.unshift('reporting_timezone_unverified');return out;
   }
   if(attempt+1<polls&&Date.now()+delay+1000<budget.deadline)await new Promise(resolve=>setTimeout(resolve,delay));else break;
  }
  return {...result(date,'pending','export_pending'),resume,discovery,requested:job.request};
 }catch(error){
  const reason=error instanceof QualificationError?error.reason:phase==='checkpoint'?'durable_checkpoint_failed':phase==='creation'?'export_creation_unconfirmed':phase==='result'?'result_temporarily_unavailable':phase==='download'?'export_download_failed':'provider_discovery_failed';
  const pending=job&&['result_temporarily_unavailable','export_download_timeout'].includes(reason);
  const status=error instanceof Error?error.message.match(/^Northbeam request returned HTTP (\d{3})$/)?.[1]:undefined;
  return {...result(date,pending?'pending':'failed',reason),diagnostic:{phase,...status?{providerCode:`http_${status}`}:{}} ,...resume?{resume}:{},...discovery?{discovery}:{}};
 }
}
/** Fixed Autobrush account scope; caller input can supply only date and a sealed
 * resume handle. Secrets are read here on the server and never returned. */
export async function qualifyAutobrushNorthbeam(input:unknown,secret:(key:string)=>string|null,fetcher:typeof fetch=fetch,now=new Date()):Promise<NorthbeamQualificationResult>{
 const apiKey=secret('AUTOBRUSH_NORTHBEAM_API_KEY'),dataClientId=secret('AUTOBRUSH_NORTHBEAM_DATA_CLIENT_ID'),sealingSecret=secret('AUTH_SECRET');
 if(!apiKey||!dataClientId||!sealingSecret||sealingSecret.length<32)return result('','failed','server_credentials_unavailable');
 if(hash(dataClientId)!==accountFingerprint)return result('','failed','autobrush_account_mismatch');
 return qualifyNorthbeamDailyProfile(input,{apiKey,dataClientId,sealingSecret},fetcher,now);
}

/** Routine reporting uses the independently reconciled fixed account profile.
 * Durable callbacks must acknowledge creation intent and the sealed identity. */
export async function qualifyAutobrushNorthbeamReportingDay(input:{date:string;resume?:string},secret:(key:string)=>string|null,lifecycle:NorthbeamReportingLifecycle,fetcher:typeof fetch=fetch,now=new Date(),budget:Budget={deadline:Date.now()+120000,maxPolls:4,pollDelayMs:2000}){
 const apiKey=secret('AUTOBRUSH_NORTHBEAM_API_KEY'),dataClientId=secret('AUTOBRUSH_NORTHBEAM_DATA_CLIENT_ID'),sealingSecret=secret('AUTH_SECRET');
 if(!apiKey||!dataClientId||!sealingSecret||sealingSecret.length<32)return result(input.date,'failed','server_credentials_unavailable');
 if(hash(dataClientId)!==accountFingerprint)return result(input.date,'failed','autobrush_account_mismatch');
 return qualifyNorthbeamDailyProfile(input,{apiKey,dataClientId,sealingSecret},fetcher,now,budget,lifecycle);
}
