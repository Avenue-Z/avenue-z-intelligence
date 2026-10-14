import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {planHistoricalHourlyJobs} from '../../lib/jobs/hourly-history';
import {Store} from '../../lib/server/store';
import initial from '../../data/initial-clients.json';
import type {AccessScope} from '../../lib/analytics/contracts';
const now=new Date('2026-10-13T15:00:00Z'),scope:AccessScope={organizationId:'o',actorId:'scheduler',role:'service',permittedClientIds:['kind-patches']};
function database(){
 const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const reads:{sql:string;values:unknown[]}[]=[];
 const prepare=(sql:string)=>{let values:unknown[]=[];const statement={bind(...input:unknown[]){values=input;return statement;},async all(){reads.push({sql,values});return {results:sqlite.prepare(sql).all(...values as any[])};},async first(){reads.push({sql,values});return sqlite.prepare(sql).get(...values as any[])??null;},async run(){const result=sqlite.prepare(sql).run(...values as any[]);return {meta:{changes:Number(result.changes)}};}};return statement;};
 return {sqlite,reads,store:new Store({prepare,batch:async(statements:ReturnType<typeof prepare>[])=>Promise.all(statements.map(statement=>statement.run()))})};
}
async function setup(provider='kind-shopify-sales',organizationId='o',clientId='kind-patches'){
 const databaseValue=database(),{store}=databaseValue,client={...initial[0],id:clientId,version:1},sourceId=`${organizationId}:${clientId}:${provider}`;
 await store.run('INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config,version) VALUES(?,?,?,?,?,?,?,?,?)',client.id,organizationId,client.name,client.id,client.timezone,client.currency,client.color,JSON.stringify(client.config),client.version);
 await store.run('INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,lastSuccess,coverageThrough,error,version) VALUES(?,?,?,?,?,?,?,?,1,?,?,NULL,1)',sourceId,organizationId,client.id,'Source',provider,'https://example.com','PRIVATE',60,'2026-10-13T14:00:00Z','2026-10-13T13:00:00Z');
 const profile={dataset:provider==='kind-meta-performance'?'creatives':provider==='kind-applovin'?'media':'revenue',metric:provider==='kind-applovin'?'platform_spend':'revenue',definition:`${provider}:hourly`,population:'population',currency:'USD',dimensions:[],hourly:true};
 const contract={clientId:client.id,queryId:`${provider}:hourly-v2`,timezone:client.timezone,currency:client.currency,hourlyGrain:true,requiresHourly:true,channels:[],requiredChannels:[],dimensions:[],requiredDimensions:[],paginationComplete:true,reconciled:true,reconciliationEvidence:'Independent same-window reconciliation',profiles:[profile]};
 await store.saveQualification(organizationId,client.id,sourceId,1,1,contract,'scheduler');
 return {...databaseValue,sourceId,client,contract,profile};
}
async function pointer(store:Store,sourceId:string,date:string,fact:unknown,status='ready',organizationId='o',clientId='kind-patches'){
 const id=`snapshot:${organizationId}:${sourceId}:${date}`;
 await store.run('INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES(?,?,?,?,?,?,1,?,?)',id,organizationId,clientId,sourceId,now.toISOString(),now.toISOString(),status,'private');
 await store.run('INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId) VALUES(?,?,?,?,?)',organizationId,clientId,sourceId,date,id);
 if(fact)await store.run('INSERT INTO observations(snapshotId,date,rowKey,payload) VALUES(?,?,?,?)',id,date,'first',JSON.stringify(fact));
}

it('queues bounded closed store days with comparison cuts ahead of other recent history',async()=>{
 const {store}=await setup();expect(await planHistoricalHourlyJobs(store,scope,now)).toEqual({eligibleSources:1,missingDays:61,queued:61});
 const jobs=await store.all<{id:string;dueAt:string;status:string}>('SELECT id,dueAt,status FROM jobs ORDER BY dueAt');
 expect(jobs.slice(0,8).map(job=>job.id.split(':').at(-1))).toEqual(['2026-10-12','2026-10-06','2026-09-15','2026-09-13','2026-10-11','2026-10-05','2026-09-14','2026-09-12']);
 expect(jobs.every(job=>job.id.includes(':hourly-history:')&&job.status==='pending'&&job.dueAt<=now.toISOString())).toBe(true);
 expect(jobs.map(job=>job.id.split(':').at(-1)).sort().at(0)).toBe('2026-08-13');expect(jobs.some(job=>job.id.endsWith('2026-10-13'))).toBe(false);
});
it('retains valid hourly facts while scheduling legacy daily, missing and unready pointers',async()=>{
 const {store,sourceId,profile,reads,sqlite}=await setup(),hourly={...profile,start:'2026-10-11T22:00:00Z',end:'2026-10-11T23:00:00Z'};
 await pointer(store,sourceId,'2026-10-12',hourly);await pointer(store,sourceId,'2026-10-11',{...profile,hourly:false});await pointer(store,sourceId,'2026-10-06',hourly,'writing');
 expect(await planHistoricalHourlyJobs(store,scope,now)).toEqual({eligibleSources:1,missingDays:60,queued:60});
 expect(await store.first("SELECT id FROM jobs WHERE id LIKE '%:2026-10-12'")).toBeNull();expect(await store.first("SELECT id FROM jobs WHERE id LIKE '%:2026-10-11'")).not.toBeNull();
 const lookup=reads.find(read=>read.sql.includes('SELECT o.payload'))!;expect(lookup.sql).toContain('ORDER BY o.rowKey LIMIT 1');
 expect(reads.filter(read=>read.sql.includes('SELECT o.payload'))).toHaveLength(1);
 const plan=sqlite.prepare(`EXPLAIN QUERY PLAN ${lookup.sql}`).all(...lookup.values as any[]).map(row=>String(row.detail));expect(plan.some(detail=>detail.includes('SEARCH o USING INDEX')&&detail.includes('snapshotId=? AND date=?'))).toBe(true);
});
it('repairs a legacy full-day interval despite its matching registered hourly measurement',async()=>{
 const {store,sourceId,profile}=await setup(),date='2026-10-12';
 await pointer(store,sourceId,date,{...profile,start:'2026-10-11T22:00:00Z',end:'2026-10-12T22:00:00Z'});
 expect((await planHistoricalHourlyJobs(store,scope,now)).queued).toBe(61);
 expect(await store.first("SELECT status FROM jobs WHERE id LIKE '%:hourly-history:2026-10-12'")).toEqual({status:'pending'});
});
it('retains the legitimate two-hour interval in a repeated Stockholm store hour',async()=>{
 const {store,sourceId,profile}=await setup(),date='2026-10-25';
 await pointer(store,sourceId,date,{...profile,start:'2026-10-25T00:00:00Z',end:'2026-10-25T02:00:00Z'});
 await store.run("UPDATE snapshots SET coverageThrough='2026-10-25T23:00:00Z'");
 expect((await planHistoricalHourlyJobs(store,scope,new Date('2026-10-26T15:00:00Z'))).queued).toBe(60);
 expect(await store.first("SELECT id FROM jobs WHERE id LIKE '%:hourly-history:2026-10-25'")).toBeNull();
});
it.each(['kind-meta-performance','kind-applovin'])('repairs %s legacy definitions even when the first fact contains an interval',async provider=>{
 const {store,sourceId,profile}=await setup(provider),fact={...profile,start:'2026-10-11T22:00:00Z',end:'2026-10-11T23:00:00Z'};
 await pointer(store,sourceId,'2026-10-12',{...fact,definition:'old_daily_measurement'});await pointer(store,sourceId,'2026-10-11',fact);
 const result=await planHistoricalHourlyJobs(store,scope,now);expect(result.queued).toBe(provider==='kind-applovin'?27:60);
 expect(await store.first("SELECT id FROM jobs WHERE id LIKE '%:2026-10-12'")).not.toBeNull();expect(await store.first("SELECT id FROM jobs WHERE id LIKE '%:2026-10-11'")).toBeNull();
});
it('keeps AppLovin safely inside its 30 UTC-day provider retention',async()=>{
 const {store}=await setup('kind-applovin');expect((await planHistoricalHourlyJobs(store,scope,now)).queued).toBe(28);
 const dates=(await store.all<{id:string}>('SELECT id FROM jobs ORDER BY id')).map(job=>job.id.split(':').at(-1));expect(dates.at(0)).toBe('2026-09-15');expect(dates.at(-1)).toBe('2026-10-12');
});
it('repairs a prior-day hourly pointer whose last settling bucket never completed',async()=>{
 const {store,sourceId,profile}=await setup('kind-meta-performance');await pointer(store,sourceId,'2026-10-12',{...profile,start:'2026-10-11T22:00:00Z',end:'2026-10-11T23:00:00Z'});
 await store.run("UPDATE snapshots SET coverageThrough='2026-10-12T21:00:00Z'");
 expect((await planHistoricalHourlyJobs(store,scope,now)).queued).toBe(61);expect(await store.first("SELECT id FROM jobs WHERE id LIKE '%:2026-10-12'")).not.toBeNull();
});
it('does not alter completed or failed jobs, source health, existing snapshots or observations on repeated ticks',async()=>{
 const {store,sourceId,profile}=await setup();await pointer(store,sourceId,'2026-10-10',profile);
 await store.enqueue('o','kind-patches',sourceId,'hourly-history:2026-10-12',now.toISOString());await store.finish(`o:${sourceId}:hourly-history:2026-10-12`);
 await store.enqueue('o','kind-patches',sourceId,'hourly-history:2026-10-11',now.toISOString());await store.finish(`o:${sourceId}:hourly-history:2026-10-11`,'historical failure');
 const before={sources:await store.all('SELECT * FROM connections'),snapshots:await store.all('SELECT * FROM snapshots'),facts:await store.all('SELECT * FROM observations'),existing:await store.all('SELECT * FROM jobs ORDER BY id')};
 expect((await planHistoricalHourlyJobs(store,scope,now)).queued).toBe(59);expect((await planHistoricalHourlyJobs(store,scope,new Date(now.getTime()+60000))).queued).toBe(0);
 expect(await store.all('SELECT * FROM connections')).toEqual(before.sources);expect(await store.all('SELECT * FROM snapshots')).toEqual(before.snapshots);expect(await store.all('SELECT * FROM observations')).toEqual(before.facts);
 for(const job of before.existing)expect(await store.first('SELECT * FROM jobs WHERE id=?',job.id)).toEqual(job);
});
it('refuses disallowed roles, clients, organizations, disabled connections and unapproved providers',async()=>{
 const {store}=await setup();expect((await planHistoricalHourlyJobs(store,{...scope,role:'analyst'},now)).queued).toBe(0);expect((await planHistoricalHourlyJobs(store,{...scope,permittedClientIds:['beam']},now)).queued).toBe(0);expect((await planHistoricalHourlyJobs(store,{...scope,organizationId:'other'},now)).queued).toBe(0);
 await store.run('UPDATE connections SET enabled=0');expect((await planHistoricalHourlyJobs(store,scope,now)).queued).toBe(0);
 await store.run("UPDATE connections SET enabled=1,provider='kind-triple-whale'");expect((await planHistoricalHourlyJobs(store,scope,now)).queued).toBe(0);expect(await store.all('SELECT * FROM jobs')).toEqual([]);
});
it('requires the latest qualification to match both versions and every hourly metric profile',async()=>{
 const {store,sourceId,contract}=await setup();await store.saveQualification('o','kind-patches',sourceId,1,1,{...contract,hourlyGrain:false,requiresHourly:false},'scheduler');expect((await planHistoricalHourlyJobs(store,scope,now)).queued).toBe(0);
 await store.saveQualification('o','kind-patches',sourceId,1,1,{...contract,profiles:[{...contract.profiles[0],hourly:false}]},'scheduler');expect((await planHistoricalHourlyJobs(store,scope,now)).queued).toBe(0);
 await store.saveQualification('o','kind-patches',sourceId,1,1,contract,'scheduler');await store.run('UPDATE connections SET version=2');expect((await planHistoricalHourlyJobs(store,scope,now)).queued).toBe(0);
 await store.run('UPDATE connections SET version=1');await store.run('UPDATE clients SET version=2');expect((await planHistoricalHourlyJobs(store,scope,now)).queued).toBe(0);
});

it('finishes only pending repairs whose qualified closed-day hourly capture already exists',async()=>{
 const {store,sourceId,profile}=await setup(),date='2026-10-12';
 await store.enqueue('o','kind-patches',sourceId,`hourly-history:${date}`,now.toISOString());
 await pointer(store,sourceId,date,{...profile,start:'2026-10-11T22:00:00Z',end:'2026-10-11T23:00:00Z'});
 await planHistoricalHourlyJobs(store,scope,now);
 expect(await store.first('SELECT status,attempts,error FROM jobs WHERE id=?',`o:${sourceId}:hourly-history:${date}`)).toEqual({status:'complete',attempts:0,error:null});
});
it('keeps a pending repair when the first captured fact does not match its qualified measurement',async()=>{
 const {store,sourceId,profile}=await setup(),date='2026-10-12';
 await store.enqueue('o','kind-patches',sourceId,`hourly-history:${date}`,now.toISOString());
 await pointer(store,sourceId,date,{...profile,definition:'unregistered',start:'2026-10-11T22:00:00Z',end:'2026-10-11T23:00:00Z'});
 await planHistoricalHourlyJobs(store,scope,now);expect(await store.first('SELECT status FROM jobs WHERE id=?',`o:${sourceId}:hourly-history:${date}`)).toEqual({status:'pending'});
});
async function rechargeSetup(expanded=true){
 const result=await setup('kind-recharge-cancellations'),{store,sourceId,contract}=result;
 const profiles=[{dataset:'subscriptionEvents',metric:'subscription_cancellations',definition:'recharge_current_cancelled_subscription_records_cancelled_at_utc_to_store_date_excludes_reactivated',population:'recharge_cancelled_subscription_records',currency:null,dimensions:[],hourly:true},...expanded?[{dataset:'subscriptionEvents',metric:'new_subscriptions',definition:'recharge_all_status_subscription_records_created_at_utc_to_store_date',population:'recharge_new_subscription_records',currency:null,dimensions:[],hourly:true},{dataset:'subscriptionEvents',metric:'same_day_subscription_cancellations',definition:'recharge_current_cancelled_created_same_store_day_cancelled_at_utc_excludes_reactivated',population:'recharge_new_subscription_records',currency:null,dimensions:[],hourly:true}]:[]];
 await store.saveQualification('o','kind-patches',sourceId,1,1,{...contract,profiles},'scheduler');return {...result,profiles};
}
it('queues Recharge cohort history when an old calendar-only snapshot exists for a closed day',async()=>{
 const {store,sourceId,profiles}=await rechargeSetup();await pointer(store,sourceId,'2026-10-12',{...profiles[0],start:'2026-10-11T22:00:00Z',end:'2026-10-11T23:00:00Z'});const result=await planHistoricalHourlyJobs(store,scope,now);expect(result.eligibleSources).toBe(1);expect(result.queued).toBe(61);expect(await store.first("SELECT status FROM jobs WHERE id LIKE '%:hourly-history:2026-10-12'")).toEqual({status:'pending'});
});
it('retains Recharge history only when both creation and same-day cancellation profiles are present and qualified',async()=>{
 const {store,sourceId,profiles}=await rechargeSetup(),date='2026-10-12';await pointer(store,sourceId,date,{...profiles[0],start:'2026-10-11T22:00:00Z',end:'2026-10-11T23:00:00Z'});const snapshotId=`snapshot:o:${sourceId}:${date}`;for(const profile of profiles.slice(1))await store.run('INSERT INTO observations(snapshotId,date,rowKey,payload) VALUES(?,?,?,?)',snapshotId,date,profile.metric,JSON.stringify({...profile,start:'2026-10-11T22:00:00Z',end:'2026-10-11T23:00:00Z'}));expect((await planHistoricalHourlyJobs(store,scope,now)).queued).toBe(60);expect(await store.first("SELECT id FROM jobs WHERE id LIKE '%:hourly-history:2026-10-12'")).toBeNull();
});
it('does not activate Recharge history before the creation cohort profile expansion is qualified',async()=>{
 const {store}=await rechargeSetup(false);expect(await planHistoricalHourlyJobs(store,scope,now)).toEqual({eligibleSources:0,missingDays:0,queued:0});expect(await store.all('SELECT id FROM jobs')).toEqual([]);
});
async function whaleSetup(){
 const result=await setup('kind-triple-whale'),{store,sourceId,contract}=result;
 const profile={...result.profile,dataset:'overview'},profiles=[profile,...['revenue','orders','new_orders'].map(metric=>({...profile,dataset:'markets',metric,currency:metric==='revenue'?'USD':null,dimensions:['market']}))];
 await store.saveQualification('o','kind-patches',sourceId,1,1,{...contract,profiles},'scheduler');return {...result,profile,profiles};
}
it('queues qualified Triple Whale country-market history independently of optional routine refreshes',async()=>{
 const {store}=await whaleSetup();expect(await planHistoricalHourlyJobs(store,scope,now)).toEqual({eligibleSources:1,missingDays:61,queued:61});
 expect((await store.all<{id:string}>('SELECT id FROM jobs ORDER BY dueAt')).slice(0,4).map(job=>job.id.split(':').at(-1))).toEqual(['2026-10-12','2026-10-06','2026-09-15','2026-09-13']);
});
it.each(['missing','daily','grouped','unregistered'])('repairs a Triple Whale hourly headline with %s country-market observations',async kind=>{
 const {store,sourceId,profile,profiles}=await whaleSetup(),date='2026-10-12',interval={start:'2026-10-11T22:00:00Z',end:'2026-10-11T23:00:00Z'};
 await pointer(store,sourceId,date,{...profile,...interval});
 if(kind!=='missing')for(const marketProfile of profiles.slice(1)){
  const fact={...marketProfile,date,value:1,quality:'complete',dimensions:{market:kind==='grouped'?'Germany / Spain / Mexico / NL':'US'},...kind==='daily'?{}:interval,...kind==='unregistered'?{definition:'legacy_unqualified'}:{}};
  await store.run('INSERT INTO observations(snapshotId,date,rowKey,payload) VALUES(?,?,?,?)',`snapshot:o:${sourceId}:${date}`,date,marketProfile.metric,JSON.stringify(fact));
 }
 expect((await planHistoricalHourlyJobs(store,scope,now)).queued).toBe(61);
 expect(await store.first("SELECT status FROM jobs WHERE id LIKE '%:hourly-history:2026-10-12'")).toEqual({status:'pending'});
});
it('retains qualified Triple Whale country history only when every required hourly market measure exists',async()=>{
 const {store,sourceId,profile,profiles}=await whaleSetup(),date='2026-10-12',interval={start:'2026-10-11T22:00:00Z',end:'2026-10-11T23:00:00Z'};
 await pointer(store,sourceId,date,{...profile,...interval});
 const id=`snapshot:o:${sourceId}:${date}`;
 for(const marketProfile of profiles.slice(1))await store.run('INSERT INTO observations(snapshotId,date,rowKey,payload) VALUES(?,?,?,?)',id,date,marketProfile.metric,JSON.stringify({...marketProfile,date,value:1,quality:'complete',dimensions:{market:'US'},...interval}));
 expect((await planHistoricalHourlyJobs(store,scope,now)).queued).toBe(60);expect(await store.first("SELECT id FROM jobs WHERE id LIKE '%:hourly-history:2026-10-12'")).toBeNull();
 await store.run("DELETE FROM observations WHERE snapshotId=? AND rowKey='orders'",id);
 expect((await planHistoricalHourlyJobs(store,scope,now)).queued).toBe(1);expect(await store.first("SELECT status FROM jobs WHERE id LIKE '%:hourly-history:2026-10-12'")).toEqual({status:'pending'});
});
