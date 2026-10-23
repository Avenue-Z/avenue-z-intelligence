import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import type {AccessScope} from '../../lib/analytics/contracts';
import initial from '../../data/initial-clients.json';
vi.mock('@avenue/runtime',()=>({env:{},runtimePlatform:'vercel'}));
vi.mock('../../lib/server/access',()=>({getStore:()=>{throw Error('Global shared Store must not be used');}}));
vi.mock('../../lib/ai/server',()=>({generateAIReview:vi.fn()}));
import {planBeamHistory} from '../../lib/jobs/beam-sync';
import {enqueueDue} from '../../lib/jobs/sync';
const now=new Date('2026-10-16T15:10:00Z'),scope:AccessScope={organizationId:'o',actorId:'native',role:'service',permittedClientIds:['beam']};
async function setup(provider='beam-shopify-sales'){
 const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:SQLInputValue[]=[];const statement={bind(...input:SQLInputValue[]){values=input;return statement;},async all(){return {results:sqlite.prepare(sql).all(...values)};},async first(){return sqlite.prepare(sql).get(...values)??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}};}};return statement;};
 const store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))}),client=initial.find(value=>value.id==='beam')!;
 await store.run('INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config,version) VALUES(?,?,?,?,?,?,?,?,1)',client.id,'o',client.name,client.slug,client.timezone,client.currency,client.color,JSON.stringify(client.config));
 await store.run("INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,version) VALUES('source','o','beam','Reporting',?,'https://example.com','PRIVATE',60,1,1)",provider);
 return {store,sqlite};
}
it('queues only the rolling 29 closed dates, yesterday and last weekday first, without duplicating jobs',async()=>{
 const {store,sqlite}=await setup();try{
  expect(await planBeamHistory(store,scope,now)).toBe(29);await planBeamHistory(store,scope,now);
  const jobs=await store.all<{id:string;status:string}>('SELECT id,status FROM jobs ORDER BY dueAt');expect(jobs).toHaveLength(29);expect(jobs.slice(0,2).map(job=>job.id.slice(-10))).toEqual(['2026-10-15','2026-10-09']);
  expect(jobs.map(job=>job.id.slice(-10)).sort().at(0)).toBe('2026-09-17');expect(jobs.every(job=>job.status==='pending')).toBe(true);
 }finally{sqlite.close();}
});
it('does not treat a settling hourly day as complete history or queue another client',async()=>{
 const {store,sqlite}=await setup();try{
  await store.run("INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES('s','o','beam','source','2026-10-16T15:00:00Z','2026-10-16T03:00:00Z',1,'ready','private')");
  await store.run("INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId) VALUES('o','beam','source','2026-10-15','s')");
  expect(await planBeamHistory(store,scope,now)).toBe(29);
  await store.run("UPDATE snapshots SET coverageThrough='2026-10-16T04:00:00Z'");await store.run('DELETE FROM jobs');
  expect(await planBeamHistory(store,scope,now)).toBe(28);expect(await planBeamHistory(store,{...scope,permittedClientIds:['kind-patches']},now)).toBe(0);
 }finally{sqlite.close();}
});
it('accepts completed provider-date reports without manufacturing store-hour coverage',async()=>{
 const {store,sqlite}=await setup('beam-motion');try{
  await store.run("INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES('s','o','beam','source','2026-10-16T15:00:00Z',NULL,1,'ready','private')");
  await store.run("INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId) VALUES('o','beam','source','2026-10-15','s')");
  expect(await planBeamHistory(store,scope,now)).toBe(28);
 }finally{sqlite.close();}
});
it('uses the explicitly owned Store for native polling and leaves disabled sources untouched',async()=>{
 const {store,sqlite}=await setup();try{
  await enqueueDue(scope,undefined,store);expect(await store.all('SELECT id FROM jobs')).toHaveLength(1);
  await store.run('DELETE FROM jobs');await store.run('UPDATE connections SET enabled=0');await enqueueDue(scope,undefined,store);expect(await store.all('SELECT id FROM jobs')).toHaveLength(0);
 }finally{sqlite.close();}
});

it('polls Beam again when the newly completed store hour was missed within the same timestamp bucket',async()=>{
 const {store,sqlite}=await setup();vi.useFakeTimers();vi.setSystemTime(now);try{
  await store.run("UPDATE connections SET lastSuccess='2026-10-16T15:01:00Z',coverageThrough='2026-10-16T14:00:00Z'");await enqueueDue(scope,undefined,store);expect(await store.all('SELECT id FROM jobs')).toHaveLength(1);
  await store.run('DELETE FROM jobs');await store.run("UPDATE connections SET coverageThrough='2026-10-16T15:00:00Z'");await enqueueDue(scope,undefined,store);expect(await store.all('SELECT id FROM jobs')).toHaveLength(0);
 }finally{vi.useRealTimers();sqlite.close();}
});
it('retries platform polling by retrieval time without fabricating an hourly coverage requirement',async()=>{
 const {store,sqlite}=await setup('beam-motion');vi.useFakeTimers();vi.setSystemTime(now);try{
  await store.run("UPDATE connections SET lastSuccess='2026-10-16T15:01:00Z',coverageThrough=NULL");await enqueueDue(scope,undefined,store);expect(await store.all('SELECT id FROM jobs')).toHaveLength(0);
  await store.run("UPDATE connections SET lastSuccess='2026-10-16T14:59:00Z'");await enqueueDue(scope,undefined,store);expect(await store.all('SELECT id FROM jobs')).toHaveLength(1);
 }finally{vi.useRealTimers();sqlite.close();}
});
it('cancels only Beam pending history outside the retained month, preserving active leases and Kind Patches work',async()=>{
 const {store,sqlite}=await setup();try{
  for(const [id,clientId,status] of [['beam-expired','beam','pending'],['beam-running','beam','running'],['kp-expired','kind-patches','pending']])await store.run('INSERT INTO jobs(id,organizationId,clientId,sourceId,status,attempts,dueAt,leaseUntil) VALUES(?,?,?,?,?,0,?,?)',`o:${id}:hourly-history:2026-09-16`,'o',clientId,'source',status,'2026-10-16T14:00:00Z',status==='running'?'2026-10-16T16:00:00Z':null);
  await planBeamHistory(store,scope,now);const jobs=await store.all<{id:string;status:string}>("SELECT id,status FROM jobs WHERE id LIKE '%2026-09-16' ORDER BY id");expect(jobs).toEqual([{id:'o:beam-expired:hourly-history:2026-09-16',status:'cancelled'},{id:'o:beam-running:hourly-history:2026-09-16',status:'running'},{id:'o:kp-expired:hourly-history:2026-09-16',status:'pending'}]);
 }finally{sqlite.close();}
});
