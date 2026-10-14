import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import {DailyScheduler} from '../../lib/jobs/scheduler';
let sqlite:DatabaseSync,store:Store;
const started='2026-10-14T17:28:23.254Z',id='o:cache',expectedUntil='2026-10-14T17:43:23.254Z';
const timeout=()=>new DOMException('Database request timed out','TimeoutError');
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(started);sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:SQLInputValue[]=[];const statement={bind(...input:SQLInputValue[]){values=input;return statement;},async first(){return sqlite.prepare(sql).get(...values)??null;},async all(){return {results:sqlite.prepare(sql).all(...values)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}};}};return statement;};
 store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))});
});
afterEach(()=>{vi.restoreAllMocks();sqlite.close();vi.useRealTimers();});
const savedLease=()=>sqlite.prepare('SELECT id,token,leaseUntil FROM runner_leases WHERE id=?').get(id);
function loseAcquisitionAcknowledgment(error:Error=timeout(),afterCommit?:()=>void){
 const run=store.run.bind(store);return vi.spyOn(store,'run').mockImplementationOnce(async(sql,...values)=>{await run(sql,...values);vi.setSystemTime(Date.now()+30002);afterCommit?.();throw error;});
}
it.each([()=>timeout(),()=>Error('Database request timed out')])('recovers only its exact durable lease after a known acquisition timeout',async failure=>{
 const error=failure(),writes=loseAcquisitionAcknowledgment(error),reads=vi.spyOn(store,'first'),scheduler=new DailyScheduler(store);
 const token=await scheduler.acquire(id,started,900000);expect(token).toBeTruthy();expect(savedLease()).toEqual({id,token,leaseUntil:expectedUntil});
 expect(writes).toHaveBeenCalledTimes(1);expect(reads).toHaveBeenCalledTimes(1);expect(reads.mock.calls[0].slice(1)).toEqual([id,token,expectedUntil,'2026-10-14T17:28:53.256Z']);
 await scheduler.release(id,token!);expect(savedLease()).toBeUndefined();
});
it('keeps the original failure when acquisition did not commit and never retries its write',async()=>{
 const error=timeout(),writes=vi.spyOn(store,'run').mockRejectedValueOnce(error),reads=vi.spyOn(store,'first');
 await expect(new DailyScheduler(store).acquire(id,started,900000)).rejects.toBe(error);expect(savedLease()).toBeUndefined();expect(writes).toHaveBeenCalledTimes(1);expect(reads).toHaveBeenCalledTimes(1);
});
it('never claims or alters a replacement owner after an uncertain acquisition',async()=>{
 const error=timeout();loseAcquisitionAcknowledgment(error,()=>{sqlite.prepare('UPDATE runner_leases SET token=? WHERE id=?').run('replacement-owner',id);});
 await expect(new DailyScheduler(store).acquire(id,started,900000)).rejects.toBe(error);expect(savedLease()).toEqual({id,token:'replacement-owner',leaseUntil:expectedUntil});
});
it('rejects the same token when its durable expiry differs from this acquisition attempt',async()=>{
 const error=timeout(),differentUntil='2026-10-14T17:44:23.254Z';loseAcquisitionAcknowledgment(error,()=>{sqlite.prepare('UPDATE runner_leases SET leaseUntil=? WHERE id=?').run(differentUntil,id);});
 await expect(new DailyScheduler(store).acquire(id,started,900000)).rejects.toBe(error);expect(savedLease()?.leaseUntil).toBe(differentUntil);
});
it('does not recover an exact owned lease that expired while its acknowledgment was missing',async()=>{
 const error=timeout();loseAcquisitionAcknowledgment(error,()=>vi.setSystemTime(Date.parse(expectedUntil)+1));const reads=vi.spyOn(store,'first');
 await expect(new DailyScheduler(store).acquire(id,started,900000)).rejects.toBe(error);expect(savedLease()?.leaseUntil).toBe(expectedUntil);expect(reads).not.toHaveBeenCalled();
});
it('checks actual time again before accepting an ownership read that completes after lease expiry',async()=>{
 const error=timeout();loseAcquisitionAcknowledgment(error);const read=store.first.bind(store);vi.spyOn(store,'first').mockImplementationOnce(async(sql,...values)=>{const row=await read(sql,...values);vi.setSystemTime(Date.parse(expectedUntil)+1);return row;});
 await expect(new DailyScheduler(store).acquire(id,started,900000)).rejects.toBe(error);expect(savedLease()?.leaseUntil).toBe(expectedUntil);
});
it('preserves the acquisition failure and durable lease when ownership verification itself fails',async()=>{
 const error=timeout();loseAcquisitionAcknowledgment(error);const reads=vi.spyOn(store,'first').mockRejectedValueOnce(Error('Verification unavailable'));
 await expect(new DailyScheduler(store).acquire(id,started,900000)).rejects.toBe(error);expect(savedLease()?.leaseUntil).toBe(expectedUntil);expect(reads).toHaveBeenCalledTimes(1);
});
it('bounds one stalled ownership verification and never accepts its late result',async()=>{
 const error=timeout();loseAcquisitionAcknowledgment(error);let finish!:(lease:unknown)=>void;const reads=vi.spyOn(store,'first').mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 let failure:unknown;const request=new DailyScheduler(store).acquire(id,started,900000).catch(error=>{failure=error;});
 await vi.advanceTimersByTimeAsync(5001);expect(failure).toBe(error);await request;expect(reads).toHaveBeenCalledTimes(1);finish(savedLease());expect(savedLease()?.leaseUntil).toBe(expectedUntil);
});
it('does not attempt ownership recovery after a nontransient SQL failure',async()=>{
 const error=Object.assign(Error('SQL constraint rejected acquisition'),{code:'SQL_INPUT_ERROR'}),reads=vi.spyOn(store,'first');vi.spyOn(store,'run').mockRejectedValueOnce(error);
 await expect(new DailyScheduler(store).acquire(id,started,900000)).rejects.toBe(error);expect(reads).not.toHaveBeenCalled();expect(savedLease()).toBeUndefined();
});
