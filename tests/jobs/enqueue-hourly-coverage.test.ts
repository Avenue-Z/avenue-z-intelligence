import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import {KIND_SOURCES} from '../../lib/sources/kind-patches';
import type {AccessScope} from '../../lib/analytics/contracts';
const state=vi.hoisted(()=>({store:null as Store|null}));
vi.mock('@avenue/runtime',()=>({env:{},runtimePlatform:'vercel'}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:()=>null}));
vi.mock('../../lib/ai/server',()=>({generateAIReview:vi.fn()}));
import {enqueueDue} from '../../lib/jobs/sync';
const scope:AccessScope={organizationId:'o',actorId:'scheduler',role:'service',permittedClientIds:['kind-patches']};
let sqlite:DatabaseSync;
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-14T21:05:00Z');sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:SQLInputValue[]=[];const statement={bind(...input:unknown[]){values=input as SQLInputValue[];return statement;},async all(){return {results:sqlite.prepare(sql).all(...values)};},async first(){return sqlite.prepare(sql).get(...values)??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}};}};return statement;};
 state.store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))});
 await state.store.run("INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config) VALUES('kind-patches','o','KP','kp','Europe/Stockholm','USD','blue','{}')");
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();sqlite.close();});
async function source(provider='kind-meta-performance',coverage='2026-10-14T20:00:00Z',lastSuccess='2026-10-14T21:00:52Z'){
 const definition=KIND_SOURCES.find(value=>value.provider===provider);
 await state.store!.run('INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,version,lastSuccess,coverageThrough,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)','source','o','kind-patches','Source',provider,definition?.endpoint??'https://source.example','PRIVATE',definition?.pollMinutes??60,1,1,lastSuccess,coverage,'OLD_ERROR');
}
const bucket=(minutes=60)=>String(Math.floor(Date.now()/(minutes*60000)));
it.each(KIND_SOURCES.filter(value=>!['kind-meta','kind-recharge'].includes(value.provider)).map(value=>value.provider))('enqueues %s for the new completed hour despite publication crossing into its poll bucket',async provider=>{
 await source(provider);const store=state.store!,before=await store.first('SELECT * FROM connections');await enqueueDue(scope);
 expect(await store.all('SELECT id,status,attempts,dueAt FROM jobs')).toEqual([{id:`o:source:${bucket(provider==='kind-triple-whale'||provider==='kind-shopify-hourly'?30:60)}`,status:'pending',attempts:0,dueAt:'2026-10-14T21:05:00.000Z'}]);expect(await store.first('SELECT * FROM connections')).toEqual(before);
});
it('does not enqueue again when the capture already covers the completed hour',async()=>{
 await source('kind-meta-performance','2026-10-14T21:00:00Z');await enqueueDue(scope);expect(await state.store!.all('SELECT * FROM jobs')).toEqual([]);
});
it.each(['pending','running','complete','failed'])('preserves the exact existing %s poll bucket instead of resetting it',async status=>{
 await source();const store=state.store!;await store.enqueue('o','kind-patches','source',bucket(),'2026-10-14T21:01:00Z');await store.run('UPDATE jobs SET status=?,attempts=3,error=?,leaseUntil=?',status,'EXISTING_JOB_ERROR','2026-10-14T21:15:00Z');const before=await store.all('SELECT * FROM jobs');
 await enqueueDue(scope);await enqueueDue(scope);expect(await store.all('SELECT * FROM jobs')).toEqual(before);
});
it.each(['kind-meta','kind-recharge','gateway'])('retains the timestamp polling policy for operational %s',async provider=>{
 await source(provider);await enqueueDue(scope);expect(await state.store!.all('SELECT * FROM jobs')).toEqual([]);
 vi.setSystemTime('2026-10-14T22:05:00Z');await enqueueDue(scope);expect(await state.store!.all('SELECT id FROM jobs')).toEqual([{id:`o:source:${bucket()}`}]);
});
it('retains thirty-minute polls even when hourly coverage is already current',async()=>{
 await source('kind-triple-whale','2026-10-14T21:00:00Z');await enqueueDue(scope);expect(await state.store!.all('SELECT * FROM jobs')).toEqual([]);
 vi.setSystemTime('2026-10-14T21:35:00Z');await enqueueDue(scope);expect(await state.store!.all('SELECT id FROM jobs')).toEqual([{id:`o:source:${bucket(30)}`}]);expect((await state.store!.first('SELECT pollMinutes FROM connections'))?.pollMinutes).toBe(30);
});
it.each([
 ['midnight stale','2026-10-14T22:05:00Z','2026-10-14T21:00:00Z',true],
 ['midnight covered','2026-10-14T22:05:00Z','2026-10-14T22:00:00Z',false],
 ['spring skipped hour','2026-03-29T01:05:00Z','2026-03-29T00:00:00Z',true],
 ['spring covered','2026-03-29T01:05:00Z','2026-03-29T01:00:00Z',false],
 ['fall repeated hour still open','2026-10-25T01:05:00Z','2026-10-25T00:00:00Z',false],
 ['fall repeated hour completed','2026-10-25T02:05:00Z','2026-10-25T00:00:00Z',true]
] as const)('uses the provider completed-hour boundary for %s',async(_label,now,coverage,due)=>{
 vi.setSystemTime(now);await source('kind-meta-performance',coverage,new Date(Date.now()-60000).toISOString());await enqueueDue(scope);expect(await state.store!.all('SELECT id FROM jobs')).toEqual(due?[{id:`o:source:${bucket()}`}]:[]);
});
it('uses the actual client timezone rather than a UTC or fixed Stockholm boundary',async()=>{
 const store=state.store!;await store.run("UPDATE clients SET timezone='Asia/Kolkata'");await source('kind-meta-performance','2026-10-14T20:30:00Z');await enqueueDue(scope);expect(await store.all('SELECT * FROM jobs')).toEqual([]);
 await store.run("UPDATE connections SET coverageThrough='2026-10-14T19:30:00Z'");await enqueueDue(scope);expect(await store.all('SELECT id FROM jobs')).toEqual([{id:`o:source:${bucket()}`}]);
});
