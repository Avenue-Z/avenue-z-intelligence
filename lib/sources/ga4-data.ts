import {privateSafeGa4Report} from '../analytics/ga4-page-privacy';
export type Ga4ReportRequest={from:string;to:string;dimensions:string[];metrics:string[];country?:string;hourBefore?:number;streamId?:string};
export type Ga4ReportRow={dimensions:Record<string,string>;metrics:Record<string,number>};
export type Ga4ReportMetadata={
 timeZone:string;currencyCode?:string;subjectToThresholding?:boolean;dataLossFromOtherRow?:boolean;emptyReason?:string;
 samplingMetadatas?:{samplesReadCount:string;samplingSpaceSize:string}[];
 schemaRestrictionResponse?:{activeMetricRestrictions?:{metricName:string;restrictedMetricTypes:string[]}[]};
 dataTruncationReasons?:Record<string,unknown>[];
 [key:string]:unknown;
};
export type Ga4Report={
 rows:Ga4ReportRow[];rowCount:number;dimensionHeaders:{name:string}[];metricHeaders:{name:string;type:string}[];metadata:Ga4ReportMetadata;
};
const dimensions=new Set(['dateHour','date','hour','landingPagePlusQueryString','landingPage','sessionSource','sessionMedium','sessionSourceMedium','sessionCampaignName','country','countryId','deviceCategory','streamId']);
const metricTypes={sessions:'TYPE_INTEGER',engagedSessions:'TYPE_INTEGER',screenPageViews:'TYPE_INTEGER',activeUsers:'TYPE_INTEGER',totalUsers:'TYPE_INTEGER',ecommercePurchases:'TYPE_INTEGER',purchaseRevenue:'TYPE_CURRENCY',sessionKeyEventRate:'TYPE_FLOAT',averageSessionDuration:'TYPE_SECONDS',bounceRate:'TYPE_FLOAT',addToCarts:'TYPE_INTEGER',checkouts:'TYPE_INTEGER'} as const;
const responseLimit=6000000,pageSize=1000,rowLimit=50000;
class Ga4ReportError extends Error{}
const invalidResponse=()=>new Ga4ReportError('GA4 report returned an invalid response');
const timedOut=()=>new Ga4ReportError('GA4 report request timed out');
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function validDate(value:unknown):value is string{return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;}
function validateRequest(accessToken:string,propertyId:string,input:Ga4ReportRequest):Ga4ReportRequest{
 try{
  if(typeof accessToken!=='string'||!accessToken.length||accessToken.length>16384||!/^[\x21-\x7e]+$/.test(accessToken))throw new Error();
  if(typeof propertyId!=='string'||!/^[1-9]\d{0,19}$/.test(propertyId)||!record(input))throw new Error();
  if(!validDate(input.from)||!validDate(input.to)||input.from>input.to)throw new Error();
  if(!Array.isArray(input.dimensions)||input.dimensions.length>9||input.dimensions.some(name=>typeof name!=='string'||!dimensions.has(name))||new Set(input.dimensions).size!==input.dimensions.length)throw new Error();
  if(!Array.isArray(input.metrics)||!input.metrics.length||input.metrics.length>10||input.metrics.some(name=>typeof name!=='string'||!Object.hasOwn(metricTypes,name))||new Set(input.metrics).size!==input.metrics.length)throw new Error();
  if(input.country!==undefined&&(typeof input.country!=='string'||!input.country.trim()||input.country.length>120||/[\u0000-\u001f\u007f]/.test(input.country)))throw new Error();
  if(input.streamId!==undefined&&(typeof input.streamId!=='string'||!/^\d{1,20}$/.test(input.streamId)))throw new Error();
  if(input.hourBefore!==undefined&&(!Number.isInteger(input.hourBefore)||input.hourBefore<0||input.hourBefore>24))throw new Error();
  return {from:input.from,to:input.to,dimensions:[...input.dimensions],metrics:[...input.metrics],country:input.country,hourBefore:input.hourBefore,streamId:input.streamId};
 }catch{throw new Error('Invalid GA4 report request');}
}
function reportMetadata(value:unknown,input:Ga4ReportRequest):Ga4ReportMetadata{
 if(!record(value)||typeof value.timeZone!=='string'||!value.timeZone||value.timeZone.length>100)throw invalidResponse();
 try{new Intl.DateTimeFormat('en-US',{timeZone:value.timeZone}).format(0);}catch{throw invalidResponse();}
 if(value.currencyCode!==undefined&&(typeof value.currencyCode!=='string'||!/^[A-Z]{3}$/.test(value.currencyCode)))throw invalidResponse();
 if(input.metrics.includes('purchaseRevenue')&&value.currencyCode===undefined)throw invalidResponse();
 for(const key of ['subjectToThresholding','dataLossFromOtherRow'])if(value[key]!==undefined&&typeof value[key]!=='boolean')throw invalidResponse();
 if(value.emptyReason!==undefined&&typeof value.emptyReason!=='string')throw invalidResponse();
 if(value.samplingMetadatas!==undefined){
  if(!Array.isArray(value.samplingMetadatas)||value.samplingMetadatas.some(sample=>!record(sample)||typeof sample.samplesReadCount!=='string'||typeof sample.samplingSpaceSize!=='string'||!/^\d{1,20}$/.test(sample.samplesReadCount)||!/^\d{1,20}$/.test(sample.samplingSpaceSize)||BigInt(sample.samplesReadCount)>BigInt(sample.samplingSpaceSize)))throw invalidResponse();
 }
 if(value.schemaRestrictionResponse!==undefined){
  const restrictions=value.schemaRestrictionResponse;if(!record(restrictions))throw invalidResponse();
  if(restrictions.activeMetricRestrictions!==undefined&&(!Array.isArray(restrictions.activeMetricRestrictions)||restrictions.activeMetricRestrictions.some(item=>!record(item)||typeof item.metricName!=='string'||!Array.isArray(item.restrictedMetricTypes)||item.restrictedMetricTypes.some(type=>typeof type!=='string'))))throw invalidResponse();
 }
 if(value.dataTruncationReasons!==undefined&&(!Array.isArray(value.dataTruncationReasons)||value.dataTruncationReasons.some(reason=>!record(reason))))throw invalidResponse();
 return value as Ga4ReportMetadata;
}
function stable(value:unknown):unknown{
 if(Array.isArray(value))return value.map(stable);
 if(record(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));
 return value;
}
function dimensionValue(value:unknown):string{if(!record(value)||typeof value.value!=='string')throw invalidResponse();return value.value;}
function metricValue(value:unknown,type:string):number{
 if(!record(value)||typeof value.value!=='string'||!/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value.value))throw invalidResponse();
 const numeric=Number(value.value);if(!Number.isFinite(numeric)||type==='TYPE_INTEGER'&&(!/^-?\d+$/.test(value.value)||!Number.isSafeInteger(numeric)))throw invalidResponse();
 return numeric;
}
function reportPage(payload:unknown,input:Ga4ReportRequest,offset:number):Ga4Report{
 if(!record(payload)||Object.hasOwn(payload,'error'))throw invalidResponse();
 // ProtoJSON omits the default int32 zero; only an empty report can imply it.
 const rowCount=!Object.hasOwn(payload,'rowCount')&&(payload.rows===undefined||Array.isArray(payload.rows)&&payload.rows.length===0)?0:payload.rowCount;
 if(typeof rowCount!=='number'||!Number.isSafeInteger(rowCount)||rowCount<0)throw invalidResponse();
 if(rowCount>rowLimit)throw new Ga4ReportError('GA4 report exceeds 50000 rows');
 const dimensionHeaders=payload.dimensionHeaders===undefined&&!input.dimensions.length?[]:payload.dimensionHeaders;
 if(!Array.isArray(dimensionHeaders)||dimensionHeaders.length!==input.dimensions.length||dimensionHeaders.some((header,index)=>!record(header)||header.name!==input.dimensions[index]))throw invalidResponse();
 const metricHeaders=payload.metricHeaders;
 if(!Array.isArray(metricHeaders)||metricHeaders.length!==input.metrics.length||metricHeaders.some((header,index)=>!record(header)||header.name!==input.metrics[index]||header.type!==metricTypes[input.metrics[index] as keyof typeof metricTypes]))throw invalidResponse();
 const rawRows=payload.rows===undefined&&rowCount===0?[]:payload.rows;
 if(!Array.isArray(rawRows)||rawRows.length!==Math.min(pageSize,rowCount-offset))throw invalidResponse();
 const rows=rawRows.map(row=>{
  if(!record(row))throw invalidResponse();const values=row.dimensionValues===undefined&&!input.dimensions.length?[]:row.dimensionValues;
  if(!Array.isArray(values)||values.length!==input.dimensions.length||!Array.isArray(row.metricValues)||row.metricValues.length!==input.metrics.length)throw invalidResponse();
  const metricValues=row.metricValues;
  return {dimensions:Object.fromEntries(input.dimensions.map((name,index)=>[name,dimensionValue(values[index])])),metrics:Object.fromEntries(input.metrics.map((name,index)=>[name,metricValue(metricValues[index],metricTypes[name as keyof typeof metricTypes])]))};
 });
 if(input.streamId!==undefined&&input.dimensions.includes('streamId')&&rows.some(row=>row.dimensions.streamId!==input.streamId))throw invalidResponse();
 return {rows,rowCount,dimensionHeaders:input.dimensions.map(name=>({name})),metricHeaders:input.metrics.map(name=>({name,type:metricTypes[name as keyof typeof metricTypes]})),metadata:reportMetadata(payload.metadata,input)};
}

export async function ga4RunReport(accessToken:string,propertyId:string,request:Ga4ReportRequest,fetcher:typeof fetch=fetch):Promise<Ga4Report>{
 const input=validateRequest(accessToken,propertyId,request),controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const filters:unknown[]=[];
 if(input.streamId!==undefined)filters.push({filter:{fieldName:'streamId',stringFilter:{matchType:'EXACT',value:input.streamId,caseSensitive:true}}});
 if(input.country!==undefined)filters.push({filter:{fieldName:/^[A-Z]{2}$/.test(input.country)?'countryId':'country',stringFilter:{matchType:'EXACT',value:input.country,caseSensitive:true}}});
 if(input.hourBefore!==undefined)filters.push({filter:{fieldName:'hour',numericFilter:{operation:'LESS_THAN',value:{int64Value:String(input.hourBefore)}}}});
 const perform=async()=>{
  let report:Ga4Report|undefined,metadataKey:string|undefined;const seen=new Set<string>();
  for(let offset=0;;){
   if(controller.signal.aborted)throw timedOut();
   const response=await fetcher(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,{
    method:'POST',redirect:'error',signal:controller.signal,headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json',Accept:'application/json'},
    body:JSON.stringify({dateRanges:[{startDate:input.from,endDate:input.to}],dimensions:input.dimensions.map(name=>({name})),metrics:input.metrics.map(name=>({name})),limit:String(pageSize),offset:String(offset),keepEmptyRows:true,...input.dimensions.length?{orderBys:input.dimensions.map(name=>({dimension:{dimensionName:name,orderType:'ALPHANUMERIC'},desc:false}))}:{},...filters.length?{dimensionFilter:filters.length===1?filters[0]:{andGroup:{expressions:filters}}}:{}}),
   });
   try{
    if(controller.signal.aborted)throw timedOut();
    if(response.redirected)throw new Ga4ReportError('GA4 report rejected a redirect');
    if(!response.ok)throw new Ga4ReportError(`GA4 report returned HTTP ${response.status}`);
    if(Number(response.headers.get('Content-Length'))>responseLimit)throw new Ga4ReportError('GA4 report response exceeds 6 MB');
    if(!response.body||response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw invalidResponse();
    reader=response.body.getReader();const parts:string[]=[],decoder=new TextDecoder('utf-8',{fatal:true});let length=0;
    for(;;){
     const chunk=await reader.read();if(controller.signal.aborted)throw timedOut();
     if(chunk.value){length+=chunk.value.byteLength;if(length>responseLimit)throw new Ga4ReportError('GA4 report response exceeds 6 MB');}
     parts.push(decoder.decode(chunk.value,{stream:!chunk.done}));if(chunk.done)break;
    }
    let payload:unknown;
    try{payload=JSON.parse(parts.join(''),(key,value:unknown)=>{if(key.includes(accessToken)||typeof value==='string'&&value.includes(accessToken))throw invalidResponse();return value;});}catch{throw invalidResponse();}
    const page=reportPage(payload,input,offset),pageMetadataKey=JSON.stringify(stable(page.metadata));
    if(report&&(page.rowCount!==report.rowCount||pageMetadataKey!==metadataKey))throw new Ga4ReportError('GA4 report changed during pagination');
    for(const row of page.rows){const key=JSON.stringify(input.dimensions.map(name=>row.dimensions[name]));if(seen.has(key))throw new Ga4ReportError('GA4 report repeated a dimension row');seen.add(key);}
    if(!report){report=page;metadataKey=pageMetadataKey;}else report.rows.push(...page.rows);
    offset+=page.rows.length;if(offset===report.rowCount)return privateSafeGa4Report(report);
   }finally{void reader?.cancel().catch(()=>{});reader=undefined;void response.body?.cancel().catch(()=>{});}
  }
 };
 const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{reject(timedOut());controller.abort();void reader?.cancel().catch(()=>{});},40000);});
 try{return await Promise.race([perform(),timeout]);}
 catch(error){throw new Error(error instanceof Ga4ReportError?error.message:'GA4 report request failed');}
 finally{clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>{});}
}
