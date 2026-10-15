import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createClient,type Client} from '@libsql/client';
import {createDatabaseFetch} from '../../lib/server/database-fetch';
import {sqliteBindings} from '../../lib/server/sqlite-bindings';
import {Store} from '../../lib/server/store';
import {DailyScheduler} from '../../lib/jobs/scheduler';

type Value={type:'null'|'integer'|'float'|'text';value?:string|number};
type RequestBody={requests:({type:'execute';stmt:{sql:string;args:Value[]}}|{type:'close'})[]};
type Mode='late-commit'|'committed-headers'|'one-service-error'|'persistent-service-error'|'replacement-owner';
const id='offline:sync',started='2026-10-14T19:35:00.000Z';
let sqlite:DatabaseSync,client:Client|undefined;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(started);vi.spyOn(console,'warn').mockImplementation(()=>{});sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE runner_leases(id TEXT PRIMARY KEY NOT NULL,token TEXT NOT NULL,leaseUntil TEXT NOT NULL)');});
afterEach(()=>{client?.close();client=undefined;sqlite.close();vi.restoreAllMocks();vi.useRealTimers();});
const decode=(v:Value):SQLInputValue=>v.type==='null'?null:v.type==='integer'?BigInt(String(v.value)):v.type==='float'?Number(v.value):String(v.value);
const encode=(v:unknown):Value=>v===null?{type:'null'}:typeof v==='number'&&Number.isInteger(v)?{type:'integer',value:String(v)}:typeof v==='number'?{type:'float',value:v}:{type:'text',value:String(v)};
function harness(mode:Mode){
 const calls:{operation:string;at:number;rows?:number}[]=[],signals:AbortSignal[]=[];let first=true,commitLater:(()=>void)|undefined,finishHeaders:((response:Response)=>void)|undefined;
 const run=(request:RequestBody['requests'][number])=>{
  if(request.type==='close')return {type:'ok',response:{type:'close'}};
  const stmt=sqlite.prepare(request.stmt.sql),values=request.stmt.args.map(decode),read=request.stmt.sql.startsWith('SELECT'),columns=stmt.columns(),rows=read?stmt.all(...values):[],changes=read?0:Number(stmt.run(...values).changes);
  if(read)calls.at(-1)!.rows=rows.length;
  return {type:'ok',response:{type:'execute',result:{cols:columns.map(column=>({name:column.name,decltype:column.type})),rows:rows.map(row=>columns.map(column=>encode(row[column.name]))),affected_row_count:changes,last_insert_rowid:null}}};
 };
 const transport:typeof fetch=async(input,init)=>{
  const request=new Request(input,init);if(new URL(request.url).origin!=='https://lease-offline.invalid')throw Error('Unexpected offline transport destination');
  const body=await request.json() as RequestBody,execute=body.requests.find(value=>value.type==='execute'),operation=execute?.type==='execute'&&execute.stmt.sql.startsWith('INSERT')?'INSERT':execute?.type==='execute'&&execute.stmt.sql.startsWith('SELECT')?'SELECT':'OTHER';
  calls.push({operation,at:Date.now()});if(init?.signal)signals.push(init.signal);
  if(first){first=false;
   if(mode==='late-commit'||mode==='replacement-owner')commitLater=()=>{body.requests.forEach(run);};else body.requests.forEach(run);
   return new Promise<Response>(resolve=>{finishHeaders=resolve;});
  }
  if(mode==='persistent-service-error'||(mode==='one-service-error'&&calls.length===2))return new Response('Offline simulated service rejection',{status:503});
  const results=body.requests.map(run);
  if(commitLater){const commit=commitLater;commitLater=undefined;setTimeout(()=>{if(mode==='replacement-owner')sqlite.prepare('INSERT INTO runner_leases(id,token,leaseUntil) VALUES(?,?,?)').run(id,'replacement-offline-owner','2026-10-14T19:51:00.000Z');commit();},10);}
  return Response.json({baton:null,base_url:null,results});
 };
 client=createClient({url:'https://lease-offline.invalid',concurrency:1,fetch:createDatabaseFetch(transport,30000)});
 return {store:new Store(sqliteBindings(client)),calls,signals,finish:()=>finishHeaders?.(Response.json({baton:null,base_url:null,results:[]}))};
}
it('recovers the original lease when the lost-ack INSERT commits after the first healthy empty SDK read',async()=>{
 const h=harness('late-commit');let token:string|null|undefined,failure:unknown;
 const request=new DailyScheduler(h.store).acquire(id,started,900000).then(value=>{token=value;},error=>{failure=error;});
 await vi.waitFor(()=>expect(h.calls).toHaveLength(1));await vi.advanceTimersByTimeAsync(35001);await request;
 expect(failure).toBeUndefined();expect(token).toBeTruthy();expect(sqlite.prepare('SELECT token,leaseUntil FROM runner_leases WHERE id=?').get(id)).toEqual({token,leaseUntil:'2026-10-14T19:50:00.000Z'});
 expect(h.calls.map(call=>call.operation)).toEqual(['INSERT','SELECT','SELECT']);expect(h.calls[1].rows).toBe(0);expect(h.calls[2].rows).toBe(1);expect(h.calls[2].at-h.calls[1].at).toBe(250);expect(h.signals[0].aborted).toBe(true);h.finish();
});
it.each(['committed-headers','one-service-error'] as const)('recovers exact committed ownership through a fresh SDK stream after %s',async mode=>{
 const h=harness(mode);let token:string|null|undefined,failure:unknown;
 const request=new DailyScheduler(h.store).acquire(id,started,900000).then(value=>{token=value;},error=>{failure=error;});
 await vi.waitFor(()=>expect(h.calls).toHaveLength(1));await vi.advanceTimersByTimeAsync(35001);await request;
 expect(failure).toBeUndefined();expect(token).toBeTruthy();expect(sqlite.prepare('SELECT token FROM runner_leases WHERE id=?').get(id)?.token).toBe(token);expect(h.calls.filter(call=>call.operation==='INSERT')).toHaveLength(1);expect(h.calls).toHaveLength(mode==='one-service-error'?3:2);h.finish();
});
it('stops at a replacement owner after an empty SDK read without replaying the original INSERT',async()=>{
 const h=harness('replacement-owner');let failure:unknown,token:string|null|undefined,settledAt:number|undefined;
 const request=new DailyScheduler(h.store).acquire(id,started,900000).then(value=>{token=value;settledAt=Date.now();},error=>{failure=error;});
 await vi.waitFor(()=>expect(h.calls).toHaveLength(1));await vi.advanceTimersByTimeAsync(35001);await request;
 expect(failure).toBeUndefined();expect(token).toBeNull();expect(h.calls.map(call=>call.operation)).toEqual(['INSERT','SELECT','SELECT']);expect(settledAt!-h.calls[1].at).toBe(250);expect(sqlite.prepare('SELECT token,leaseUntil FROM runner_leases WHERE id=?').get(id)).toEqual({token:'replacement-offline-owner',leaseUntil:'2026-10-14T19:51:00.000Z'});h.finish();
});
it('bounds persistent service failures across fresh SDK reads by one shared reconciliation window',async()=>{
 const h=harness('persistent-service-error');let failure:unknown,rejectedAt:number|undefined;
 const request=new DailyScheduler(h.store).acquire(id,started,900000).catch(error=>{failure=error;rejectedAt=Date.now();});
 await vi.waitFor(()=>expect(h.calls).toHaveLength(1));await vi.advanceTimersByTimeAsync(35001);await request;
 expect(failure).toMatchObject({name:'TimeoutError'});expect(rejectedAt!-h.calls[1].at).toBe(5000);expect(h.calls.filter(call=>call.operation==='INSERT')).toHaveLength(1);expect(h.calls.filter(call=>call.operation==='SELECT')).toHaveLength(20);expect(sqlite.prepare('SELECT leaseUntil FROM runner_leases WHERE id=?').get(id)?.leaseUntil).toBe('2026-10-14T19:50:00.000Z');h.finish();
});
