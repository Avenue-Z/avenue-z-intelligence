import {expect,it,vi} from 'vitest';
vi.mock('@avenue/runtime',()=>({runtimePlatform:'sites'}));
import {withAnalyticsMemory} from '../../lib/server/analytics-memory';
it('bounds large simultaneous reads and releases the next read after errors',async()=>{
 let running=0,peak=0;const order:number[]=[];
 const run=(id:number,fail=false)=>withAnalyticsMemory(async()=>{running++;peak=Math.max(peak,running);order.push(id);await new Promise(resolve=>setTimeout(resolve,5));running--;if(fail)throw Error('Read failed');return id;});
 const result=await Promise.allSettled([run(1,true),run(2),run(3)]);
 expect(peak).toBe(1);expect(order).toEqual([1,2,3]);expect(result[0].status).toBe('rejected');expect(result[2]).toMatchObject({status:'fulfilled',value:3});expect(await run(4)).toBe(4);
});
