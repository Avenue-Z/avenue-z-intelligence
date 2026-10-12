import {expect,it,vi} from 'vitest';
vi.mock('@avenue/runtime',()=>({runtimePlatform:'vercel'}));
import {withAnalyticsMemory} from '../../lib/server/analytics-memory';
it('serializes company heavy reads and allows a read lasting beyond the Worker budget',async()=>{
 vi.useFakeTimers();try{
 let finish!:()=>void,running=0,peak=0;
 const first=withAnalyticsMemory(async()=>{running++;peak=Math.max(peak,running);await new Promise<void>(resolve=>{finish=resolve;});running--;return 1;});
 const second=withAnalyticsMemory(async()=>{running++;peak=Math.max(peak,running);running--;return 2;});
 await vi.advanceTimersByTimeAsync(50000);expect(peak).toBe(1);finish();await vi.advanceTimersByTimeAsync(20);expect(await first).toBe(1);expect(await second).toBe(2);
 }finally{vi.useRealTimers();}
});
it('keeps a timed-out native computation leased until it actually settles',async()=>{
 vi.useFakeTimers();try{
 let finish!:()=>void,started=false;
 const first=withAnalyticsMemory(()=>new Promise<void>(resolve=>{finish=resolve;})),expired=expect(first).rejects.toThrow('took too long');
 await vi.advanceTimersByTimeAsync(80000);await expired;
 const second=withAnalyticsMemory(async()=>{started=true;return 2;});
 await vi.advanceTimersByTimeAsync(100);expect(started).toBe(false);finish();await vi.advanceTimersByTimeAsync(20);expect(await second).toBe(2);
 }finally{vi.useRealTimers();}
});
