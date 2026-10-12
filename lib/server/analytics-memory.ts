import {runtimePlatform} from '@avenue/runtime';
const capacity=runtimePlatform==='vercel'?4:1;
const leases=new Map<symbol,number>();
const queue:{ticket:symbol;expiry:number}[]=[];
const budgetMs=45000;
/** Request-owned timers keep waits valid in Workers. Expiring leases prevent
 * a canceled browser request from permanently occupying an isolate's slot. */
export async function withAnalyticsMemory<T>(work:()=>Promise<T>):Promise<T>{
 const ticket=Symbol(),started=Date.now();queue.push({ticket,expiry:started+budgetMs});
 try{
  for(;;){const now=Date.now();for(const [id,expiry]of leases)if(expiry<=now)leases.delete(id);while(queue.length&&queue[0].expiry<=now)queue.shift();
   if(queue[0]?.ticket===ticket&&leases.size<capacity){queue.shift();leases.set(ticket,now+budgetMs);break;}
   if(now-started>=budgetMs)throw Error('Analytics is refreshing a large period. Please retry in a moment.');
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Analytics refresh took too long. Please retry the selected period.')),budgetMs);})]);}
  finally{if(timer)clearTimeout(timer);}
 }finally{leases.delete(ticket);const position=queue.findIndex(entry=>entry.ticket===ticket);if(position>=0)queue.splice(position,1);}
}
