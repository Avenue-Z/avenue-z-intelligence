/** Keep database RPCs outside Next's fetch cache. A stalled HTTP request must
 * eventually release the SDK's pooled slot and any awaiting analytics lease.
 * The signal remains active through response-body consumption as well. */
export function createDatabaseFetch(transport:typeof fetch=globalThis.fetch,timeoutMs=30000):typeof fetch{
 let sequence=0;
 return async(input,init)=>{
  const rpcSequence=++sequence,started=performance.now(),deadline=new AbortController(),signals=[input instanceof Request?input.signal:undefined,init?.signal,deadline.signal].filter((signal):signal is AbortSignal=>!!signal),signal=AbortSignal.any(signals);
  let phase:'headers'|'body'='headers',status:number|undefined;
  let rejectAbort!:(reason:unknown)=>void,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,bodyController:ReadableStreamDefaultController<Uint8Array>|undefined;
  const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
  const timer=setTimeout(()=>deadline.abort(new DOMException('Database request timed out','TimeoutError')),timeoutMs);
  const clean=()=>{clearTimeout(timer);signal.removeEventListener('abort',onAbort);};
  const cancelBody=()=>{void reader?.cancel(signal.reason).catch(()=>{});};
  const onAbort=()=>{rejectAbort(signal.reason);if(bodyController){console.warn('Database response body aborted',{operation:'database-rpc',sequence:rpcSequence,phase,ms:Math.round(performance.now()-started),kind:signal.reason instanceof Error&&signal.reason.name==='TimeoutError'?'TimeoutError':'AbortError',...status!==undefined?{status}:{}});bodyController.error(signal.reason);}cancelBody();clean();};
  signal.addEventListener('abort',onAbort,{once:true});
  try{
   if(signal.aborted)throw signal.reason;
   const upstream=transport(input,{...init,cache:'no-store',signal});
   // A framework transport can ignore abort. Reject our caller independently
   // and close any response that eventually arrives after its deadline.
   void upstream.then(response=>{if(signal.aborted)void response.body?.cancel(signal.reason).catch(()=>{});},()=>{});
   const response=await Promise.race([upstream,aborted]),ms=Math.round(performance.now()-started);
   status=response.status;
   if(ms>=5000||!response.ok)console.warn('Database request slow or rejected',{operation:'database-rpc',sequence:rpcSequence,phase,ms,status});
   if(!response.body){clean();return response;}
   phase='body';
   reader=response.body.getReader();
   // The SDK decodes the body after fetch resolves. Keep the same deadline
   // through that read without allocating another complete response buffer.
   const body=new ReadableStream<Uint8Array>({
    start(controller){bodyController=controller;},
    async pull(controller){try{const next=await Promise.race([reader!.read(),aborted]);if(next.done){clean();controller.close();}else controller.enqueue(next.value);}catch(error){clean();if(!signal.aborted)controller.error(error);}},
    cancel(reason){clean();void reader!.cancel(reason).catch(()=>{});}
   });
   return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  }catch(error){
   clean();cancelBody();
   const kind=error instanceof Error&&['Error','TypeError','AbortError','TimeoutError'].includes(error.name)?error.name:'Unknown';
   const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^[A-Z0-9_]{1,40}$/.test(error.code)?error.code:undefined;
   console.warn('Database request failed',{operation:'database-rpc',sequence:rpcSequence,phase,ms:Math.round(performance.now()-started),kind,...code?{code}:{},...status!==undefined?{status}:{}});
   throw error;
  }
 };
}
