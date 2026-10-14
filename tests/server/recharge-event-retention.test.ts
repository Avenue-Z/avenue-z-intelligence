import{DatabaseSync}from'node:sqlite';
import{readFileSync,readdirSync}from'node:fs';
import{expect,it}from'vitest';
import{Store}from'../../lib/server/store';
import type{Observation,SourceBatch}from'../../lib/analytics/contracts';
import initial from'../../data/initial-clients.json';
import{dayWindow}from'../../lib/analytics/windows';
import{kindQualification,localHourInterval}from'../../lib/sources/kind-patches';
import{rechargeCancellationDefinition,rechargeCancellationPopulation}from'../../lib/sources/recharge-cancellations';
import{rechargeCreatedDefinition,rechargeSameDayCancellationDefinition,rechargeSameDayCancellationEventDefinition,rechargeCancellationEventDefinition,rechargeNewSubscriptionPopulation,rechargeCancellationEventPopulation}from'../../lib/sources/recharge-subscription-cohort';
const profiles=[['subscription_cancellations',rechargeCancellationDefinition,rechargeCancellationPopulation],['new_subscriptions',rechargeCreatedDefinition,rechargeNewSubscriptionPopulation],['same_day_subscription_cancellations',rechargeSameDayCancellationDefinition,rechargeNewSubscriptionPopulation],['same_day_subscription_cancellation_events',rechargeSameDayCancellationEventDefinition,rechargeNewSubscriptionPopulation],['subscription_cancellation_events',rechargeCancellationEventDefinition,rechargeCancellationEventPopulation]] as const;
const client={...initial[0],version:1},date='2026-10-08',firstAt='2026-10-14T00:00:00Z',nextAt='2026-10-15T00:00:00Z';
function capture(day=date,exact=true,hours=24):SourceBatch{const rows:Observation[]=[];for(let hour=0;hour<hours;hour++){const interval=localHourInterval(day,hour,client.timezone);if(!interval)continue;for(const[metric,definition,population]of profiles.slice(0,exact?5:3))rows.push({date:day,dataset:'subscriptionEvents',metric,definition,population,value:metric==='new_subscriptions'?10:1,currency:null,dimensions:{},...interval,sourceId:'',retrievedAt:'',coverageThrough:null,quality:hours===24?'complete':'partial'});}return{clientId:client.id,timezone:client.timezone,currency:client.currency,channels:[],dimensions:[],grain:'hourly',complete:true,coverageThrough:hours===24?dayWindow(day,client.timezone).end:rows.at(-1)?.end??null,rows};}
async function setup(provider='kind-recharge-cancellations'){
 const sqlite=new DatabaseSync(':memory:');for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${f}`,'utf8'));
 const prepare=(sql:string)=>{let v:unknown[]=[];const api={sql,bind(...values:unknown[]){v=values;return api;},async all(){return{results:sqlite.prepare(sql).all(...v as (string|number|null)[])};},async first(){return sqlite.prepare(sql).get(...v as (string|number|null)[])??null;},async run(){return{meta:{changes:Number(sqlite.prepare(sql).run(...v as (string|number|null)[]).changes)}};}};return api;};
 const store=new Store({prepare,batch:async ss=>{sqlite.exec('BEGIN');try{const values=[];for(const s of ss)values.push(await s.run());sqlite.exec('COMMIT');return values;}catch(e){sqlite.exec('ROLLBACK');throw e;}}});
 await store.run("INSERT INTO organizations VALUES('o','Avenue Z',1)");await store.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',client.id,'o',client.name,client.slug,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);
 await store.run("INSERT INTO connections VALUES('source','o','kind-patches','Recharge',?,'registered','test',60,1,NULL,NULL,NULL,1)",provider);await store.saveQualification('o',client.id,'source',1,1,kindQualification(capture(),'kind-recharge-cancellations'),'test');
 return{store,sqlite};
}
async function pointer(store:Store,day=date){return store.first<{snapshotId:string;dataHash:string|null;publishedAt:string}>("SELECT snapshotId,dataHash,publishedAt FROM current_snapshots WHERE organizationId='o' AND clientId='kind-patches' AND sourceId='source' AND date=?",day);}
it('keeps the entire qualified immutable exact day when a later retained-state capture can no longer query its events',async()=>{
 const{store}=await setup(),original=capture();const oldId=await store.persistBatch('o','source',original,'exact',firstAt),before=await pointer(store),beforeRows=await store.observations('o',client.id);
 const incoming=capture(date,false);incoming.rows.forEach(row=>{if(row.metric==='new_subscriptions')row.value=20;});const newId=await store.persistBatch('o','source',incoming,'state',nextAt);
 expect(await pointer(store)).toEqual({...before,publishedAt:nextAt});expect((await pointer(store))?.snapshotId).toBe(oldId);expect(await store.observations('o',client.id)).toEqual(beforeRows);
 expect(await store.first('SELECT status,objectKey,retrievedAt FROM snapshots WHERE id=?',newId)).toEqual({status:'ready',objectKey:`snapshots/${newId}.json`,retrievedAt:nextAt});expect(await store.first('SELECT retrievedAt FROM snapshots WHERE id=?',oldId)).toEqual({retrievedAt:firstAt});
 expect(await store.all('SELECT * FROM observations WHERE snapshotId=?',newId)).toEqual([]);
});
it('preserves an expired exact day while publishing genuinely new current-day facts in the same capture',async()=>{
 const{store}=await setup();const oldId=await store.persistBatch('o','source',capture(),'exact',firstAt),today=capture('2026-10-15',true,2),incoming={...today,rows:[...capture(date,false).rows,...today.rows]};
 const newId=await store.persistBatch('o','source',incoming,'mixed',nextAt);expect((await pointer(store))?.snapshotId).toBe(oldId);expect((await pointer(store,'2026-10-15'))?.snapshotId).toBe(newId);
 const rows=await store.observations('o',client.id);expect(rows.filter(row=>row.date===date)).toHaveLength(120);expect(rows.filter(row=>row.date==='2026-10-15')).toHaveLength(10);expect(rows.filter(row=>row.date===date).every(row=>row.retrievedAt===firstAt)).toBe(true);
});
it('accepts actual exact-event corrections and retains ordinary publication within the event window',async()=>{
 const{store}=await setup();await store.persistBatch('o','source',capture(),'exact',firstAt);const corrected=capture();corrected.rows.find(row=>row.metric==='same_day_subscription_cancellation_events')!.value=2;
 const correctedId=await store.persistBatch('o','source',corrected,'correction',nextAt);expect((await pointer(store))?.snapshotId).toBe(correctedId);
 const stateId=await store.persistBatch('o','source',capture(date,false),'state-within', '2026-10-14T01:00:00Z');expect((await pointer(store))?.snapshotId).toBe(correctedId);expect(stateId).not.toBe(correctedId);
 const second=await setup();await second.store.persistBatch('o','source',capture(),'exact',firstAt);const withinId=await second.store.persistBatch('o','source',capture(date,false),'state','2026-10-14T01:00:00Z');expect((await pointer(second.store))?.snapshotId).toBe(withinId);
});
it.each(['missing-hour','definition','currency','population','dimensions','partial','coverage','unqualified','invalid-row-coverage','invalid-count'])('does not pin an original exact day with invalid %s evidence',async invalid=>{
 const{store}=await setup(),original=capture();if(invalid==='missing-hour')original.rows.pop();if(invalid==='definition')original.rows[0].definition='wrong';if(invalid==='currency')original.rows[0].currency='USD';if(invalid==='population')original.rows[0].population='wrong';if(invalid==='dimensions')original.rows[0].dimensions={market:'US'};if(invalid==='partial')original.complete=false;if(invalid==='coverage')original.coverageThrough=original.rows[0].end!;
 await store.persistBatch('o','source',original,'original',firstAt);if(invalid==='unqualified')await store.run('UPDATE connections SET version=2');if(invalid==='invalid-row-coverage')await store.run("UPDATE observations SET payload=json_set(payload,'$.coverageThrough','invalid')");if(invalid==='invalid-count')await store.run("UPDATE observations SET payload=json_set(payload,'$.value',-1)");const newId=await store.persistBatch('o','source',capture(date,false),'state',nextAt);expect((await pointer(store))?.snapshotId).toBe(newId);
});
it('does not overwrite a concurrent genuine exact-event correction with an expired state-only refresh',async()=>{
 const{store}=await setup();await store.persistBatch('o','source',capture(),'exact',firstAt);const realBatch=store.db.batch;let correctedId='',injected=false;
 store.db.batch=async statements=>{if(!injected&&statements[0]?.sql.startsWith('UPDATE current_snapshots SET publishedAt')){injected=true;const corrected=capture();corrected.rows.find(row=>row.metric==='same_day_subscription_cancellation_events')!.value=2;correctedId=await store.persistBatch('o','source',corrected,'correction','2026-10-15T01:00:00Z');}return realBatch(statements);};
 await store.persistBatch('o','source',capture(date,false),'state','2026-10-15T02:00:00Z');expect(injected).toBe(true);expect((await pointer(store))?.snapshotId).toBe(correctedId);expect((await pointer(store))?.publishedAt).toBe('2026-10-15T01:00:00Z');
});
it('leaves other providers on their existing publication policy',async()=>{const{store}=await setup('kind-shopify-sales');await store.persistBatch('o','source',capture(),'exact',firstAt);const id=await store.persistBatch('o','source',capture(date,false),'state',nextAt);expect((await pointer(store))?.snapshotId).toBe(id);});
