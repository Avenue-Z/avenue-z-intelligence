import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {Store} from '../../lib/server/store';
import {backfillSnapshotDayProjections,writeSnapshotDayProjection,smallSnapshotDayBatchWithinLimits,readSmallSnapshotDayProjections,type SnapshotDayManifest} from '../../lib/server/snapshot-day-projections';
import {observationCodec} from '../../lib/server/observation-codec';
import type {Client,Observation,QueryFilters,SourceBatch} from '../../lib/analytics/contracts';
import clients from '../../data/initial-clients.json';
import {queryClient} from '../../lib/analytics/query';
function database(projections=true){
 const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')&&(projections||!f.startsWith('0008_'))))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const queries:string[]=[],batches:{sql:string;values:unknown[]}[][]=[];
 const connect=()=>{const prepare=(sql:string)=>{let values:unknown[]=[];const statement={sql,get values(){return values;},bind(...input:unknown[]){values=input;return statement;},async all(){queries.push(sql);return {results:sqlite.prepare(sql).all(...values as any[])};},async first(){queries.push(sql);return sqlite.prepare(sql).get(...values as any[])??null;},async run(){const result=sqlite.prepare(sql).run(...values as any[]);return {meta:{changes:Number(result.changes)}};}};return statement;};return {prepare,async batch(statements:ReturnType<typeof prepare>[]){batches.push(statements.map(statement=>({sql:statement.sql,values:statement.values})));sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};};
 return {sqlite,connect,queries,batches};
}
const filters:QueryFilters={from:'2026-10-10',to:'2026-10-11',compare:'previous',mode:'closed',view:'traffic',market:'',stream:'',source:'',device:'',page:''};
function batch(clientId='a',value=42):SourceBatch{return {clientId,timezone:'UTC',currency:'USD',channels:['web'],dimensions:['device'],grain:'daily',complete:true,coverageThrough:'2026-10-12T00:00:00Z',rows:['2026-10-10','2026-10-11'].map(date=>({date,dataset:'traffic',metric:'sessions',value,currency:'USD',definition:'web',dimensions:{device:'mobile'},sourceId:'',retrievedAt:'',coverageThrough:null,quality:'complete'}))};}
const rawReads=(queries:string[])=>queries.filter(sql=>sql.startsWith('SELECT o.payload')).length;
it('reuses ingestion projections across new date ranges and database instances without transferring raw facts',async()=>{
 const {connect,queries}=database(),store=new Store(connect());await store.persistBatch('o','source',batch(),'one','2026-10-12T00:00:00Z');await store.saveQualification('o','a','source',1,1,{profiles:[{dataset:'traffic',metric:'sessions'}]},'admin');
 expect(await store.observations('o','a',filters,false,undefined,{datasets:['traffic']})).toHaveLength(2);
 expect(await new Store(connect()).observations('o','a',{...filters,from:'2026-10-11',compare:'weekday'},false,undefined,{datasets:['traffic']})).toHaveLength(1);
 expect(rawReads(queries)).toBe(0);
});
it('mirrors legacy SQL date, dataset and dimension selection for mixed unqualified archives',async()=>{
 const projected=database(),legacy=database(false),base=batch().rows[0];
 const dimensions:Record<string,string>[]=[{}, {market:'US',device:'mobile'}, {market:'United States',device:'desktop'},{market:'GB',device:'mobile'},{market:'United Kingdom',device:'mobile'}];
 const rows:Observation[]=['2026-08-17','2026-09-11','2026-10-03','2026-10-07','2026-10-08','2026-10-09','2026-10-10','2026-10-11','2026-10-12'].flatMap(date=>['overview','subscriptions','markets','traffic','funnels','products','media'].flatMap(dataset=>dimensions.map((dimensions,index)=>({...base,date,dataset,metric:dataset==='media'?'active_ads':'sessions',value:index+1,dimensions}))));
 for(const db of [projected,legacy]){const store=new Store(db.connect());await store.run("INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config) VALUES('a','o','A','a','UTC','USD','blue','{}')");await store.persistBatch('o','archive',{...batch(),rows},'mixed','2026-10-12T00:00:00Z');}
 for(const compare of ['previous','weekday','fourWeeks','custom'] as const)for(const market of ['','US','UK'])for(const headlinesOnly of [false,true]){
  const selected={...filters,compare,compareFrom:'2026-08-17',compareTo:'2026-08-18',market,device:'mobile'},selection={datasets:['overview','subscriptions','markets','funnels','traffic','media'],dimensions:true};
  expect(await new Store(projected.connect()).observations('o','a',selected,headlinesOnly,undefined,selection)).toEqual(await new Store(legacy.connect()).observations('o','a',selected,headlinesOnly,undefined,selection));
 }
 expect(projected.queries.some(sql=>sql.includes('JOIN snapshot_day_projection_chunks'))).toBe(true);expect(rawReads(legacy.queries)).toBeGreaterThan(0);
});
it('retains raw hourly intervals and exactly matches known, advancing and missing partial coverage',async()=>{
 const projected=database(),legacy=database(false),base=batch().rows[0],rows=['2026-10-10','2026-10-11'].flatMap(date=>[0,1,2].map(hour=>({...base,date,dataset:'funnels',metric:'sessions',definition:'shopify_human_public_landing_pages',population:'human_public_landing_page_sessions',currency:null,value:hour+1,dimensions:{page:'/lp',market:'US'},start:`${date}T0${hour}:00:00Z`,end:`${date}T0${hour+1}:00:00Z`})));
 for(const db of [projected,legacy]){const store=new Store(db.connect());await store.run("INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config) VALUES('a','o','A','a','UTC','USD','blue','{}')");await store.run("INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,version) VALUES('source','o','a','Hourly','kind-shopify-hourly','','',60,1,1)");await store.persistBatch('o','source',{...batch(),rows,grain:'hourly',coverageThrough:'2026-10-11T03:00:00Z'},'hours','2026-10-12T00:00:00Z');}
 for(const coverage of ['2026-10-11T01:00:00Z','2026-10-11T02:00:00Z',null]){
  for(const db of [projected,legacy]){db.sqlite.prepare('UPDATE connections SET coverageThrough=?').run(coverage);db.sqlite.exec('DELETE FROM observation_cache_chunks; DELETE FROM observation_cache_entries');}
  const actual=await new Store(projected.connect()).observations('o','a',{...filters,from:'2026-10-11',mode:'partial'},false,undefined,{datasets:['funnels']});
  expect(actual).toEqual(await new Store(legacy.connect()).observations('o','a',{...filters,from:'2026-10-11',mode:'partial'},false,undefined,{datasets:['funnels']}));
  expect(actual).toHaveLength(coverage?2:6);expect(actual.filter(row=>row.date==='2026-10-11').reduce((sum,row)=>sum+(row.value??0),0)).toBe(coverage?.includes('01:')?1:coverage?3:6);
 }
 expect(rawReads(projected.queries)).toBe(0);
});
it('preserves immutable retrieval metadata on ready replay and raw first-wins duplicates',async()=>{
 const {connect,sqlite,batches}=database(),store=new Store(connect()),first=batch();first.rows.push({...first.rows[0],value:999});
 await store.persistBatch('o','source',first,'same','2026-10-12T00:00:00Z');const priorInserts=batches.flat().filter(s=>s.sql.startsWith('INSERT INTO observations')).length;await store.persistBatch('o','source',{...batch('a',77),channels:['other'],coverageThrough:null},'same','2026-10-12T01:00:00Z');
 expect(batches.flat().filter(s=>s.sql.startsWith('INSERT INTO observations'))).toHaveLength(priorInserts);
 const rows=await new Store(connect()).observations('o','a',filters);expect(rows).toHaveLength(2);expect(rows.every(row=>row.value===42&&row.retrievedAt==='2026-10-12T00:00:00Z'&&row.coverageThrough==='2026-10-12T00:00:00Z'&&row.channels?.[0]==='web')).toBe(true);
 expect(sqlite.prepare('SELECT COUNT(*) AS n FROM snapshot_day_projection_entries').get()?.n).toBe(2);
});
it('resumes a writing snapshot without materializing retry metadata over first-attempt facts',async()=>{
 const {connect,sqlite}=database(),store=new Store(connect()),id='o:a:source:resume',old={...batch().rows[0],sourceId:'source',retrievedAt:'2026-10-12T00:00:00Z',coverageThrough:null,channels:['old']};
 await store.run("INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES(?,'o','a','source','2026-10-12T00:00:00Z',NULL,1,'writing','old')",id);
 await store.run('INSERT INTO observations(snapshotId,date,rowKey,payload) VALUES(?,?,?,?)',id,old.date,JSON.stringify([old.dataset,old.metric,undefined,undefined,Object.entries(old.dimensions).sort()]),JSON.stringify(old));
 await store.persistBatch('o','source',batch('a',99),'resume','2026-10-12T01:00:00Z');expect(sqlite.prepare('SELECT COUNT(*) AS n FROM snapshot_day_projection_entries').get()?.n).toBe(0);
 expect(await backfillSnapshotDayProjections(store,'o','a')).toEqual({written:2,existing:0,failed:0});const result=await new Store(connect()).observations('o','a',filters);expect(result.find(row=>row.date==='2026-10-10')).toMatchObject({value:42,retrievedAt:'2026-10-12T00:00:00Z',coverageThrough:null,channels:['old']});expect(result.find(row=>row.date==='2026-10-11')).toMatchObject({value:99,retrievedAt:'2026-10-12T00:00:00Z',coverageThrough:null});
});
it('isolates tenant manifests and follows source corrections including an empty day',async()=>{
 const {connect,queries}=database();for(const [org,client,value] of [['o','a',42],['other','a',99],['o','b',7]] as const)await new Store(connect()).persistBatch(org,'source',batch(client,value),'one','2026-10-12T00:00:00Z');
 for(const [org,client,value] of [['o','a',42],['other','a',99],['o','b',7]] as const)expect((await new Store(connect()).observations(org,client,filters))[0].value).toBe(value);
 await new Store(connect()).persistBatch('o','source',batch('a',100),'two','2026-10-12T01:00:00Z');expect((await new Store(connect()).observations('o','a',filters))[0].value).toBe(100);
 await new Store(connect()).persistBatch('o','source',{...batch(),rows:[]},'empty','2026-10-12T02:00:00Z',{from:'2026-10-11',to:'2026-10-11'});expect((await new Store(connect()).observations('o','a',filters)).map(row=>row.date)).toEqual(['2026-10-10']);expect(rawReads(queries)).toBe(0);
});
it('fails open on corrupt or structurally invalid projections before emitting any facts',async()=>{
 const {connect,sqlite,queries}=database();await new Store(connect()).persistBatch('o','source',batch(),'one','2026-10-12T00:00:00Z');sqlite.exec("UPDATE snapshot_day_projection_chunks SET payload='corrupt' WHERE date='2026-10-10'");
 expect(await new Store(connect()).observations('o','a',filters)).toHaveLength(2);expect(rawReads(queries)).toBe(1);
 const compact=JSON.parse(observationCodec.encode(batch().rows.map(row=>({...row,sourceId:'source',retrievedAt:'2026-10-12T00:00:00Z'}))));compact.rows.push([0,999999,0,9]);const invalid=JSON.stringify(compact),emitted:Observation[]=[];expect(()=>observationCodec.visit(invalid,row=>emitted.push(row))).toThrow('Invalid observation projection');expect(emitted).toEqual([]);
});
it('backfills complete legacy days across datasets while preserving the original provenance',async()=>{
 const {connect,sqlite,queries}=database(),store=new Store(connect()),base=batch(),rows=base.rows.flatMap(row=>[row,{...row,dataset:'revenue',metric:'net_sales',value:100}]);await store.persistBatch('o','source',{...base,rows},'old','2026-10-12T00:00:00Z');sqlite.exec('DELETE FROM snapshot_day_projection_chunks; DELETE FROM snapshot_day_projection_entries');
 await store.observations('o','a',filters,false,undefined,{datasets:['traffic']});expect(sqlite.prepare('SELECT COUNT(*) AS n FROM snapshot_day_projection_entries').get()?.n).toBe(0);
 expect(await backfillSnapshotDayProjections(new Store(connect()),'o','a')).toEqual({written:2,existing:0,failed:0});const before=rawReads(queries);
 const result=await new Store(connect()).observations('o','a',{...filters,compare:'weekday'},false,undefined,{datasets:['revenue','traffic']});expect(result).toHaveLength(4);expect(result.filter(row=>row.dataset==='revenue').every(row=>row.value===100&&row.retrievedAt==='2026-10-12T00:00:00Z')).toBe(true);expect(rawReads(queries)).toBe(before);
 expect(await backfillSnapshotDayProjections(new Store(connect()),'other','a')).toEqual({written:0,existing:0,failed:0});expect(await backfillSnapshotDayProjections(new Store(connect()),'o','a')).toEqual({written:0,existing:2,failed:0});
});
it('bounds chunks and writes, and never publishes a failed staged generation',async()=>{
 const {connect,sqlite,batches}=database(),db=connect(),store=new Store(db),rows=Array.from({length:1500},(_,index)=>({...batch().rows[0],dimensions:{page:`/${index}-${'x'.repeat(1000)}`}}));await store.persistBatch('o','source',{...batch(),rows},'large','2026-10-12T00:00:00Z');
 const stored=sqlite.prepare('SELECT payload FROM snapshot_day_projection_chunks').all();expect(stored.length).toBeGreaterThan(4);for(const row of stored)expect(Buffer.byteLength(String(row.payload))).toBeLessThanOrEqual(256*1024);
 for(const writes of batches.filter(statements=>statements[0]?.sql.startsWith('INSERT INTO snapshot_day_projection_chunks'))){expect(writes.length).toBeLessThanOrEqual(4);expect(Buffer.byteLength(JSON.stringify(writes))).toBeLessThan(1024*1024);}
 const writeBatch=db.batch;db.batch=async statements=>{if(statements.some(statement=>statement.sql.startsWith('INSERT INTO snapshot_day_projection_chunks')))throw Error('Unavailable');return writeBatch(statements);};
 await store.persistBatch('o','source',batch('a',77),'failed','2026-10-12T01:00:00Z');expect(sqlite.prepare("SELECT COUNT(*) AS n FROM snapshot_day_projection_entries WHERE snapshotId LIKE '%failed'").get()?.n).toBe(0);expect((await new Store(connect()).observations('o','a',filters))[0].value).toBe(77);
});
it('retains a ready immutable projection through transient chunk-read failure',async()=>{
 const {connect,sqlite,queries}=database(),db=connect(),store=new Store(db),rows=Array.from({length:1000},(_,index)=>({...batch().rows[0],dimensions:{page:`/${index}-${'x'.repeat(200)}`}}));await store.persistBatch('o','source',{...batch(),rows},'large','2026-10-12T00:00:00Z');const prepare=db.prepare;
 db.prepare=(sql:string)=>{const statement=prepare(sql);if(sql.startsWith('SELECT chunkIndex,payload FROM snapshot_day_projection_chunks'))statement.all=async()=>{throw Error('Temporary database error');};return statement;};
 expect(await store.observations('o','a',filters)).toHaveLength(1000);expect(rawReads(queries)).toBeGreaterThan(0);expect(sqlite.prepare("SELECT status FROM snapshot_day_projection_entries").get()?.status).toBe('ready');const before=rawReads(queries);
 expect(await new Store(connect()).observations('o','a',{...filters,compare:'weekday'})).toHaveLength(1000);expect(rawReads(queries)).toBe(before);
});
it('fences orphan cleanup when a slow writer loses its generation to a retry',async()=>{
 const {connect,sqlite}=database(),db=connect(),store=new Store(db),id=await store.persistBatch('o','source',batch(),'one','2026-10-12T00:00:00Z');sqlite.exec('DELETE FROM snapshot_day_projection_chunks; DELETE FROM snapshot_day_projection_entries');const prepare=db.prepare;
 db.prepare=(sql:string)=>{const statement=prepare(sql);if(sql.startsWith('DELETE FROM snapshot_day_projection_chunks')&&sql.includes('generation<>?')){const run=statement.run;statement.run=async()=>{sqlite.exec("UPDATE snapshot_day_projection_entries SET generation='new-owner'; INSERT INTO snapshot_day_projection_chunks(organizationId,clientId,snapshotId,date,codecVersion,generation,chunkIndex,payload) SELECT organizationId,clientId,snapshotId,date,codecVersion,generation,0,'newer' FROM snapshot_day_projection_entries");return run();};}return statement;};
 expect(await writeSnapshotDayProjection(db,'o','a',{snapshotId:id,date:'2026-10-10',sourceId:'source'},observationCodec.encode([]))).toBe(false);expect(sqlite.prepare('SELECT generation,status FROM snapshot_day_projection_entries').get()).toMatchObject({generation:'new-owner',status:'writing'});expect(sqlite.prepare('SELECT payload FROM snapshot_day_projection_chunks').get()?.payload).toBe('newer');
});
it('keeps indexed scoped reads when a qualified mixed-source projection would transfer excluded dense detail',async()=>{
 const {connect,queries}=database(),store=new Store(connect()),base=batch().rows[0];await store.persistBatch('o','mixed',{...batch(),rows:[{...base,dataset:'revenue',metric:'net_sales'},...Array.from({length:2500},(_,index)=>({...base,dataset:'funnels',dimensions:{page:`/${index}`}}))]},'large','2026-10-12T00:00:00Z');
 await store.saveQualification('o','a','mixed',1,1,{profiles:[{dataset:'revenue',metric:'net_sales'},{dataset:'funnels',metric:'sessions'}]},'admin');const before=queries.length;
 expect(await new Store(connect()).observations('o','a',filters,false,undefined,{datasets:['revenue']})).toHaveLength(1);expect(queries.slice(before).filter(sql=>sql.includes('FROM snapshot_day_projection_chunks')||sql.includes('JOIN snapshot_day_projection_chunks'))).toHaveLength(0);expect(rawReads(queries)).toBe(1);
});
it('preserves the named landing-page cohort with matched Stockholm hours, UTM groups and missing-dimension evidence',async()=>{
 const projected=database(),legacy=database(false),client={...(clients[0] as Client),id:'a',timezone:'Europe/Stockholm'},page='/pages/glplpv4';
 const dimensions={page,market:'US',device:'mobile',source:'social',utm_source:'facebook',utm_medium:'paid',utm_campaign:'launch'};
 const dates=['2026-10-13','2026-10-14'],starts=[['2026-10-12T22:00:00Z','2026-10-12T23:00:00Z','2026-10-13T00:00:00Z'],['2026-10-13T22:00:00Z','2026-10-13T23:00:00Z','2026-10-14T00:00:00Z']];
 const cohort=(date:string,day:number,dims:Record<string,string>,sessions:number[],converting:number[])=>sessions.flatMap((value,hour)=>Object.entries({sessions:value,converting_sessions:converting[hour],atc_sessions:10,checkouts:5,completed_checkouts:2}).map(([metric,value])=>({...batch().rows[0],date,dataset:'traffic',metric,value,currency:null,definition:'shopify_human_public_landing_page_traffic',population:'human_public_landing_page_sessions',dimensions:dims,start:starts[day][hour],end:new Date(Date.parse(starts[day][hour])+3600000).toISOString()})));
 const rows:Observation[]=dates.flatMap((date,day)=>[
  ...cohort(date,day,dimensions,day?[100,200,1000]:[80,120,1000],day?[10,20,100]:[4,6,100]),
  ...cohort(date,day,{...dimensions,market:'United States',utm_source:'tiktok'},day?[50,50,1000]:[25,25,1000],day?[5,5,100]:[5,5,100]),
  ...[{...dimensions,market:'CA'},{...dimensions,device:'desktop'},{...dimensions,source:'organic'},...Array.from({length:600},(_,index)=>({...dimensions,page:`/unrelated-${index}`}))].flatMap(dims=>cohort(date,day,dims,[100,200,1000],[10,20,100])),
  {...batch().rows[0],date,dataset:'traffic',metric:'bounce_rate',value:0.3,currency:null,definition:'legacy_without_page',dimensions:{market:'US',device:'mobile',source:'social'},start:starts[day][0],end:new Date(Date.parse(starts[day][0])+3600000).toISOString()}
 ]);
 for(const fixture of [projected,legacy]){const store=new Store(fixture.connect());await store.run("INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config) VALUES('a','o','A','a','Europe/Stockholm','USD','blue',?)",JSON.stringify(client.config));await store.run("INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,version,coverageThrough) VALUES('source','o','a','Traffic','kind-shopify-traffic','','',60,1,1,'2026-10-14T00:00:00Z')");await store.persistBatch('o','source',{...batch(),timezone:client.timezone,rows,grain:'hourly',coverageThrough:'2026-10-14T01:00:00Z'},'scoped-page','2026-10-14T01:00:00Z');await store.saveQualification('o','a','source',1,1,{profiles:['sessions','converting_sessions','atc_sessions','checkouts','completed_checkouts','bounce_rate'].map(metric=>({dataset:'traffic',metric}))},'admin');}
 const selected:QueryFilters={...filters,from:'2026-10-14',to:'2026-10-14',mode:'partial',market:'US',device:'mobile',source:'social',page},selection={datasets:['traffic'],dimensions:true,includePriorWeek:false,includeOperations:false,trendDatasets:[]};
 const actual=await new Store(projected.connect()).observations('o','a',selected,false,undefined,selection),expected=await new Store(legacy.connect()).observations('o','a',selected,false,undefined,selection);
 expect(actual).toEqual(expected);expect(actual.some(row=>row.dimensions.page===undefined&&row.metric==='bounce_rate')).toBe(true);
 const result=queryClient(client,actual,await new Store(projected.connect()).connections('o','a'),selected,{preparedDatasets:['traffic']});
 expect(result.cutoff).toBe('2026-10-14T00:00:00Z');expect(result.datasetSeries.traffic[0].summary).toMatchObject({sessions:400,cvr:0.1,atc:0.1,checkoutCompletion:0.4});expect(result.comparisonDatasetSeries.traffic[0].summary).toMatchObject({sessions:250,cvr:0.08,atc:0.16,checkoutCompletion:0.4});
 expect(result.details.map(row=>[row.dimensions.utm_source,row.summary.sessions,row.summary.cvr]).sort()).toEqual([['facebook',300,0.1],['tiktok',100,0.1]]);expect(result.warnings.some(warning=>warning.includes('traffic:bounce_rate'))).toBe(true);
 expect(actual).toHaveLength(22);
});
it('uses dense projections only for pointer dates inside selected, comparison or prior-week detail windows',async()=>{
 const projected=database(),legacy=database(false),base=batch().rows[0],rows=['2026-10-01','2026-10-02','2026-10-10'].flatMap(date=>[{...base,date,dataset:'overview',metric:'revenue',value:100,dimensions:{}},...Array.from({length:2500},(_,index)=>({...base,date,dataset:'funnels',dimensions:{page:`/${index}-${'detail'.repeat(20)}`}}))]);
 for(const fixture of [projected,legacy]){const store=new Store(fixture.connect());await store.persistBatch('o','mixed',{...batch(),rows},'history','2026-10-12T00:00:00Z');await store.saveQualification('o','a','mixed',1,1,{profiles:[{dataset:'overview',metric:'revenue'},{dataset:'funnels',metric:'sessions'}]},'admin');}
 const db=projected.connect(),prepare=db.prepare,chunkReads:unknown[][]=[];
 db.prepare=(sql:string)=>{const statement=prepare(sql);if(sql.startsWith('SELECT')&&sql.includes('snapshot_day_projection_chunks')){const bind=statement.bind;statement.bind=(...values:unknown[])=>{chunkReads.push(values);return bind(...values);};}return statement;};
 const selection={datasets:['overview','funnels','traffic']},actual=await new Store(db).observations('o','a',filters,false,undefined,selection),expected=await new Store(legacy.connect()).observations('o','a',filters,false,undefined,selection);
 expect(actual).toEqual(expected);expect(actual).toHaveLength(2503);expect(actual.filter(row=>row.dataset==='overview').map(row=>[row.date,row.value])).toEqual([['2026-10-01',100],['2026-10-02',100],['2026-10-10',100]]);
 expect(chunkReads.length).toBeGreaterThan(0);expect(JSON.stringify(chunkReads)).toContain('2026-10-10');expect(JSON.stringify(chunkReads)).not.toContain('2026-10-01');expect(JSON.stringify(chunkReads)).not.toContain('2026-10-02');expect(rawReads(projected.queries)).toBe(1);
 expect(projected.queries.find(sql=>sql.startsWith('SELECT o.payload'))).toContain("json_extract(o.payload,'$.dataset') IN (?)");
});

it('preserves qualified Revenue context, stream filtering and exact comparisons on pure and mixed dense day captures',async()=>{
 const projected=database(),legacy=database(false),base=batch().rows[0],dates=Array.from({length:34},(_,index)=>new Date(Date.UTC(2026,8,9+index)).toISOString().slice(0,10)),client={...(clients[0] as Client),id:'a',timezone:'UTC'};
 const revenue=dates.flatMap((date,index)=>['web','Recharge'].flatMap((stream,streamIndex)=>[{...base,date,dataset:'revenue',metric:'revenue',value:100+index+streamIndex,population:'shopify_sales',definition:'shopify_net_sales',dimensions:{stream}},{...base,date,dataset:'revenue',metric:'orders',value:10,population:'shopify_sales',definition:'shopify_orders',dimensions:{stream}}]));
 for(const mixed of [false,true]){
  const source=mixed?'mixed':'pure',rows:Observation[]=mixed?revenue.flatMap(row=>[row,...row.metric==='revenue'&&row.dimensions.stream==='web'?Array.from({length:80},(_,index)=>({...base,date:row.date,dataset:'traffic',metric:'sessions',value:index+1,dimensions:{page:`/heavy-${index}`}})):[]]):revenue;
  for(const fixture of [projected,legacy]){const store=new Store(fixture.connect());await store.persistBatch('o',source,{...batch(),rows},`${source}-context`,'2026-10-13T00:00:00Z');await store.saveQualification('o','a',source,1,1,{profiles:[{dataset:'revenue',metric:'revenue'},{dataset:'revenue',metric:'orders'},...mixed?[{dataset:'traffic',metric:'sessions'}]:[]]},'admin');}
  // Select one source at a time so overlapping source authority cannot conceal history selection bugs.
  for(const fixture of [projected,legacy])fixture.sqlite.prepare('DELETE FROM current_snapshots WHERE sourceId<>?').run(source);
  const selection={datasets:['revenue'],includePriorWeek:false,trendDatasets:['revenue'],dimensions:true},scope={...filters,from:'2026-10-12',to:'2026-10-12',view:'revenue',stream:'web'};
  for(const compare of ['weekday','custom'] as const){const selected={...scope,compare,...compare==='custom'?{compareFrom:'2026-09-09',compareTo:'2026-09-09'}:{}};
   const actual=await new Store(projected.connect()).observations('o','a',selected,false,undefined,selection);expect(actual).toEqual(await new Store(legacy.connect()).observations('o','a',selected,false,undefined,selection));expect(actual.every(row=>row.dataset==='revenue'&&row.dimensions.stream==='web')).toBe(true);
   const result=queryClient(client,actual,[],selected,{preparedDatasets:['revenue']});expect(result.datasetSeries.revenue).toHaveLength(1);expect(result.datasetSeries.revenue[0].summary).toMatchObject({revenue:133,orders:10,aov:13.3});expect(result.comparisonDatasetSeries.revenue[0].summary.revenue).toBe(compare==='weekday'?126:100);
   expect(result.datasetHistorySeries.revenue).toHaveLength(30);expect(result.datasetHistorySeries.revenue.map(row=>row.date)).toEqual(dates.slice(4));expect(result.datasetHistorySeries.revenue.every(row=>row.summary.revenue!==null&&row.summary.orders===10&&row.summary.aov===row.summary.revenue!/10)).toBe(true);
  }
 }
 expect(projected.queries.some(sql=>sql.includes('snapshot_day_projection_chunks'))).toBe(true);expect(rawReads(projected.queries)).toBeGreaterThan(0);
});

it('keeps the previous-day live trend on the same matched hour as its comparison',async()=>{
 const {connect}=database(),store=new Store(connect()),client={...(clients[0] as Client),id:'a',timezone:'UTC'};
 await store.run("INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config) VALUES('a','o','A','a','UTC','USD','blue',?)",JSON.stringify(client.config));
 await store.run("INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,version,coverageThrough) VALUES('source','o','a','Traffic','kind-shopify-traffic','','',60,1,1,'2026-10-12T01:00:00Z')");
 const rows:Observation[]=['2026-10-11','2026-10-12'].flatMap(date=>[0,1].map(hour=>({...batch().rows[0],date,metric:'sessions',dataset:'traffic',currency:null,definition:'shopify_human_public_landing_page_traffic',population:'human_public_landing_page_sessions',value:hour?90:10,dimensions:{page:'/lp',market:'US',device:'mobile',source:'social',utm_source:'meta',utm_medium:'paid',utm_campaign:'c'},start:`${date}T0${hour}:00:00Z`,end:`${date}T0${hour+1}:00:00Z`})));
 await store.persistBatch('o','source',{...batch(),rows,grain:'hourly',coverageThrough:'2026-10-12T02:00:00Z'},'full-and-matched','2026-10-12T03:00:00Z');
 const filters:QueryFilters={from:'2026-10-12',to:'2026-10-12',mode:'partial',compare:'previous',view:'traffic',market:'',device:'',page:'',source:'',stream:''};
 const observations=await store.observations('o','a',filters,false,undefined,{datasets:['traffic'],trendDatasets:['traffic'],includePriorWeek:false});
 const result=queryClient(client,observations,await store.connections('o','a'),filters,{preparedDatasets:['traffic']});
 expect(result.datasetSeries.traffic[0].summary.sessions).toBe(10);expect(result.comparisonDatasetSeries.traffic[0].summary.sessions).toBe(10);
 expect(result.trendDatasetSeries.traffic.find(point=>point.date==='2026-10-11')?.summary.sessions).toBe(10);
});
it('keeps complete earlier selected-period traffic totals alongside matched-hour chart context',async()=>{
 const {connect}=database(),store=new Store(connect()),client={...(clients[0] as Client),id:'a',timezone:'UTC'};
 await store.run("INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config) VALUES('a','o','A','a','UTC','USD','blue',?)",JSON.stringify(client.config));
 await store.run("INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,version,coverageThrough) VALUES('source','o','a','Traffic','kind-shopify-traffic','','',60,1,1,'2026-10-12T01:00:00Z')");
 const rows:Observation[]=['2026-10-07','2026-10-08','2026-10-09','2026-10-10','2026-10-11','2026-10-12'].flatMap(date=>[0,1].flatMap(hour=>['sessions','converting_sessions'].map(metric=>({...batch().rows[0],date,metric,dataset:'traffic',currency:null,definition:'shopify_human_public_landing_page_traffic',population:'human_public_landing_page_sessions',value:metric==='sessions'?(hour?90:10):(hour?9:1),dimensions:{page:'/lp',market:'US',device:'mobile',source:'social',utm_source:'meta',utm_medium:'paid',utm_campaign:'c'},start:`${date}T0${hour}:00:00Z`,end:`${date}T0${hour+1}:00:00Z`}))));
 await store.persistBatch('o','source',{...batch(),rows,grain:'hourly',coverageThrough:'2026-10-12T02:00:00Z'},'multiday-matched','2026-10-12T03:00:00Z');
 const filters:QueryFilters={from:'2026-10-10',to:'2026-10-12',mode:'partial',compare:'previous',view:'traffic',market:'',device:'',page:'',source:'',stream:''},selection={datasets:['traffic'],trendDatasets:['traffic'],includePriorWeek:false};
 const observations=await store.observations('o','a',filters,false,undefined,selection),result=queryClient(client,observations,await store.connections('o','a'),filters,{preparedDatasets:['traffic']});
 expect(result.datasetSeries.traffic.map(point=>point.summary.sessions)).toEqual([100,100,10]);expect(result.comparisonDatasetSeries.traffic.map(point=>point.summary.sessions)).toEqual([100,100,10]);
 expect(result.trendDatasetSeries.traffic.filter(point=>point.summary.sessions!==null).map(point=>[point.date,point.summary.sessions])).toEqual(['2026-10-07','2026-10-08','2026-10-09','2026-10-10','2026-10-11','2026-10-12'].map(date=>[date,10]));
 expect(result.trendComparisonDatasetSeries.traffic.filter(point=>point.summary.sessions!==null).map(point=>point.summary.sessions)).toEqual([10,10,10]);
});

it('packs a cold thirty-day headline read into one bounded RPC with exactly the raw observations and metrics',async()=>{
 const projected=database(),legacy=database(false),client={...(clients[0] as Client),id:'a',timezone:'UTC'},base=batch().rows[0];
 const dates=Array.from({length:30},(_,index)=>new Date(Date.UTC(2026,8,12+index)).toISOString().slice(0,10));
 const rows:Observation[]=dates.flatMap((date,index)=>Object.entries({revenue:index===29?0:100+index,orders:index+1,sessions:1000+index,converting_sessions:index+1}).map(([metric,value])=>({...base,date,dataset:'overview',metric,value,definition:metric,population:'human_sessions',currency:metric==='revenue'?'USD':null,dimensions:{}})));
 for(const fixture of [projected,legacy]){const store=new Store(fixture.connect());await store.run("INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config) VALUES('a','o','A','a','UTC','USD','blue',?)",JSON.stringify(client.config));await store.persistBatch('o','source',{...batch(),rows},'thirty-headlines','2026-10-12T00:00:00Z');await store.saveQualification('o','a','source',1,1,{profiles:Object.keys({revenue:0,orders:0,sessions:0,converting_sessions:0}).map(metric=>({dataset:'overview',metric}))},'admin');}
 const selected={...filters,from:'2026-10-11',to:'2026-10-11',view:'overview'},selection={datasets:['overview'],includePriorWeek:false,includeOperations:false,trendDatasets:[]},before=projected.queries.length;
 const actual=await new Store(projected.connect()).observations('o','a',selected,true,undefined,selection),expected=await new Store(legacy.connect()).observations('o','a',selected,true,undefined,selection);
 expect(actual).toEqual(expected);expect(actual).toHaveLength(120);
 const actualAnalytics=queryClient(client,actual,[],selected,{preparedDatasets:['overview']}),expectedAnalytics=queryClient(client,expected,[],selected,{preparedDatasets:['overview']});
 expect(actualAnalytics.metrics).toEqual(expectedAnalytics.metrics);expect(actualAnalytics.series).toEqual(expectedAnalytics.series);expect(actualAnalytics.metrics.revenue).toBe(0);
 expect(rawReads(projected.queries.slice(before))).toBe(0);
 expect(projected.queries.slice(before).filter(sql=>sql.includes('JOIN snapshot_day_projection_chunks'))).toHaveLength(1);
});


it('caps small batches at32 manifests and the original256Ki character budget before reading',async()=>{
 const manifest=(characters:number,index=0):SnapshotDayManifest=>({snapshotId:`snapshot-${index}`,date:'2026-10-10',sourceId:'source',generation:'generation',chunkCount:1,characters,payloadHash:'hash'});
 expect(smallSnapshotDayBatchWithinLimits(Array.from({length:32},(_,index)=>manifest(8192,index)))).toBe(true);
 expect(smallSnapshotDayBatchWithinLimits(Array.from({length:4},(_,index)=>manifest(65536,index)))).toBe(true);
 expect(smallSnapshotDayBatchWithinLimits(Array.from({length:33},(_,index)=>manifest(1,index)))).toBe(false);
 const overBudget=Array.from({length:5},(_,index)=>manifest(65536,index));expect(smallSnapshotDayBatchWithinLimits(overBudget)).toBe(false);
 for(const characters of [0,-1,0.5,NaN,65537])expect(smallSnapshotDayBatchWithinLimits([manifest(characters)])).toBe(false);
 expect(smallSnapshotDayBatchWithinLimits([{...manifest(1),chunkCount:2}])).toBe(false);
 const fixture=database();expect((await readSmallSnapshotDayProjections(fixture.connect(),'o','a',overBudget)).size).toBe(0);expect(fixture.queries).toEqual([]);
});

it.each([{days:33,padding:100,sizes:[32,1]},{days:5,padding:64000,sizes:[4,1]}])('packs contiguous days within both batch limits: %j',async({days,padding,sizes})=>{
 const fixture=database(),store=new Store(fixture.connect()),rows:Observation[]=Array.from({length:days},(_,index)=>({...batch().rows[0],date:new Date(Date.UTC(2026,8,9+index)).toISOString().slice(0,10),dataset:'overview',metric:'revenue',dimensions:{label:'x'.repeat(padding)},value:index}));
 await store.persistBatch('o','source',{...batch(),rows},'packing-boundary','2026-10-12T00:00:00Z');await store.saveQualification('o','a','source',1,1,{profiles:[{dataset:'overview',metric:'revenue'}]},'admin');
 const db=fixture.connect(),prepare=db.prepare,groups:{snapshotId:string;date:string;generation:string}[][]=[];
 db.prepare=(sql:string)=>{const statement=prepare(sql);if(sql.includes('JOIN snapshot_day_projection_chunks')){const bind=statement.bind;statement.bind=(...values:unknown[])=>{groups.push(JSON.parse(String(values[0])));return bind(...values);};}return statement;};
 const result=await new Store(db).observations('o','a',undefined,true,undefined,{datasets:['overview'],includeOperations:false});
 expect(result).toHaveLength(days);expect(groups.map(group=>group.length)).toEqual(sizes);expect(groups.flatMap(group=>group.map(day=>day.date))).toEqual(rows.map(row=>row.date));
 for(const group of groups){const characters=group.reduce((sum,day)=>sum+Number(fixture.sqlite.prepare('SELECT characters FROM snapshot_day_projection_entries WHERE snapshotId=? AND date=? AND generation=?').get(day.snapshotId,day.date,day.generation)?.characters),0);expect(characters).toBeLessThanOrEqual(256*1024);}
 expect(rawReads(fixture.queries)).toBe(0);
});

it.each(['missing','hash','declared-length','invalid-first','nul-payload','source','date','generation'])('retains valid Unicode neighbors and exactly falls back on an invalid %s in a larger batch',async invalid=>{
 const projected=database(),legacy=database(false),rows:Observation[]=Array.from({length:8},(_,index)=>({...batch().rows[0],date:`2026-10-${String(index+4).padStart(2,'0')}`,dataset:'overview',metric:'revenue',dimensions:{label:'市場🙂'},value:index}));
 for(const fixture of [projected,legacy]){const store=new Store(fixture.connect());await store.persistBatch('o','source',{...batch(),rows},'unicode-days','2026-10-12T00:00:00Z');await store.saveQualification('o','a','source',1,1,{profiles:[{dataset:'overview',metric:'revenue'}]},'admin');}
 const badDate=invalid==='invalid-first'?'2026-10-04':'2026-10-06',where=`WHERE date='${badDate}'`;
 if(invalid==='missing')projected.sqlite.exec(`DELETE FROM snapshot_day_projection_chunks ${where}`);
 if(invalid==='hash')projected.sqlite.exec(`UPDATE snapshot_day_projection_chunks SET payload='corrupt' ${where}`);
 if(invalid==='declared-length')projected.sqlite.exec(`UPDATE snapshot_day_projection_entries SET characters=1 ${where}`);
 if(invalid==='invalid-first')projected.sqlite.exec(`UPDATE snapshot_day_projection_entries SET characters=0 ${where}`);
 if(invalid==='nul-payload'){projected.sqlite.prepare('UPDATE snapshot_day_projection_chunks SET payload=? WHERE date=?').run('\u0000'+'x'.repeat(1000),badDate);projected.sqlite.exec(`UPDATE snapshot_day_projection_entries SET characters=1 ${where}`);}
 if(invalid==='generation')projected.sqlite.exec(`UPDATE snapshot_day_projection_entries SET generation='other-generation' ${where}`);
 if(invalid==='source'||invalid==='date'){
  const row=JSON.parse(String(projected.sqlite.prepare('SELECT payload FROM observations WHERE date=?').get(badDate)?.payload)) as Observation;
  const payload=observationCodec.encode([{...row,...invalid==='source'?{sourceId:'foreign-source'}:{date:'2026-01-01'}}]);
  projected.sqlite.prepare('UPDATE snapshot_day_projection_chunks SET payload=? WHERE date=?').run(payload,badDate);
  projected.sqlite.prepare('UPDATE snapshot_day_projection_entries SET characters=?,payloadHash=? WHERE date=?').run(payload.length,createHash('sha256').update(payload).digest('hex'),badDate);
 }
 const db=projected.connect(),prepare=db.prepare,transferredDates:string[]=[];
 db.prepare=(sql:string)=>{const statement=prepare(sql);if(sql.includes('JOIN snapshot_day_projection_chunks')){const all=statement.all;statement.all=async()=>{const result=await all();transferredDates.push(...result.results.map(row=>String(row.date)));return result;};}return statement;};
 const selected={...filters,from:'2026-10-11',to:'2026-10-11',view:'overview'},selection={datasets:['overview'],includePriorWeek:false,includeOperations:false,trendDatasets:[]};
 const actual=await new Store(db).observations('o','a',selected,true,undefined,selection),expected=await new Store(legacy.connect()).observations('o','a',selected,true,undefined,selection);
 expect(actual).toEqual(expected);expect(actual).toHaveLength(8);expect(actual.every(row=>row.dimensions.label==='市場🙂'&&row.sourceId==='source')).toBe(true);expect(actual.some(row=>row.value===0)).toBe(true);expect(rawReads(projected.queries)).toBe(1);
 expect(transferredDates.filter(date=>date!==badDate)).toHaveLength(7);
 if(['declared-length','invalid-first','nul-payload'].includes(invalid))expect(transferredDates).not.toContain(badDate);
});
