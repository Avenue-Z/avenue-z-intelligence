import {providerJson} from './kind-patches';

const resources={
 'store-identity':'store',
 'cancellation-state':'subscriptions',
 'creation-cohort':'subscriptions',
 'retained-events':'events',
} as const;
type RechargePhase=keyof typeof resources;
const errorNames=new Set(['Error','TypeError','TimeoutError','AbortError']);
const causeCodes=new Set(['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','ENOTFOUND','EAI_AGAIN','ECONNRESET','ECONNREFUSED','ETIMEDOUT']);
function errorDiagnostic(error:unknown){
 try{
  const value=error as {name?:unknown;code?:unknown;cause?:{code?:unknown}}|null;
  const name=value?.name,candidate=value?.cause?.code??value?.code,code=typeof candidate==='string'?candidate:undefined;
  return {kind:typeof name==='string'&&errorNames.has(name)?name:'other',causeCode:code===undefined?'none':typeof code==='string'&&causeCodes.has(code)?code:'other'};
 }catch{return {kind:'other',causeCode:'other'};}
}
function remaining(deadline:number,now:number){return Math.max(0,deadline-now);}

/** Retain provider errors and request budgets without logging request content.
 * Historical subscription cursors may replay one failed GET with enough time
 * for its full 60s deadline and the database's existing 31s publication reserve. */
export async function rechargeProviderJson(fetcher:typeof fetch,url:string,options:RequestInit,deadline:number,phase:RechargePhase,cursor=false,requestTimeoutMs=25000){
 const started=Date.now(),safePhase=Object.hasOwn(resources,phase)?phase:'unknown',resource=safePhase==='unknown'?'unknown':resources[safePhase];
 const retryableCursor=cursor===true&&requestTimeoutMs===60000&&(safePhase==='cancellation-state'||safePhase==='creation-cohort')&&(options.method??'GET').toUpperCase()==='GET';let cursorRetryUsed=false;
 let requestPhase:'before-request'|'fetch'|'response'='before-request',status:number|null=null,requestStarted=started,requestBudget=remaining(deadline,started),rawFailure:ReturnType<typeof errorDiagnostic>|undefined,signal:AbortSignal|null|undefined;
 const observed:typeof fetch=async(input,init)=>{
  let requestOptions=init;
  for(;;){
   requestStarted=Date.now();requestBudget=remaining(deadline,requestStarted);requestPhase='fetch';status=null;rawFailure=undefined;signal=requestOptions?.signal;
   try{
    const response=await fetcher(input,requestOptions);requestPhase='response';status=response.status;return response;
   }catch(error){
    rawFailure=errorDiagnostic(error);
    const knownTransportFailure=error instanceof Error&&(rawFailure.kind==='TimeoutError'||causeCodes.has(rawFailure.causeCode)||rawFailure.kind==='AbortError'&&signal?.aborted===true&&errorDiagnostic(signal.reason).kind==='TimeoutError');
    if(!retryableCursor||cursorRetryUsed||!knownTransportFailure||requestBudget<60000||Date.now()+60000+31000>deadline)throw error;
    cursorRetryUsed=true;
    try{console.warn('Recharge provider cursor retry',{service:'recharge',resource,phase:safePhase,cursor:true,retry:1,requestTimeoutMs:60000,elapsedMs:Date.now()-started,remainingBudgetMs:remaining(deadline,Date.now()),...rawFailure});}catch{/* Logging is diagnostic only. */}
    // Preserve the exact cursor and request options, replacing only the spent
    // timeout signal. Failed requests never reach the caller's page counters.
    requestOptions={...init,signal:AbortSignal.timeout(60000)};
   }
  }
 };
 try{return await providerJson(observed,url,options,deadline,0,requestTimeoutMs);}
 catch(error){
  // Diagnostics must never replace the provider's original throw or expose its
  // arbitrary message, cause, headers, cursor, URL or subscription payload.
  try{
   const now=Date.now();console.warn('Recharge provider request failed',{
    service:'recharge',resource,phase:safePhase,cursor:cursor===true,requestPhase,status,
    elapsedMs:now-started,requestElapsedMs:now-requestStarted,
    remainingBudgetMs:requestBudget,remainingBudgetAfterMs:remaining(deadline,now),
    requestTimeoutMs:requestPhase==='before-request'?0:Math.max(1,Math.min(requestTimeoutMs,requestBudget)),
    aborted:signal?.aborted===true,...rawFailure??errorDiagnostic(error),
   });
  }catch{/* Logging is diagnostic only. */}
  throw error;
 }
}
