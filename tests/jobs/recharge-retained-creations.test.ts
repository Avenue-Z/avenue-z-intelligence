import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import type {AccessScope,Client} from '../../lib/analytics/contracts';
import initial from '../../data/initial-clients.json';
import {kindQualification,observation,sourceBatch} from '../../lib/sources/kind-patches';
import {rechargeCancellationDefinition,rechargeCancellationPopulation} from '../../lib/sources/recharge-cancellations';

const state=vi.hoisted(()=>({store:null as Store|null,date:'2026-10-15',archives:[] as string[],secret:''}));
vi.mock('@avenue/runtime',()=>({env:{BUCKET:{put:async(_key:string,body:string)=>{state.archives.push(body);}}},runtimePlatform:'sites'}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:()=>state.secret}));
vi.mock('../../lib/ai/server',()=>({generateAIReview:vi.fn()}));
import {runSyncBatch} from '../../lib/jobs/sync';
import {runHourlyHistoryBatch} from '../../lib/jobs/run-hourly-history';
const scope:AccessScope={organizationId:'o',actorId:'scheduler',role:'service',permittedClientIds:['kind-patches']};
const client={...initial[0],version:1} as Client;
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-15T14:35:00Z');state.date='2026-10-15';state.archives=[];
 state.secret=JSON.stringify({SHOP_DOMAIN:'bright-patches.myshopify.com',SHOPIFY_ADMIN_TOKEN:'private',TRIPLE_WHALE_SQL_KEY:'private',TRIPLE_WHALE_SUMMARY_KEY:'private',META_ACCESS_TOKEN:'private',META_AD_ACCOUNT_ID:'123',META_API_VERSION:'v24.0',META_TIME_ZONE:'Europe/Stockholm',APPLOVIN_REPORT_KEY:'private',RECHARGE_ADMIN_TOKEN:'private'});
 const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let args:unknown[]=[];const statement={bind(...values:unknown[]){args=values;return statement;},async all(){return {results:sqlite.prepare(sql).all(...args as SQLInputValue[])};},async first(){return sqlite.prepare(sql).get(...args as SQLInputValue[])??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args as SQLInputValue[]).changes)}};}};return statement;};
 const store=state.store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))});
 await store.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',client.id,'o',client.name,client.slug,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);
 await store.run("INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,version,lastSuccess) VALUES('recharge','o','kind-patches','Recharge','kind-recharge-cancellations','https://api.rechargeapps.com','PRIVATE',60,1,1,'2026-10-15T13:00:00Z')");
 const batch=sourceBatch(client,[observation('2026-10-15','subscriptionEvents','subscription_cancellations',0,rechargeCancellationDefinition,rechargeCancellationPopulation,null,{}, {start:'2026-10-15T13:00:00Z',end:'2026-10-15T14:00:00Z'})],'2026-10-15T14:00:00Z',[],'hourly');
 await store.saveQualification('o',client.id,'recharge',1,1,kindQualification(batch,'kind-recharge-cancellations'),'scheduler');
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
  const url=new URL(String(input)),date=state.date;
  if(url.pathname==='/store')return Response.json({store:{platform_domain:'bright-patches.myshopify.com',storefront_domain:'kindpatches.com',test_mode:false}});
  if(url.pathname==='/events')return Response.json({events:[{id:99,object_id:1,object_type:'subscription',verb:'cancelled',created_at:`${date}T12:00:00Z`}],next_cursor:null});
  if(url.pathname==='/subscriptions')return Response.json({subscriptions:url.searchParams.has('status')?[]:[{id:2,status:'active',created_at:`${date}T10:00:00Z`,cancelled_at:null}],next_cursor:null});
  throw Error('Unexpected provider request in local fixture');
 }));
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
async function retainBirth(date:string){await state.store!.run('INSERT INTO audit VALUES(?,?,?,?,?,?,?)','recharge-creation:o:kind-patches:1','o','kind-patches','recharge-webhook','recharge.subscription.creation.retained',JSON.stringify({subscriptionId:'1',createdAt:`${date}T10:00:00Z`,receivedAt:'2026-10-15T14:00:00Z',source:'recharge-webhook',topic:'subscription/created'}),'2026-10-15T14:00:00Z');}
async function published(date:string){return state.store!.all<{metric:string;value:number}>("SELECT json_extract(o.payload,'$.metric') metric,SUM(json_extract(o.payload,'$.value')) value FROM observations o JOIN current_snapshots p ON p.snapshotId=o.snapshotId AND p.date=o.date WHERE p.organizationId='o' AND p.clientId='kind-patches' AND p.sourceId='recharge' AND p.date=? GROUP BY metric",date);}
it('publishes retained deleted births and matching cancellation events through the actual hourly job',async()=>{
 await retainBirth(state.date);await state.store!.enqueue('o',client.id,'recharge','current',new Date().toISOString());
 expect(await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+700000})).toMatchObject({completed:['o:recharge:current'],failed:[]});
 const rows=await published(state.date);expect(rows.find(row=>row.metric==='new_subscriptions')?.value).toBe(2);expect(rows.find(row=>row.metric==='same_day_subscription_cancellation_events')?.value).toBe(1);expect(rows.find(row=>row.metric==='same_day_subscription_cancellations')?.value).toBe(0);
 expect(await state.store!.first('SELECT error,coverageThrough FROM connections')).toEqual({error:null,coverageThrough:'2026-10-15T14:00:00Z'});
 expect(state.archives).toHaveLength(1);expect(state.archives[0]).not.toContain('subscriptionId');
});
it('uses the same retained births when a closed store day is repaired by its native history job',async()=>{
 state.date='2026-10-14';await retainBirth(state.date);await state.store!.enqueue('o',client.id,'recharge',`hourly-history:${state.date}`,new Date().toISOString());
 expect(await runHourlyHistoryBatch(state.store!,scope,{maxJobs:1,deadline:Date.now()+700000})).toMatchObject({completed:['o:recharge:hourly-history:2026-10-14'],failed:[]});
 const rows=await published(state.date);expect(rows.find(row=>row.metric==='new_subscriptions')?.value).toBe(2);expect(rows.find(row=>row.metric==='same_day_subscription_cancellation_events')?.value).toBe(1);
});
it('defers an owned history job without consuming attempts when retained evidence uses its remaining budget',async()=>{
 state.date='2026-10-14';await retainBirth(state.date);await state.store!.enqueue('o',client.id,'recharge',`hourly-history:${state.date}`,new Date().toISOString());
 const store=state.store!,all=store.all.bind(store),deadline=Date.now()+700000;
 vi.spyOn(store,'all').mockImplementation(async(sql:string,...args:unknown[])=>{
  const rows=await all(sql,...args);if(sql.startsWith('SELECT id,payload FROM audit WHERE'))vi.setSystemTime(deadline+1);return rows;
 });
 expect(await runHourlyHistoryBatch(store,scope,{maxJobs:1,deadline})).toMatchObject({completed:[],failed:[],skipped:'budget'});
 expect(await store.first('SELECT status,attempts,error,leaseUntil FROM jobs')).toEqual({status:'pending',attempts:0,error:'Source synchronization deadline reached',leaseUntil:null});
 expect(state.archives).toHaveLength(0);expect(await store.all('SELECT * FROM current_snapshots')).toEqual([]);
});
