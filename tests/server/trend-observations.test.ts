import {createClient} from '@libsql/client';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {sqliteBindings} from '../../lib/server/sqlite-bindings';
import {Store} from '../../lib/server/store';
import {readTrendObservations} from '../../lib/server/trend-observations';
import {writeSnapshotDayProjection} from '../../lib/server/snapshot-day-projections';
import {observationCodec} from '../../lib/server/observation-codec';

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
  expect(reads.length).toBeGreaterThan(2);expect(Math.max(...reads)).toBeLessThanOrEqual(2000);expect(Math.max(...returned)).toBeLessThan(10);
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
