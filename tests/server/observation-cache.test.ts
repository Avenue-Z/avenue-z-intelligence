import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import type {Observation,QueryFilters,SourceBatch} from '../../lib/analytics/contracts';

function database(){
 const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const queries:string[]=[];
 const prepare=(sql:string)=>{let values:unknown[]=[];const statement={bind(...input:unknown[]){values=input;return statement;},async all(){queries.push(sql);return {results:sqlite.prepare(sql).all(...values as any[])};},async first(){queries.push(sql);return sqlite.prepare(sql).get(...values as any[])??null;},async run(){const result=sqlite.prepare(sql).run(...values as any[]);return {meta:{changes:Number(result.changes)}};}};return statement;};
 return {db:{prepare,async batch(statements:ReturnType<typeof prepare>[]){const results=[];for(const statement of statements)results.push(await statement.run());return results;}},queries,sqlite};
}
const filters:QueryFilters={from:'2026-10-07',to:'2026-10-07',compare:'previous',mode:'closed',view:'overview',market:'',stream:'',source:'',device:'',page:''};
function batch(clientId='a',value=42):SourceBatch{return {clientId,timezone:'UTC',currency:'USD',channels:[],dimensions:[],grain:'daily',complete:true,coverageThrough:null,rows:[{date:'2026-10-07',dataset:'overview',metric:'revenue',value,currency:'USD',definition:'web',dimensions:{},sourceId:'',retrievedAt:'',coverageThrough:null,quality:'complete'}]};}
function observationReads(queries:string[]){return queries.filter(sql=>sql.startsWith('SELECT o.payload')).length;}
afterEach(()=>vi.restoreAllMocks());

it('reuses captured observations across new request stores and tabs while checking fresh source pointers',async()=>{
 const {db,queries}=database(),store=new Store(db);await store.persistBatch('o','source',batch(),'one','2026-10-08T00:00:00Z');
 expect((await store.observations('o','a',filters))[0].value).toBe(42);const reads=observationReads(queries),pointerReads=queries.filter(sql=>sql.startsWith('SELECT c.snapshotId')).length;
 const next=await new Store(db).observations('o','a',{...filters,view:'media',market:'US'});
 expect(next[0].value).toBe(42);expect(observationReads(queries)).toBe(reads);expect(queries.filter(sql=>sql.startsWith('SELECT c.snapshotId')).length).toBe(pointerReads+1);
});
it('keeps organization, client, date, comparison, mode and headline scopes separate',async()=>{
 const {db,queries}=database(),store=new Store(db);await store.persistBatch('o','source',batch(),'one','2026-10-08T00:00:00Z');await store.persistBatch('other','source',batch('a',99),'two','2026-10-08T00:00:00Z');await store.persistBatch('o','source',batch('b',7),'three','2026-10-08T00:00:00Z');
 expect((await store.observations('o','a',filters))[0].value).toBe(42);expect((await store.observations('other','a',filters))[0].value).toBe(99);expect((await store.observations('o','b',filters))[0].value).toBe(7);
 const variants=[{...filters,from:'2026-10-06',to:'2026-10-06'},{...filters,compare:'weekday' as const},{...filters,mode:'partial' as const}];
 for(const variant of variants){const before=observationReads(queries);await store.observations('o','a',variant);expect(observationReads(queries)).toBeGreaterThan(before);}
 const before=observationReads(queries);await store.observations('o','a',filters,true);expect(observationReads(queries)).toBeGreaterThan(before);
});
it('observes source refreshes and corrected empty days immediately inside the cache lifetime',async()=>{
 const {db}=database(),store=new Store(db);await store.persistBatch('o','source',batch(),'one','2026-10-08T00:00:00Z');expect((await store.observations('o','a',filters))[0].value).toBe(42);
 await new Store(db).persistBatch('o','source',batch('a',50),'two','2026-10-08T01:00:00Z');expect((await store.observations('o','a',filters))[0].value).toBe(50);
 await store.persistBatch('o','source',{...batch(),rows:[]},'empty','2026-10-08T02:00:00Z',{from:'2026-10-07',to:'2026-10-07'});expect(await store.observations('o','a',filters)).toEqual([]);
});
it('does not reuse another database or allow a caller to mutate cached evidence',async()=>{
 const first=database(),second=database(),one=new Store(first.db),two=new Store(second.db);await one.persistBatch('o','source',batch(),'one','2026-10-08T00:00:00Z');await two.persistBatch('o','source',batch('a',99),'one','2026-10-08T00:00:00Z');
 const rows=await one.observations('o','a',filters);rows[0].value=999;rows[0].dimensions.page='/changed';
 expect((await one.observations('o','a',filters))[0]).toMatchObject({value:42,dimensions:{}});expect((await two.observations('o','a',filters))[0].value).toBe(99);
});
it('expires cached observations and coalesces concurrent reads for one captured source version',async()=>{
 const {db,queries}=database(),store=new Store(db);await store.persistBatch('o','source',batch(),'one','2026-10-08T00:00:00Z');let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now);
 const [one,two]=await Promise.all([store.observations('o','a',filters),new Store(db).observations('o','a',filters)]);expect(one).toEqual(two);expect(observationReads(queries)).toBe(1);
 const durableReads=queries.filter(sql=>sql.startsWith('SELECT generation,chunkCount')).length;now+=60001;await store.observations('o','a',filters);expect(observationReads(queries)).toBe(1);expect(queries.filter(sql=>sql.startsWith('SELECT generation,chunkCount')).length).toBe(durableReads+1);
});
it('updates partial rollups when source coverage changes without republishing observations',async()=>{
 const {db}=database(),store=new Store(db);await store.run("INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config,version) VALUES('a','o','A','a','UTC','USD','blue','{}',1)");
 await store.run("INSERT INTO connections(id,organizationId,clientId,name,provider,endpoint,secretRef,pollMinutes,enabled,coverageThrough,version) VALUES('source','o','a','Source','kind-shopify-hourly','','',60,1,'2026-10-07T01:00:00Z',1)");
 const rows:Observation[]=[0,1].map(hour=>({date:'2026-10-07',dataset:'funnels',metric:'sessions',value:hour+1,currency:null,definition:'shopify_human_public_landing_pages',population:'human_public_landing_page_sessions',dimensions:{page:'/lp',market:'US'},start:`2026-10-07T0${hour}:00:00Z`,end:`2026-10-07T0${hour+1}:00:00Z`,sourceId:'',retrievedAt:'',quality:'complete',coverageThrough:'2026-10-07T02:00:00Z'}));
 await store.persistBatch('o','source',{...batch(),rows,coverageThrough:'2026-10-07T02:00:00Z'},'one','2026-10-08T00:00:00Z');
 const partial={...filters,mode:'partial' as const};expect((await store.observations('o','a',partial))[0].value).toBe(1);
 await store.run("UPDATE connections SET coverageThrough='2026-10-07T02:00:00Z' WHERE id='source'");expect((await store.observations('o','a',partial))[0].value).toBe(3);
 await store.run("UPDATE connections SET coverageThrough=NULL WHERE id='source'");expect((await store.observations('o','a',partial))).toHaveLength(2);
});
it('evicts older filter selections instead of retaining unbounded response data',async()=>{
 const {db,queries}=database(),store=new Store(db);await store.persistBatch('o','source',batch(),'one','2026-10-08T00:00:00Z');await store.observations('o','a',filters);
 for(let day=1;day<=30;day++)await store.observations('o','a',{...filters,from:`2026-09-${String(day).padStart(2,'0')}`,to:`2026-09-${String(day).padStart(2,'0')}`});
 const before=observationReads(queries);expect((await store.observations('o','a',filters))[0].value).toBe(42);expect(observationReads(queries)).toBeGreaterThan(before);
});
it('skips irrelevant qualified source dates while retaining overview trends, renewal history, inventory and unknown archives',async()=>{
 const {db,queries}=database(),store=new Store(db),dates=Array.from({length:20},(_,day)=>new Date(Date.UTC(2026,8,20+day)).toISOString().slice(0,10));
 const overview=batch().rows[0];
 await store.persistBatch('o','detail',{...batch(),rows:dates.map(date=>({...overview,date,dataset:'funnels',metric:'sessions',value:10}))},'one','2026-10-10T00:00:00Z');
 await store.saveQualification('o','a','detail',1,1,{profiles:[{dataset:'funnels',metric:'sessions'}]},'u');
 await store.persistBatch('o','headline',{...batch(),rows:dates.map(date=>({...overview,date}))},'one','2026-10-10T00:00:00Z');await store.saveQualification('o','a','headline',1,1,{profiles:[{dataset:'overview',metric:'revenue'}]},'u');
 await store.persistBatch('o','renewals',{...batch(),rows:[{...overview,date:'2026-08-17',dataset:'subscriptions',metric:'recurring_revenue',value:12}]},'one','2026-10-10T00:00:00Z');await store.saveQualification('o','a','renewals',1,1,{profiles:[{dataset:'subscriptions',metric:'recurring_revenue'}]},'u');
 await store.persistBatch('o','inventory',{...batch(),rows:[{...overview,date:'2026-10-09',dataset:'media',metric:'active_ads',value:7}]},'one','2026-10-10T00:00:00Z');await store.saveQualification('o','a','inventory',1,1,{profiles:[{dataset:'media',metric:'active_ads'}]},'u');
 await store.persistBatch('o','archive',{...batch(),rows:[{...overview,date:'2026-08-17',dataset:'subscriptions',metric:'recurring_orders',value:3}]},'one','2026-10-10T00:00:00Z');
 const rows=await store.observations('o','a',filters);
 expect(rows.filter(r=>r.sourceId==='detail').map(r=>r.date)).toEqual(['2026-09-30','2026-10-06','2026-10-07']);expect(rows.filter(r=>r.sourceId==='headline')).toHaveLength(18);
 expect(rows.find(r=>r.sourceId==='renewals')?.value).toBe(12);expect(rows.find(r=>r.sourceId==='inventory')?.value).toBe(7);expect(rows.find(r=>r.sourceId==='archive')?.value).toBe(3);expect(observationReads(queries)).toBeLessThan(24);
});
it('reuses large multi-metric exports within the serialized memory budget without changing their evidence',async()=>{
 const {db,queries}=database(),store=new Store(db),base=batch().rows[0],rows:Observation[]=Array.from({length:1600},(_,index)=>['sessions','converting_sessions','atc_sessions','checkouts','completed_checkouts'].map(metric=>({...base,dataset:'funnels',metric,value:index+1,dimensions:{page:`/${'landing-page-'.repeat(14)}${index}`,market:'US'}}))).flat();
 await store.persistBatch('o','source',{...batch(),rows},'large','2026-10-08T00:00:00Z');const first=await store.observations('o','a',filters),reads=observationReads(queries);expect(first).toHaveLength(8000);
 expect(await new Store(db).observations('o','a',filters)).toEqual(first);expect(observationReads(queries)).toBe(reads);
});
it('batches constrained history reads and resumes an overflowing pointer without rescanning or dropping rows',async()=>{
 const {db,queries}=database(),store=new Store(db),base=batch().rows[0],dates=['2026-09-15','2026-09-16','2026-09-17','2026-09-18','2026-09-19','2026-09-20'];
 const rows=dates.flatMap((date,index)=>Array.from({length:index===2?2101:1},(_,page)=>({...base,date,dataset:'subscriptions',metric:'recurring_orders',value:1,dimensions:{page:`/p-${page}`}})));
 await store.persistBatch('o','source',{...batch(),rows},'one','2026-10-08T00:00:00Z');const result=await store.observations('o','a',filters);
 expect(result).toHaveLength(2106);expect(result.reduce((sum,row)=>sum+(row.value??0),0)).toBe(2106);expect(result.filter(row=>row.date==='2026-09-17')).toHaveLength(2101);expect(observationReads(queries)).toBeLessThan(7);
});
it('retains subscription history after a source is qualified for a different profile',async()=>{
 const {db}=database(),store=new Store(db),row={...batch().rows[0],date:'2026-08-17',dataset:'subscriptions',metric:'recurring_revenue',value:12};
 await store.persistBatch('o','source',{...batch(),rows:[row]},'one','2026-10-08T00:00:00Z');await store.saveQualification('o','a','source',1,1,{profiles:[{dataset:'subscriptions',metric:'recurring_revenue'}]},'u');await store.saveQualification('o','a','source',2,1,{profiles:[{dataset:'overview',metric:'revenue'}]},'u');
 expect((await store.observations('o','a',filters))[0]).toMatchObject({date:'2026-08-17',dataset:'subscriptions',value:12});
});
it('fails a fresh pointer check instead of returning earlier cached evidence',async()=>{
 const {db}=database(),store=new Store(db);await store.persistBatch('o','source',batch(),'one','2026-10-08T00:00:00Z');await store.observations('o','a',filters);const prepare=db.prepare;
 db.prepare=(sql:string)=>{const statement=prepare(sql);if(sql.startsWith('SELECT c.snapshotId'))statement.all=async()=>{throw Error('Metadata unavailable');};return statement;};
 await expect(store.observations('o','a',filters)).rejects.toThrow('Metadata unavailable');
});
