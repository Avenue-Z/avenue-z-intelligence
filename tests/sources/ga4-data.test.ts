import {afterEach,expect,it,vi} from 'vitest';
import {ga4RunReport,type Ga4ReportRequest} from '../../lib/sources/ga4-data';

const token='ga4-private-test-access-token',propertyId='292550743';
const request:Ga4ReportRequest={from:'2026-10-14',to:'2026-10-15',dimensions:['sessionSource'],metrics:['sessions']};
const metadata={timeZone:'America/New_York',currencyCode:'USD'};
const metricTypes:Record<string,string>={sessions:'TYPE_INTEGER',engagedSessions:'TYPE_INTEGER',screenPageViews:'TYPE_INTEGER',activeUsers:'TYPE_INTEGER',totalUsers:'TYPE_INTEGER',ecommercePurchases:'TYPE_INTEGER',purchaseRevenue:'TYPE_CURRENCY',sessionKeyEventRate:'TYPE_FLOAT',averageSessionDuration:'TYPE_SECONDS',bounceRate:'TYPE_FLOAT',addToCarts:'TYPE_INTEGER',checkouts:'TYPE_INTEGER'};
const json=(value:unknown,headers:HeadersInit={})=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json; charset=UTF-8',...headers}});
function report(input=request,count=1,offset=0,length=Math.min(1000,count-offset)){
 return {
  dimensionHeaders:input.dimensions.map(name=>({name})),metricHeaders:input.metrics.map(name=>({name,type:metricTypes[name]})),
  rows:Array.from({length},(_,index)=>({dimensionValues:input.dimensions.map(()=>({value:`source-${offset+index}`})),metricValues:input.metrics.map(()=>({value:'2'}))})),
  rowCount:count,metadata:{...metadata},
 };
}
function fixture(responder:(body:Record<string,unknown>,index:number)=>Response|Promise<Response>=()=>json(report())){
 const calls:{url:string;init:RequestInit;body:Record<string,unknown>}[]=[];
 const fetcher:typeof fetch=async(url,init)=>{const body=JSON.parse(String(init?.body));calls.push({url:String(url),init:init!,body});return responder(body,calls.length-1);};
 return {fetcher,calls};
}
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllGlobals();});

it('posts to the exact property endpoint and returns named rows with unscaled numeric metrics',async()=>{
 const input={...request,dimensions:['dateHour','countryId'],metrics:['sessions','purchaseRevenue','bounceRate','averageSessionDuration']};
 const response={...report(input),rows:[{dimensionValues:[{value:'2026101413'},{value:'US'}],metricValues:[{value:'12'},{value:'43.25'},{value:'0.125'},{value:'17.5'}]}]};
 const {fetcher,calls}=fixture(()=>json(response));
 expect(await ga4RunReport(token,propertyId,input,fetcher)).toEqual({
  dimensionHeaders:[{name:'dateHour'},{name:'countryId'}],metricHeaders:[{name:'sessions',type:'TYPE_INTEGER'},{name:'purchaseRevenue',type:'TYPE_CURRENCY'},{name:'bounceRate',type:'TYPE_FLOAT'},{name:'averageSessionDuration',type:'TYPE_SECONDS'}],
  rows:[{dimensions:{dateHour:'2026101413',countryId:'US'},metrics:{sessions:12,purchaseRevenue:43.25,bounceRate:0.125,averageSessionDuration:17.5}}],rowCount:1,metadata,
 });
 expect(calls).toHaveLength(1);expect(calls[0].url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/292550743:runReport');
 expect(calls[0].init.method).toBe('POST');expect(calls[0].init.redirect).toBe('error');expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
 expect(new Headers(calls[0].init.headers).get('Authorization')).toBe(`Bearer ${token}`);expect(new Headers(calls[0].init.headers).get('Content-Type')).toBe('application/json');
 expect(calls[0].body).toEqual({dateRanges:[{startDate:'2026-10-14',endDate:'2026-10-15'}],dimensions:[{name:'dateHour'},{name:'countryId'}],metrics:input.metrics.map(name=>({name})),limit:'1000',offset:'0',keepEmptyRows:true,orderBys:[{dimension:{dimensionName:'dateHour',orderType:'ALPHANUMERIC'},desc:false},{dimension:{dimensionName:'countryId',orderType:'ALPHANUMERIC'},desc:false}]});
 expect(JSON.stringify(calls[0].body)).not.toContain(token);
});

it.each(['dateHour','date','hour','landingPagePlusQueryString','landingPage','sessionSource','sessionMedium','sessionSourceMedium','sessionCampaignName','country','countryId','deviceCategory','streamId'])('allows the documented dimension %s',async dimension=>{
 const input={...request,dimensions:[dimension]};const {fetcher}=fixture(()=>json(report(input)));await expect(ga4RunReport(token,propertyId,input,fetcher)).resolves.toMatchObject({rowCount:1});
});

it.each(Object.keys(metricTypes))('allows the documented metric %s',async metric=>{
 const input={...request,metrics:[metric]};const {fetcher}=fixture(()=>json(report(input)));await expect(ga4RunReport(token,propertyId,input,fetcher)).resolves.toMatchObject({rows:[{metrics:{[metric]:2}}]});
});

it('filters ISO2 countries through countryId and combines the cutoff using an AND expression',async()=>{
 const {fetcher,calls}=fixture();await ga4RunReport(token,propertyId,{...request,country:'US',hourBefore:13},fetcher);
 expect(calls[0].body.dimensionFilter).toEqual({andGroup:{expressions:[{filter:{fieldName:'countryId',stringFilter:{matchType:'EXACT',value:'US',caseSensitive:true}}},{filter:{fieldName:'hour',numericFilter:{operation:'LESS_THAN',value:{int64Value:'13'}}}}]}});
});

it('filters a country name exactly without adding it to the requested dimensions',async()=>{
 const {fetcher,calls}=fixture();await ga4RunReport(token,propertyId,{...request,country:'United States'},fetcher);
 expect(calls[0].body.dimensionFilter).toEqual({filter:{fieldName:'country',stringFilter:{matchType:'EXACT',value:'United States',caseSensitive:true}}});
 expect(calls[0].body.dimensions).toEqual([{name:'sessionSource'}]);
});

it.each([0,24])('preserves the hour cutoff boundary %i',async hourBefore=>{
 const {fetcher,calls}=fixture();await ga4RunReport(token,propertyId,{...request,hourBefore},fetcher);
 expect(calls[0].body.dimensionFilter).toEqual({filter:{fieldName:'hour',numericFilter:{operation:'LESS_THAN',value:{int64Value:String(hourBefore)}}}});
});

it('paginates in 1000-row requests and accepts the complete 50000-row boundary',async()=>{
 const {fetcher,calls}=fixture(body=>json(report(request,50000,Number(body.offset))));const result=await ga4RunReport(token,propertyId,request,fetcher) as {rows:{dimensions:Record<string,string>}[];rowCount:number};
 expect(result.rowCount).toBe(50000);expect(result.rows).toHaveLength(50000);expect(result.rows[0].dimensions.sessionSource).toBe('source-0');expect(result.rows[49999].dimensions.sessionSource).toBe('source-49999');
 expect(calls.map(call=>call.body.offset)).toEqual(Array.from({length:50},(_,index)=>String(index*1000)));expect(calls.every(call=>call.body.limit==='1000')).toBe(true);
});

it('retains a 10000-row report with long landing pages using pages below the 6 MB cap',async()=>{
 const input={...request,dimensions:['landingPage','sessionSource','sessionMedium','countryId','deviceCategory','sessionCampaignName','dateHour']};
 const page=(offset:number,length:number)=>{
  const response=report(input,10000,offset,length);
  response.rows.forEach((row,index)=>{row.dimensionValues[0].value=`/products/${'a'.repeat(700)}?variant=${offset+index}`;});
  return response;
 };
 expect(Buffer.byteLength(JSON.stringify(page(0,10000)))).toBeGreaterThan(6000000);
 const bytes:number[]=[],{fetcher,calls}=fixture(body=>{
  const offset=Number(body.offset),response=page(offset,Math.min(Number(body.limit),10000-offset));
  bytes.push(Buffer.byteLength(JSON.stringify(response)));return json(response);
 });
 const result=await ga4RunReport(token,propertyId,input,fetcher);
 expect(result.rows).toHaveLength(10000);expect(result.rowCount).toBe(10000);expect(result.rows[9999].dimensions.landingPage).toBe(`/products/${'a'.repeat(700)}`);
 expect(calls.map(call=>call.body.offset)).toEqual(Array.from({length:10},(_,index)=>String(index*1000)));
 expect(bytes.every(length=>length<=6000000)).toBe(true);
});

it('fails before retaining a truncated report above the 50000-row limit',async()=>{
 const {fetcher,calls}=fixture(()=>json(report(request,50001,0,1)));await expect(ga4RunReport(token,propertyId,request,fetcher)).rejects.toThrow('GA4 report exceeds 50000 rows');expect(calls).toHaveLength(1);
});

it.each(['rowCount','empty-page','duplicate-page','metric-type','timezone','threshold'])('rejects inconsistent pagination case %s rather than returning partial facts',async change=>{
 const {fetcher,calls}=fixture((body,index)=>{
  const response=report(request,1001,Number(body.offset));
  if(index){if(change==='rowCount')response.rowCount=1002;if(change==='empty-page')response.rows=[];if(change==='duplicate-page')response.rows[0].dimensionValues[0].value='source-0';if(change==='metric-type')response.metricHeaders[0].type='TYPE_FLOAT';if(change==='timezone')response.metadata.timeZone='UTC';if(change==='threshold')Object.assign(response.metadata,{subjectToThresholding:true});}
  return json(response);
 });
 await expect(ga4RunReport(token,propertyId,request,fetcher)).rejects.toThrow();expect(calls).toHaveLength(2);
});

it('preserves sampling, thresholds, other-row loss and access restrictions in metadata',async()=>{
 const response={...report(),metadata:{...metadata,subjectToThresholding:true,dataLossFromOtherRow:true,samplingMetadatas:[{samplesReadCount:'10000000000000000',samplingSpaceSize:'20000000000000000'}],emptyReason:'',schemaRestrictionResponse:{activeMetricRestrictions:[{metricName:'purchaseRevenue',restrictedMetricTypes:['REVENUE_DATA']}]},dataTruncationReasons:[{dataTruncationType:'DATA_TRUNCATION_TYPE_PROPERTY',dataTruncationDate:'2026-01-01'}]}};
 const {fetcher}=fixture(()=>json(response));await expect(ga4RunReport(token,propertyId,request,fetcher)).resolves.toMatchObject({metadata:response.metadata});
});

it('permits absent currency metadata for a report without monetary metrics',async()=>{
 const response={...report(),metadata:{timeZone:'America/New_York'}};const {fetcher}=fixture(()=>json(response));await expect(ga4RunReport(token,propertyId,request,fetcher)).resolves.toMatchObject({metadata:{timeZone:'America/New_York'}});
});

it('requires currency metadata when purchase revenue is requested',async()=>{
 const input={...request,metrics:['purchaseRevenue']};const response={...report(input),metadata:{timeZone:'America/New_York'}};const {fetcher}=fixture(()=>json(response));await expect(ga4RunReport(token,propertyId,input,fetcher)).rejects.toThrow();
});

it.each([true,false])('returns an explicit zero-row report with no invented metric values (rows provided: %s)',async includeRows=>{
 const response:Record<string,unknown>=report(request,0);if(!includeRows)delete response.rows;const {fetcher}=fixture(()=>json(response));await expect(ga4RunReport(token,propertyId,request,fetcher)).resolves.toMatchObject({rows:[],rowCount:0});
});

it.each([true,false])('accepts protobuf-omitted zero rowCount only for an empty report (rows provided: %s)',async includeRows=>{
 const response:Record<string,unknown>=report(request,0);delete response.rowCount;if(!includeRows)delete response.rows;
 const {fetcher}=fixture(()=>json(response));await expect(ga4RunReport(token,propertyId,request,fetcher)).resolves.toMatchObject({rows:[],rowCount:0,metadata});
});

it.each([null,'0',0.5])('rejects a present malformed rowCount in an empty report case %#',async rowCount=>{
 const {fetcher}=fixture(()=>json({...report(request,0),rowCount}));await expect(ga4RunReport(token,propertyId,request,fetcher)).rejects.toThrow();
});

it.each(['headers','metadata'])('still validates %s when an empty report omits rowCount',async invalid=>{
 const response:Record<string,unknown>=report(request,0);delete response.rowCount;if(invalid==='headers')delete response.metricHeaders;else response.metadata={};
 const {fetcher}=fixture(()=>json(response));await expect(ga4RunReport(token,propertyId,request,fetcher)).rejects.toThrow();
});

it('supports an unsegmented report while retaining distinct users and rates as reported',async()=>{
 const input={...request,dimensions:[],metrics:['activeUsers','sessionKeyEventRate']};const response={...report(input),rows:[{metricValues:[{value:'3'},{value:'0.25'}]}]};delete (response as {dimensionHeaders?:unknown}).dimensionHeaders;
 const {fetcher}=fixture(()=>json(response));await expect(ga4RunReport(token,propertyId,input,fetcher)).resolves.toMatchObject({dimensionHeaders:[],rows:[{dimensions:{},metrics:{activeUsers:3,sessionKeyEventRate:0.25}}]});
});

it.each(['','space token','line\nbreak','é','x'.repeat(16385),null,42])('rejects invalid token case %# before fetching',async invalid=>{
 const fetcher=vi.fn();await expect(ga4RunReport(invalid as string,propertyId,request,fetcher)).rejects.toThrow('Invalid GA4 report request');expect(fetcher).not.toHaveBeenCalled();
});

it.each(['','properties/292550743','292550743:runReport?x=1','https://attacker.example','0','123\n',null,42])('rejects invalid property case %# before fetching',async invalid=>{
 const fetcher=vi.fn();await expect(ga4RunReport(token,invalid as string,request,fetcher)).rejects.toThrow('Invalid GA4 report request');expect(fetcher).not.toHaveBeenCalled();
});

it.each([
 {...request,from:'2026-02-30'}, {...request,from:'yesterday'}, {...request,to:'2026-10-13'},
 {...request,dimensions:['dateHourMinute']}, {...request,dimensions:['eventName']}, {...request,dimensions:['hour','hour']}, {...request,dimensions:Array(10).fill('hour')},
 {...request,metrics:[]}, {...request,metrics:['unknownMetric']}, {...request,metrics:['sessions','sessions']}, {...request,metrics:Object.keys(metricTypes).slice(0,11)},
 {...request,dimensions:null}, {...request,metrics:null}, {...request,country:''}, {...request,country:'US\n'},
 {...request,hourBefore:-1}, {...request,hourBefore:25}, {...request,hourBefore:1.5}, {...request,hourBefore:'2'}, null,
])('rejects invalid report input case %# before fetching',async invalid=>{
 const fetcher=vi.fn();await expect(ga4RunReport(token,propertyId,invalid as Ga4ReportRequest,fetcher)).rejects.toThrow('Invalid GA4 report request');expect(fetcher).not.toHaveBeenCalled();
});

it.each(['',' ','NaN','Infinity','0x10','12 orders','9007199254740992',null,2])('rejects invalid integer metric value case %# without coercing missing values to zero',async value=>{
 const response=report();response.rows[0].metricValues[0]={value:value as string};const {fetcher}=fixture(()=>json(response));await expect(ga4RunReport(token,propertyId,request,fetcher)).rejects.toThrow();
});

it('accepts explicit zero and signed decimal or scientific floating-point metrics without rounding',async()=>{
 const input={...request,metrics:['sessions','purchaseRevenue','bounceRate']};const response={...report(input),rows:[{dimensionValues:[{value:''}],metricValues:[{value:'0'},{value:'-12.125'},{value:'1.25e-2'}]}]};
 const {fetcher}=fixture(()=>json(response));await expect(ga4RunReport(token,propertyId,input,fetcher)).resolves.toMatchObject({rows:[{dimensions:{sessionSource:''},metrics:{sessions:0,purchaseRevenue:-12.125,bounceRate:0.0125}}]});
});

it.each([
 (response:ReturnType<typeof report>)=>{response.dimensionHeaders[0].name='sessionMedium';},
 (response:ReturnType<typeof report>)=>{response.metricHeaders[0].name='activeUsers';},
 (response:ReturnType<typeof report>)=>{response.metricHeaders[0].type='TYPE_CURRENCY';},
 (response:ReturnType<typeof report>)=>{response.rows[0].dimensionValues=[];},
 (response:ReturnType<typeof report>)=>{response.rows[0].metricValues=[];},
 (response:ReturnType<typeof report>)=>{response.rows[0].metricValues.push({value:'2'});},
 (response:ReturnType<typeof report>)=>{delete (response.rows[0].metricValues[0] as {value?:string}).value;},
 (response:ReturnType<typeof report>)=>{delete (response.rows[0].dimensionValues[0] as {value?:string}).value;},
 (response:ReturnType<typeof report>)=>{delete (response as {rowCount?:number}).rowCount;},
 (response:ReturnType<typeof report>)=>{response.rowCount=0;},
 (response:ReturnType<typeof report>)=>{response.rowCount=-1;},
 (response:ReturnType<typeof report>)=>{response.rowCount=1.5;},
])('rejects malformed response headers, rows or count case %#',async mutate=>{
 const response=report();mutate(response);const {fetcher}=fixture(()=>json(response));await expect(ga4RunReport(token,propertyId,request,fetcher)).rejects.toThrow();
});

it.each([
 {},{timeZone:'not/a-timezone'},{...metadata,currencyCode:'usd'},{...metadata,subjectToThresholding:'false'},
 {...metadata,samplingMetadatas:[{samplesReadCount:'x',samplingSpaceSize:'20'}]},
 {...metadata,samplingMetadatas:[{samplesReadCount:'30',samplingSpaceSize:'20'}]},
 {...metadata,schemaRestrictionResponse:'not-object'},
])('rejects malformed report metadata case %#',async invalid=>{
 const response={...report(),metadata:invalid};const {fetcher}=fixture(()=>json(response));await expect(ga4RunReport(token,propertyId,request,fetcher)).rejects.toThrow();
});

it.each([401,403,429,500])('reports only sanitized HTTP %i without logging a provider body',async status=>{
 const {fetcher}=fixture(()=>new Response(token,{status}));const failure=await ga4RunReport(token,propertyId,request,fetcher).then(()=>null,error=>error);
 expect(String(failure)).toContain(`HTTP ${status}`);expect(String(failure)).not.toContain(token);expect(failure.cause).toBeUndefined();
});

it('blocks a redirected response without sending credentials elsewhere',async()=>{
 const response=json(report());Object.defineProperty(response,'redirected',{value:true});const {fetcher,calls}=fixture(()=>response);await expect(ga4RunReport(token,propertyId,request,fetcher)).rejects.toThrow();expect(calls).toHaveLength(1);expect(calls[0].init.redirect).toBe('error');
});

it.each([new Response('invalid',{headers:{'Content-Type':'application/json'}}),new Response('<html>login</html>',{headers:{'Content-Type':'text/html'}}),json({error:{message:token}})])('rejects an invalid successful HTTP payload case %# with sanitized errors',async response=>{
 const {fetcher}=fixture(()=>response);const failure=await ga4RunReport(token,propertyId,request,fetcher).then(()=>null,error=>error);expect(failure).toBeInstanceOf(Error);expect(String(failure)).not.toContain(token);expect(failure.cause).toBeUndefined();
});

it('bounds streamed response bytes to 6 MB and cancels an oversized body',async()=>{
 const cancel=vi.fn(),body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(6000001));},cancel});const {fetcher}=fixture(()=>new Response(body,{headers:{'Content-Type':'application/json'}}));
 await expect(ga4RunReport(token,propertyId,request,fetcher)).rejects.toThrow('GA4 report response exceeds 6 MB');expect(cancel).toHaveBeenCalled();
});

it('rejects excessive Content-Length before reading the body',async()=>{
 const cancel=vi.fn(),body=new ReadableStream<Uint8Array>({cancel});const {fetcher}=fixture(()=>new Response(body,{headers:{'Content-Type':'application/json','Content-Length':'6000001'}}));
 await expect(ga4RunReport(token,propertyId,request,fetcher)).rejects.toThrow('GA4 report response exceeds 6 MB');expect(cancel).toHaveBeenCalled();
});

it('enforces one 40-second deadline across pages including a delayed fetch',async()=>{
 vi.useFakeTimers();const {fetcher,calls}=fixture(async body=>{await new Promise(resolve=>setTimeout(resolve,25000));return json(report(request,1001,Number(body.offset)));});
 const outcome=ga4RunReport(token,propertyId,request,fetcher).then(()=>null,error=>error);await vi.advanceTimersByTimeAsync(40000);
 expect(String(await outcome)).toBe('Error: GA4 report request timed out');expect(calls).toHaveLength(2);expect(calls.every(call=>call.init.signal!.aborted)).toBe(true);await vi.advanceTimersByTimeAsync(12000);expect(calls).toHaveLength(2);
});

it('times out a never-ending response body and cancels its reader',async()=>{
 vi.useFakeTimers();const cancel=vi.fn(),body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel});const {fetcher}=fixture(()=>new Response(body,{headers:{'Content-Type':'application/json'}}));
 const outcome=ga4RunReport(token,propertyId,request,fetcher).then(()=>null,error=>error);await vi.advanceTimersByTimeAsync(40000);expect(String(await outcome)).toBe('Error: GA4 report request timed out');expect(cancel).toHaveBeenCalled();
});

it('does not continue pagination if a fetch resolves after its deadline',async()=>{
 vi.useFakeTimers();const {fetcher,calls}=fixture(async()=>{await new Promise(resolve=>setTimeout(resolve,41000));return json(report(request,1001,0));});
 const outcome=ga4RunReport(token,propertyId,request,fetcher).then(()=>null,error=>error);await vi.advanceTimersByTimeAsync(40000);expect(String(await outcome)).toBe('Error: GA4 report request timed out');await vi.advanceTimersByTimeAsync(2000);expect(calls).toHaveLength(1);
});

it('rejects a provider-echoed access token rather than returning it as report data',async()=>{
 const response=report();response.rows[0].dimensionValues[0].value=token;const {fetcher}=fixture(()=>json(response));const failure=await ga4RunReport(token,propertyId,request,fetcher).then(()=>null,error=>error);expect(failure).toBeInstanceOf(Error);expect(String(failure)).not.toContain(token);
});

it('sanitizes thrown transport errors and never logs tokens or report payloads',async()=>{
 const log=vi.spyOn(console,'log').mockImplementation(()=>{}),warn=vi.spyOn(console,'warn').mockImplementation(()=>{}),error=vi.spyOn(console,'error').mockImplementation(()=>{});const fetcher:typeof fetch=async()=>{throw Error(`${token} private report`);};
 const failure=await ga4RunReport(token,propertyId,request,fetcher).then(()=>null,error=>error);expect(String(failure)).toBe('Error: GA4 report request failed');expect(failure.cause).toBeUndefined();expect(log).not.toHaveBeenCalled();expect(warn).not.toHaveBeenCalled();expect(error).not.toHaveBeenCalled();
});

it('uses a supplied global fetch without touching real credentials',async()=>{
 const {fetcher}=fixture();vi.stubGlobal('fetch',fetcher);await expect(ga4RunReport(token,propertyId,request)).resolves.toMatchObject({rowCount:1});
});

it('fully paginates Autobrush website detail beyond the local 5000-row probe while retaining every stream filter and quality flag',async()=>{
 const input={...request,dimensions:['dateHour','landingPage','countryId','deviceCategory','sessionSource','sessionMedium','sessionCampaignName','streamId'],streamId:'2635677328'};
 const {fetcher,calls}=fixture(body=>{const page=report(input,6001,Number(body.offset));page.metadata={timeZone:'America/Los_Angeles',currencyCode:'USD',subjectToThresholding:true} as typeof metadata;page.rows.forEach(row=>{row.dimensionValues[7].value=input.streamId;});return json(page);});
 const result=await ga4RunReport(token,'274489308',input,fetcher);expect(result.rows).toHaveLength(6001);expect(result.metadata).toMatchObject({timeZone:'America/Los_Angeles',subjectToThresholding:true});expect(calls.map(call=>call.body.offset)).toEqual(['0','1000','2000','3000','4000','5000','6000']);
 expect(calls.every(call=>JSON.stringify(call.body.dimensionFilter)===JSON.stringify({filter:{fieldName:'streamId',stringFilter:{matchType:'EXACT',value:input.streamId,caseSensitive:true}}}))).toBe(true);
});
