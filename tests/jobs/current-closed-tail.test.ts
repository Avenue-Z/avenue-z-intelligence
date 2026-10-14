import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import initial from '../../data/initial-clients.json';
import type {AccessScope,Client,Connection} from '../../lib/analytics/contracts';
import {fetchKindSource} from '../../lib/sources/kind-fetch';
import {KIND_SOURCES,kindQualification} from '../../lib/sources/kind-patches';
const state=vi.hoisted(()=>({store:null as Store|null,secret:'',failure:null as string|null,requests:[] as string[],puts:0}));
vi.mock('@avenue/runtime',()=>({runtimePlatform:'vercel',env:{BUCKET:{put:async()=>{state.puts++;}}}}));
vi.mock('../../lib/server/access',()=>({getStore:()=>state.store}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:()=>state.secret}));
vi.mock('../../lib/ai/server',()=>({generateAIReview:vi.fn()}));
import {runSyncBatch} from '../../lib/jobs/sync';
const client={...initial[0],version:1} as Client,scope:AccessScope={organizationId:'o',actorId:'runner',role:'service',permittedClientIds:[client.id]};
let sqlite:DatabaseSync,priorId:string,coverage:string;
function connection(provider:string,id:string):Connection{return {...KIND_SOURCES.find(value=>value.provider===provider)!,id,clientId:client.id,enabled:true,secretRef:'PRIVATE',version:1,lastSuccess:'2026-10-13T11:00:00Z',coverageThrough:null,error:null};}
const current=connection('kind-triple-whale','tw'),next=connection('kind-meta','meta');
const fixture:typeof fetch=async(url,options)=>{
 if(String(url).includes('graph.facebook.com'))return Response.json(String(url).includes('/ads?')?{data:[{id:'ad',effective_status:'ACTIVE',creative:{id:'creative'}}]}:{currency:'USD',timezone_name:client.timezone});
 const body=JSON.parse(String(options?.body)),date=body.period.startDate,query=body.query;state.requests.push(date);
 if(date==='2026-10-13'&&state.failure==='today-timeout')throw new DOMException('Request timed out','TimeoutError');
 if(date<'2026-10-13'&&state.failure==='timeout')throw new DOMException('Request timed out','TimeoutError');
 if(date<'2026-10-13'&&state.failure==='deadline')vi.setSystemTime(Date.now()+10000);
 if(date<'2026-10-13'&&state.failure==='auth')return new Response('',{status:403});
 if(date<'2026-10-13'&&state.failure==='schema')return new Response('invalid json');
 if(date<'2026-10-13'&&state.failure==='reconcile')return Response.json(query.includes('GROUP BY event_date,event_hour')?[]:[{event_date:date,revenue:999,orders:99,new_orders:99}]);
 const commerce={event_date:date,revenue:100,orders:2,new_orders:1},hourly=query.includes('GROUP BY event_date,event_hour');
 const row=query.includes('recurring_revenue')?{event_date:date,event_hour:14,recurring_revenue:30,recurring_orders:1,recurring_refund_orders:0,recurring_cancelled_orders:0}:query.includes('ads_table')?{event_date:date,...hourly?{event_hour:14}:{},channel:'facebook-ads',spend:20}:{...commerce,...hourly?{event_hour:14,shop_timezone:client.timezone}:{},...query.includes('billing_country_code')?{billing_country_code:'US'}:{}};
 return Response.json([row]);
};
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-13T13:00:00Z');state.failure=null;state.requests=[];state.puts=0;
 state.secret=JSON.stringify({SHOP_DOMAIN:'bright-patches.myshopify.com',SHOPIFY_ADMIN_TOKEN:'private',TRIPLE_WHALE_SQL_KEY:'private',TRIPLE_WHALE_SUMMARY_KEY:'private',META_ACCESS_TOKEN:'private',META_AD_ACCOUNT_ID:'123',META_API_VERSION:'v24.0',META_TIME_ZONE:client.timezone,APPLOVIN_REPORT_KEY:'private',RECHARGE_ADMIN_TOKEN:'private'});
 sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:SQLInputValue[]=[];const statement={sql,bind(...input:unknown[]){values=input as SQLInputValue[];return statement;},async first(){return sqlite.prepare(sql).get(...values)??null;},async all(){return {results:sqlite.prepare(sql).all(...values)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}};}};return statement;};
 const store=state.store=new Store({prepare,batch:async statements=>{sqlite.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}});
 await store.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',client.id,'o',client.name,client.slug,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);
 for(const source of [current,next]){await store.run('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',source.id,'o',client.id,source.name,source.provider,source.endpoint,'PRIVATE',60,1,source.lastSuccess,null,null,1);const batch=await fetchKindSource(source,client,{from:'2026-10-13',to:'2026-10-13'},state.secret,fixture,Date.now()+300000);await store.saveQualification('o',client.id,source.id,1,1,kindQualification(batch,source.provider),'fixture');if(source.id==='tw')coverage=batch.coverageThrough!;}
 const previous=await fetchKindSource(current,client,{from:'2026-10-12',to:'2026-10-12'},state.secret,fixture,Date.now()+300000);priorId=await store.persistBatch('o','tw',previous,'prior','2026-10-13T11:00:00Z',{from:'2026-10-12',to:'2026-10-12'});
 await store.enqueue('o',client.id,'tw','current','2026-10-13T12:00:00Z');await store.enqueue('o',client.id,'meta','current','2026-10-13T12:01:00Z');state.requests=[];vi.stubGlobal('fetch',fixture);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();sqlite.close();});
it.each(['timeout','deadline'])('completes durable current data after optional closed %s, preserves yesterday and gives the next source its turn',async failure=>{
 const store=state.store!,oldFacts=await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY rowKey',priorId),oldPointer=await store.first("SELECT * FROM current_snapshots WHERE sourceId='tw' AND date='2026-10-12'");state.failure=failure;
 expect(await runSyncBatch(scope,{maxJobs:2,deadline:Date.now()+300000})).toEqual({completed:['o:tw:current','o:meta:current'],failed:[]});
 expect(await store.first("SELECT status,error FROM jobs WHERE sourceId='tw'")).toEqual({status:'complete',error:null});expect(await store.first("SELECT coverageThrough,error FROM connections WHERE id='tw'")).toEqual({coverageThrough:coverage,error:null});expect((await store.first("SELECT lastSuccess FROM connections WHERE id='tw'"))?.lastSuccess).not.toBe(current.lastSuccess);
 expect(await store.first("SELECT status FROM snapshots WHERE id=(SELECT snapshotId FROM current_snapshots WHERE sourceId='tw' AND date='2026-10-13')")).toEqual({status:'ready'});expect(await store.first("SELECT SUM(json_extract(payload,'$.value')) n FROM observations WHERE snapshotId=(SELECT snapshotId FROM current_snapshots WHERE sourceId='tw' AND date='2026-10-13') AND json_extract(payload,'$.dataset')='overview' AND json_extract(payload,'$.metric')='revenue'")).toEqual({n:100});
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY rowKey',priorId)).toEqual(oldFacts);expect(await store.first("SELECT * FROM current_snapshots WHERE sourceId='tw' AND date='2026-10-12'")).toEqual(oldPointer);expect(state.requests).toContain('2026-10-12');expect(state.puts).toBe(2);
 state.failure=null;state.requests=[];await store.enqueue('o',client.id,'tw','next-native-poll',new Date().toISOString());expect((await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000})).completed).toEqual(['o:tw:next-native-poll']);expect(state.requests).toContain('2026-10-12');
});
it.each(['auth','schema','reconcile'])('keeps optional %s failures visible after current publication',async failure=>{
 state.failure=failure;const result=await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000});expect(result.completed).toEqual([]);expect(result.failed).toHaveLength(1);expect((await state.store!.first("SELECT status FROM jobs WHERE sourceId='tw'"))?.status).not.toBe('complete');expect(await state.store!.first("SELECT coverageThrough,error FROM connections WHERE id='tw'")).toEqual({coverageThrough:coverage,error:null});
});
it.each(['manual','initial'])('retains %s closed-tail failure instead of treating it as an optional recurring repair',async kind=>{
 const store=state.store!;if(kind==='manual'){await store.run("DELETE FROM jobs WHERE sourceId='tw'");await store.enqueue('o',client.id,'tw','manual:abc','2026-10-13T12:00:00Z');}else await store.run("UPDATE connections SET lastSuccess=NULL WHERE id='tw'");state.failure='timeout';const result=await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000});expect(result.completed).toEqual([]);expect(result.failed).toHaveLength(1);
});
it('does not defer a failed closed-date publication even after today was durable',async()=>{
 const store=state.store!,persist=store.persistBatch.bind(store);vi.spyOn(store,'persistBatch').mockImplementation(async(...args)=>{if(args[5]?.to==='2026-10-12')throw new DOMException('Database request timed out','TimeoutError');return persist(...args);});const result=await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000});expect(result.completed).toEqual([]);expect(result.failed).toEqual([{id:'o:tw:current',error:'Database request timed out'}]);expect(await store.first("SELECT status FROM jobs WHERE sourceId='tw'")).toEqual({status:'pending'});
});
it('retains a failed mandatory today fetch with no fabricated current facts or freshness',async()=>{
 state.failure='today-timeout';const store=state.store!,before=await store.first("SELECT lastSuccess,coverageThrough FROM connections WHERE id='tw'");expect((await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000})).failed).toEqual([{id:'o:tw:current',error:'Provider request timed out or could not be reached'}]);expect(await store.first("SELECT lastSuccess,coverageThrough FROM connections WHERE id='tw'")).toEqual(before);expect(await store.first("SELECT snapshotId FROM current_snapshots WHERE sourceId='tw' AND date='2026-10-13'")).toBeNull();expect(state.puts).toBe(0);
});
it('uses the actual mandatory date when closed-session lookup crosses the first completed store hour',async()=>{
 const store=state.store!,source=connection('kind-shopify-hourly','sessions'),requests:string[]=[],through='2026-10-13T23:00:00Z';let failClosed=false,healthAtTail:unknown;
 const sessionFixture:typeof fetch=async(_url,options)=>{
  const query=JSON.parse(String(options?.body)).query;
  if(query.includes('shop {'))return Response.json({data:{shop:{ianaTimezone:client.timezone,currencyCode:client.currency,myshopifyDomain:'bright-patches.myshopify.com'}}});
  const date=query.match(/SINCE (\d{4}-\d{2}-\d{2})/)![1];requests.push(date);
  if(failClosed&&date<'2026-10-14'){healthAtTail=await store.first("SELECT coverageThrough,error FROM connections WHERE id='sessions'");throw new DOMException('Request timed out','TimeoutError');}
  const counts={sessions:7,sessions_with_cart_additions:3,sessions_that_reached_checkout:2,sessions_that_completed_checkout:1},row={day:date,...counts,...query.includes('GROUP BY day,hour_of_day')?{hour_of_day:0}:{},...query.includes('landing_page_path,session_country')?{landing_page_path:'/pages/glp',session_country:'United States'}:{}};
  return Response.json({data:{shopifyqlQuery:{parseErrors:[],tableData:{columns:[],rows:[row]}}}});
 };
 await store.run('DELETE FROM jobs');await store.run('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',source.id,'o',client.id,source.name,source.provider,source.endpoint,'PRIVATE',60,1,source.lastSuccess,null,'OLD_SOURCE_ERROR',1);
 vi.setSystemTime('2026-10-13T23:00:00.100Z');const qualified=await fetchKindSource(source,client,{from:'2026-10-14',to:'2026-10-14'},state.secret,sessionFixture,Date.now()+300000);await store.saveQualification('o',client.id,source.id,1,1,kindQualification(qualified,source.provider),'fixture');
 const previous=await fetchKindSource(source,client,{from:'2026-10-13',to:'2026-10-13'},state.secret,sessionFixture,Date.now()+300000),previousId=await store.persistBatch('o',source.id,previous,'prior-sessions','2026-10-13T22:30:00Z',{from:'2026-10-13',to:'2026-10-13'}),oldPointer=await store.first("SELECT * FROM current_snapshots WHERE sourceId='sessions' AND date='2026-10-13'"),oldFacts=await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY rowKey',previousId);
 vi.setSystemTime('2026-10-13T22:59:59.900Z');await store.enqueue('o',client.id,source.id,'current',new Date().toISOString());const all=store.all.bind(store);let lookups=0;
 vi.spyOn(store,'all').mockImplementation(async(...args)=>{if(args[0].includes('SELECT c.date,s.complete')){lookups++;vi.setSystemTime('2026-10-13T23:00:00.100Z');}return all(...args);});
 failClosed=true;requests.length=0;vi.stubGlobal('fetch',sessionFixture);
 expect(await runSyncBatch(scope,{maxJobs:1,deadline:Date.now()+300000})).toEqual({completed:['o:sessions:current'],failed:[]});expect(lookups).toBe(1);expect(requests[0]).toBe('2026-10-14');expect(requests).toContain('2026-10-13');expect(healthAtTail).toEqual({coverageThrough:through,error:null});
 expect(await store.first("SELECT status,error FROM jobs WHERE sourceId='sessions'")).toEqual({status:'complete',error:null});expect(await store.first("SELECT lastSuccess,coverageThrough,error FROM connections WHERE id='sessions'")).toEqual({lastSuccess:'2026-10-13T23:00:00.100Z',coverageThrough:through,error:null});expect(await store.first("SELECT status,coverageThrough FROM snapshots WHERE id=(SELECT snapshotId FROM current_snapshots WHERE sourceId='sessions' AND date='2026-10-14')")).toEqual({status:'ready',coverageThrough:through});
 expect(await store.first("SELECT * FROM current_snapshots WHERE sourceId='sessions' AND date='2026-10-13'")).toEqual(oldPointer);expect(await store.all('SELECT * FROM observations WHERE snapshotId=? ORDER BY rowKey',previousId)).toEqual(oldFacts);
});
