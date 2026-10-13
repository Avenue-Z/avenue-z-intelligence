/** Keep database RPCs outside Next's fetch cache. A stalled HTTP request must
 * eventually release the SDK's pooled slot and any awaiting analytics lease.
 * The signal remains active through response-body consumption as well. */
export function createDatabaseFetch(transport:typeof fetch=globalThis.fetch,timeoutMs=30000):typeof fetch{
 return async(input,init)=>{
  const started=performance.now(),signals=[input instanceof Request?input.signal:undefined,init?.signal,AbortSignal.timeout(timeoutMs)].filter((signal):signal is AbortSignal=>!!signal);
  try{
   const response=await transport(input,{...init,cache:'no-store',signal:AbortSignal.any(signals)}),ms=Math.round(performance.now()-started);
   if(ms>=5000||!response.ok)console.warn('Database request slow or rejected',{operation:'database-rpc',ms,status:response.status});
   return response;
  }catch(error){
   const kind=error instanceof Error&&['Error','TypeError','AbortError','TimeoutError'].includes(error.name)?error.name:'Unknown';
   const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^[A-Z0-9_]{1,40}$/.test(error.code)?error.code:undefined;
   console.warn('Database request failed',{operation:'database-rpc',ms:Math.round(performance.now()-started),kind,...code?{code}:{}});
   throw error;
  }
 };
}
