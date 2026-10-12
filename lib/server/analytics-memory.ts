import {runtimePlatform} from '@avenue/runtime';
// Decoding several large exports concurrently can exceed a small preview
// worker's heap. The shared database cache remains the source of each read.
const capacity=runtimePlatform==='vercel'?4:1;
let active=0;
const waiting:(()=>void)[]=[];
export async function withAnalyticsMemory<T>(work:()=>Promise<T>):Promise<T>{
 if(active>=capacity)await new Promise<void>(resolve=>waiting.push(resolve));else active++;
 try{return await work();}finally{const next=waiting.shift();if(next)next();else active--;}
}
