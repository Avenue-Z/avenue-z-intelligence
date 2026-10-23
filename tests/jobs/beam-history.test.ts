import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import {planBeamHistory} from '../../lib/jobs/beam-history';
import {dayWindow} from '../../lib/analytics/windows';
import type {AccessScope} from '../../lib/analytics/contracts';
import initial from '../../data/initial-clients.json';

const now=new Date('2026-10-16T20:00:00Z'),scope:AccessScope={organizationId:'o',actorId:'native',role:'service',permittedClientIds:['beam']},date='2026-10-15',id=`o:source:hourly-history:${date}`,oldDue='2026-10-16T18:59:00.000Z';
type Job={id:string;organizationId:string;clientId:string;sourceId:string;status:string;attempts:number;dueAt:string;error:string|null;leaseUntil:string|null};
async function setup(){
 const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:SQLInputValue[]=[];const statement={bind(...input:SQLInputValue[]){values=input;return statement;},async all(){return {results:sqlite.prepare(sql).all(...values)};},async first(){return sqlite.prepare(sql).get(...values)??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}};}};return statement;};
 const store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))}),client=initial.find(value=>value.id==='beam')!;
 await store.run('INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config,version) VALUES(?,?,?,?,?,?,?,?,1)',client.id,'o',client.name,client.slug,client.timezone,client.currency,client.color,JSON.stringify(client.config));
 await store.run("INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,version) VALUES('source','o','beam','Reporting','beam-shopify-sales','https://example.com','PRIVATE',60,1,1)");
 const contract={clientId:'beam',queryId:'beam-shopify:hourly-v1',timezone:client.timezone,currency:client.currency,hourlyGrain:true,requiresHourly:true,channels:[],requiredChannels:[],dimensions:[],requiredDimensions:[],paginationComplete:true,reconciled:true,reconciliationEvidence:'Independent exact store-day reconciliation',profiles:[{dataset:'revenue',metric:'revenue',population:'orders',definition:'net_sales',currency:'USD',dimensions:[],hourly:true}]};
 await store.saveQualification('o','beam','source',1,1,contract,'native');
 return {store,sqlite,contract};
}
async function failed(store:Store,error='Provider request timed out or could not be reached',dueAt=oldDue,jobId=id,clientId='beam',organizationId='o',status='failed'){
 await store.run('INSERT INTO jobs(id,organizationId,clientId,sourceId,status,attempts,dueAt,error,leaseUntil) VALUES(?,?,?,?,?,3,?,?,?)',jobId,organizationId,clientId,'source',status,dueAt,error,status==='running'?'2026-10-16T22:00:00Z':null);
}
const read=(store:Store,jobId=id)=>store.first<Job>('SELECT * FROM jobs WHERE id=?',jobId);

it('recovers the same fixed history job after three actual Store claims/retries and a one-hour cooldown',async()=>{
 const {store,sqlite}=await setup();try{
  let tick=new Date(Date.parse(oldDue)-14*60000).toISOString();await store.enqueue('o','beam','source',`hourly-history:${date}`,tick);
  for(let attempt=1;attempt<=3;attempt++){
   const claim=await store.claim(tick,'o',['beam']);expect(claim).toMatchObject({id,attempts:attempt});
   await store.retry(id,attempt,'Provider returned HTTP 503',tick);tick=(await read(store))!.dueAt;
  }
  expect(await read(store)).toMatchObject({status:'failed',attempts:3,dueAt:oldDue,error:'Provider returned HTTP 503'});
  await planBeamHistory(store,scope,now);
  expect(await read(store)).toMatchObject({id,status:'pending',attempts:0,dueAt:now.toISOString(),error:'Provider returned HTTP 503',leaseUntil:null});
  expect((await store.all('SELECT id FROM jobs WHERE id=?',id))).toHaveLength(1);
  const next=await store.claim(now.toISOString(),'o',['beam']);expect(next).toMatchObject({id,attempts:1});await store.finish(id);
  expect(await read(store)).toMatchObject({status:'complete',error:null});
 }finally{sqlite.close();}
});

it.each(['Source synchronization deadline reached','Provider rate limited; retry after its cooldown','Database request timed out','Motion MCP request timed out','The operation was aborted due to timeout','fetch failed','Network request failed','connect ECONNRESET','Provider returned HTTP 408','Provider returned HTTP 429','Motion MCP returned HTTP 500','Provider returned HTTP 599'])('reopens an explicitly transient %s failure',async error=>{
 const {store,sqlite}=await setup();try{await failed(store,error);await planBeamHistory(store,scope,now);expect(await read(store)).toMatchObject({status:'pending',attempts:0,error});}finally{sqlite.close();}
});
it.each(['Provider returned HTTP 400','Provider returned HTTP 401','Provider returned HTTP 403','Provider returned HTTP 404','Provider returned HTTP 422','Invalid source configuration','Source qualification required before activation','Source or client configuration changed; re-qualification required','Beam ShopifyQL query rejected; source schema needs review','Registered population or definition changed','Provider returned invalid JSON','Validation request timed out','HTTP 503: authentication invalid','Access token expired after timeout','Missing credentials after network error','Invalid source schema: network timeout','Unknown publication failure'])('preserves a permanent or unclassified %s failure',async error=>{
 const {store,sqlite}=await setup();try{await failed(store,error);const before=await read(store);await planBeamHistory(store,scope,now);expect(await read(store)).toEqual(before);}finally{sqlite.close();}
});
it.each(['2026-10-16T19:00:00.001Z','2026-10-16T21:00:00.000Z','not-a-date'])('preserves the failed job before a valid one-hour dueAt cooldown: %s',async dueAt=>{
 const {store,sqlite}=await setup();try{await failed(store,undefined,dueAt);const before=await read(store);await planBeamHistory(store,scope,now);expect(await read(store)).toEqual(before);}finally{sqlite.close();}
});
it('allows recovery exactly one hour after the stored dueAt and leaves existing pending priority unchanged',async()=>{
 const {store,sqlite}=await setup();try{
  await failed(store,undefined,'2026-10-16T19:00:00.000Z');const pendingId='o:source:hourly-history:2026-10-09';await store.enqueue('o','beam','source','hourly-history:2026-10-09','2026-10-16T18:00:00Z');const pending=await read(store,pendingId);
  await planBeamHistory(store,scope,now);expect(await read(store)).toMatchObject({status:'pending',attempts:0});expect(await read(store,pendingId)).toEqual(pending);
 }finally{sqlite.close();}
});
it.each(['disabled','unqualified','source-version','client-version','invalid-contract','wrong-provider'])('does not reopen a %s source failure',async reason=>{
 const {store,sqlite}=await setup();try{
  await failed(store);const before=await read(store);
  if(reason==='disabled')await store.run('UPDATE connections SET enabled=0');
  if(reason==='unqualified')await store.run('DELETE FROM qualifications');
  if(reason==='source-version')await store.run('UPDATE connections SET version=2');
  if(reason==='client-version')await store.run('UPDATE clients SET version=2');
  if(reason==='invalid-contract')await store.run("UPDATE qualifications SET payload='{}'");
  if(reason==='wrong-provider')await store.run("UPDATE connections SET provider='kind-shopify-sales'");
  await planBeamHistory(store,scope,now);expect(await read(store)).toEqual(before);
 }finally{sqlite.close();}
});
it('does not reopen a failed job whose complete published store day already exists',async()=>{
 const {store,sqlite}=await setup();try{
  await failed(store);const before=await read(store),through=dayWindow(date,'America/New_York').end;
  await store.run("INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES('ready','o','beam','source',?,?,1,'ready','private-test')",now.toISOString(),through);
  await store.run("INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId) VALUES('o','beam','source',?,'ready')",date);
  await planBeamHistory(store,scope,now);expect(await read(store)).toEqual(before);
 }finally{sqlite.close();}
});
it('preserves complete/running/current/KP/other-organization/out-of-retention jobs',async()=>{
 const {store,sqlite}=await setup();try{
  const cases=[['o:source:hourly-history:2026-10-15','beam','o','complete'],['o:source:hourly-history:2026-10-14','beam','o','running'],['o:source:current','beam','o','failed'],['o:kp-source:hourly-history:2026-10-15','kind-patches','o','failed'],['other:source:hourly-history:2026-10-15','beam','other','failed'],['o:source:hourly-history:2026-09-16','beam','o','failed'],['o:source:hourly-history:2026-10-16','beam','o','failed'],['o:lookalike:hourly-history:2026-10-13','beam','o','failed']];
  for(const [jobId,clientId,org,status] of cases)await failed(store,undefined,oldDue,jobId,clientId,org,status);
  const before=await store.all<Job>('SELECT * FROM jobs ORDER BY id');await planBeamHistory(store,scope,now);
  for(const job of before)expect(await read(store,job.id)).toEqual(job);
 }finally{sqlite.close();}
});
it.each(['analyst','wrong-client','wrong-organization'])('does not recover jobs outside %s access',async reason=>{
 const {store,sqlite}=await setup();try{
  await failed(store);const before=await read(store),unauthorized={...scope,...reason==='analyst'?{role:'analyst' as const}:reason==='wrong-client'?{permittedClientIds:['kind-patches']}:{organizationId:'other'}};
  await planBeamHistory(store,unauthorized,now);expect(await read(store)).toEqual(before);
 }finally{sqlite.close();}
});
it.each(['running','dueAt','attempts','error','disabled','source-version','client-version','qualification'])('preserves a %s change made after recovery planning',async change=>{
 const {store,sqlite,contract}=await setup();try{
  await failed(store);const run=store.run.bind(store);let raced=false,expected:Job|null=null;
  const spy=vi.spyOn(store,'run').mockImplementation(async(sql,...values)=>{
   if(!raced&&sql.startsWith("UPDATE jobs SET status='pending'")){
    raced=true;
    if(change==='running')await run("UPDATE jobs SET status='running',leaseUntil='2026-10-16T22:00:00Z' WHERE id=?",id);
    if(change==='dueAt')await run("UPDATE jobs SET dueAt='2026-10-16T19:59:00Z' WHERE id=?",id);
    if(change==='attempts')await run('UPDATE jobs SET attempts=4 WHERE id=?',id);
    if(change==='error')await run("UPDATE jobs SET error='Provider returned HTTP 401' WHERE id=?",id);
    if(change==='disabled')await run('UPDATE connections SET enabled=0');
    if(change==='source-version')await run('UPDATE connections SET version=2');
    if(change==='client-version')await run('UPDATE clients SET version=2');
    if(change==='qualification')await store.saveQualification('o','beam','source',1,1,contract,'reviewer');
    expected=await read(store);
   }
   return run(sql,...values);
  });
  try{await planBeamHistory(store,scope,now);expect(raced).toBe(true);expect(await read(store)).toEqual(expected);}finally{spy.mockRestore();}
 }finally{sqlite.close();}
});
