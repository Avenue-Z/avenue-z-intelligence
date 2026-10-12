import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {Store} from '../../lib/server/store';
import type {Observation,QueryFilters,SourceBatch} from '../../lib/analytics/contracts';
function database(){const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));const queries:string[]=[];const prepare=(sql:string)=>{let values:unknown[]=[];const statement={bind(...input:unknown[]){values=input;return statement;},async first(){queries.push(sql);return sqlite.prepare(sql).get(...values as any[])??null;},async all(){queries.push(sql);return {results:sqlite.prepare(sql).all(...values as any[])};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values as any[]).changes)}};}};return statement;};return {sqlite,queries,store:new Store({prepare,batch:async(statements:ReturnType<typeof prepare>[])=>{const results=[];for(const statement of statements)results.push(await statement.run());return results;}})};}
const filters:QueryFilters={from:'2026-10-11',to:'2026-10-11',compare:'previous',mode:'closed',view:'overview',market:'',stream:'',source:'',device:'',page:''};
const row=(date:string,value:number,dataset='overview',metric='revenue'):Observation=>({date,dataset,metric,value,dimensions:{},definition:'web',population:'web',currency:'USD',sourceId:'',retrievedAt:'',coverageThrough:null,quality:'complete'});
const batch=(revenue=100,today=20,coverage='2026-10-12T12:00:00Z'):SourceBatch=>({clientId:'a',timezone:'UTC',currency:'USD',channels:['meta'],dimensions:[],grain:'daily',complete:true,coverageThrough:coverage,rows:[row(filters.to,revenue),row('2026-10-12',today,'subscriptions','recurring_revenue')]});
async function setup(){const d=database();await d.store.run("INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config,version) VALUES('a','o','A','a','UTC','USD','blue','{}',1)");await d.store.saveQualification('o','a','source',1,1,{profiles:[{dataset:'overview',metric:'revenue'},{dataset:'subscriptions',metric:'recurring_revenue'}]},'u');return d;}
it('retains the original closed-day snapshot and warm cache when a mixed batch only changes today',async()=>{
 const {store,queries}=await setup();await store.persistBatch('o','source',batch(),'first','2026-10-12T12:00:00Z');const first=await store.observations('o','a',filters),pointer=await store.first("SELECT snapshotId FROM current_snapshots WHERE sourceId='source' AND date='2026-10-11'"),reads=queries.filter(sql=>sql.startsWith('SELECT o.payload')).length;
 await store.persistBatch('o','source',batch(100,40,'2026-10-12T13:00:00Z'),'second','2026-10-12T13:00:00Z');expect(await store.first("SELECT snapshotId FROM current_snapshots WHERE sourceId='source' AND date='2026-10-11'")).toEqual(pointer);expect(await store.observations('o','a',filters)).toEqual(first);expect(queries.filter(sql=>sql.startsWith('SELECT o.payload'))).toHaveLength(reads);expect(first.map(value=>value.date)).toEqual(['2026-10-11']);
});
it('invalidates corrected closed-day counts while preventing an older replay after an unchanged poll',async()=>{
 const {store}=await setup();await store.persistBatch('o','source',batch(),'first','2026-10-12T12:00:00Z');await store.persistBatch('o','source',batch(100,30),'same-facts','2026-10-12T14:00:00Z');await store.persistBatch('o','source',batch(999,30),'late-old','2026-10-12T13:00:00Z');expect((await store.observations('o','a',filters))[0].value).toBe(100);
 await store.persistBatch('o','source',batch(110,30),'corrected','2026-10-12T15:00:00Z');expect((await store.observations('o','a',filters))[0].value).toBe(110);
});
it('does not reuse current partial-day pointers when coverage advances',async()=>{
 const {store}=await setup();await store.persistBatch('o','source',batch(),'first','2026-10-12T12:00:00Z');const pointer=await store.first("SELECT snapshotId FROM current_snapshots WHERE sourceId='source' AND date='2026-10-12'");await store.persistBatch('o','source',batch(100,20,'2026-10-12T13:00:00Z'),'next-cutoff','2026-10-12T13:00:00Z');expect(await store.first("SELECT snapshotId FROM current_snapshots WHERE sourceId='source' AND date='2026-10-12'")).not.toEqual(pointer);
});
it('does not retain a closed pointer whose original source coverage was incomplete',async()=>{
 const {store}=await setup();await store.persistBatch('o','source',batch(100,20,'2026-10-11T13:00:00Z'),'incomplete','2026-10-12T12:00:00Z');const pointer=await store.first("SELECT snapshotId FROM current_snapshots WHERE sourceId='source' AND date='2026-10-11'");await store.persistBatch('o','source',batch(),'complete','2026-10-12T13:00:00Z');expect(await store.first("SELECT snapshotId FROM current_snapshots WHERE sourceId='source' AND date='2026-10-11'")).not.toEqual(pointer);
});
it('reads operational-only snapshots fresh without invalidating the bulky closed cache',async()=>{
 const {store,queries}=await setup();await store.persistBatch('o','source',batch(),'first','2026-10-12T12:00:00Z');await store.saveQualification('o','a','ops',1,1,{profiles:[{dataset:'media',metric:'active_ads'}]},'u');const inventory=(value:number):SourceBatch=>({...batch(),rows:[row('2026-10-12',value,'media','active_ads')]});await store.persistBatch('o','ops',inventory(3),'ops-first','2026-10-12T12:00:00Z');expect((await store.observations('o','a',filters)).find(value=>value.metric==='active_ads')?.value).toBe(3);const reads=queries.filter(sql=>sql.startsWith('SELECT o.payload')).length;
 await store.persistBatch('o','ops',inventory(4),'ops-next','2026-10-12T13:00:00Z');expect((await store.observations('o','a',filters)).find(value=>value.metric==='active_ads')?.value).toBe(4);expect(queries.filter(sql=>sql.startsWith('SELECT o.payload'))).toHaveLength(reads);
});
it('keeps current operational counters separate from a narrow historical dataset selection',async()=>{
 const {store}=await setup();await store.persistBatch('o','source',batch(),'first','2026-10-12T12:00:00Z');
 await store.saveQualification('o','a','ops',1,1,{profiles:[{dataset:'media',metric:'active_ads'}]},'u');
 await store.persistBatch('o','ops',{...batch(),rows:[row('2026-10-12',7,'media','active_ads')]},'ops','2026-10-12T12:00:00Z');
 const rows=await store.observations('o','a',{...filters,market:'US'},false,undefined,{datasets:['overview'],dimensions:true});
 expect(rows.find(value=>value.metric==='active_ads')).toMatchObject({value:7,date:'2026-10-12',dataset:'media'});
 expect(rows.filter(value=>value.metric!=='active_ads').every(value=>value.dataset==='overview')).toBe(true);
});
