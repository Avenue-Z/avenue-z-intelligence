import {runtimePlatform} from '@avenue/runtime';
const native=runtimePlatform==='vercel',capacity=1;
const leases=new Map<symbol,number>();
const queue:{ticket:symbol;expiry:number}[]=[];
const budgetMs=native?80000:45000;
/** Request-owned timers keep waits valid in Workers. Expiring leases prevent
 * a canceled browser request from permanently occupying an isolate's slot. */
export async function withAnalyticsMemory<T>(work:()=>Promise<T>):Promise<T>{
 const ticket=Symbol(),started=Date.now();let nativeWorkStarted=false;queue.push({ticket,expiry:started+budgetMs});
 try{
  for(;;){const now=Date.now();for(const [id,expiry]of leases)if(expiry<=now)leases.delete(id);while(queue.length&&queue[0].expiry<=now)queue.shift();
   if(queue[0]?.ticket===ticket&&leases.size<capacity){queue.shift();leases.set(ticket,native?Infinity:now+budgetMs);break;}
   if(now-started>=budgetMs)throw Error('Analytics is refreshing a large period. Please retry in a moment.');
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   nativeWorkStarted=native;
   // A timed-out Node response cannot cancel its underlying DB computation.
   // Keep that allocation leased until the computation actually settles.
   const computation=Promise.resolve().then(work).finally(()=>{if(native)leases.delete(ticket);});
   return await Promise.race([computation,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Analytics refresh took too long. Please retry the selected period.')),budgetMs);})]);}
  finally{if(timer)clearTimeout(timer);}
 }finally{if(!nativeWorkStarted)leases.delete(ticket);const position=queue.findIndex(entry=>entry.ticket===ticket);if(position>=0)queue.splice(position,1);}
}
