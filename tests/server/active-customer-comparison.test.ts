import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import {fingerprint} from '../../lib/reviews/build';
import {kindQualification,observation,sourceBatch} from '../../lib/sources/kind-patches';
import {queryClient} from '../../lib/analytics/query';
import {workspacePresentation} from '../../lib/analytics/presentation';
import {preparedWorkspaceFrame} from '../../lib/server/prepared-workspace-cache';
import {Temporal} from '@js-temporal/polyfill';
import initial from '../../data/initial-clients.json';
import type {Client,Connection,QueryFilters} from '../../lib/analytics/contracts';
vi.mock('@avenue/runtime',()=>({runtimePlatform:'vercel'}));
const client={...initial[0],version:1} as Client,org='o',source='recharge';
const filters:QueryFilters={from:'2026-09-14',to:'2026-10-13',compare:'previous',mode:'closed',view:'subscriptions',market:'US',stream:'',source:'other',device:'',page:''};
const selection={datasets:['subscriptions'],trendDatasets:[],includePriorWeek:false};
let sqlite:DatabaseSync,store:Store,queries:string[],baselineId:string,currentId:string;
function batch(at:string,value:number){const date=Temporal.Instant.from(at).toZonedDateTimeISO(client.timezone).toPlainDate().toString();return sourceBatch(client,[observation(date,'subscriptions','active_customers',value,'recharge_raw_active_customers_not_subscription_count_or_baseline_adjusted','recharge_active_customers',null,{source:'recharge'})],at);}
async function capture(at:string,value:number){const input=batch(at,value);return store.persistBatch(org,source,input,await fingerprint(input),at);}
async function read(options?:{deadline:number}){return workspacePresentation(queryClient(client,await store.observations(org,client.id,filters,false,options,selection),await store.connections(org,client.id),filters,{preparedDatasets:selection.datasets}),filters);}
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-14T21:25:00Z');sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));queries=[];
 const prepare=(sql:string)=>{let values:SQLInputValue[]=[];const statement={bind(...input:unknown[]){values=input as SQLInputValue[];return statement;},async all(){queries.push(sql);return {results:sqlite.prepare(sql).all(...values)};},async first(){queries.push(sql);return sqlite.prepare(sql).get(...values)??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}};}};return statement;};
 store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))});
 await store.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',client.id,org,client.name,client.slug,client.timezone,client.currency,client.color,JSON.stringify(client.config),client.version);
 await store.run('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',source,org,client.id,'Recharge','kind-recharge','https://api.rechargeapps.com','PRIVATE',60,1,null,null,null,1);
 await store.saveQualification(org,client.id,source,1,1,kindQualification(batch('2026-10-14T21:20:32.836Z',148546),'kind-recharge'),'fixture');
 baselineId=await capture('2026-10-13T21:20:30.259Z',147803);await capture('2026-10-13T21:05:00Z',147700);await capture('2026-10-13T22:55:00Z',160000);currentId=await capture('2026-10-14T21:20:32.836Z',148546);queries=[];
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();sqlite.close();});
it('compares nearest real same-store-hour snapshots independently of selected range and filters without replacing the current count',async()=>{
 const before=sqlite.prepare('SELECT * FROM observations ORDER BY snapshotId,date,rowKey').all(),result=await read();
 expect(result.liveOperations).toHaveLength(1);expect(result.liveOperations[0]).toMatchObject({value:148546,retrievedAt:'2026-10-14T21:20:32.836Z'});expect(result.liveOperations[0]).not.toHaveProperty('activeCustomerComparison');
 expect(result.activeCustomerComparison).toEqual({baseline:{value:147803,asOf:'2026-10-13T21:20:30.259Z',retrievedAt:'2026-10-13T21:20:30.259Z',snapshotId:baselineId},delta:743,relativeChange:743/147803,alignment:'same-store-hour'});
 expect(sqlite.prepare('SELECT * FROM observations ORDER BY snapshotId,date,rowKey').all()).toEqual(before);const sql=queries.find(query=>query.startsWith('WITH candidates AS MATERIALIZED'))!;expect(sql).toContain('LIMIT 8');expect(sql).toContain('id>=? AND id<?');expect(sql).toContain('o.rowKey=?');
});
it('omits the comparison when only a different-hour/end-of-day sample remains',async()=>{
 await store.run("DELETE FROM snapshots WHERE coverageThrough LIKE '2026-10-13T21:%'");expect((await read()).activeCustomerComparison).toBeUndefined();expect((await read()).liveOperations[0].value).toBe(148546);
});
it.each(['definition','population','currency','dimensions','interval','quality','source','retrievedAt','coverageThrough','value'])('does not compare a %s-mismatched historical fact',async field=>{
 await store.run("DELETE FROM snapshots WHERE id<>? AND id<>?",baselineId,currentId);const saved=sqlite.prepare('SELECT payload FROM observations WHERE snapshotId=?').get(baselineId)!,row=JSON.parse(String(saved.payload));
 const changes:Record<string,unknown>={definition:'other',population:'subscriptions',currency:'USD',dimensions:{source:'other'},interval:'2026-10-13T20:00:00Z',quality:'partial',source:'foreign',retrievedAt:'2026-10-13T21:10:00Z',coverageThrough:'2026-10-13T21:10:00Z',value:-1};row[field==='source'?'sourceId':field==='interval'?'start':field]=changes[field];await store.run('UPDATE observations SET payload=? WHERE snapshotId=?',JSON.stringify(row),baselineId);
 const result=await read();expect(result.activeCustomerComparison).toBeUndefined();expect(result.liveOperations[0].value).toBe(148546);
});
it.each(['disabled','source-version','client-version','provider','qualification'])('omits an unauthorized or changed %s source comparison',async condition=>{
 if(condition==='disabled')await store.run('UPDATE connections SET enabled=0');if(condition==='source-version')await store.run('UPDATE connections SET version=2');if(condition==='client-version')await store.run('UPDATE clients SET version=2');if(condition==='provider')await store.run("UPDATE connections SET provider='gateway'");if(condition==='qualification')await store.run("UPDATE qualifications SET payload=json_set(payload,'$.profiles[0].population','other')");
 expect((await read()).activeCustomerComparison).toBeUndefined();
});
it('retains a real delta with a null relative change when yesterday was zero',async()=>{
 await capture('2026-10-13T21:20:32.835Z',0);const result=await read();expect(result.activeCustomerComparison).toMatchObject({baseline:{value:0},delta:148546,relativeChange:null});
});
it('does not fail the canonical current count after an optional database error',async()=>{
 const first=store.first.bind(store);vi.spyOn(store,'first').mockImplementation(async(sql,...args)=>{if(sql.startsWith('SELECT c.provider'))throw new DOMException('Database request timed out','TimeoutError');return first(sql,...args);});
 const result=await read();expect(result.activeCustomerComparison).toBeUndefined();expect(result.liveOperations[0].value).toBe(148546);
});
it.each([5000,1000])('bounds optional reads to %sms and starts no further work after their timeout',async milliseconds=>{
 const first=store.first.bind(store);let resolveGate:((value:unknown)=>void)|undefined;const gate=vi.spyOn(store,'first').mockImplementation(async(sql,...args)=>sql.startsWith('SELECT c.provider')?new Promise(resolve=>{resolveGate=resolve;}):first(sql,...args)),work=read(milliseconds===1000?{deadline:Date.now()+1000}:undefined);
 await vi.waitFor(()=>expect(resolveGate).toBeDefined());await vi.advanceTimersByTimeAsync(milliseconds);const result=await work;expect(result.activeCustomerComparison).toBeUndefined();expect(result.liveOperations[0].value).toBe(148546);const readCount=queries.length;resolveGate?.(null);await Promise.resolve();await Promise.resolve();expect(queries).toHaveLength(readCount);expect(gate).toHaveBeenCalled();
});
it('round-trips the comparison through prepared cache and invalidates it with the current operation pointer',async()=>{
 const input={store,organizationId:org,client,filters,preparedDatasets:selection.datasets,selection},load=vi.fn(async(connections:Connection[])=>workspacePresentation(queryClient(client,await store.observations(org,client.id,filters,false,undefined,selection),connections,filters,{preparedDatasets:selection.datasets}),filters));
 const first=await preparedWorkspaceFrame(input,load),cached=await preparedWorkspaceFrame(input,load);expect(first.activeCustomerComparison?.delta).toBe(743);expect(cached.activeCustomerComparison).toEqual(first.activeCustomerComparison);expect(load).toHaveBeenCalledTimes(1);
 await capture('2026-10-14T21:30:00Z',148555);const changed=await preparedWorkspaceFrame(input,load);expect(changed.activeCustomerComparison?.delta).toBe(752);expect(changed.liveOperations[0].value).toBe(148555);expect(load).toHaveBeenCalledTimes(2);
});
it.each([
 ['2026-03-29T01:20:00Z','2026-03-28T02:20:00Z'],
 ['2026-10-25T02:20:00Z','2026-10-24T01:20:00Z'],
 ['2026-10-14T22:20:00Z','2026-10-13T22:20:00Z']
])('aligns calendar yesterday in the store timezone for %s',async(now,yesterday)=>{
 await store.run('DELETE FROM current_snapshots');const baseline=await capture(yesterday,100);await capture(now,110);const result=await read();expect(result.activeCustomerComparison).toMatchObject({baseline:{value:100,asOf:yesterday,snapshotId:baseline},delta:10,relativeChange:.1});
});
it.each(['delta','scope','hour'])('rejects a correctly hashed cache with an invalid comparison %s',async condition=>{
 const input={store,organizationId:org,client,filters,preparedDatasets:selection.datasets,selection},load=vi.fn(async(connections:Connection[])=>workspacePresentation(queryClient(client,await store.observations(org,client.id,filters,false,undefined,selection),connections,filters,{preparedDatasets:selection.datasets}),filters)),frame=await preparedWorkspaceFrame(input,load),comparison=structuredClone(frame.activeCustomerComparison!);
 if(condition==='delta')comparison.delta=1;if(condition==='scope')comparison.baseline.snapshotId=baselineId.replace(/^o:/,'foreign:');if(condition==='hour')comparison.baseline.asOf='2026-10-13T20:20:30.259Z';
 const payload=Buffer.from(await new Response(new Response(JSON.stringify({...frame,connections:undefined,activeCustomerComparison:comparison})).body!.pipeThrough(new CompressionStream('gzip'))).arrayBuffer()).toString('base64');await store.run('UPDATE prepared_workspace_cache SET payload=?,payloadHash=?',payload,createHash('sha256').update(payload).digest('hex'));
 const recovered=await preparedWorkspaceFrame({...input,store:new Store({...store.db})},load);expect(recovered.activeCustomerComparison?.delta).toBe(743);expect(recovered.activeCustomerComparison?.baseline.snapshotId).toBe(baselineId);expect(load).toHaveBeenCalledTimes(2);
});
