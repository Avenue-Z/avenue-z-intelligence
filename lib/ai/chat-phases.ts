import {runtimePlatform} from '@avenue/runtime';
export type ChatPhase='authorize'|'context'|'reserve'|'history'|'model'|'persist';
export type ChatPhaseRunner=<T>(phase:ChatPhase,work:()=>Promise<T>)=>Promise<T>;
export const untracedChatPhase:ChatPhaseRunner=(_phase,work)=>work();

/** Fixed fields only: prompts, identities, SQL and error messages stay private. */
export function createChatPhaseRunner():ChatPhaseRunner{
 if(runtimePlatform!=='vercel')return untracedChatPhase;
 const requestId=crypto.randomUUID();
 return async(phase,work)=>{
  const started=performance.now();
  console.info('Chat request phase',{requestId,phase,status:'started',ms:0});
  try{const result=await work();console.info('Chat request phase',{requestId,phase,status:'complete',ms:Math.round(performance.now()-started)});return result;}
  catch(error){const kind=error instanceof Error&&['Error','TypeError','AbortError','TimeoutError'].includes(error.name)?error.name:'Unknown';console.warn('Chat request phase',{requestId,phase,status:'failed',ms:Math.round(performance.now()-started),kind});throw error;}
 };
}
