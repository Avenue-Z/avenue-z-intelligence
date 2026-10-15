import {createClient} from '@libsql/client';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {sqliteBindings} from '../../lib/server/sqlite-bindings';
import {Store} from '../../lib/server/store';
import {readTrendObservations} from '../../lib/server/trend-observations';
import {writeSnapshotDayProjection} from '../../lib/server/snapshot-day-projections';
import {observationCodec} from '../../lib/server/observation-codec';
import {shiftDate} from '../../lib/analytics/windows';

it('prepares common layouts natively after a foreground read, without adding day-cache writes to foreground navigation',async()=>{
 const client=createClient({url:'file::memory:'});try{
  for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))await client.executeMultiple(readFileSync(`drizzle/${file}`,'utf8'));
  let writes=0;const base=sqliteBindings(client),reads:string[]=[],db={...base,async batch(statements:Parameters<typeof base.batch>[0]){writes++;return base.batch(statements);},prepare(sql:string){const statement=base.prepare(sql);return {...statement,bind(...args:unknown[]){const bound=statement.bind(...args);return {...bound,run:async()=>{writes++;return bound.run();},all:async()=>{reads.push(sql);return bound.all();}};}};}},store=new Store(db),scope={organizationId:'agency',clientId:'kind-patches'},date='2026-10-10',pointer={snapshotId:'common',sourceId:'traffic',date};
  await store.run("INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES('common','agency','kind-patches','traffic','2026-10-12T03:00:00Z','2026-10-12T03:00:00Z',1,'ready','test')");
  const rows=[0,1].flatMap(hour=>['US','CA'].map((market,index)=>({date,dataset:'traffic',metric:'sessions',value:(hour+1)*(index+1),dimensions:{market,page:index?'/b':'/a',utm_campaign:'kept-in-original'},definition:'captured',population:'human',currency:null,sourceId:'traffic',retrievedAt:'2026-10-12T03:00:00Z',coverageThrough:'2026-10-12T03:00:00Z',quality:'complete' as const,start:`${date}T0${hour}:00:00Z`,end:`${date}T0${hour+1}:00:00Z`})));
  await writeSnapshotDayProjection(db,scope.organizationId,scope.clientId,pointer,observationCodec.encode(rows));
  const filters={from:'2026-10-12',to:'2026-10-12',view:'traffic',compare:'previous',mode:'partial',market:'',stream:'',source:'',device:'',page:''} as const,cutoff={timezone:'UTC',cutoff:'2026-10-12T01:00:00Z',anchorDate:filters.to},dayEntries=()=>client.execute("SELECT cacheKey,generation,createdAt FROM observation_cache_entries WHERE cacheKey LIKE 'trend-day:%' ORDER BY cacheKey");
  const beforeForeground=writes;await readTrendObservations(store,[pointer],['traffic'],filters,scope,cutoff);expect((await dayEntries()).rows).toHaveLength(0);expect(writes).toBe(beforeForeground);
  const before=reads.length;await readTrendObservations(store,[pointer],['traffic'],filters,scope,cutoff,Date.now()+60000);
  expect(reads.slice(before).filter(sql=>sql.includes('FROM snapshot_day_projection_chunks'))).toHaveLength(1);
  const prepared=await dayEntries();expect(prepared.rows).toHaveLength(3);reads.length=0;const beforeNavigation=writes;
  const market=await readTrendObservations(store,[pointer],['traffic'],{...filters,market:'US'},scope,{...cutoff,cutoff:'2026-10-12T02:00:00Z'}),page=await readTrendObservations(store,[pointer],['traffic'],{...filters,page:'/a'},scope,{...cutoff,cutoff:'2026-10-12T02:00:00Z'});
  expect(market.map(row=>[row.dimensions.market,row.value])).toEqual([['US',3],['CA',6]]);expect(page.map(row=>[row.dimensions.page,row.value])).toEqual([['/a',3],['/b',6]]);
  expect(reads.filter(sql=>sql.includes('snapshot_day_projection_chunks'))).toHaveLength(0);expect((await dayEntries()).rows).toEqual(prepared.rows);expect(writes).toBe(beforeNavigation);
 }finally{client.close();}
});

it('keeps an unknown interval distinct from a daily or hourly cohort instead of manufacturing a combined count',async()=>{
 const client=createClient({url:'file::memory:'});try{
  for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))await client.executeMultiple(readFileSync(`drizzle/${file}`,'utf8'));
  const db=sqliteBindings(client),store=new Store(db),scope={organizationId:'agency',clientId:'kind-patches'},date='2026-10-10',pointer={snapshotId:'mixed',sourceId:'traffic',date};
  await store.run("INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES('mixed','agency','kind-patches','traffic','2026-10-12T03:00:00Z','2026-10-12T03:00:00Z',1,'ready','test')");
  const base={date,dataset:'traffic',metric:'sessions',value:100,dimensions:{market:'US'},definition:'captured',population:'human',currency:null,sourceId:'traffic',retrievedAt:'2026-10-12T03:00:00Z',coverageThrough:'2026-10-12T03:00:00Z',quality:'complete' as const};
  await writeSnapshotDayProjection(db,scope.organizationId,scope.clientId,pointer,observationCodec.encode([base,{...base,value:25,start:'invalid',end:`${date}T01:00:00Z`}]));
  const filters={from:'2026-10-12',to:'2026-10-12',view:'traffic',compare:'previous',mode:'closed',market:'US',stream:'',source:'',device:'',page:''} as const;
  expect((await readTrendObservations(store,[pointer],['traffic'],filters,scope)).map(row=>row.value)).toEqual([null,null]);
 }finally{client.close();}
});

it('reuses unchanged immutable day cohorts after a pointer correction and a later matched-hour cutoff',async()=>{
 const client=createClient({url:'file::memory:'});try{
  for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))await client.executeMultiple(readFileSync(`drizzle/${file}`,'utf8'));
  const base=sqliteBindings(client),projectionDates:string[]=[],db={...base,prepare(sql:string){const statement=base.prepare(sql);return {...statement,bind(...args:unknown[]){const bound=statement.bind(...args);return {...bound,all:async()=>{if(sql.includes('FROM snapshot_day_projection_chunks'))projectionDates.push(String(args[3]));return bound.all();}};}};}},store=new Store(db),scope={organizationId:'agency',clientId:'kind-patches'},sourceId='traffic';
  for(const snapshotId of ['original','corrected'])await store.run("INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES(?,'agency','kind-patches','traffic','2026-10-02T03:00:00Z','2026-10-02T03:00:00Z',1,'ready','test')",snapshotId);
  const pointers=Array.from({length:30},(_,index)=>({snapshotId:'original',sourceId,date:shiftDate('2026-09-01',index)}));
  const rows=(date:string,multiplier=1)=>[0,1].flatMap(hour=>Array.from({length:10},(_,campaign)=>({date,dataset:'traffic',metric:'sessions',value:(hour+1)*multiplier,dimensions:{market:'US',utm_campaign:String(campaign)},definition:'captured',population:'human',currency:null,sourceId,retrievedAt:'2026-10-02T03:00:00Z',coverageThrough:'2026-10-02T03:00:00Z',quality:'complete' as const,start:`${date}T0${hour}:00:00Z`,end:`${date}T0${hour+1}:00:00Z`})));
  for(const pointer of pointers)await writeSnapshotDayProjection(db,scope.organizationId,scope.clientId,pointer,observationCodec.encode(rows(pointer.date)));
  const filters={from:'2026-10-02',to:'2026-10-02',view:'traffic',compare:'previous',mode:'partial',market:'US',stream:'',source:'',device:'',page:''} as const;
  const first=await readTrendObservations(store,pointers,['traffic'],filters,scope,{timezone:'UTC',cutoff:'2026-10-02T01:00:00Z',anchorDate:filters.to},Date.now()+60000);
  expect(first).toHaveLength(30);expect(first.map(row=>row.value)).toEqual(Array(30).fill(10));
  const corrected={...pointers.at(-1)!,snapshotId:'corrected'};await writeSnapshotDayProjection(db,scope.organizationId,scope.clientId,corrected,observationCodec.encode(rows(corrected.date,10)));
  projectionDates.length=0;
  const second=await readTrendObservations(store,[...pointers.slice(0,-1),corrected],['traffic'],filters,scope,{timezone:'UTC',cutoff:'2026-10-02T02:00:00Z',anchorDate:filters.to});
  expect(second.map(row=>row.value)).toEqual([...Array(29).fill(30),300]);
  expect(projectionDates).toEqual([corrected.date]);
 }finally{client.close();}
});

it('rebuilds the observation context when an active filter needs a retained dimension, then shares it across values',async()=>{
 const client=createClient({url:'file::memory:'});try{
  for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))await client.executeMultiple(readFileSync(`drizzle/${file}`,'utf8'));
  const base=sqliteBindings(client),reads:string[]=[],db={...base,prepare(sql:string){const statement=base.prepare(sql);return {...statement,bind(...args:unknown[]){const bound=statement.bind(...args);return {...bound,all:async()=>{reads.push(sql);return bound.all();}};}};}},store=new Store(db);
  const date='2026-10-10',sourceId='traffic',rows=['US','CA'].map((market,index)=>({date,dataset:'traffic',metric:'sessions',value:index?5:10,dimensions:{market,page:index?'/b':'/a'},definition:'captured',population:'human',currency:null,sourceId,retrievedAt:'2026-10-12T03:00:00Z',coverageThrough:'2026-10-12T03:00:00Z',quality:'complete' as const}));
  await store.run("INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config) VALUES('kind-patches','agency','KP','kp','UTC','USD','blue','{}')");
  await store.run("INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES('projected','agency','kind-patches','traffic','2026-10-12T03:00:00Z','2026-10-12T03:00:00Z',1,'ready','test')");
  await store.run("INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId) VALUES('agency','kind-patches','traffic',?,'projected')",date);
  await store.saveQualification('agency','kind-patches','traffic',1,1,{profiles:[{dataset:'traffic',metric:'sessions'}]},'test');
  await writeSnapshotDayProjection(db,'agency','kind-patches',{snapshotId:'projected',sourceId,date},observationCodec.encode(rows));
  const filters={from:'2026-10-12',to:'2026-10-12',view:'traffic',compare:'previous',mode:'closed',market:'',stream:'',source:'',device:'',page:''} as const,selection={datasets:['traffic'],includePriorWeek:false,includeOperations:false,trendDatasets:['traffic']};
  expect(await store.observations('agency','kind-patches',filters,false,undefined,selection)).toMatchObject([{value:15,dimensions:{},contextOnly:true}]);
  const market=await store.observations('agency','kind-patches',{...filters,market:'US'},false,undefined,selection);
  expect(market.map(row=>[row.dimensions.market,row.value])).toEqual([['US',10],['CA',5]]);
  const before=reads.length;expect(await store.observations('agency','kind-patches',{...filters,market:'CA'},false,undefined,selection)).toEqual(market);
  expect(reads.slice(before).filter(sql=>sql.includes('snapshot_day_projection_chunks'))).toHaveLength(0);
  expect((await store.observations('agency','kind-patches',{...filters,page:'/a'},false,undefined,selection)).map(row=>[row.dimensions.page,row.value])).toEqual([['/a',10],['/b',5]]);
 }finally{client.close();}
});

it('reuses an immutable trend cohort across filter values while preserving every value and isolating dimension layouts',async()=>{
 const client=createClient({url:'file::memory:'});try{
  for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))await client.executeMultiple(readFileSync(`drizzle/${file}`,'utf8'));
  const base=sqliteBindings(client),reads:string[]=[],db={...base,prepare(sql:string){const statement=base.prepare(sql);return {...statement,bind(...args:unknown[]){const bound=statement.bind(...args);return {...bound,all:async()=>{reads.push(sql);return bound.all();}};}};}},store=new Store(db),date='2026-10-10',scope={organizationId:'agency',clientId:'kind-patches'},pointer={snapshotId:'projected',sourceId:'traffic',date};
  await store.run("INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES('projected','agency','kind-patches','traffic','2026-10-12T03:00:00Z','2026-10-12T03:00:00Z',1,'ready','test')");
  const rows=['US','CA'].map((market,index)=>({date,dataset:'traffic',metric:'sessions',value:index?5:10,dimensions:{market,page:index?'/b':'/a'},definition:'captured',population:'human',currency:null,sourceId:'traffic',retrievedAt:'2026-10-12T03:00:00Z',coverageThrough:'2026-10-12T03:00:00Z',quality:'complete' as const}));
  await writeSnapshotDayProjection(db,scope.organizationId,scope.clientId,pointer,observationCodec.encode(rows));
  const filters={from:'2026-10-12',to:'2026-10-12',view:'traffic',compare:'previous',mode:'closed',market:'US',stream:'',source:'',device:'',page:''} as const;
  const first=await readTrendObservations(store,[pointer],['traffic'],filters,scope,undefined,Date.now()+60000),before=reads.length;
  expect(await readTrendObservations(store,[pointer],['traffic'],{...filters,market:'CA'},scope)).toEqual(first);
  expect(reads.slice(before).filter(sql=>sql.includes('snapshot_day_projection_chunks'))).toHaveLength(0);
  expect(first.map(row=>[row.dimensions.market,row.value])).toEqual([['US',10],['CA',5]]);
  expect((await readTrendObservations(store,[pointer],['traffic'],{...filters,market:'',page:'/a'},scope)).map(row=>[row.dimensions.page,row.value])).toEqual([['/a',10],['/b',5]]);
 }finally{client.close();}
});

it('compacts a missing dense history projection through bounded indexed reads without losing rows, filters or rate qualification',async()=>{
 const client=createClient({url:'file::memory:'});
 try{
  for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))await client.executeMultiple(readFileSync(`drizzle/${file}`,'utf8'));
  const date='2026-09-28',snapshotId='captured-history',sourceId='traffic',make=(metric:string,value:number|null,index:number,market='US')=>{const hour=Math.min(23,Math.floor(index/200)),clock=(value:number)=>String(value).padStart(2,'0');return {date,dataset:'traffic',metric,value,dimensions:{market,page:'/a',utm_campaign:`campaign-${index}`},population:'human',definition:'captured',currency:null,sourceId,retrievedAt:'2026-10-13T12:00:00Z',coverageThrough:'2026-09-28T22:00:00Z',quality:'complete',start:`2026-09-28T${clock(hour)}:00:00Z`,end:`2026-09-28T${clock(hour+1)}:00:00Z`};};
  const rows=[...Array.from({length:4101},(_,index)=>make('sessions',1,index)),make('converting_sessions',13,0),make('sessions',3,4102,'CA'),make('reported_rate',.2,0),make('reported_rate',.3,1),{...make('component_rate',.25,0),numerator:1,denominator:4},{...make('component_rate',.5,1),numerator:2,denominator:4}];
  for(let index=0;index<rows.length;index+=500)await client.batch(rows.slice(index,index+500).map((row,offset)=>({sql:'INSERT INTO observations(snapshotId,date,rowKey,payload) VALUES(?,?,?,?)',args:[snapshotId,date,String(index+offset).padStart(6,'0'),JSON.stringify(row)]})),'write');
  const base=sqliteBindings(client),reads:number[]=[],returned:number[]=[];
  const db={...base,prepare(sql:string){const statement=base.prepare(sql);return {...statement,bind(...args:unknown[]){const bound=statement.bind(...args);return {...bound,all:async()=>{const result=await bound.all();if(sql.startsWith('WITH page AS MATERIALIZED')){reads.push(Number(result.results[0]?.pageCount??0));returned.push(result.results.length);}return result;}};}};}};
  const filters={from:'2026-10-13',to:'2026-10-13',view:'traffic',compare:'previous',mode:'closed',market:'US',stream:'',source:'',device:'',page:'/a'} as const;
  const result=await readTrendObservations(new Store(db),[{snapshotId,sourceId,date}],['traffic'],filters,{organizationId:'agency',clientId:'kind-patches'});
  expect(reads.length).toBeGreaterThan(2);expect(Math.max(...reads)).toBeLessThanOrEqual(2000);expect(Math.max(...returned)).toBeLessThan(32);
  const sessions=result.filter(row=>row.metric==='sessions');expect(sessions.find(row=>row.dimensions.market==='US')).toMatchObject({value:4101,start:'2026-09-28T00:00:00Z',end:'2026-09-28T21:00:00Z'});expect(sessions.find(row=>row.dimensions.market==='CA')?.value).toBe(3);
  expect(result.find(row=>row.metric==='converting_sessions')?.value).toBe(13);expect(result.find(row=>row.metric==='reported_rate')?.value).toBeNull();
  expect(result.every(row=>'contextOnly' in row&&row.contextOnly===true)).toBe(true);expect(result.some(row=>'utm_campaign' in row.dimensions)).toBe(false);
  expect(result.filter(row=>row.metric==='component_rate').map(row=>[row.value,row.numerator,row.denominator])).toEqual([[.25,1,4],[.5,2,4]]);
 }finally{client.close();}
});
it('matches projected and paged legacy live history, advances the clock cache and scans past fully clipped pages',async()=>{
 const client=createClient({url:'file::memory:'});try{
  for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))await client.executeMultiple(readFileSync(`drizzle/${file}`,'utf8'));
  const date='2026-10-10',sourceId='traffic',scope={organizationId:'agency',clientId:'kind-patches'},base={date,dataset:'traffic',metric:'sessions',value:1,dimensions:{page:'/a',market:'US'},definition:'captured',population:'human',currency:null,sourceId,retrievedAt:'2026-10-12T03:00:00Z',coverageThrough:'2026-10-12T03:00:00Z',quality:'complete' as const,start:`${date}T01:00:00Z`,end:`${date}T02:00:00Z`};
  const rows=[...Array.from({length:2000},(_,index)=>({...base,dimensions:{...base.dimensions,utm_campaign:`late-${index}`}})),{...base,value:10,start:`${date}T00:00:00Z`,end:`${date}T01:00:00Z`},{...base,metric:'converting_sessions',value:1,start:`${date}T00:00:00Z`,end:`${date}T01:00:00Z`}];
  for(const snapshotId of ['projected','legacy']){
   await client.execute({sql:"INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES(?,'agency','kind-patches',?,'2026-10-12T03:00:00Z','2026-10-12T03:00:00Z',1,'ready','test')",args:[snapshotId,sourceId]});
   for(let index=0;index<rows.length;index+=500)await client.batch(rows.slice(index,index+500).map((row,offset)=>({sql:'INSERT INTO observations(snapshotId,date,rowKey,payload) VALUES(?,?,?,?)',args:[snapshotId,date,String(index+offset).padStart(6,'0'),JSON.stringify(row)]})),'write');
  }
  const db=sqliteBindings(client),store=new Store(db);await writeSnapshotDayProjection(db,scope.organizationId,scope.clientId,{snapshotId:'projected',sourceId,date},observationCodec.encode(rows));
  const filters={from:'2026-10-12',to:'2026-10-12',view:'traffic',compare:'previous',mode:'partial',market:'US',stream:'',source:'',device:'',page:'/a'} as const,read=(snapshotId:string,cutoff:string|null,mode:'closed'|'partial'='partial')=>readTrendObservations(store,[{snapshotId,sourceId,date}],['traffic'],{...filters,mode},scope,{timezone:'UTC',cutoff,anchorDate:filters.to});
  const projected=await read('projected','2026-10-12T01:00:00Z'),legacy=await read('legacy','2026-10-12T01:00:00Z'),byMetric=(a:{metric:string},b:{metric:string})=>a.metric.localeCompare(b.metric);expect([...legacy].sort(byMetric)).toEqual([...projected].sort(byMetric));expect(projected.find(row=>row.metric==='sessions')?.value).toBe(10);
  expect((await read('legacy','2026-10-12T02:00:00Z')).find(row=>row.metric==='sessions')?.value).toBe(2010);expect((await read('legacy','2026-10-12T01:00:00Z')).find(row=>row.metric==='sessions')?.value).toBe(10);
  expect((await read('legacy',null,'closed')).find(row=>row.metric==='sessions')?.value).toBe(2010);expect(await read('legacy',null)).toEqual([]);
  expect(await read('legacy','2026-10-12T00:00:00Z')).toEqual([]);
  await store.run("INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config) VALUES('kind-patches','agency','KP','kp','UTC','USD','blue','{}')");
  await store.run("INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,coverageThrough,version) VALUES('traffic','agency','kind-patches','Traffic','kind-shopify-traffic','','',60,1,'2026-10-12T01:00:00Z',1)");
  await store.run("INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId) VALUES('agency','kind-patches','traffic',?,'projected')",date);
  await store.saveQualification('agency','kind-patches','traffic',1,1,{profiles:[{dataset:'traffic',metric:'sessions'},{dataset:'traffic',metric:'converting_sessions'}]},'test');
  const selection={datasets:['traffic'],includePriorWeek:false,includeOperations:false,trendDatasets:['traffic']};
  expect((await store.observations('agency','kind-patches',filters,false,undefined,selection)).find(row=>row.metric==='sessions')?.value).toBe(10);
  await store.run("UPDATE connections SET coverageThrough='2026-10-12T02:00:00Z' WHERE id='traffic'");
  expect((await store.observations('agency','kind-patches',filters,false,undefined,selection)).find(row=>row.metric==='sessions')?.value).toBe(2010);
 }finally{client.close();}
});
