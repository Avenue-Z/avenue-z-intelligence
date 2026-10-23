import {describe,expect,it} from 'vitest';
import {qualifyAutobrushNorthbeam,qualifyNorthbeamDailyProfile,qualifyAutobrushNorthbeamReportingDay} from '../../lib/server/autobrush-northbeam-qualification';
const config={apiKey:'fixture-private-api-key',dataClientId:'fixture-autobrush-account',sealingSecret:'fixture-sealing-secret-that-is-long-enough'};
const now=new Date('2026-10-22T15:00:00Z'),date='2026-10-21',id='3c90c3cc-0d44-4b50-8888-8dd25736052a';
const base='https://api.northbeam.io/v1/exports',file='https://storage.googleapis.com/northbeam-private/export.csv?signature=private-download';
const header='date,breakdown_platform_northbeam,accounting_mode,attribution_model,attribution_window,nb_spend,nb_attributed_revenue';
const csv=()=>`${header}\r\n${date},Meta,Accrual performance,Clicks only,7,25.5,100\r\n${date},Google,Accrual performance,Clicks only,7,4.5,20\r\n`;
const metrics=[{id:'rev',label:'Rev'},{id:'actual_attributed_rev_id',label:'Attributed Rev'},{id:'spend',label:'Spend'},{id:'new_attr',label:'Attributed Rev (New)'}];
type Changes={metrics?:unknown;csv?:string;pending?:boolean;postFailure?:boolean;downloadHost?:string;resultFailure?:boolean;files?:string[];csvByUrl?:Record<string,string>};
function fixture(changes:Changes={}){
 const calls:{url:string;method:string;body?:unknown;headers:Headers}[]=[];
 const fetcher=(async(input,init)=>{
  const url=String(input),method=init?.method??'GET';calls.push({url,method,body:init?.body?JSON.parse(String(init.body)):undefined,headers:new Headers(init?.headers)});
  if(url===base+'/metrics')return Response.json({metrics:changes.metrics??metrics});
  if(url===base+'/attribution-models')return Response.json({attribution_models:[{id:'northbeam_custom',name:'Clicks only'}]});
  if(url===base+'/breakdowns')return Response.json({breakdowns:[]});
  if(url===base+'/data-export'){if(changes.postFailure)throw Error(config.apiKey+' '+file);return Response.json({id},{status:201});}
  if(url===base+'/data-export/result/'+id){if(changes.resultFailure)throw Error(config.apiKey+' '+file);return Response.json({data_export_id:id,status:changes.pending?'PENDING':'SUCCESS',result:changes.pending?[]:changes.files??[changes.downloadHost??file],created_at:'2026-10-22T14:58:00Z',finished_at:changes.pending?null:'2026-10-22T14:59:00Z'});}
  if(url===(changes.downloadHost??file)||changes.files?.includes(url))return new Response(changes.csvByUrl?.[url]??changes.csv??csv(),{headers:{'content-type':'text/csv'}});
  throw Error('Unexpected fixture request');
 }) as typeof fetch;return {calls,fetcher};
}
async function run(changes:Changes={},input:{date:string;resume?:string}={date}){const io=fixture(changes);return {result:await qualifyNorthbeamDailyProfile(input,config,io.fetcher,now,{deadline:Date.now()+10000,maxPolls:1,pollDelayMs:0}),calls:io.calls};}
describe('fixed Northbeam daily accrual qualification',()=>{
 it('discovers actual attributed revenue and preserves a single closed daily profile without activation',async()=>{
  const {result,calls}=await run();expect(calls.find(call=>call.method==='POST')!.body).toMatchObject({level:'platform',time_granularity:'DAILY',period_type:'FIXED',period_options:{period_starting_at:'2026-10-21T00:00:00.000Z',period_ending_at:'2026-10-21T23:59:59.999Z'},attribution_options:{attribution_models:['northbeam_custom'],attribution_windows:['7'],accounting_modes:['accrual']},metrics:[{id:'spend',label:'nb_spend'},{id:'actual_attributed_rev_id',label:'nb_attributed_revenue'}],breakdowns:[],options:{export_aggregation:'DATE',remove_zero_spend:false,aggregate_data:true,include_ids:false,include_kind_and_platform:false}});
  expect(result).toMatchObject({clientId:'autobrush',provider:'northbeam',status:'scope-verified',reportingScopeValidated:true,qualifiedForActivation:false,sourceActivationPerformed:false,coverageThrough:null,grain:'daily',date,summary:{rowCount:2,totals:{spend:30,attributedRevenue:120},actual:{dates:[date],accountingModes:['Accrual performance'],models:['Clicks only'],windows:['7'],currencies:[],timezones:[]},currency:null,reportingTimezone:null}});
  expect(result.remainingGaps).toEqual(expect.arrayContaining(['currency_unverified','reporting_timezone_unverified','independent_reconciliation_unverified','source_not_activated']));
  const download=calls.find(call=>call.url===file)!;expect(download.headers.has('authorization')).toBe(false);expect(download.headers.has('data-client-id')).toBe(false);
  for(const privateText of [config.apiKey,config.dataClientId,'signature='])expect(JSON.stringify(result)).not.toContain(privateText);expect(result).not.toHaveProperty('rows');
 });
 it('retains explicit provider currency and Los Angeles timezone without inventing New York coverage',async()=>{
  const body=csv().replace(header,header+',reporting_currency,reporting_timezone').replaceAll(',25.5,100',',25.5,100,USD,America/Los_Angeles').replaceAll(',4.5,20',',4.5,20,USD,America/Los_Angeles');const {result}=await run({csv:body});expect(result.summary).toMatchObject({currency:'USD',reportingTimezone:'America/Los_Angeles'});expect(result.qualifiedForActivation).toBe(false);expect(result.coverageThrough).toBeNull();
 });
 it.each(['cash-only','missing','ambiguous'])('never substitutes cash when attributed discovery is %s',async kind=>{
  const found=kind==='cash-only'?[metrics[0],metrics[2]]:kind==='missing'?[metrics[2]]:[...metrics,{id:'other_attr',label:'Attributed Revenue'}];const {result,calls}=await run({metrics:found});expect(result.reason).toBe('attributed_revenue_metric_unavailable_or_ambiguous');expect(calls.filter(call=>call.method==='POST')).toEqual([]);
 });
 it.each(['2026-10-22','2026-10-23','2026-09-31','2026-09-01'])('rejects invalid closed date %s before provider reads',async date=>{const {result,calls}=await run({},{date});expect(result.reason).toBe('invalid_closed_date');expect(calls).toEqual([]);});
 it.each(['cash','window','model','extra-date','blank'])('keeps %s output unavailable rather than relabeling or partially summing it',async kind=>{
  const bad=kind==='cash'?csv().replaceAll('Accrual performance','Cash snapshot'):kind==='window'?csv().replaceAll(',7,',',1,'):kind==='model'?csv().replaceAll('Clicks only','Last touch'):kind==='blank'?csv().replace(',25.5,100',',25.5,'):csv()+`2026-10-22,Meta,Accrual performance,Clicks only,7,8,30\r\n`;
  const {result}=await run({csv:bad});expect(result.status).toBe('scope-mismatch');expect(result.reportingScopeValidated).toBe(false);expect(result.summary?.totals).toEqual({spend:null,attributedRevenue:null});if(kind==='blank')expect(result.summary?.missingCells.attributedRevenue).toBe(1);
 });
 it.each(['duplicate-header','broken-quote','nonfinite','empty','repeated-file','unsafe-download'])('fails safely for %s data',async kind=>{
  const change=kind==='duplicate-header'?{csv:csv().replace(header,header+',nb_spend')}:kind==='broken-quote'?{csv:header+'\n"unterminated'}:kind==='nonfinite'?{csv:csv().replace(',25.5,100',',NaN,100')}:kind==='empty'?{csv:header+'\n'}:kind==='repeated-file'?{files:[file,file]}:{downloadHost:'https://127.0.0.1/private.csv'};
  const {result,calls}=await run(change);expect(result.status).toBe('failed');expect(result.qualifiedForActivation).toBe(false);expect(JSON.stringify(result)).not.toContain('signature=');if(kind==='unsafe-download')expect(calls.some(call=>call.url.includes('127.0.0.1'))).toBe(false);
 });
 it('seals a pending handle and resumes that exact export without another creation',async()=>{const first=await run({pending:true});expect(first.result.status).toBe('pending');expect(typeof first.result.resume).toBe('string');const second=await run({},{date,resume:first.result.resume});expect(second.result.status).toBe('scope-verified');expect(second.calls.filter(call=>call.method==='POST')).toEqual([]);});
 it('retains resumability after a known result transport failure',async()=>{const {result,calls}=await run({resultFailure:true});expect(result.status).toBe('pending');expect(result.reason).toBe('result_temporarily_unavailable');expect(typeof result.resume).toBe('string');expect(calls.filter(call=>call.method==='POST')).toHaveLength(1);});
 it('never retries an ambiguous export creation or exposes private error text',async()=>{const {result,calls}=await run({postFailure:true});expect(result.reason).toBe('export_creation_unconfirmed');expect(result.resume).toBeUndefined();expect(calls.filter(call=>call.method==='POST')).toHaveLength(1);expect(JSON.stringify(result)).not.toContain(config.apiKey);});
 it('rejects altered and date-swapped resume handles before arbitrary result reads',async()=>{const first=await run({pending:true});for(const input of [{date,resume:first.result.resume+'x'},{date:'2026-10-20',resume:first.result.resume}]){const {result,calls}=await run({},input);expect(result.reason).toBe('invalid_resume');expect(calls).toEqual([]);}});
 it('rejects another server account fingerprint before using its credentials',async()=>{const io=fixture(),secret=(key:string)=>key==='AUTH_SECRET'?config.sealingSecret:key==='AUTOBRUSH_NORTHBEAM_API_KEY'?config.apiKey:key==='AUTOBRUSH_NORTHBEAM_DATA_CLIENT_ID'?config.dataClientId:null;const result=await qualifyAutobrushNorthbeam({date},secret,io.fetcher,now);expect(result.reason).toBe('autobrush_account_mismatch');expect(io.calls).toEqual([]);});
});
it('returns safe discovered attributed-revenue candidates when the requested definition is ambiguous',async()=>{
 const {result}=await run({metrics:[...metrics,{id:'other_attr',label:'Attributed Revenue'}]});
 expect(result.discovery).toMatchObject({metricCount:5,revenueCandidates:expect.arrayContaining([{id:'actual_attributed_rev_id',label:'Attributed Rev'},{id:'other_attr',label:'Attributed Revenue'}])});
});
it('reports only a static HTTP diagnostic for a rejected provider discovery',async()=>{
 const fetcher=(async()=>Response.json({error:config.apiKey},{status:401})) as typeof fetch;
 const result=await qualifyNorthbeamDailyProfile({date},config,fetcher,now,{deadline:Date.now()+10000,maxPolls:1,pollDelayMs:0});
 expect(result.diagnostic).toEqual({phase:'discovery',providerCode:'http_401'});expect(JSON.stringify(result)).not.toContain(config.apiKey);
});

it('rejects the same semantic row repeated across files with reordered CSV headers',async()=>{
 const second='https://storage.googleapis.com/northbeam-private/second.csv?signature=private-second';
 const first=header+'\r\n2026-10-21,Meta,Accrual performance,Clicks only,7,25.5,100\r\n';
 const reordered='nb_attributed_revenue,nb_spend,attribution_window,attribution_model,accounting_mode,breakdown_platform_northbeam,date\r\n100,25.5,7,Clicks only,Accrual performance,Meta,2026-10-21\r\n';
 const {result}=await run({files:[file,second],csvByUrl:{[file]:first,[second]:reordered}});
 expect(result.status).toBe('failed');expect(result.reason).toBe('duplicate_export_rows');expect(result.qualifiedForActivation).toBe(false);
});
it('omits private email and control content from discovered revenue candidate labels',async()=>{
 const {result}=await run({metrics:[...metrics,{id:'custom_private_metric',label:'Attributed Rev contact@example.com'},{id:'control_private_metric',label:'Attributed Rev\nprivate'}]});
 expect(result.status).toBe('scope-verified');expect(JSON.stringify(result)).not.toContain('contact@example.com');expect(JSON.stringify(result.discovery)).not.toContain('\\n');
});
it('does not overflow finite totals while formatting the aggregate proof',async()=>{
 const {result}=await run({csv:header+'\r\n2026-10-21,Meta,Accrual performance,Clicks only,7,1e308,1e308\r\n'});
 expect(result.status).toBe('scope-verified');expect(Number.isFinite(result.summary?.totals.spend)).toBe(true);expect(Number.isFinite(result.summary?.totals.attributedRevenue)).toBe(true);
});

it('checkpoints before the only POST and seals its known identity before polling',async()=>{
 const io=fixture({pending:true}),order:string[]=[];const fetcher=(async(input,init)=>{if(init?.method==='POST')order.push('post');if(String(input).includes('/result/'))order.push('poll');return io.fetcher(input,init);}) as typeof fetch;
 const result=await qualifyNorthbeamDailyProfile({date:'2026-10-22'},config,fetcher,now,{deadline:Date.now()+10000,maxPolls:1,pollDelayMs:0},{beforeCreate:async()=>{order.push('before');},knownExport:async token=>{expect(token).toMatch(/^v1\./);order.push('known');}});
 expect(result.status).toBe('pending');expect(order).toEqual(['before','post','known','poll']);
});
it('never creates if durable pre-creation confirmation fails',async()=>{
 const io=fixture();const result=await qualifyNorthbeamDailyProfile({date},config,io.fetcher,now,{deadline:Date.now()+10000,maxPolls:1},{beforeCreate:async()=>{throw Error('private database detail');},knownExport:async()=>{}});
 expect(result.reason).toBe('durable_checkpoint_failed');expect(io.calls.filter(call=>call.method==='POST')).toHaveLength(0);expect(JSON.stringify(result)).not.toContain('private database');
});
it('does not poll an export until known identity persistence is acknowledged',async()=>{
 const io=fixture();const result=await qualifyNorthbeamDailyProfile({date},config,io.fetcher,now,{deadline:Date.now()+10000,maxPolls:1},{beforeCreate:async()=>{},knownExport:async()=>{throw Error('private storage detail');}});
 expect(result.reason).toBe('durable_checkpoint_failed');expect(io.calls.filter(call=>call.method==='POST')).toHaveLength(1);expect(io.calls.some(call=>call.url.includes('/result/'))).toBe(false);
});
it('resumes durable reporting beyond one hour and cannot use a reporting handle in qualification',async()=>{
 const io=fixture({pending:true}),hooks={beforeCreate:async()=>{},knownExport:async()=>{}};const first=await qualifyNorthbeamDailyProfile({date},config,io.fetcher,now,{deadline:Date.now()+10000,maxPolls:1},hooks);
 const next=fixture();const result=await qualifyNorthbeamDailyProfile({date,resume:first.resume},config,next.fetcher,new Date(now.getTime()+7200000),{deadline:Date.now()+10000,maxPolls:1},hooks);expect(result.status).toBe('scope-verified');expect(next.calls.filter(call=>call.method==='POST')).toHaveLength(0);
 const isolated=await run({},{date,resume:first.resume});expect(isolated.result.reason).toBe('invalid_resume');
});
it('expires durable handles without provider reads or replacement export creation',async()=>{
 const io=fixture({pending:true}),hooks={beforeCreate:async()=>{},knownExport:async()=>{}};const first=await qualifyNorthbeamDailyProfile({date},config,io.fetcher,now,{deadline:Date.now()+10000,maxPolls:1},hooks);const after=fixture();
 const result=await qualifyNorthbeamDailyProfile({date,resume:first.resume},config,after.fetcher,new Date('2026-10-30T15:00:00Z'),{deadline:Date.now()+10000,maxPolls:1},hooks);expect(result.reason).toBe('invalid_resume');expect(after.calls).toEqual([]);
});
it('uses the Detroit reporting calendar at midnight while keeping the closed qualifier unchanged',async()=>{
 const io=fixture(),hooks={beforeCreate:async()=>{},knownExport:async()=>{}};const result=await qualifyNorthbeamDailyProfile({date:'2026-10-22'},config,io.fetcher,new Date('2026-10-22T02:00:00Z'),{deadline:Date.now()+10000,maxPolls:1},hooks);expect(result.reason).toBe('invalid_closed_date');expect(io.calls).toEqual([]);
});

it('pins routine reporting to the same fixed Autobrush account before provider or checkpoint calls',async()=>{
 const io=fixture(),calls:string[]=[],secrets:Record<string,string>={AUTH_SECRET:config.sealingSecret,AUTOBRUSH_NORTHBEAM_API_KEY:config.apiKey,AUTOBRUSH_NORTHBEAM_DATA_CLIENT_ID:config.dataClientId};
 const result=await qualifyAutobrushNorthbeamReportingDay({date},key=>secrets[key]??null,{beforeCreate:async()=>{calls.push('create');},knownExport:async()=>{calls.push('known');}},io.fetcher,now);expect(result.reason).toBe('autobrush_account_mismatch');expect(io.calls).toEqual([]);expect(calls).toEqual([]);
});
