import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import initial from '../../data/initial-clients.json';
const state=vi.hoisted(()=>({store:null as Store|null,warm:vi.fn()}));
vi.mock('@avenue/runtime',()=>({runtimePlatform:'vercel'}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:(name:string)=>name==='APP_ORGANIZATION_ID'?'o':name==='CRON_SECRET'?'a'.repeat(32):null}));
vi.mock('../../lib/server/cache-warming',()=>({warmSuccessfulSourceJobs:state.warm}));
import {cacheTick} from '../../lib/jobs/cache-runner';
import {GET} from '../../app/api/cron/cache/route';
let sqlite:DatabaseSync;
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-13T18:00:00Z');state.warm.mockReset().mockResolvedValue({attempted:9,completed:9});vi.stubGlobal('fetch',()=>{throw Error('Provider pulls are forbidden');});
 sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:SQLInputValue[]=[];const statement={bind(...input:SQLInputValue[]){values=input;return statement;},async first(){return sqlite.prepare(sql).get(...values)??null;},async all(){return {results:sqlite.prepare(sql).all(...values)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}};}};return statement;};
 const store=state.store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))});
 await store.run("INSERT INTO organizations VALUES('o','Avenue Z',1)");const client=initial[0];await store.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',client.id,'o',client.name,client.slug,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);
});
afterEach(()=>{vi.restoreAllMocks();sqlite.close();vi.useRealTimers();vi.unstubAllGlobals();});
async function job(bucket:string,client='kind-patches',organization='o',dueAt='2026-10-13T17:00:00Z',complete=true){const store=state.store!;await store.enqueue(organization,client,'source',bucket,dueAt);if(complete)await store.finish(`${organization}:source:${bucket}`);}
it('warms only recent completed current-source jobs for the initialized Kind workspace with its own 15-minute lease and 700-second budget',async()=>{
 for(let index=0;index<15;index++)await job(`current-${index}`,'kind-patches','o',`2026-10-13T17:${String(index).padStart(2,'0')}:00Z`);
 await job('hourly-history:2026-10-12');await job('other-client','beam');await job('other-organization','kind-patches','other');await job('pending','kind-patches','o','2026-10-13T17:55:00Z',false);
 const before=await state.store!.all('SELECT id,status,attempts FROM jobs ORDER BY id');
 state.warm.mockImplementationOnce(async()=>{expect(await state.store!.first("SELECT leaseUntil FROM runner_leases WHERE id='o:cache'")).toEqual({leaseUntil:'2026-10-13T18:15:00.000Z'});return {attempted:9,completed:9};});
 expect(await cacheTick()).toMatchObject({failed:[],cacheWarm:{attempted:9,completed:9}});
 expect(state.warm).toHaveBeenCalledWith(state.store,{organizationId:'o',actorId:'application-cache-scheduler',role:'service',permittedClientIds:['kind-patches']},Array.from({length:13},(_,index)=>`o:source:current-${14-index}`),Date.parse('2026-10-13T18:00:00Z')+700000);
 expect(await state.store!.all('SELECT id,status,attempts FROM jobs ORDER BY id')).toEqual(before);expect(await state.store!.all('SELECT * FROM runner_leases')).toEqual([]);
});
it('skips an existing cache lease without touching the source sync lease',async()=>{
 await state.store!.run("INSERT INTO runner_leases VALUES('o:sync','sync-token','2026-10-13T18:15:00Z')");await state.store!.run("INSERT INTO runner_leases VALUES('o:cache','cache-token','2026-10-13T18:15:00Z')");
 expect(await cacheTick()).toMatchObject({skipped:'already-running',failed:[]});expect(state.warm).not.toHaveBeenCalled();expect(await state.store!.all('SELECT id,token FROM runner_leases ORDER BY id')).toEqual([{id:'o:cache',token:'cache-token'},{id:'o:sync',token:'sync-token'}]);
});
it('does no warming when no current jobs exist or initialization is unavailable',async()=>{
 await job('hourly-history:2026-10-12');expect(await cacheTick()).toMatchObject({skipped:'no-completed-source-jobs',failed:[]});expect(state.warm).not.toHaveBeenCalled();
 await state.store!.run('UPDATE organizations SET initialized=0');await expect(cacheTick()).rejects.toThrow('initialized');expect(state.warm).not.toHaveBeenCalled();
});
it('requires the existing cron credential and releases its lease on failures',async()=>{
 expect((await GET(new Request('https://app.example/api/cron/cache'))).status).toBe(401);expect(state.warm).not.toHaveBeenCalled();
 await job('current');state.warm.mockRejectedValueOnce(Error('Warm failed'));await expect(cacheTick()).rejects.toThrow('Warm failed');expect(await state.store!.all('SELECT * FROM runner_leases')).toEqual([]);
 const response=await GET(new Request('https://app.example/api/cron/cache',{headers:{authorization:`Bearer ${'a'.repeat(32)}`}}));expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
});
it('continues cache warming and releases its actual durable lease after a committed acquisition response times out',async()=>{
 await job('current');const store=state.store!,run=store.run.bind(store),before=await store.all('SELECT id,status,attempts FROM jobs ORDER BY id');
 vi.spyOn(store,'run').mockImplementationOnce(async(sql,...values)=>{await run(sql,...values);vi.setSystemTime(Date.now()+30002);throw new DOMException('Database request timed out','TimeoutError');});
 expect(await cacheTick()).toMatchObject({failed:[],cacheWarm:{attempted:9,completed:9}});
 expect(await store.all('SELECT * FROM runner_leases')).toEqual([]);expect(await store.all('SELECT id,status,attempts FROM jobs ORDER BY id')).toEqual(before);
});
