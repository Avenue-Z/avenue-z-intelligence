/** Retry only replay-safe database publication/acknowledgment operations. The
 * provider result and immutable snapshot identity stay unchanged on replay. */
export async function retryPublication<T>(operation:string,deadline:number,publish:()=>Promise<T>):Promise<T>{
 for(let attempt=1;;attempt++){
  try{return await publish();}
  catch(error){
   const timeout=error instanceof Error&&(error.name==='TimeoutError'||error.message==='Database request timed out');
   const delay=attempt*250;
   // Database RPCs have a 30s hard deadline. Leave that budget before starting
   // another attempt; the native job lease/deadline still bounds the run.
   if(!timeout||attempt>=3||Date.now()+delay+31000>deadline)throw error;
   console.warn('Database publication retry',{operation,attempt,delayMs:delay});
   await new Promise(resolve=>setTimeout(resolve,delay));
  }
 }
}
