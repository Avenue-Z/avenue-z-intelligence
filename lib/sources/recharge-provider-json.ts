import {providerJson} from './kind-patches';

const resources={
 'store-identity':'store',
 'cancellation-state':'subscriptions',
 'creation-cohort':'subscriptions',
 'retained-events':'events',
} as const;
type RechargePhase=keyof typeof resources;
const errorNames=new Set(['Error','TypeError','TimeoutError','AbortError']);
const causeCodes=new Set(['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','ENOTFOUND','EAI_AGAIN','ECONNRESET','ECONNREFUSED','ETIMEDOUT']);
function errorDiagnostic(error:unknown){
 try{
  const value=error as {name?:unknown;code?:unknown;cause?:{code?:unknown}}|null;
  const name=value?.name,candidate=value?.cause?.code??value?.code,code=typeof candidate==='string'?candidate:undefined;
  return {kind:typeof name==='string'&&errorNames.has(name)?name:'other',causeCode:code===undefined?'none':typeof code==='string'&&causeCodes.has(code)?code:'other'};
 }catch{return {kind:'other',causeCode:'other'};}
}
function remaining(deadline:number,now:number){return Math.max(0,deadline-now);}

/** Retain the existing provider errors and budgets while logging no request or
 * response content. Explicit labels also identify filter-free cursor requests. */
export async function rechargeProviderJson(fetcher:typeof fetch,url:string,options:RequestInit,deadline:number,phase:RechargePhase,cursor=false,requestTimeoutMs=25000){
 const started=Date.now(),safePhase=Object.hasOwn(resources,phase)?phase:'unknown',resource=safePhase==='unknown'?'unknown':resources[safePhase];
 let requestPhase:'before-request'|'fetch'|'response'='before-request',status:number|null=null,requestStarted=started,requestBudget=remaining(deadline,started),rawFailure:ReturnType<typeof errorDiagnostic>|undefined,signal:AbortSignal|null|undefined;
 const observed:typeof fetch=async(input,init)=>{
  requestStarted=Date.now();requestBudget=remaining(deadline,requestStarted);requestPhase='fetch';status=null;rawFailure=undefined;signal=init?.signal;
  try{
   const response=await fetcher(input,init);requestPhase='response';status=response.status;return response;
  }catch(error){rawFailure=errorDiagnostic(error);throw error;}
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
