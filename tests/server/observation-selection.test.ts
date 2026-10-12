import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {Store} from '../../lib/server/store';
import {queryClient} from '../../lib/analytics/query';
import type {Client,Observation,QueryFilters,SourceBatch} from '../../lib/analytics/contracts';
function database(){const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));const prepare=(sql:string)=>{let values:unknown[]=[];const statement={bind(...input:unknown[]){values=input;return statement;},async first(){return sqlite.prepare(sql).get(...values as any[])??null;},async all(){return {results:sqlite.prepare(sql).all(...values as any[])};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values as any[]).changes)}};}};return statement;};return new Store({prepare,batch:async(statements:ReturnType<typeof prepare>[])=>Promise.all(statements.map(statement=>statement.run()))});}
const filters:QueryFilters={from:'2026-10-11',to:'2026-10-11',compare:'previous',mode:'closed',view:'traffic',market:'',stream:'',source:'',device:'',page:'/pages/wanted'};
const row=(dataset:string,metric:string,value:number,dimensions:Record<string,string>):Observation=>({date:filters.to,dataset,metric,value,dimensions,definition:dataset,population:dataset,currency:metric==='revenue'?'USD':null,sourceId:'',retrievedAt:'',coverageThrough:null,quality:'complete'});
async function fixture(){const store=database(),rows=[row('traffic','sessions',10,{page:'/pages/wanted',market:'FR'}),row('traffic','sessions',20,{page:'/pages/other',market:'US'}),row('overview','revenue',100,{}),row('products','revenue',200,{product:'Bundle'})];const batch:SourceBatch={clientId:'a',timezone:'UTC',currency:'USD',channels:[],dimensions:['page','market','product'],grain:'daily',complete:true,coverageThrough:'2026-10-12T00:00:00Z',rows};await store.persistBatch('o','source',batch,'all','2026-10-12T12:00:00Z');return {store,batch};}
it('slims dataset and page evidence while retaining dimensionless overview rows for unsupported-filter checks',async()=>{
 const {store}=await fixture(),rows=await store.observations('o','a',filters,false,undefined,{datasets:['overview','traffic'],dimensions:true});expect(rows.map(value=>[value.dataset,value.value])).toEqual([['overview',100],['traffic',10]]);
 const client:Client={id:'a',name:'A',slug:'a',timezone:'UTC',currency:'USD',color:'blue',version:1,config:{markets:['FR'],benchmarkMarket:'FR',revenueDefinition:'overview',spendChannels:[],recurringLabel:'Recurring',minSessions:100,minOpportunity:10,maxActions:5,reviewTime:'09:00',reviewTimezone:'UTC',reviewMode:'closed',incidents:[]}};
 const result=queryClient(client,rows,[],filters);expect(result.metrics.revenue).toBeNull();expect(result.warnings.join(' ')).toContain('overview:revenue');expect(result.datasetMetrics.sessions).toBe(10);
});
it('keeps dataset and active dimension selections isolated from normal and other scoped cache entries',async()=>{
 const {store}=await fixture();const wanted=await store.observations('o','a',filters,false,undefined,{datasets:['traffic'],dimensions:true}),other=await store.observations('o','a',{...filters,page:'/pages/other'},false,undefined,{datasets:['traffic'],dimensions:true});expect(wanted.map(value=>value.value)).toEqual([10]);expect(other.map(value=>value.value)).toEqual([20]);expect(await store.observations('o','a',filters)).toHaveLength(4);expect(await store.observations('o','a',filters,false,undefined,{datasets:['products']})).toHaveLength(1);
});
it('retains selected-dataset rows missing a requested dimension instead of pretending they support the filter',async()=>{
 const {store,batch}=await fixture();await store.persistBatch('o','source',{...batch,rows:[...batch.rows,row('traffic','sessions',30,{source:'organic'})]},'with-unsupported','2026-10-12T13:00:00Z');const rows=await store.observations('o','a',filters,false,undefined,{datasets:['traffic'],dimensions:true});expect(rows.map(value=>value.value).sort((a,b)=>a!-b!)).toEqual([10,30]);
});
it('matches normalized country aliases in historical observations without loading unrelated markets',async()=>{
 const {store,batch}=await fixture();await store.persistBatch('o','source',{...batch,rows:[row('traffic','sessions',11,{page:'/pages/wanted',market:'France'}),row('traffic','sessions',20,{page:'/pages/wanted',market:'US'})]},'country-alias','2026-10-12T13:00:00Z');expect((await store.observations('o','a',{...filters,market:'FR'},false,undefined,{datasets:['traffic'],dimensions:true})).map(value=>value.value)).toEqual([11]);
});
