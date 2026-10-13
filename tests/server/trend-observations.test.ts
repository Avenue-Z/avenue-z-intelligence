import {createClient} from '@libsql/client';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {sqliteBindings} from '../../lib/server/sqlite-bindings';
import {Store} from '../../lib/server/store';
import {readTrendObservations} from '../../lib/server/trend-observations';

it('compacts a missing dense history projection through bounded indexed reads without losing rows, filters or rate qualification',async()=>{
 const client=createClient({url:'file::memory:'});
 try{
  for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))await client.executeMultiple(readFileSync(`drizzle/${file}`,'utf8'));
  const date='2026-09-28',snapshotId='captured-history',sourceId='traffic',make=(metric:string,value:number|null,index:number,market='US')=>{const hour=Math.min(23,Math.floor(index/200)),clock=(value:number)=>String(value).padStart(2,'0');return {date,dataset:'traffic',metric,value,dimensions:{market,page:'/a',utm_campaign:`campaign-${index}`},population:'human',definition:'captured',currency:null,sourceId,retrievedAt:'2026-10-13T12:00:00Z',coverageThrough:'2026-09-28T22:00:00Z',quality:'complete',start:`2026-09-28T${clock(hour)}:00:00Z`,end:`2026-09-28T${clock(hour+1)}:00:00Z`};};
  const rows=[...Array.from({length:4101},(_,index)=>make('sessions',1,index)),make('converting_sessions',13,0),make('sessions',3,4102,'CA'),make('reported_rate',.2,0),make('reported_rate',.3,1),{...make('component_rate',.25,0),numerator:1,denominator:4},{...make('component_rate',.5,1),numerator:2,denominator:4}];
  for(let index=0;index<rows.length;index+=500)await client.batch(rows.slice(index,index+500).map((row,offset)=>({sql:'INSERT INTO observations(snapshotId,date,rowKey,payload) VALUES(?,?,?,?)',args:[snapshotId,date,String(index+offset).padStart(6,'0'),JSON.stringify(row)]})),'write');
  const base=sqliteBindings(client),reads:number[]=[],returned:number[]=[];
  const db={...base,prepare(sql:string){const statement=base.prepare(sql);return {...statement,bind(...args:unknown[]){const bound=statement.bind(...args);return {...bound,all:async()=>{const result=await bound.all();if(sql.startsWith('WITH page AS MATERIALIZED')){reads.push(Number(result.results[0]?.pageCount??0));returned.push(result.results.length);}return result;}};}};}};
  const filters={from:'2026-10-13',to:'2026-10-13',view:'traffic',compare:'previous',mode:'partial',market:'US',stream:'',source:'',device:'',page:'/a'} as const;
  const result=await readTrendObservations(new Store(db),[{snapshotId,sourceId,date}],['traffic'],filters,{organizationId:'agency',clientId:'kind-patches'});
  expect(reads.length).toBeGreaterThan(2);expect(Math.max(...reads)).toBeLessThanOrEqual(2000);expect(Math.max(...returned)).toBeLessThan(10);
  const sessions=result.filter(row=>row.metric==='sessions');expect(sessions.find(row=>row.dimensions.market==='US')).toMatchObject({value:4101,start:'2026-09-28T00:00:00Z',end:'2026-09-28T21:00:00Z'});expect(sessions.find(row=>row.dimensions.market==='CA')?.value).toBe(3);
  expect(result.find(row=>row.metric==='converting_sessions')?.value).toBe(13);expect(result.find(row=>row.metric==='reported_rate')?.value).toBeNull();
  expect(result.every(row=>'contextOnly' in row&&row.contextOnly===true)).toBe(true);expect(result.some(row=>'utm_campaign' in row.dimensions)).toBe(false);
  expect(result.filter(row=>row.metric==='component_rate').map(row=>[row.value,row.numerator,row.denominator])).toEqual([[.25,1,4],[.5,2,4]]);
 }finally{client.close();}
});
