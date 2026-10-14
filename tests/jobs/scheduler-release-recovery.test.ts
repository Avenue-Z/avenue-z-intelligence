import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import {DailyScheduler} from '../../lib/jobs/scheduler';

let sqlite:DatabaseSync,store:Store;
const id='o:sync',token='original-owner',until='2026-10-14T19:10:32.000Z';
const timeout=()=>new DOMException('Database request timed out','TimeoutError');
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-14T19:03:00Z');sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:SQLInputValue[]=[];const statement={bind(...input:SQLInputValue[]){values=input;return statement;},async first(){return sqlite.prepare(sql).get(...values)??null;},async all(){return {results:sqlite.prepare(sql).all(...values)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}};}};return statement;};
 store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))});sqlite.prepare('INSERT INTO runner_leases VALUES(?,?,?)').run(id,token,until);
});
afterEach(()=>{vi.restoreAllMocks();sqlite.close();vi.useRealTimers();});
const savedLease=()=>sqlite.prepare('SELECT id,token,leaseUntil FROM runner_leases WHERE id=?').get(id);

it.each([()=>timeout(),()=>Error('Database request timed out')])('recognizes a committed release with a lost acknowledgment without another delete',async failure=>{
 const error=failure(),run=store.run.bind(store),writes=vi.spyOn(store,'run').mockImplementationOnce(async(sql,...values)=>{await run(sql,...values);throw error;}),reads=vi.spyOn(store,'first');
 await expect(new DailyScheduler(store).release(id,token)).resolves.toBeUndefined();
 expect(savedLease()).toBeUndefined();expect(writes).toHaveBeenCalledTimes(1);expect(reads).toHaveBeenCalledTimes(1);
});
it.each([()=>timeout(),()=>Error('Database request timed out')])('retries an uncommitted release once only after verifying the original owner',async failure=>{
 const error=failure(),writes=vi.spyOn(store,'run').mockRejectedValueOnce(error),reads=vi.spyOn(store,'first');
 await expect(new DailyScheduler(store).release(id,token)).resolves.toBeUndefined();
 expect(savedLease()).toBeUndefined();expect(reads).toHaveBeenCalledTimes(1);expect(writes).toHaveBeenCalledTimes(2);
 expect(writes.mock.calls[1]).toEqual(['DELETE FROM runner_leases WHERE id=? AND token=?',id,token]);
});
it('leaves a replacement owner untouched without retrying a timed-out release',async()=>{
 const error=timeout(),writes=vi.spyOn(store,'run').mockImplementationOnce(async()=>{sqlite.prepare('UPDATE runner_leases SET token=? WHERE id=?').run('replacement-owner',id);throw error;});
 await expect(new DailyScheduler(store).release(id,token)).resolves.toBeUndefined();
 expect(savedLease()).toEqual({id,token:'replacement-owner',leaseUntil:until});expect(writes).toHaveBeenCalledTimes(1);
});
it('keeps the token guard when a new owner arrives between verification and the retry',async()=>{
 const error=timeout(),writes=vi.spyOn(store,'run').mockRejectedValueOnce(error),first=store.first.bind(store);
 vi.spyOn(store,'first').mockImplementationOnce(async(sql,...values)=>{const lease=await first(sql,...values);sqlite.prepare('UPDATE runner_leases SET token=? WHERE id=?').run('replacement-owner',id);return lease;});
 await expect(new DailyScheduler(store).release(id,token)).resolves.toBeUndefined();
 expect(savedLease()).toEqual({id,token:'replacement-owner',leaseUntil:until});expect(writes).toHaveBeenCalledTimes(2);expect(writes.mock.calls[1].slice(1)).toEqual([id,token]);
});
it('retains the original failure and never retries when ownership verification fails',async()=>{
 const error=timeout(),writes=vi.spyOn(store,'run').mockRejectedValueOnce(error),reads=vi.spyOn(store,'first').mockRejectedValueOnce(Error('Verification unavailable'));
 await expect(new DailyScheduler(store).release(id,token)).rejects.toBe(error);
 expect(savedLease()).toEqual({id,token,leaseUntil:until});expect(writes).toHaveBeenCalledTimes(1);expect(reads).toHaveBeenCalledTimes(1);
});
it('bounds stalled verification to five seconds and never acts on its late result',async()=>{
 const error=timeout(),writes=vi.spyOn(store,'run').mockRejectedValueOnce(error);let finish!:(lease:unknown)=>void;
 const reads=vi.spyOn(store,'first').mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));let failure:unknown;
 const request=new DailyScheduler(store).release(id,token).catch(error=>{failure=error;});
 await vi.advanceTimersByTimeAsync(5001);await request;expect(failure).toBe(error);expect(writes).toHaveBeenCalledTimes(1);expect(reads).toHaveBeenCalledTimes(1);
 finish(savedLease());await Promise.resolve();expect(writes).toHaveBeenCalledTimes(1);expect(savedLease()).toEqual({id,token,leaseUntil:until});
});
it('bounds the single retry to five seconds and cannot delete a later owner if the RPC finishes late',async()=>{
 const error=timeout(),run=store.run.bind(store);let finish!:()=>Promise<void>;
 const writes=vi.spyOn(store,'run').mockRejectedValueOnce(error).mockImplementationOnce((sql,...values)=>new Promise(resolve=>{finish=async()=>{resolve(await run(sql,...values));};}));let failure:unknown;
 const request=new DailyScheduler(store).release(id,token).catch(error=>{failure=error;});
 await vi.advanceTimersByTimeAsync(5001);await request;expect(failure).toBe(error);expect(writes).toHaveBeenCalledTimes(2);expect(savedLease()).toEqual({id,token,leaseUntil:until});
 sqlite.prepare('UPDATE runner_leases SET token=? WHERE id=?').run('replacement-owner',id);await finish();expect(savedLease()).toEqual({id,token:'replacement-owner',leaseUntil:until});expect(writes).toHaveBeenCalledTimes(2);
});
it('does not attempt recovery after a nontransient release failure',async()=>{
 const error=Object.assign(Error('SQL constraint rejected release'),{code:'SQL_INPUT_ERROR'}),writes=vi.spyOn(store,'run').mockRejectedValueOnce(error),reads=vi.spyOn(store,'first');
 await expect(new DailyScheduler(store).release(id,token)).rejects.toBe(error);expect(writes).toHaveBeenCalledTimes(1);expect(reads).not.toHaveBeenCalled();expect(savedLease()).toEqual({id,token,leaseUntil:until});
});
